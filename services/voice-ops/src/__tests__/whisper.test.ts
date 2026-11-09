import { copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { realRun, realSpawnDetached, type Run, type SetTimer, type SpawnDetached } from "../run.js";
import { openStateDir } from "../state.js";
import {
  checkModelFile, healthOf, MIN_MODEL_BYTES, startWhisper, stopWhisper, WHISPER_POLL_MS, WHISPER_READY_WAIT_MS, WHISPER_STOP_GRACE_MS, whisperArgs, whisperEnv,
  whisperHealth, WhisperStartError, whisperWarm, type HealthAnswer,
} from "../whisper.js";

// US-0072 (EPIC-0003 voice A1c, Task 4): starting whisper-server hardened on loopback. The REAL whisper-server is never started here:
// the unit tests fake the spawn, the runner and the timers; the process tests run a node stand-in (fixtures/whisper-server-stub.mjs)
// copied into a private directory as `whisper-server`. No model is downloaded or read: the "model" files are placeholder bytes.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const STUB = fileURLToPath(new URL("./fixtures/whisper-server-stub.mjs", import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL("../..", import.meta.url)); // services/voice-ops: where `--import tsx` resolves
const REQUEST_PATH = "/0123456789abcdef0123456789abcdef"; // fabricated, not a real request path

let root: string;
let savedTmp: string | undefined;
const startedPids: number[] = [];
beforeAll(() => {
  savedTmp = process.env.TMPDIR;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "acr-voice-ops-whisper-")));
  process.env.TMPDIR = root;
});
afterAll(() => {
  for (const pid of startedPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});
const newDir = (): string => mkdtempSync(path.join(root, "d-"));
const fakeRepo = (): string => newDir();
function stateDir(): string { const d = path.join(newDir(), "voice"); openStateDir(d, { repoRoot: fakeRepo() }); return d; }
function modelFile(name = "ggml-small.en.bin", bytes = MIN_MODEL_BYTES): string {
  const f = path.join(newDir(), name);
  writeFileSync(f, Buffer.alloc(bytes, 1));
  return f;
}
const sttUrl = (port = 24680, p = REQUEST_PATH): URL => new URL(`http://127.0.0.1:${port}${p}`);

/** Timers that fire at once (in order, on the next microtask) and advance a fake clock by their delay: no real waiting. */
function autoTimers(): { setTimer: SetTimer; now: () => number; advanced: () => number } {
  let t = 1_000_000;
  const start = t;
  return {
    now: () => t,
    advanced: () => t - start,
    setTimer: (fn, ms) => {
      let cancelled = false;
      void Promise.resolve().then(() => { if (!cancelled) { t += ms; fn(); } });
      return () => { cancelled = true; };
    },
  };
}

/** `ps -o lstart=` text for epoch ms, as `ps` prints it in the C locale. */
function lstartOf(ms: number): string {
  const d = new Date(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

/** A fake system: one process table answering `ps`, and a `kill` that records signals. */
function fakeSystem(o: { comm?: string; ignoreTerm?: boolean; startedAt?: () => number; onTerm?: (p: { comm: string; args: string; start: number; alive: boolean }) => void; eperm?: boolean;
  lstart?: string; refuseSignals?: boolean } = {}) {
  const procs = new Map<number, { comm: string; args: string; start: number; alive: boolean }>();
  const signals: [number, string | 0][] = [];
  const calls: { cmd: string; args: readonly string[] }[] = [];
  let nextPid = 5000;
  const spawnDetached: SpawnDetached & { last?: { cmd: string; args: readonly string[]; o: Parameters<SpawnDetached>[2] } } = (cmd, args, so) => {
    const pid = nextPid++;
    procs.set(pid, { comm: o.comm ?? "whisper-server", args: [cmd, ...args].join(" "), start: o.startedAt?.() ?? Date.now(), alive: true });
    spawnDetached.last = { cmd, args, o: so };
    return { pid, exited: () => !procs.get(pid)!.alive };
  };
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const p = procs.get(Number(args[3]));
    if (cmd !== "ps" || !p || !p.alive) return { code: 1, stdout: "", stderr: "" };
    if (args[1] === "comm=") return { code: 0, stdout: `/opt/homebrew/bin/${p.comm}\n`, stderr: "" };
    if (args[1] === "lstart=") return { code: 0, stdout: `${o.lstart ?? lstartOf(p.start)}\n`, stderr: "" };
    return { code: 0, stdout: `${p.args}\n`, stderr: "" };
  };
  const kill = (pid: number, sig: NodeJS.Signals | 0): void => {
    signals.push([pid, sig]);
    const p = procs.get(pid);
    if (!p || !p.alive) { const e = new Error("no such process") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; }
    if (o.refuseSignals && sig !== 0) { const e = new Error("operation not permitted") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }
    if (o.eperm) { const e = new Error("operation not permitted") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; }
    if (sig === "SIGTERM") o.onTerm?.(p);
    if (sig === "SIGKILL" || (sig === "SIGTERM" && !o.ignoreTerm)) p.alive = false;
  };
  return { procs, signals, calls, spawnDetached, run, kill };
}

describe("whisperArgs and whisperEnv (US-0072, A1c Task 4)", () => {
  it("whisperArgs binds 127.0.0.1, sets the request path, -sns, --public and --tmp-dir, and never --convert", () => {
    const a = whisperArgs({ port: 24680, requestPath: REQUEST_PATH, modelFile: "/m/ggml-small.en.bin", publicDir: "/s/public", tmpDir: "/s/tmp" });
    expect(a).toEqual(["--host", "127.0.0.1", "--port", "24680", "--request-path", REQUEST_PATH, "-m", "/m/ggml-small.en.bin", "-sns", "--public", "/s/public", "--tmp-dir", "/s/tmp"]);
    expect(a).not.toContain("--convert");
    expect(a.filter((x) => x === "--host")).toHaveLength(1);
  });

  // Batch 2 review B F10: `--request-path` is always present for a voice-ops start: an empty path, or one under 16 characters after
  // the leading slash, is refused (whisper-server's CORS header lets any web page that finds the port POST to /inference and /load).
  it("whisperArgs refuses an empty or short request path: --request-path is always present", () => {
    const base = { port: 9000, modelFile: "/m.bin", publicDir: "/p", tmpDir: "/t" };
    for (const requestPath of ["", "/", "/abc", "/abcdefghijklmno"]) expect(() => whisperArgs({ ...base, requestPath }), requestPath).toThrow();
    expect(whisperArgs({ ...base, requestPath: "/abcdefghijklmnop" })).toContain("--request-path");
  });

  it("whisperArgs refuses a port or a path it must not pass", () => {
    const base = { requestPath: REQUEST_PATH, modelFile: "/m.bin", publicDir: "/p", tmpDir: "/t" };
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(() => whisperArgs({ ...base, port }), String(port)).toThrow();
    for (const requestPath of ["abc", "/a//b", "/a b", "-x"]) expect(() => whisperArgs({ ...base, port: 9000, requestPath }), requestPath).toThrow();
    for (const k of ["modelFile", "publicDir", "tmpDir"] as const) expect(() => whisperArgs({ ...base, port: 9000, [k]: "relative" }), k).toThrow();
  });

  it("whisperEnv holds exactly PATH and HOME", () => {
    const env = whisperEnv({ PATH: "/usr/bin", HOME: "/h", LIVEKIT_API_SECRET: "s".repeat(40), STT_URL: "http://127.0.0.1:1/x", NODE_OPTIONS: "--require x", DYLD_INSERT_LIBRARIES: "/x" });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h" });
    expect(whisperEnv({})).toEqual({});
  });
});

describe("checkModelFile (US-0072, A1c Task 4)", () => {
  it("accepts a model file and a symlink to one", () => {
    const f = modelFile();
    expect(checkModelFile(f, "small.en")).toEqual({ ok: true });
    const link = path.join(newDir(), "ggml-small.en.bin");
    symlinkSync(f, link);
    expect(checkModelFile(link, "small.en")).toEqual({ ok: true });
  });

  it("refuses a missing file, a directory and a 10-byte file", () => {
    const dir = newDir();
    for (const f of [path.join(dir, "ggml-small.en.bin"), dir, modelFile("ggml-small.en.bin", 10)]) {
      const r = checkModelFile(f, "small.en");
      expect(r.ok, f).toBe(false);
    }
  });

  it("warns when the file name does not contain the label", () => {
    const r = checkModelFile(modelFile("ggml-large.bin"), "small.en");
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toContain("STT_MODEL");
  });

  it("the missing-model error tells how to obtain one and never mentions a download by voice:up", () => {
    const f = path.join(newDir(), "secret-folder-name", "ggml-small.en.bin");
    const r = checkModelFile(f, "small.en");
    expect(r.ok).toBe(false);
    const msg = r.ok ? "" : r.error;
    expect(msg).toContain("STT_MODEL_FILE");
    expect(msg).toContain("never downloads");
    expect(msg).toContain("ggml");
    expect(msg).not.toContain("secret-folder-name"); // names the variable, never the path
    expect(msg.toLowerCase()).not.toMatch(/will download|downloading|curl|wget|https?:/);
  });
});

describe("healthOf (US-0072, A1c Task 4)", () => {
  it("reads the answer table", () => {
    const table: [number | null, string, HealthAnswer][] = [
      [200, '{"status":"ok"}', "ok"], [503, '{"status":"loading model"}', "loading"], [200, '{"status":"loading model"}', "loading"],
      [500, '{"status":"ok"}', "down"], [404, "not found", "down"], [200, "not json", "down"], [200, '{"status":"other"}', "down"], [null, "", "down"],
    ];
    for (const [status, body, want] of table) expect(healthOf(status, body), `${status} ${body}`).toBe(want);
  });
});

describe("startWhisper and stopWhisper, with fakes (US-0072, A1c Task 4)", () => {
  function setup(o: { health: () => Promise<HealthAnswer>; warm?: () => Promise<void>; sys?: ReturnType<typeof fakeSystem>; signal?: AbortSignal; url?: URL }) {
    const timers = autoTimers();
    const sys = o.sys ?? fakeSystem({ startedAt: () => timers.now() });
    const order: string[] = [];
    const dir = stateDir();
    const p = startWhisper({
      spawnDetached: sys.spawnDetached, run: sys.run, kill: sys.kill, env: { PATH: "/usr/bin:/bin", HOME: "/h", LIVEKIT_API_KEY: "APIplaceholder" },
      stateDir: dir, sttUrl: o.url ?? sttUrl(), modelFile: "/m/ggml-small.en.bin",
      health: async () => { order.push("health"); return o.health(); }, warm: async () => { order.push("warm"); await (o.warm ?? (async () => {}))(); },
      setTimer: timers.setTimer, now: timers.now, onStarted: (w) => { order.push(`started:${w.comm}`); }, ...(o.signal ? { signal: o.signal } : {}),
    });
    return { p, sys, order, dir, timers };
  }
  const startError = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (e) { if (e instanceof WhisperStartError) return e.code; throw e; }
    throw new Error("expected a WhisperStartError");
  };

  it("startWhisper spawns in the state directory with whisperEnv, stdout discarded and stderr to whisper.log", async () => {
    const { p, sys, dir } = setup({ health: async () => "ok" });
    await p;
    const last = sys.spawnDetached.last!;
    expect(last.cmd).toBe("whisper-server");
    expect(last.o.cwd).toBe(dir);
    expect(last.o.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/h" });
    expect(last.o.logFile).toBe(path.join(dir, "whisper.log"));
    expect(last.args).toEqual(whisperArgs({ port: 24680, requestPath: REQUEST_PATH, modelFile: "/m/ggml-small.en.bin", publicDir: path.join(dir, "public"), tmpDir: path.join(dir, "tmp") }));
    expect(statSync(path.join(dir, "public")).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "tmp")).mode & 0o777).toBe(0o700);
  });

  it("onStarted runs before the first health poll, with the comm read right after the spawn", async () => {
    const { p, order } = setup({ health: async () => "ok" });
    await p;
    expect(order).toEqual(["started:whisper-server", "health", "warm"]);
  });

  // Review B2 F7: the record is handed over synchronously after the spawn (comm = whisper-server), then refined when ps says otherwise.
  it("onStarted runs before the first ps call, and again with the comm ps reads when it differs", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), comm: "whisper-server-1.9" });
    const order: string[] = [];
    const run: Run = async (cmd, args, o) => { order.push(`ps:${args[1]}`); return sys.run(cmd, args, o); };
    await startWhisper({
      spawnDetached: sys.spawnDetached, run, kill: sys.kill, env: {}, stateDir: stateDir(), sttUrl: sttUrl(), modelFile: "/m.bin",
      health: async () => "ok", warm: async () => {}, setTimer: timers.setTimer, now: timers.now, onStarted: (w) => { order.push(`started:${w.comm}`); },
    });
    expect(order).toEqual(["started:whisper-server", "ps:comm=", "started:whisper-server-1.9"]);
  });

  it("waits through loading and warms once ok", async () => {
    const answers: HealthAnswer[] = ["down", "loading", "loading", "ok"];
    const { p, order, timers } = setup({ health: async () => answers.shift() ?? "ok" });
    const r = await p;
    expect(r.pid).toBeGreaterThan(0);
    expect(order.filter((x) => x === "health")).toHaveLength(4);
    expect(order.filter((x) => x === "warm")).toHaveLength(1);
    expect(timers.advanced()).toBe(3 * WHISPER_POLL_MS);
  });

  it("gives up after WHISPER_READY_WAIT_MS and stops the process", async () => {
    const { p, sys, timers } = setup({ health: async () => "loading" });
    expect(await startError(p)).toBe("not_ready");
    expect(timers.advanced()).toBeGreaterThanOrEqual(WHISPER_READY_WAIT_MS);
    expect(sys.signals.some(([, s]) => s === "SIGTERM")).toBe(true);
    expect([...sys.procs.values()].every((x) => !x.alive)).toBe(true);
  });

  // Batch 2 review B F5: a failed start stops the process THIS run spawned through the spawn's own handle (`exited()`), not through
  // `ps`: with a `ps` that cannot parse lstart, the old path called it "not ours", left it running and still said "it was stopped".
  it("a failed start stops its own process even when ps cannot read its start time", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), lstart: "garbage" });
    const { p } = setup({ sys, health: async () => "loading" });
    expect(await startError(p)).toBe("not_ready");
    expect(sys.signals.some(([, s]) => s === "SIGTERM")).toBe(true);
    expect([...sys.procs.values()].every((x) => !x.alive)).toBe(true);
  });

  it("a failed start whose process cannot be stopped says so instead of claiming it was stopped", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), refuseSignals: true });
    const { p } = setup({ sys, health: async () => "ok", warm: async () => { throw new Error("boom"); } });
    let err: unknown;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WhisperStartError);
    expect((err as WhisperStartError).code).toBe("not_stopped");
    expect((err as WhisperStartError).after).toBe("warm_failed");
    expect((err as Error).message).toContain("could not be stopped");
    expect((err as Error).message).toContain("stop it by hand");
    expect((err as Error).message).not.toContain("it was stopped");
    expect([...sys.procs.values()].some((x) => x.alive)).toBe(true);
  });

  it("a process whose comm cannot be read right after the spawn is stopped through its handle", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now() });
    const run: Run = async (cmd, args, o) => (args[1] === "comm=" ? { code: 1, stdout: "", stderr: "" } : sys.run(cmd, args, o));
    const dir = stateDir();
    await expect(startWhisper({
      spawnDetached: sys.spawnDetached, run, kill: sys.kill, env: {}, stateDir: dir, sttUrl: sttUrl(), modelFile: "/m.bin",
      health: async () => "ok", warm: async () => {}, setTimer: timers.setTimer, now: timers.now, onStarted: () => {},
    })).rejects.toMatchObject({ code: "exited" });
    expect([...sys.procs.values()].every((x) => !x.alive)).toBe(true);
  });

  it("a warm-up failure stops the process", async () => {
    const { p, sys } = setup({ health: async () => "ok", warm: async () => { throw new Error("boom"); } });
    expect(await startError(p)).toBe("warm_failed");
    expect([...sys.procs.values()].every((x) => !x.alive)).toBe(true);
  });

  it("a process that dies during the wait is reported as exited", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now() });
    let n = 0;
    const { p } = setup({ sys, health: async () => { n += 1; if (n === 2) for (const x of sys.procs.values()) x.alive = false; return "down"; } });
    expect(await startError(p)).toBe("exited");
  });

  it("an abort during the health wait stops the process (the SIGINT rollback of Task 7)", async () => {
    const ac = new AbortController();
    let n = 0;
    const { p, sys } = setup({ signal: ac.signal, health: async () => { n += 1; if (n === 3) ac.abort(); return "loading"; } });
    expect(await startError(p)).toBe("interrupted");
    expect([...sys.procs.values()].every((x) => !x.alive)).toBe(true);
  });

  it("refuses an STT_URL whisper-server cannot serve, before spawning", async () => {
    for (const u of [new URL("http://[::1]:9000/abc"), new URL("http://127.0.0.1:9000/a%20b"), new URL("http://127.0.0.1:9000"), new URL("http://127.0.0.1:9000/abcdefghijklmno")]) {
      const { p, sys } = setup({ url: u, health: async () => "ok" });
      expect(await startError(p)).toBe("bad_url");
      expect(sys.spawnDetached.last).toBeUndefined();
    }
  });

  it("refuses a public folder that is not empty, before spawning", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now() });
    const dir = stateDir();
    mkdirSync(path.join(dir, "public"), { mode: 0o700 });
    writeFileSync(path.join(dir, "public", "x.html"), "x");
    await expect(startWhisper({
      spawnDetached: sys.spawnDetached, run: sys.run, kill: sys.kill, env: {}, stateDir: dir, sttUrl: sttUrl(), modelFile: "/m.bin",
      health: async () => "ok", warm: async () => {}, setTimer: timers.setTimer, now: timers.now, onStarted: () => {},
    })).rejects.toThrow(/public folder/);
    expect(sys.spawnDetached.last).toBeUndefined();
  });

  it("stopWhisper sends SIGTERM and returns stopped", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now() });
    const { pid } = sys.spawnDetached("whisper-server", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    const r = await stopWhisper({ pid, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, { run: sys.run, kill: sys.kill, setTimer: timers.setTimer, graceMs: WHISPER_STOP_GRACE_MS });
    expect(r).toBe("stopped");
    expect(sys.signals.filter(([, s]) => s !== 0).map(([, s]) => s)).toEqual(["SIGTERM"]);
  });

  it("stopWhisper sends SIGKILL after graceMs when SIGTERM is ignored", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), ignoreTerm: true });
    const { pid } = sys.spawnDetached("whisper-server", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    const r = await stopWhisper({ pid, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, { run: sys.run, kill: sys.kill, setTimer: timers.setTimer, graceMs: 2000 });
    expect(r).toBe("stopped");
    expect(sys.signals.filter(([, s]) => s !== 0).map(([, s]) => s)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(timers.advanced()).toBeGreaterThanOrEqual(2000);
  });

  // Batch 2 review B F4: surviving mutations.
  it("stopWhisper never SIGKILLs a pid whose process became another program during the grace period", async () => {
    const timers = autoTimers();
    // SIGTERM is ignored, and meanwhile the pid belongs to another program (it exited and the pid was reused): no SIGKILL.
    const sys = fakeSystem({ startedAt: () => timers.now(), ignoreTerm: true, onTerm: (p) => { p.comm = "bash"; p.args = "bash --port 24680"; } });
    const { pid } = sys.spawnDetached("whisper-server", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    const r = await stopWhisper({ pid, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, { run: sys.run, kill: sys.kill, setTimer: timers.setTimer, graceMs: 1000 });
    expect(r).toBe("stopped");
    expect(sys.signals.filter(([, s]) => s !== 0).map(([, s]) => s)).toEqual(["SIGTERM"]);
  });

  it("stopWhisper counts a pid it may not signal (EPERM: another user's process) as alive and not ours, never as gone", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), comm: "sshd", eperm: true });
    const { pid } = sys.spawnDetached("sshd", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    const r = await stopWhisper({ pid, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, { run: sys.run, kill: sys.kill, setTimer: timers.setTimer, graceMs: 1000 });
    expect(r).toBe("not_ours");
    expect(sys.signals.filter(([, s]) => s !== 0)).toEqual([]);
  });

  it("stopWhisper never signals a pid that is not ours, and reports a gone one", async () => {
    const timers = autoTimers();
    const sys = fakeSystem({ startedAt: () => timers.now(), comm: "bash" });
    const { pid } = sys.spawnDetached("bash", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    const opts = { run: sys.run, kill: sys.kill, setTimer: timers.setTimer, graceMs: 1000 };
    expect(await stopWhisper({ pid, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, opts)).toBe("not_ours");
    expect(sys.signals.filter(([, s]) => s !== 0)).toEqual([]);
    expect(await stopWhisper({ pid: 999_999, port: 24680, startedAt: timers.now(), comm: "whisper-server" }, opts)).toBe("gone");
    // a recorded start time far from the real one (pid reuse after a reboot) is not ours either
    const sys2 = fakeSystem({ startedAt: () => timers.now() });
    const { pid: pid2 } = sys2.spawnDetached("whisper-server", ["--port", "24680"], { logFile: "/x", env: {}, cwd: "/" });
    expect(await stopWhisper({ pid: pid2, port: 24680, startedAt: timers.now() - 3_600_000, comm: "whisper-server" }, { ...opts, run: sys2.run, kill: sys2.kill })).toBe("not_ours");
    expect(sys2.signals.filter(([, s]) => s !== 0)).toEqual([]);
  });
});

describe("whisperHealth and whisperWarm against a loopback server (US-0072, A1c Task 4)", () => {
  async function server(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void>; seen: string[] }> {
    const seen: string[] = [];
    const s = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); handler(req, res); });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return { port: (s.address() as net.AddressInfo).port, seen, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
  }

  it("whisperHealth reads ok and loading under the request path", async () => {
    let n = 0;
    const s = await server((_req, res) => { n += 1; res.writeHead(n === 1 ? 503 : 200); res.end(n === 1 ? '{"status":"loading model"}' : '{"status":"ok"}'); });
    try {
      expect(await whisperHealth(sttUrl(s.port))).toBe("loading");
      expect(await whisperHealth(sttUrl(s.port))).toBe("ok");
      expect(s.seen).toEqual([`GET ${REQUEST_PATH}/health`, `GET ${REQUEST_PATH}/health`]);
    } finally { await s.close(); }
  });

  it("whisperHealth is down for a closed port, an aborted request and a non-loopback URL", async () => {
    const s = await server(() => { /* never answers */ });
    const port = s.port;
    try {
      const ac = new AbortController();
      const p = whisperHealth(sttUrl(port), { timeout: () => ac.signal });
      await vi.waitFor(() => { expect(s.seen).toHaveLength(1); });
      ac.abort();
      expect(await p).toBe("down");
    } finally { await s.close(); }
    expect(await whisperHealth(sttUrl(port))).toBe("down");
    expect(await whisperHealth(new URL("http://192.168.1.20:9000/x"))).toBe("down");
    expect(await whisperHealth(new URL("http://localhost:9000/x"))).toBe("down");
  });

  it("whisperWarm posts one multipart segment to <path>/inference and resolves on 200", async () => {
    let body = "";
    let type = "";
    const s = await server((req, res) => { type = String(req.headers["content-type"]); req.setEncoding("latin1"); req.on("data", (d: string) => { body += d; }); req.on("end", () => { res.writeHead(200); res.end("{}"); }); });
    try {
      await whisperWarm(sttUrl(s.port));
      expect(s.seen).toEqual([`POST ${REQUEST_PATH}/inference`]);
      expect(type).toMatch(/^multipart\/form-data; boundary=/);
      expect(body).toContain('name="file"; filename="segment.wav"');
      expect(body).toContain("RIFF");
      expect(body).toContain('name="response_format"');
    } finally { await s.close(); }
  });

  it("whisperWarm rejects a non-2xx answer with a message that names no URL", async () => {
    const s = await server((req, res) => { req.resume(); req.on("end", () => { res.writeHead(500); res.end(); }); });
    try {
      const err = await whisperWarm(sttUrl(s.port)).then(() => null, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).not.toContain(REQUEST_PATH.slice(1));
      expect(err!.message).not.toContain(String(s.port));
    } finally { await s.close(); }
  });

  // Batch 2 review B F2: Node configures the env proxy (NODE_USE_ENV_PROXY + HTTP_PROXY) at START-UP, so setting the variables inside
  // this process proves nothing. A child Node started with both runs the real probes (through tsx, as the CLI does); the proxy must see
  // neither. The child's own default-agent request is the self-check that the env proxy is live on this Node (22.21 and later).
  it("whisperHealth and whisperWarm never go through an environment proxy (a child Node started with the proxy on)", async () => {
    const proxy = await server((req, res) => { req.resume(); res.writeHead(502); res.end(); });
    const target = await server((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200); res.end('{"status":"ok"}'); }); });
    const whisperFile = pathToFileURL(fileURLToPath(new URL("../whisper.ts", import.meta.url))).href;
    const dir = newDir();
    const script = path.join(dir, "probe.mts");
    const url = `http://127.0.0.1:${target.port}${REQUEST_PATH}`;
    writeFileSync(script, `
      import http from "node:http";
      const { whisperHealth, whisperWarm } = await import(${JSON.stringify(whisperFile)});
      const health = await whisperHealth(new URL(${JSON.stringify(url)}));
      let warmed = true;
      try { await whisperWarm(new URL(${JSON.stringify(url)})); } catch { warmed = false; }
      await new Promise((r) => { const q = http.get(${JSON.stringify(`http://127.0.0.1:${target.port}/selfcheck`)}, (res) => { res.resume(); res.on("end", r); }); q.on("error", r); });
      process.stdout.write(JSON.stringify({ health, warmed }));
      process.exit(0);`);
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const env = { PATH: process.env.PATH ?? "", HOME: dir, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" };
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--import", "tsx", script], { env, cwd: PACKAGE_DIR, timeout: 60_000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(`child failed: ${String(stderr).slice(0, 500)}`)); else resolve(String(stdout));
        });
      });
      expect(JSON.parse(out)).toEqual({ health: "ok", warmed: true });
      expect(target.seen).toContain(`GET ${REQUEST_PATH}/health`);
      expect(target.seen).toContain(`POST ${REQUEST_PATH}/inference`);
      expect(proxy.seen.filter((u) => u.includes(REQUEST_PATH.slice(1)))).toEqual([]);
      const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
      if (major > 22 || (major === 22 && minor >= 21)) expect(proxy.seen.some((u) => u.includes("selfcheck"))).toBe(true); // the env proxy was live
    } finally { await proxy.close(); await target.close(); }
  });
});

describe("startWhisper with the whisper-server stub, real processes (US-0072, A1c Task 4)", () => {
  /** The stub copied as `whisper-server` into a private bin directory, its shebang this Node, mode 755, with its config beside it. */
  function installStub(config: Record<string, unknown>): string {
    const bin = newDir();
    const target = path.join(bin, "whisper-server");
    copyFileSync(STUB, target);
    const text = readFileSync(target, "utf8").split("\n");
    text[0] = `#!${process.execPath}`; // an absolute interpreter: one exec, so the comm read right after the spawn is final
    writeFileSync(target, text.join("\n"));
    chmodSync(target, 0o755);
    writeFileSync(path.join(bin, "stub-config.json"), JSON.stringify(config));
    return bin;
  }
  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
  }
  const realTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
  const get = (port: number, p: string): Promise<number> => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", () => resolve(0));
    req.end();
  });

  it("starts the stub with the exact arguments; it answers under the request path only; its stdout marker is not in whisper.log", async () => {
    const marker = `MARKER-${process.pid}-STDOUT`;
    const bin = installStub({ loadingPolls: 2, stdoutMarker: marker });
    const home = newDir();
    const dir = stateDir();
    const port = await freePort();
    const url = sttUrl(port);
    const model = modelFile();
    let record: { pid: number; startedAt: number; comm: string } | undefined;
    const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LIVEKIT_API_SECRET: "placeholder-secret-".padEnd(40, "x") };
    const { pid } = await startWhisper({
      spawnDetached: realSpawnDetached, run: realRun, kill: (p, s) => { process.kill(p, s); }, env, stateDir: dir, sttUrl: url, modelFile: model,
      health: () => whisperHealth(url), warm: () => whisperWarm(url), setTimer: realTimer, now: Date.now, onStarted: (w) => { record = w; startedPids.push(w.pid); },
    });
    expect(record?.pid).toBe(pid);
    const seen = JSON.parse(readFileSync(path.join(bin, "stub-record.json"), "utf8")) as { argv: string[]; cwd: string; envNames: string[] };
    expect(seen.argv).toEqual(whisperArgs({ port, requestPath: REQUEST_PATH, modelFile: model, publicDir: path.join(dir, "public"), tmpDir: path.join(dir, "tmp") }));
    expect(seen.argv).not.toContain("--convert");
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir));
    expect(seen.envNames.filter((n) => n !== "__CF_USER_TEXT_ENCODING")).toEqual(["HOME", "PATH"]); // macOS adds that one in-process
    expect(await get(port, `${REQUEST_PATH}/health`)).toBe(200);
    expect(await get(port, "/health")).toBe(404);
    expect(await get(port, "/")).toBe(404);
    const log = path.join(dir, "whisper.log");
    await vi.waitFor(() => { expect(readFileSync(log, "utf8")).toContain("inference answered"); }, { timeout: 60_000, interval: 50 });
    expect(readFileSync(log, "utf8")).not.toContain(marker);
    expect(statSync(log).mode & 0o777).toBe(0o600);
    const stopped = await stopWhisper({ pid, port, startedAt: record!.startedAt, comm: record!.comm }, { run: realRun, kill: (p, s) => { process.kill(p, s); }, setTimer: realTimer, graceMs: WHISPER_STOP_GRACE_MS });
    expect(stopped).toBe("stopped");
    await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 60_000, interval: 50 });
    expect(existsSync(path.join(dir, "public"))).toBe(true);
  });
});
