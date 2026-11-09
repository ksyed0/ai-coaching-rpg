import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeWav } from "@acr/adapters";
import { concat, silence, tone } from "./signals.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(PKG, "src", "main.ts");

let dir: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-proc-"));
  process.env.TMPDIR = dir;
  await writeFile(path.join(dir, "tech_lead.wav"), encodeWav(concat(silence(200), tone(800, -20), silence(800)), 16000));
  await writeFile(path.join(dir, "script.json"), JSON.stringify({ tech_lead: ["We can ship in May."] }));
});
afterAll(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(dir, { recursive: true, force: true });
});

function start(env: NodeJS.ProcessEnv): { child: ChildProcess; messages: unknown[]; exited: Promise<number | null>; stderr: () => string } {
  let err = "";
  const child = fork(ENTRY, [], { execArgv: ["--import", "tsx"], cwd: PKG, env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  child.stderr!.on("data", (b: Buffer) => { err += b.toString(); });
  const messages: unknown[] = [];
  child.on("message", (m) => messages.push(m));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, messages, exited, stderr: () => err };
}

const workerEnv = (): NodeJS.ProcessEnv => ({
  STT_PROVIDER: "fake", STT_FAKE_SCRIPT: path.join(dir, "script.json"), SPEECH_INGEST: "file", SPEECH_INGEST_DIR: dir, SPEECH_INGEST_ROLES: "tech_lead",
});
const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true }];

describe("the forked speech worker (US-0070)", () => {
  it("answers voice_state with voice_line messages for a fixture file and exits 0 when the parent disconnects", async () => {
    const w = start(workerEnv());
    try {
      await vi.waitFor(() => expect(w.messages).toContainEqual({ type: "worker_ready", stt: "ok" }), { timeout: 60_000 });
      w.child.send({ type: "voice_state", paused: false, ended: false, holders });
      await vi.waitFor(() => expect(w.messages).toContainEqual(expect.objectContaining({ type: "voice_line", roleId: "tech_lead", participantId: "p1", text: "We can ship in May." })), { timeout: 60_000 });
      await vi.waitFor(() => expect(w.messages).toContainEqual(expect.objectContaining({ type: "speech_activity", active: false })), { timeout: 60_000 });
      w.child.disconnect();
      expect(await w.exited).toBe(0);
      expect(w.stderr()).not.toContain(dir);
    } finally { w.child.kill("SIGKILL"); }
  });

  it("an invalid message from the parent is ignored", async () => {
    const w = start(workerEnv());
    try {
      await vi.waitFor(() => expect(w.messages).toContainEqual({ type: "worker_ready", stt: "ok" }), { timeout: 60_000 });
      w.child.send({ type: "voice_state", paused: false, ended: false, holders, extra: 1 }); // strict: dropped
      w.child.send({ type: "bogus" });
      w.child.send("not an object");
      // A real state afterwards still works: the worker neither crashed nor started on the invalid one.
      await new Promise((r) => setImmediate(r));
      expect(w.messages).toEqual([{ type: "worker_ready", stt: "ok" }]);
      w.child.send({ type: "voice_state", paused: false, ended: false, holders });
      await vi.waitFor(() => expect(w.messages).toContainEqual(expect.objectContaining({ type: "voice_line", text: "We can ship in May." })), { timeout: 60_000 });
      w.child.disconnect();
      expect(await w.exited).toBe(0);
    } finally { w.child.kill("SIGKILL"); }
  });

  it("a bad setting exits 2 with fixed errors naming the variable only", async () => {
    const w = start({ STT_PROVIDER: "whisper", STT_URL: "http://example.com:9000/secret-path", SPEECH_INGEST_DIR: dir, SPEECH_INGEST_ROLES: "tech_lead" });
    expect(await w.exited).toBe(2);
    expect(w.stderr()).toContain("STT_URL");
    expect(w.stderr()).not.toContain("secret-path");
    expect(w.stderr()).not.toContain(dir);
  });

  it("a fake script that cannot be read exits 2 with a fixed error", async () => {
    const w = start({ ...workerEnv(), STT_FAKE_SCRIPT: path.join(dir, "missing.json") });
    expect(await w.exited).toBe(2);
    expect(w.stderr()).toContain("STT_FAKE_SCRIPT");
    expect(w.stderr()).not.toContain(dir);
  });
});
