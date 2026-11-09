import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync } from "node:fs";
import path from "node:path";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 3): the command runner, the detached spawn and the process identity of `voice-ops`. Every other
 * module takes these as injected seams (tests fake them); `cli.ts` (Task 7) passes the real ones below.
 *
 * - `realRun`: `spawn`, never a shell, exactly the given environment (REQUIRED, never a default of process.env: review B2 F5; the
 *   command is looked up in ITS `PATH`), a default timeout of
 *   120 s, output capped at 1 MiB per stream. A non-zero exit is a result, not a throw; a run that was killed (the timeout, or the cap)
 *   is `code: null`; a command that cannot be started (ENOENT) throws. Assignable to the `.env` writer's `GitRun`.
 * - `realSpawnDetached`: `spawn` with `detached: true` (its own process group, so a Ctrl-C to the terminal does not reach it), the
 *   given `cwd` and exactly the given environment; **stdout is discarded** (whisper-server may print segment text there, K16) and only
 *   stderr goes to a log opened O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW and set to 0600; `unref()`, so `voice:up` can exit. It
 *   returns the pid and `exited()`, read from the child's handle.
 * - `isOurWhisper`: before `voice:down` signals a recorded pid, all three of: its `ps -o comm=` basename is the one recorded right after
 *   voice:up's own spawn, its `ps -o lstart=` start time (either reading in the repeated autumn hour) is within 5 s of the recorded
 *   `startedAt`, and its `ps -o args=` holds
 *   `--port <port>` as two words. The arguments also hold the STT request path (K14): they are compared and dropped, never printed,
 *   logged or kept. `ps` runs with a fixed PATH (`/usr/bin:/bin`) and the C locale (so `lstart` is in English).
 */

export type SetTimer = (fn: () => void, ms: number) => () => void;
/** Control's shape: the timer is unref'd, so a pending one never keeps the process alive. */
export const realSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

export type RunResult = { code: number | null; stdout: string; stderr: string };
/**
 * `env` is required (review B2 F5): a call that forgets it would hand the child the whole process.env, exported keys included.
 * `signal` (review B2 F6) ends the run with SIGTERM when aborted; the promise still settles only once the child has exited (SIGKILL
 * after RUN_ABORT_GRACE_MS), so a caller never starts its next command while the aborted one runs. `detached` (review B2 F3) runs the
 * child in its own process group, so a Ctrl-C to the terminal's group does not reach it (voice:up's rollback `compose down`).
 */
export type Run = (cmd: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; detached?: boolean }) => Promise<RunResult>;

export const RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const RUN_MAX_OUTPUT_BYTES = 1024 * 1024;
/** How long a child killed by the timeout, the cap or an abort gets after SIGTERM before SIGKILL. */
export const RUN_ABORT_GRACE_MS = 10_000;

/**
 * `spawn` (not `execFile`: it does not pass `detached` on, review B2 F3), never a shell, stdin closed, stdout and stderr collected up
 * to RUN_MAX_OUTPUT_BYTES each. The timeout, the cap and an abort send SIGTERM (SIGKILL after RUN_ABORT_GRACE_MS) and the result is
 * `code: null`; it settles on the child's `close`, i.e. after it has exited.
 */
