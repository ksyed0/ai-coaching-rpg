import { describe, expect, it, afterEach } from "vitest";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootstrap, type Runtime } from "../main.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null;
afterEach(async () => { await runtime?.stop(); runtime = null; if (tmp) await rm(tmp, { recursive: true, force: true }); });

describe("bootstrap", () => {
  it("starts the runtime with the mock provider on an ephemeral port and serves a facilitator join", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const logs: string[] = [];
    const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "t1", MODEL_PROVIDER: "mock", ANTHROPIC_API_KEY: "sk-secret-123" }, root: tmp, logDir: tmp, tickMs: 50, log: (m) => logs.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(runtime.port).toBeGreaterThan(0);
    const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}`);
    const msg = await new Promise<any>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "join_facilitator", sessionId: "t1" })));
      ws.on("message", (d) => resolve(JSON.parse(d.toString())));
      ws.on("error", reject);
    });
    ws.close();
    expect(msg).toMatchObject({ type: "joined", roleId: "facilitator" });
    expect(logs.join("\n")).toMatch(/Minimal/);
    expect(logs.join("\n")).not.toMatch(/sk-secret-123/);
  });

  it("reports validation errors and starts nothing", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const bad = path.join(tmp, "bad");
    await cp(fixture, bad, { recursive: true });
    const scriptFile = path.join(bad, "script.yaml");
    await writeFile(scriptFile, (await readFile(scriptFile, "utf8")).replace("participants: [host, guest]", "participants: [host, ghost]"));
    const r = await bootstrap({ env: { SCENARIO_DIR: bad, RUNTIME_PORT: "0", MODEL_PROVIDER: "mock" }, root: tmp, logDir: tmp, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/ghost/);
  });

  it("reports a scenario that cannot be loaded", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const r = await bootstrap({ env: { SCENARIO_DIR: path.join(tmp, "missing"), RUNTIME_PORT: "0", MODEL_PROVIDER: "mock" }, root: tmp, logDir: tmp, log: () => {} });
    expect(r.ok).toBe(false);
  });

  it("does not run on import (importing this module started nothing)", () => {
    expect(typeof bootstrap).toBe("function");
  });

  it("a temp root whose .env selects anthropic without a key fails clearly instead of calling a live model", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    await writeFile(path.join(tmp, ".env"), "MODEL_PROVIDER=anthropic\n");
    const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0" }, root: tmp, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("an unreadable .env (a directory) is reported as an error naming the file, not a rejection", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    await mkdir(path.join(tmp, ".env"));
    const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", MODEL_PROVIDER: "mock" }, root: tmp, log: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(path.join(tmp, ".env"));
  });

  describe("repo-root resolution (I5)", () => {
    const connect = (port: number, msg: unknown) => new Promise<any[]>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const got: any[] = [];
      ws.on("open", () => ws.send(JSON.stringify(msg)));
      ws.on("message", (d) => { got.push(JSON.parse(d.toString())); resolve(got); ws.close(); });
      ws.on("error", reject);
    });

    it("loads <root>/.env, resolves a relative SCENARIO_DIR and the data dir against the root, and logs provider + dir but no secret", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-root-"));
      await cp(fixture, path.join(tmp, "scn"), { recursive: true });
      await writeFile(path.join(tmp, ".env"), "SESSION_ID=fromdotenv\nRUNTIME_PORT=0\nSCENARIO_DIR=scn\nANTHROPIC_API_KEY=sk-from-dotenv\n");
      const logs: string[] = [];
      const r = await bootstrap({ env: {}, root: tmp, tickMs: 50, log: (m) => logs.push(m) });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      const [msg] = await connect(runtime.port, { type: "join_facilitator", sessionId: "fromdotenv" });
      expect(msg.type).toBe("joined");
      expect(logs.join("\n")).toContain(path.join(tmp, "scn"));
      expect(logs.join("\n")).toMatch(/provider.*mock/);
      expect(logs.join("\n")).not.toContain("sk-from-dotenv");
      // the event log lands under <root>/data/sessions
      await connect(runtime.port, { type: "join_facilitator", sessionId: "fromdotenv" });
      await runtime.host.start();
      expect((await stat(path.join(tmp, "data", "sessions", "fromdotenv.jsonl"))).isFile()).toBe(true);
    });

    it("real environment variables win over .env", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-root-"));
      await writeFile(path.join(tmp, ".env"), "SESSION_ID=fromdotenv\nRUNTIME_PORT=0\n");
      const r = await bootstrap({ env: { SESSION_ID: "fromenv", SCENARIO_DIR: fixture }, root: tmp, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      const [msg] = await connect(runtime.port, { type: "join_facilitator", sessionId: "fromenv" });
      expect(msg.type).toBe("joined");
    });

    it("works without a .env and resolves the default scenario against the root", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-root-"));
      const r = await bootstrap({ env: { RUNTIME_PORT: "0" }, root: tmp, log: () => {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toContain(path.join(tmp, "scenarios", "friday-escalation"));
    });

    it("uses an absolute SCENARIO_DIR as given, whatever the root", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-root-"));
      const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0" }, root: tmp, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      expect(runtime.port).toBeGreaterThan(0);
    });
  });

  describe("stale session log rotation", () => {
    const env = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "local", MODEL_PROVIDER: "mock", ...extra });
    const wsOpen = (port: number) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(w)); w.on("error", rej); });
    const waitMsg = (w: WebSocket, pred: (m: any) => boolean) => new Promise<any>((res) => { w.on("message", (d) => { const m = JSON.parse(d.toString()); if (pred(m)) res(m); }); });
    const dataDir = () => path.join(tmp, "data", "sessions");
    const rotated = async () => (await readdir(dataDir())).filter((f) => /^local\.\d{8}T\d{6}Z(-\d+)?\.jsonl$/.test(f));

    async function runOnce(logs: string[]) {
      const r = await bootstrap({ env: env(), root: tmp, tickMs: 1_000, log: (m) => logs.push(m) });
      if (!r.ok) throw new Error(r.errors.join("; "));
      const fac = await wsOpen(r.runtime.port);
      const started = waitMsg(fac, (m) => m.type === "event" && m.event.type === "scene.entered");
      const joined = waitMsg(fac, (m) => m.type === "joined");
      fac.send(JSON.stringify({ type: "join_facilitator", sessionId: "local" }));
      await joined;
      fac.send(JSON.stringify({ type: "start" }));
      await started;
      return { runtime: r.runtime, fac };
    }

    it("a second start with the same session id rotates the old log aside, preserves it, and works end to end", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      const logs: string[] = [];
      const first = await runOnce(logs);
      first.fac.close(); await first.runtime.stop();
      const oldText = await readFile(path.join(dataDir(), "local.jsonl"), "utf8");
      expect(oldText.length).toBeGreaterThan(0);

      const second = await runOnce(logs); // regression: used to answer "internal error" to start
      runtime = second.runtime;
      second.fac.close();
      const files = await rotated();
      expect(files).toHaveLength(1);
      expect(await readFile(path.join(dataDir(), files[0]), "utf8")).toBe(oldText);
      const fresh = await readFile(path.join(dataDir(), "local.jsonl"), "utf8");
      expect(fresh.split("\n")[0]).toContain('"seq":1');
      expect(logs.join("\n")).toContain(files[0]);
      expect(logs.join("\n")).not.toContain("session.started");
    });

    it("a rotation name collision gets a numeric suffix", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(dataDir(), "local.jsonl"), "old-a\n");
      const now = () => new Date("2026-10-02T17:45:12Z");
      await writeFile(path.join(dataDir(), "local.20261002T174512Z.jsonl"), "taken\n");
      const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      expect(await readFile(path.join(dataDir(), "local.20261002T174512Z.jsonl"), "utf8")).toBe("taken\n");
      expect(await readFile(path.join(dataDir(), "local.20261002T174512Z-1.jsonl"), "utf8")).toBe("old-a\n");
    });

    it("an empty or missing log file is not rotated", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(dataDir(), "local.jsonl"), "");
      const r = await bootstrap({ env: env(), root: tmp, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      expect(await readdir(dataDir())).toEqual(["local.jsonl"]);
    });
  });
});
