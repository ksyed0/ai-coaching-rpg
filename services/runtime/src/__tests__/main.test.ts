import { describe, expect, it, afterEach, vi } from "vitest";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, symlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { bootstrap, type Runtime } from "../main.js";
// Whole-demo and real-process/socket tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Seam: lets a test make linkSync / unlinkSync fail like a bind mount without hard-link support. Passthrough by default.
const fsHooks = vi.hoisted(() => ({ link: null as null | ((src: string, dst: string) => void), unlink: null as null | ((p: string) => void), realUnlink: null as null | ((p: string) => void) }));
vi.mock("node:fs", async (orig) => {
  const actual = await orig<typeof import("node:fs")>();
  fsHooks.realUnlink = actual.unlinkSync;
  return {
    ...actual,
    linkSync: (s: string, d: string) => (fsHooks.link ? fsHooks.link(s, d) : actual.linkSync(s, d)),
    unlinkSync: (p: string) => (fsHooks.unlink ? fsHooks.unlink(p) : actual.unlinkSync(p)),
  };
});
const errno = (code: string) => Object.assign(new Error(code), { code });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null;
afterEach(async () => { fsHooks.link = null; fsHooks.unlink = null; await runtime?.stop(); runtime = null; if (tmp) await rm(tmp, { recursive: true, force: true }); });