export const realRun: Run = (cmd, args, o) => new Promise<RunResult>((resolve, reject) => {
  // Never a default of process.env: a caller (or a cast) that leaves env out is refused before anything runs.
  if (o === undefined || o === null || typeof o.env !== "object" || o.env === null) { reject(new Error(`${path.basename(cmd)} needs an explicit environment`)); return; }
  const fail = (code: string): void => reject(new Error(`could not run ${path.basename(cmd)} (${code})`)); // never the command line or a path
  let child: ChildProcess;
  try { child = spawn(cmd, [...args], { env: o.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: o.detached === true }); }
  catch (err) { fail(typeof (err as NodeJS.ErrnoException).code === "string" ? (err as NodeJS.ErrnoException).code! : "error"); return; }
  const bufs = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  const sizes = { stdout: 0, stderr: 0 };
  let killed = false;
  let settled = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (killed) return;
    killed = true;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    grace = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, RUN_ABORT_GRACE_MS);
  };
  for (const name of ["stdout", "stderr"] as const) {
    child[name]?.on("data", (c: Buffer) => {
      const room = RUN_MAX_OUTPUT_BYTES - sizes[name];
      if (room > 0) bufs[name].push(c.length <= room ? c : c.subarray(0, room));
      sizes[name] += c.length;
      if (sizes[name] > RUN_MAX_OUTPUT_BYTES) stop();
    });
  }
  const timer = setTimeout(stop, o.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS);
  const onAbort = (): void => stop();
  if (o.signal?.aborted) stop(); else o.signal?.addEventListener("abort", onAbort, { once: true });
  const done = (): void => { clearTimeout(timer); if (grace) clearTimeout(grace); o.signal?.removeEventListener("abort", onAbort); };
  child.once("error", (err: NodeJS.ErrnoException) => {
    if (settled || child.pid !== undefined) return; // a started child reports through close
    settled = true; done(); fail(typeof err.code === "string" ? err.code : "error");
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true; done();
    const out = { stdout: Buffer.concat(bufs.stdout).toString("utf8"), stderr: Buffer.concat(bufs.stderr).toString("utf8") };
    resolve({ code: killed || code === null ? null : code, ...out });
  });
});

/**
 * `exited()` reads the spawn's own handle (batch 2 review B F5): while it is false the pid is still the child this run started (an
 * unreaped child keeps its pid), so a failed start can signal it directly, without asking `ps` who it is.
 */
export type SpawnedChild = { pid: number; exited: () => boolean };
export type SpawnDetached = (cmd: string, args: readonly string[], o: { logFile: string; env: NodeJS.ProcessEnv; cwd: string }) => SpawnedChild;

export const realSpawnDetached: SpawnDetached = (cmd, args, o) => {
  const fd = openSync(o.logFile, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) throw new Error("the log is not a regular file of this user");
    fchmodSync(fd, 0o600); // an existing log may have been wider; the umask may have narrowed the owner bits
    const child = spawn(cmd, [...args], { detached: true, cwd: o.cwd, env: o.env, stdio: ["ignore", "ignore", fd], windowsHide: true });
    child.on("error", () => { /* reported by the missing pid below; an unhandled 'error' event would crash the CLI */ });
    if (child.pid === undefined) throw new Error(`could not start ${path.basename(cmd)}`);
    let ended = false;
    child.once("exit", () => { ended = true; });
    child.unref();
    return { pid: child.pid, exited: () => ended || child.exitCode !== null || child.signalCode !== null };
  } finally { closeSync(fd); }
};

// ---- process identity ----

/** How far the `ps` start time may be from the recorded `startedAt` (lstart has whole seconds; Linux derives it from boot time). */
export const START_TOLERANCE_MS = 5_000;
const PS_TIMEOUT_MS = 10_000;

function psEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", LC_ALL: "C", ...(process.env.TZ !== undefined ? { TZ: process.env.TZ } : {}) };
}

/** One `ps` answer: the value; "gone" (exit 1 with no output at all: no such process); "unknown" (ps could not answer: review B2 F4). */
type PsAnswer = { value: string } | "gone" | "unknown";

async function psAsk(field: "comm=" | "lstart=" | "args=", pid: number, run: Run): Promise<PsAnswer> {
  if (!Number.isInteger(pid) || pid < 1) return "gone";
  let r: RunResult;
  try { r = await run("ps", ["-o", field, "-p", String(pid)], { env: psEnv(), timeoutMs: PS_TIMEOUT_MS }); } catch { return "unknown"; }
  const v = r.stdout.trim();
  if (r.code === 0) return v === "" ? "unknown" : { value: v };
  if (r.code === 1 && v === "" && r.stderr.trim() === "") return "gone";
  return "unknown";
}

async function ps(field: "comm=" | "lstart=" | "args=", pid: number, run: Run): Promise<string | null> {
  const a = await psAsk(field, pid, run);
  return typeof a === "object" ? a.value : null;
}

