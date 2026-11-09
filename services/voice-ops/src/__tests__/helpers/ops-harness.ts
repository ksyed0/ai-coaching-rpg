import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpsDeps, PortProbe } from "../../ops.js";
import type { Run, RunResult } from "../../run.js";
import type { HealthAnswer } from "../../whisper.js";

/**
 * US-0072 (A1c Task 7): a fake world for `voiceUp` / `voiceDown` / `voiceCheck` unit tests. Every seam is fake: the command runner
 * (git, docker, ps), the detached spawn (a process table), kill, ports, the clock and timers (a timer advances the fake clock and fires
 * on the next microtask: no real wait), whisper health and warm-up, LiveKit answers, the TLS route and the interrupt. Files are real,
 * in a private temp root: a 0600 `.env`, a model file, the state directory.
 */

export type Call = { cmd: string; args: string[]; env: NodeJS.ProcessEnv | undefined; timeoutMs: number | undefined; signal?: AbortSignal; detached?: boolean };
type RunOpts = Parameters<Run>[2];
export type Proc = { comm: string; startedAt: number; args: string[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number): string => String(n).padStart(2, "0");
/** `ps -o lstart=` in the C locale for a local time. */
export function lstartOf(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`;
}

export type World = ReturnType<typeof makeWorld>;

export function makeWorld(root: string, o: { lan?: boolean; envLines?: string[] } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(root, "w-")));
  const repoRoot = path.join(dir, "repo");
  const home = path.join(dir, "home");
  const stateDir = path.join(dir, "state", "voice");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "packages: []\n");
  const modelFile = path.join(dir, "models", "ggml-small.en.bin");
  mkdirSync(path.dirname(modelFile), { recursive: true });
  writeFileSync(modelFile, Buffer.alloc(1_000_001));
  const certFile = path.join(dir, "tls", "cert.pem");
  const keyFile = path.join(dir, "tls", "key.pem");
  mkdirSync(path.dirname(certFile), { recursive: true });
  writeFileSync(certFile, "placeholder certificate\n");
  writeFileSync(keyFile, "placeholder key\n", { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const envFile = path.join(repoRoot, ".env");
  const lines = [
    "LAUNCHER_TOKEN=placeholder-launcher-token-0123456789abcdef",
    `VOICE_STATE_DIR=${stateDir}`,
    `STT_MODEL_FILE=${modelFile}`,
    ...(o.lan ? ["VOICE_ACCESS=lan", "VOICE_HOSTNAME=voice.pilot.example", `VOICE_TLS_CERT_FILE=${certFile}`, `VOICE_TLS_KEY_FILE=${keyFile}`] : []),
    ...(o.envLines ?? []),
  ];
  writeFileSync(envFile, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(envFile, 0o600);

  const w = {
    dir, repoRoot, home, stateDir, modelFile, certFile, keyFile, envFile,
    clock: 1_800_000_000_000,
    calls: [] as Call[],
    spawns: [] as { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; logFile: string }[],
    out: [] as string[],
    procs: new Map<number, Proc>(),
    nextPid: 4000,
    signals: [] as { pid: number; sig: string }[],
    /** A pid whose signals are refused with EPERM. */
    eperm: new Set<number>(),
    /** Processes that ignore SIGTERM. */
    stubborn: new Set<number>(),
    ports: new Map<string, PortProbe>(),
    portsAsked: [] as string[],
    composeUp: (_o?: RunOpts): Promise<RunResult> | RunResult => ({ code: 0, stdout: "", stderr: "" }),
    composeDown: (_o?: RunOpts): Promise<RunResult> | RunResult => ({ code: 0, stdout: "", stderr: "" }),
    composeVersion: "2.24.0",
    contextHost: "unix:///var/run/docker.sock",
    dockerMissing: false,
    /** `ps` times out (code null): the identity cannot be decided (review B2 F4). */
    psFails: false,
    git: (): RunResult => ({ code: 128, stdout: "", stderr: "" }),
    health: (): HealthAnswer => "ok",
    warm: async (): Promise<void> => {},
    livekit: (): boolean => w.composeIsUp,
    composeIsUp: false,
    tls: (): { authorized: boolean; status: number | null } => ({ authorized: true, status: 404 }),
    tlsAsked: [] as { host: string; port: number; servername: string }[],
    interrupt: null as null | (() => void),
    /** Called on every run/spawn/health step, for tests that interrupt at a chosen moment. */
    onStep: (_step: string): void => {},
    ifaces: (o.lan ? { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: "192.168.1.20/24" }] } : {}) as NodeJS.Dict<os.NetworkInterfaceInfo[]>,
    realEnv: { PATH: "/usr/bin:/bin", HOME: home } as NodeJS.ProcessEnv,
  };

  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
  const kill = (pid: number, sig: NodeJS.Signals | 0): void => {
    if (w.eperm.has(pid)) throw errno("EPERM");
    if (!w.procs.has(pid)) throw errno("ESRCH");
    if (sig === 0) return;
    w.signals.push({ pid, sig });
    if (sig === "SIGKILL" || !w.stubborn.has(pid)) w.procs.delete(pid);
  };

  const run = async (cmd: string, args: readonly string[], ro: RunOpts): Promise<RunResult> => {
    // Review B2 F5: every command gets an explicit environment (realRun refuses one without); a call without it fails the test here.
    if (ro?.env === undefined) throw new Error(`the harness was asked to run ${cmd} without an explicit environment`);
    w.calls.push({ cmd, args: [...args], env: ro.env, timeoutMs: ro.timeoutMs, ...(ro.signal ? { signal: ro.signal } : {}), ...(ro.detached !== undefined ? { detached: ro.detached } : {}) });
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    if (cmd === "git") return w.git();
    if (cmd === "ps") {
      w.onStep("ps");
      if (w.psFails) return { code: null, stdout: "", stderr: "" };
      const pid = Number(args[3]);
      const p = w.procs.get(pid);
      if (!p) return { code: 1, stdout: "", stderr: "" };
      if (args[1] === "comm=") return ok(`/opt/homebrew/bin/${p.comm}\n`);
      if (args[1] === "lstart=") return ok(lstartOf(p.startedAt) + "\n");
      return ok(p.args.join(" ") + "\n");
    }
    if (cmd === "docker") {
      if (w.dockerMissing) throw new Error("could not run docker (ENOENT)");
      if (args[0] === "compose" && args[1] === "version") return ok(w.composeVersion + "\n");
      if (args[0] === "context") return ok(w.contextHost + "\n");
      if (args.includes("up")) { w.onStep("compose-up"); const r = await w.composeUp(ro); if (r.code === 0) w.composeIsUp = true; return r; }
      if (args.includes("down")) { w.onStep("compose-down"); const r = await w.composeDown(ro); if (r.code === 0) w.composeIsUp = false; return r; }
      return ok();
    }
    if (cmd === "tmutil") return ok(`[Excluded]    ${args[1]}\n`);
    return { code: 127, stdout: "", stderr: "" };
  };

  const spawnDetached: OpsDeps["spawnDetached"] = (cmd, args, so) => {
    w.onStep("spawn");
    const pid = w.nextPid++;
    w.spawns.push({ cmd, args: [...args], env: so.env, cwd: so.cwd, logFile: so.logFile });
    w.procs.set(pid, { comm: cmd, startedAt: w.clock, args: [cmd, ...args] });
    return { pid, exited: () => !w.procs.has(pid) };
  };

  const deps = (): OpsDeps => ({
    env: w.realEnv, home, repoRoot, out: (l) => { w.out.push(l); }, run, spawnDetached, kill, pid: process.pid,
    freePort: async () => 23456,
    portFree: async (host, port, proto) => { const k = `${host}:${port}/${proto}`; w.portsAsked.push(k); return w.ports.get(k) ?? "free"; },
    random: (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 37 + n) & 0xff; return b; },
    now: () => w.clock,
    setTimer: (fn, ms) => { let live = true; w.clock += ms; queueMicrotask(() => { if (live) fn(); }); return () => { live = false; }; },
    interfaces: () => w.ifaces,
    onInterrupt: (fn) => { w.interrupt = fn; return () => { w.interrupt = null; }; },
    tlsConnect: async (host, port, servername) => { w.tlsAsked.push({ host, port, servername }); return w.tls(); },
    health: async () => { w.onStep("health"); return w.health(); },
    warm: async () => { w.onStep("warm"); await w.warm(); },
    answers: async () => { w.onStep("answers"); return w.livekit(); },
  });

  return Object.assign(w, {
    deps, kill, run,
    envText: (): string => readFileSync(envFile, "utf8"),
    envBytes: (): Buffer => readFileSync(envFile),
    dockerCalls: (): string[][] => w.calls.filter((c) => c.cmd === "docker").map((c) => c.args),
    composeVerbs: (): string[] => w.calls.filter((c) => c.cmd === "docker" && c.args[0] === "compose" && c.args[1] === "-p").map((c) => (c.args.includes("up") ? "up" : "down")),
    statePath: path.join(stateDir, "state.json"),
  });
}

/** The values the writer appended to `.env` (from the file), for the secret scans. */
export function secretsOf(envText: string): { key: string; secret: string; sttUrl: string; requestPath: string } {
  const get = (n: string): string => { const l = envText.split("\n").find((x) => x.startsWith(`${n}=`)); if (!l) throw new Error(`no ${n}`); return l.slice(n.length + 1); };
  const sttUrl = get("STT_URL");
  return { key: get("LIVEKIT_API_KEY"), secret: get("LIVEKIT_API_SECRET"), sttUrl, requestPath: new URL(sttUrl).pathname };
}

export function privateTmp(prefix: string): { root: string; restore: () => void } {
  const saved = process.env.TMPDIR;
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.env.TMPDIR = root;
  return { root, restore: () => { if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved; } };
}