describe("bootstrap: facilitator token and limits (US-0017)", () => {
  const TOKEN = "bootstrap-token-0123456789abcdef";
  const base = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "t1", ...extra });
  const join = (port: number, token?: string) => new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify({ type: "join_facilitator", sessionId: "t1", ...(token === undefined ? {} : { token }) })));
    ws.on("message", (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
    ws.on("error", reject);
  });

  it("with no token the server stays open and prints one loud warning that contains no secret", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const warns: string[] = [];
    const r = await bootstrap({ env: base({ ANTHROPIC_API_KEY: "sk-secret-123" }), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: (m) => warns.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect((await join(runtime.port)).type).toBe("joined");
    const open = warns.filter((w) => /FACILITATOR_TOKEN is not set/.test(w));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatch(/^WARNING: /);
    expect(open[0]).not.toContain("\n");
    expect(open[0]).not.toContain("sk-secret-123");
  });

  it("with a token the server requires it, prints no open-server warning and never logs the token", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const warns: string[] = []; const logs: string[] = [];
    const r = await bootstrap({ env: base({ FACILITATOR_TOKEN: TOKEN }), root: tmp, logDir: tmp, tickMs: 50, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect((await join(runtime.port)).code).toBe("unauthorized");
    expect((await join(runtime.port, "wrong-token-0123456789")).code).toBe("unauthorized");
    expect((await join(runtime.port, TOKEN)).type).toBe("joined");
    expect(warns.filter((w) => /FACILITATOR_TOKEN is not set/.test(w))).toHaveLength(0);
    expect(logs.join("\n") + warns.join("\n")).not.toContain(TOKEN);
  });

  it("reads the token from <root>/.env; the real environment wins", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    await writeFile(path.join(tmp, ".env"), `FACILITATOR_TOKEN=${TOKEN}\n`);
    const r = await bootstrap({ env: base(), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: () => {} });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect((await join(runtime.port)).code).toBe("unauthorized");
    expect((await join(runtime.port, TOKEN)).type).toBe("joined");
  });

  it("an invalid token or limit stops startup with errors that name the variable, never the token value", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const secret = "short-secret";
    const r = await bootstrap({ env: base({ FACILITATOR_TOKEN: secret, WS_MSG_RATE: "0", WS_MAX_CONNECTIONS: "many" }), root: tmp, logDir: tmp, log: () => {}, warn: () => {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join("\n");
    expect(text).toContain("FACILITATOR_TOKEN"); expect(text).toContain("WS_MSG_RATE"); expect(text).toContain("WS_MAX_CONNECTIONS");
    expect(text).not.toContain(secret);
  });

  it("an EMPTY real-env FACILITATOR_TOKEN does not switch off the token in .env; a non-empty one wins", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    await writeFile(path.join(tmp, ".env"), `FACILITATOR_TOKEN=${TOKEN}\n`);
    const r = await bootstrap({ env: base({ FACILITATOR_TOKEN: "" }), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: () => {} });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect((await join(runtime.port)).code).toBe("unauthorized");
    expect((await join(runtime.port, TOKEN)).type).toBe("joined");
    await runtime.stop(); runtime = null;
    const other = "a-different-real-env-token-0123456789";
    const r2 = await bootstrap({ env: base({ FACILITATOR_TOKEN: other }), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: () => {} });
    if (!r2.ok) throw new Error(r2.errors.join("; "));
    runtime = r2.runtime;
    expect((await join(runtime.port, TOKEN)).code).toBe("unauthorized");
    expect((await join(runtime.port, other)).type).toBe("joined");
  });

  it("TRUST_PROXY=1 on a non-loopback host warns; on loopback it does not", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const warns: string[] = [];
    const r = await bootstrap({ env: base({ TRUST_PROXY: "1", FACILITATOR_TOKEN: TOKEN }), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: (m) => warns.push(m) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(warns.filter((w) => /TRUST_PROXY=1/.test(w))).toHaveLength(1);
    await runtime.stop(); runtime = null;
    const warns2: string[] = [];
    const r2 = await bootstrap({ env: base({ TRUST_PROXY: "1", RUNTIME_HOST: "127.0.0.1", FACILITATOR_TOKEN: TOKEN }), root: tmp, logDir: tmp, tickMs: 50, log: () => {}, warn: (m) => warns2.push(m) });
    if (!r2.ok) throw new Error(r2.errors.join("; "));
    runtime = r2.runtime;
    expect(warns2.filter((w) => /TRUST_PROXY=1/.test(w))).toHaveLength(0);
  });

  it("RUNTIME_HOST binds that interface", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-"));
    const logs: string[] = [];
    const r = await bootstrap({ env: base({ RUNTIME_HOST: "127.0.0.1" }), root: tmp, logDir: tmp, tickMs: 50, log: (m) => logs.push(m), warn: () => {} });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(logs.join("\n")).toContain("bound to loopback only");
  });
});

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

    it("loads <root>/.env, resolves a relative SCENARIO_DIR and the data dir against the root, (the scenario loaded from it), and logs the provider but no secret or path", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-root-"));
      await cp(fixture, path.join(tmp, "scn"), { recursive: true });
      await writeFile(path.join(tmp, ".env"), "SESSION_ID=fromdotenv\nRUNTIME_PORT=0\nSCENARIO_DIR=scn\nANTHROPIC_API_KEY=sk-from-dotenv\n");
      const logs: string[] = [];
      const r = await bootstrap({ env: {}, root: tmp, tickMs: 50, log: (m) => logs.push(m) });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      const [msg] = await connect(runtime.port, { type: "join_facilitator", sessionId: "fromdotenv" });
      expect(msg.type).toBe("joined");
      expect(logs.join("\n")).toMatch(/scenario "Minimal"/); // the relative SCENARIO_DIR resolved against the root
      expect(logs.join("\n")).not.toContain(tmp);
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

  describe("stale session log rotation (SESSION_START=fresh)", () => {
    // US-0018: rotation is the explicit fresh start (AC-0058); the default resumes a running session (main.resume.test.ts).
    const env = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "local", MODEL_PROVIDER: "mock", SESSION_START: "fresh", ...extra });
    const wsOpen = (port: number) => new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(w)); w.on("error", rej); });
    const waitMsg = (w: WebSocket, pred: (m: any) => boolean) => new Promise<any>((res) => { w.on("message", (d) => { const m = JSON.parse(d.toString()); if (pred(m)) res(m); }); });
    const dataDir = () => path.join(tmp, "data", "sessions");
    const rotated = async () => (await readdir(dataDir()).catch(() => [] as string[])).filter((f) => /^local\.\d{8}T\d{6}Z(-\d+)?\.jsonl$/.test(f));

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

    const now = () => new Date("2026-10-02T17:45:12Z");

    it.each([
      ["../x"], ["../../foo/bar"], ["a/b"], ["."], [".."], [""], ["a".repeat(200)], ["bad\u0000id"], ["line\nbreak"],
    ])("an invalid SESSION_ID %j is refused before any filesystem action, and nothing outside the data dir is moved", async (bad) => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(path.join(tmp, "data", "sessions"), { recursive: true });
      await mkdir(path.join(tmp, "foo"), { recursive: true });
      await writeFile(path.join(tmp, "data", "x.jsonl"), "keep-x\n");
      await writeFile(path.join(tmp, "foo", "bar.jsonl"), "keep-bar\n");
      const before = [(await readdir(path.join(tmp, "data"))).sort(), (await readdir(path.join(tmp, "foo"))).sort()];
      const logs: string[] = [];
      const r = await bootstrap({ env: env({ SESSION_ID: bad }), root: tmp, now, log: (m) => logs.push(m) });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).not.toMatch(/[\u0000-\u001f]/);
      expect(await readFile(path.join(tmp, "data", "x.jsonl"), "utf8")).toBe("keep-x\n");
      expect(await readFile(path.join(tmp, "foo", "bar.jsonl"), "utf8")).toBe("keep-bar\n");
      expect([(await readdir(path.join(tmp, "data"))).sort(), (await readdir(path.join(tmp, "foo"))).sort()]).toEqual(before);
    });

    it("collisions land on the next free suffix and never overwrite an existing file", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(dataDir(), "local.jsonl"), "current\n");
      const taken = ["local.20261002T174512Z.jsonl", "local.20261002T174512Z-1.jsonl", "local.20261002T174512Z-2.jsonl"];
      for (const f of taken) await writeFile(path.join(dataDir(), f), `old ${f}\n`);
      const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      for (const f of taken) expect(await readFile(path.join(dataDir(), f), "utf8")).toBe(`old ${f}\n`);
      expect(await readFile(path.join(dataDir(), "local.20261002T174512Z-3.jsonl"), "utf8")).toBe("current\n");
    });


    describe("copy fallback when hard links are unsupported", () => {
      const now = () => new Date("2026-10-02T17:45:12Z");
      const seed = async (text: string) => { tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-")); await mkdir(dataDir(), { recursive: true }); await writeFile(path.join(dataDir(), "local.jsonl"), text); };

      it.each(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"])("%s from linkSync: rotates by copy, byte-identical, and removes the original", async (code) => {
        await seed("old-bytes\n\u00e9\n");
        fsHooks.link = () => { throw errno(code); };
        const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
        if (!r.ok) throw new Error(r.errors.join("; "));
        runtime = r.runtime;
        expect(await readFile(path.join(dataDir(), "local.20261002T174512Z.jsonl"), "utf8")).toBe("old-bytes\n\u00e9\n");
        expect(await readdir(dataDir())).not.toContain("local.jsonl");
      });

      it("never overwrites an existing target in the fallback path (numeric suffix)", async () => {
        await seed("old-a\n");
        await writeFile(path.join(dataDir(), "local.20261002T174512Z.jsonl"), "taken\n");
        fsHooks.link = () => { throw errno("EPERM"); };
        const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
        if (!r.ok) throw new Error(r.errors.join("; "));
        runtime = r.runtime;
        expect(await readFile(path.join(dataDir(), "local.20261002T174512Z.jsonl"), "utf8")).toBe("taken\n");
        expect(await readFile(path.join(dataDir(), "local.20261002T174512Z-1.jsonl"), "utf8")).toBe("old-a\n");
      });

      it("unlink failing after a successful copy returns ok:false saying a copy exists and the stale file needs manual handling", async () => {
        await seed("old-a\n");
        fsHooks.link = () => { throw errno("EPERM"); };
        fsHooks.unlink = (p) => { if (p.endsWith(".jsonl")) throw errno("EACCES"); fsHooks.realUnlink!(p); }; // the log only (US-0033: the codes file is removed first)
        const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const msg = r.errors.join("\n");
        expect(msg).toContain("local.20261002T174512Z.jsonl");
        expect(msg).toMatch(/copy/i);
        expect(msg).toMatch(/by hand/);
        expect(msg).not.toContain("old-a");
        expect(await readFile(path.join(dataDir(), "local.jsonl"), "utf8")).toBe("old-a\n"); // source untouched
      });

      it("another linkSync error is reported with the dir and code, and nothing is copied", async () => {
        await seed("old-a\n");
        fsHooks.link = () => { throw errno("EIO"); };
        const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.errors.join("\n")).toMatch(/EIO/);
        expect(r.errors.join("\n")).toContain(dataDir());
        expect(await readdir(dataDir())).toEqual(["local.jsonl"]);
      });
    });

    it("a missing log file and a missing data dir are not an error and nothing is rotated", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      expect(await rotated()).toEqual([]);
    });

    it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a rotation failure (read-only data dir) returns ok:false naming the dir and code, never contents", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(dataDir(), "local.jsonl"), "SECRET-CONTENT\n");
      await chmod(dataDir(), 0o555); // skipped as root, which ignores permissions
      try {
        const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.errors.join("\n")).toContain(dataDir());
          expect(r.errors.join("\n")).toMatch(/EACCES|EPERM/);
          expect(r.errors.join("\n")).not.toContain("SECRET-CONTENT");
        }
      } finally { await chmod(dataDir(), 0o755); }
    });

    it("a directory at <id>.jsonl is refused (not renamed)", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(path.join(dataDir(), "local.jsonl"), { recursive: true });
      const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.join("\n")).toMatch(/not a regular file/);
      expect((await lstat(path.join(dataDir(), "local.jsonl"))).isDirectory()).toBe(true);
    });

    it("a symlink at <id>.jsonl is refused and not followed", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(tmp, "target.txt"), "target\n");
      await symlink(path.join(tmp, "target.txt"), path.join(dataDir(), "local.jsonl"));
      const r = await bootstrap({ env: env(), root: tmp, now, log: () => {} });
      expect(r.ok).toBe(false);
      expect((await lstat(path.join(dataDir(), "local.jsonl"))).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(tmp, "target.txt"), "utf8")).toBe("target\n");
    });

    it("an empty or missing log file is not rotated", async () => {
      tmp = await mkdtemp(path.join(os.tmpdir(), "acr-rot-"));
      await mkdir(dataDir(), { recursive: true });
      await writeFile(path.join(dataDir(), "local.jsonl"), "");
      const r = await bootstrap({ env: env(), root: tmp, log: () => {} });
      if (!r.ok) throw new Error(r.errors.join("; "));
      runtime = r.runtime;
      expect((await readdir(dataDir())).filter((f) => !f.endsWith(".lock") && !f.endsWith(".codes.json"))).toEqual(["local.jsonl"]); // the running server holds local.lock (and its join codes file)
    });
  });
});

