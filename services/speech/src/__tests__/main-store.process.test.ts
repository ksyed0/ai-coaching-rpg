import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionLock } from "@acr/runtime/files";
import { LOCK_WAIT_MS } from "../store/store-setup.js";

/**
 * US-0073 (A2a Task 10, carried from the Task 7c review): a forked worker (the real main.ts) that is waiting for its store lock and whose
 * parent's IPC channel closes exits 0 at once (well inside LOCK_WAIT_MS), never starts the worker, and leaves no lock of its own behind.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = path.join(PKG, "src", "main.ts");
const HELD = "0123456789abcdef0123456789abcdef";
const FREE = "fedcba9876543210fedcba9876543210";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-lockwait-"));
  await mkdir(path.join(dir, "audio"), { mode: 0o700 });
  await mkdir(path.join(dir, "sessions"), { mode: 0o700 });
  await writeFile(path.join(dir, "script.json"), JSON.stringify({ tech_lead: ["unused"] }));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function start(identity: string): { child: ChildProcess; messages: { type?: string }[]; exited: Promise<number | null> } {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, STT_PROVIDER: "fake", STT_FAKE_SCRIPT: path.join(dir, "script.json"), SPEECH_INGEST: "file", SPEECH_INGEST_DIR: dir,
    SPEECH_INGEST_ROLES: "tech_lead", AUDIO_DIR: path.join(dir, "audio"), SPEECH_SESSIONS_DIR: path.join(dir, "sessions"), SPEECH_LOG_IDENTITY: identity, SPEECH_SESSION_ID: "sess-1", AUDIO_MIN_FREE_MB: "512",
  };
  const child = fork(ENTRY, [], { execArgv: ["--import", "tsx"], cwd: PKG, env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const messages: { type?: string }[] = [];
  child.on("message", (m) => messages.push(m as { type?: string }));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, messages, exited };
}

describe("the forked speech worker waiting for its store lock (US-0073)", () => {
  it("exits 0 promptly when the parent's channel closes during the lock wait, starts nothing, and holds no lock afterwards", async () => {
    const held = SessionLock.acquire(path.join(dir, "audio"), HELD, { suffix: "store" }); // an old worker still flushing
    const waiting = start(HELD);
    const free = start(FREE); // the same start-up with a free lock: once it is ready, the other is surely inside its wait
    try {
      await vi.waitFor(() => expect(free.messages).toContainEqual({ type: "worker_ready", stt: "ok" }), { timeout: 60_000 });
      expect(waiting.messages).toEqual([]); // blocked on the lock: not ready, no store_stopped
      let code: number | null | undefined;
      void waiting.exited.then((c) => { code = c; });
      waiting.child.disconnect();
      // Our lock is still held: without the abort the worker would sit out the whole LOCK_WAIT_MS before noticing. Poll for the exit
      // with a budget far inside that window (a poll on the effect, not a measured duration).
      await vi.waitFor(() => expect(code).toBe(0), { timeout: LOCK_WAIT_MS / 3, interval: 25 });
      expect(waiting.messages).toEqual([]);
      held.release();
      // The exited worker never took the lock: a new holder gets it at once.
      const again = SessionLock.acquire(path.join(dir, "audio"), HELD, { suffix: "store" });
      again.release();
    } finally {
      waiting.child.kill("SIGKILL");
      free.child.kill("SIGKILL");
      try { held.release(); } catch { /* released */ }
    }
  });
});