/** The basename of `ps -o comm= -p <pid>` (macOS prints the full path, Linux the name), or null for a dead pid or a failed ps. */
export async function readComm(pid: number, run: Run): Promise<string | null> {
  const v = await ps("comm=", pid, run);
  if (v === null) return null;
  const base = v.split("/").pop() ?? "";
  return base === "" ? null : base;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const allDigits = (s: string): boolean => s.length > 0 && [...s].every((c) => c >= "0" && c <= "9");

/**
 * Every instant whose local time is the `ps -o lstart=` text (C locale, `Mon Nov  9 12:00:05 2026`), ascending, or null when it is not
 * exactly that shape. Usually one; TWO in the repeated hour of a change back from summer time (batch 2 review B F6): `new Date(y, m, d,
 * h, mi, s)` picks the earlier offset, so a process started in the second occurrence would read an hour off. The other reading is found
 * by trying the instants up to 3 hours either side in 15-minute steps (every real offset change is a multiple of 15 minutes) and keeping
 * those whose local fields are exactly the parsed ones.
 */
export function lstartCandidates(v: string): number[] | null {
  const t = parseLstart(v);
  if (t === null) return null;
  const want = new Date(t);
  const fields = (d: Date): string => [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].join(",");
  const key = fields(want);
  const out: number[] = [];
  for (let k = -12; k <= 12; k++) { const c = t + k * 15 * 60_000; if (fields(new Date(c)) === key) out.push(c); }
  return out.length > 0 ? out : [t];
}

/** `ps -o lstart=` in the C locale (`Mon Nov  9 12:00:05 2026`, local time) as epoch ms (the earlier reading in an ambiguous hour, see
 * `lstartCandidates`), or null when it is not exactly that shape. */
export function parseLstart(v: string): number | null {
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [, mon, day, time, year] = parts as [string, string, string, string, string];
  const m = MONTHS.indexOf(mon);
  const hms = time.split(":");
  if (m < 0 || !allDigits(day) || !allDigits(year) || year.length !== 4 || hms.length !== 3 || !hms.every((x) => allDigits(x) && x.length === 2)) return null;
  const [h, mi, s] = hms.map(Number) as [number, number, number];
  const d = Number(day);
  if (d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(Number(year), m, d, h, mi, s).getTime();
}

/** `--port <port>` as two consecutive words of the argument line. */
function hasPortWords(args: string, port: number): boolean {
  const words = args.split(/\s+/);
  for (let i = 0; i + 1 < words.length; i++) if (words[i] === "--port" && words[i + 1] === String(port)) return true;
  return false;
}

/**
 * Whether the recorded pid is still the whisper-server `voice:up` started (pid reuse after a crash or a reboot): the comm, the start time
 * within START_TOLERANCE_MS and `--port <port>`. "ours"; "not_ours" for a dead or bad pid or a real mismatch; "unknown" when `ps` could
 * not answer one of the three questions (it threw, timed out or failed: review B2 F4), so a caller never mistakes a ps failure for
 * another program and drops the record of a whisper-server that still runs. Never throws, never logs.
 */
export type WhisperIdentity = "ours" | "not_ours" | "unknown";

export async function isOurWhisper(w: { pid: number; port: number; startedAt: number; comm: string }, run: Run): Promise<WhisperIdentity> {
  const comm = await psAsk("comm=", w.pid, run);
  if (comm === "unknown") return "unknown";
  if (comm === "gone" || (comm.value.split("/").pop() ?? "") !== w.comm) return "not_ours";
  const lstart = await psAsk("lstart=", w.pid, run);
  if (lstart === "unknown") return "unknown";
  const ts = lstart === "gone" ? null : lstartCandidates(lstart.value);
  if (ts === null || !ts.some((t) => Math.abs(t - w.startedAt) <= START_TOLERANCE_MS)) return "not_ours";
  const args = await psAsk("args=", w.pid, run);
  if (args === "unknown") return "unknown";
  return args !== "gone" && hasPortWords(args.value, w.port) ? "ours" : "not_ours";
}