describe("bootstrap: player join codes (US-0033)", () => {
  const env = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "jc", MODEL_PROVIDER: "mock", ...extra });
  const ask = (port: number, m: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => ws.send(JSON.stringify(m)));
    ws.on("message", (d) => { resolve(JSON.parse(d.toString())); ws.close(); });
    ws.on("error", reject);
  });

  it("test_bootstrap_issues_codes_shows_them_once_outside_the_log_and_requires_them", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-codes-"));
    const logs: string[] = []; const shown: { roleId: string; code: string }[][] = [];
    const r = await bootstrap({ env: env(), root: tmp, logDir: tmp, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), showJoinCodes: (c) => shown.push(c) });
    if (!r.ok) throw new Error(r.errors.join("; "));
    runtime = r.runtime;
    expect(shown).toHaveLength(1);
    expect(shown[0]!.map((c) => c.roleId)).toEqual(["host"]);
    const code = shown[0]![0]!.code;
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const norm = code.replace(/-/g, "");
    expect(logs.join("\n")).not.toContain(norm);
    expect(await readFile(path.join(tmp, "jc.codes.json"), "utf8")).not.toContain(norm);
    expect((await ask(runtime.port, { type: "join", sessionId: "jc", roleId: "host", participantId: "a" })).code).toBe("unauthorized");
    expect((await ask(runtime.port, { type: "join", sessionId: "jc", roleId: "guest", participantId: "a", joinCode: code })).code).toBe("unauthorized");
    expect((await ask(runtime.port, { type: "join", sessionId: "jc", roleId: "host", participantId: "a", joinCode: code })).type).toBe("joined");
    expect((await ask(runtime.port, { type: "join_facilitator", sessionId: "jc" })).type).toBe("joined"); // the facilitator does not need a code
  });

  it("test_bootstrap_restart_keeps_the_codes_without_showing_them_and_fresh_issues_new_ones", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-codes-"));
    const shown: { roleId: string; code: string }[][] = [];
    const show = (c: { roleId: string; code: string }[]) => shown.push(c);
    const a = await bootstrap({ env: env(), root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {}, showJoinCodes: show });
    if (!a.ok) throw new Error(a.errors.join("; "));
    await a.runtime.stop();
    const logs: string[] = [];
    const b = await bootstrap({ env: env(), root: tmp, logDir: tmp, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m), showJoinCodes: show });
    if (!b.ok) throw new Error(b.errors.join("; "));
    expect(shown).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/codes issued earlier for this session still apply/);
    const code = shown[0]![0]!.code;
    expect((await ask(b.runtime.port, { type: "join", sessionId: "jc", roleId: "host", participantId: "a", joinCode: code })).type).toBe("joined");
    await b.runtime.stop();
    const c = await bootstrap({ env: env({ SESSION_START: "fresh" }), root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {}, showJoinCodes: show });
    if (!c.ok) throw new Error(c.errors.join("; "));
    runtime = c.runtime;
    expect(shown).toHaveLength(2);
    expect((await ask(c.runtime.port, { type: "join", sessionId: "jc", roleId: "host", participantId: "a", joinCode: code })).code).toBe("unauthorized");
  });

  it("test_bootstrap_unusable_codes_file_stops_startup_with_a_remedy", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-codes-"));
    await writeFile(path.join(tmp, "jc.codes.json"), "{ broken", { mode: 0o600 });
    const r = await bootstrap({ env: env(), root: tmp, logDir: tmp, log: () => {}, warn: () => {}, showJoinCodes: () => {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/join codes file.*move jc\.codes\.json aside/);
  });

  it("test_printJoinCodes_lists_each_role_once_with_a_hint_and_nothing_else", async () => {
    const { printJoinCodes } = await import("../main.js");
    let out = "";
    printJoinCodes([{ roleId: "delivery_lead", code: "ABCD-EFGH-JKMN" }, { roleId: "tl", code: "0000-1111-2222" }], (t) => { out += t; });
    expect(out).toMatch(/PLAYER JOIN CODES/);
    expect(out).toContain("  delivery_lead  ABCD-EFGH-JKMN\n");
    expect(out).toContain("  tl             0000-1111-2222\n");
    expect(out).toMatch(/JOIN_CODE/);
  });
});
