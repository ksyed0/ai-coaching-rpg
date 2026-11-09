import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { encodeWav } from "@acr/adapters";
import { isLongRequestPath, sttRequestPath } from "./env-file.js";
import { isOurWhisper, readComm, type Run, type SetTimer, type SpawnDetached, type SpawnedChild } from "./run.js";
import { openPrivateSubdir, type WhisperRecord } from "./state.js";
import { isRequestPath } from "./text.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 4): starting whisper.cpp's `whisper-server` 1.9.5 natively, hardened, on loopback.
 *
 * - Always `whisper-server --host 127.0.0.1 --port <port> --request-path /<path> -m <STT_MODEL_FILE> -sns --public <empty 0700
 *   folder> --tmp-dir <state>/tmp`: fixed arguments only, **never `--convert`** (it would run ffmpeg on uploaded files); nothing here
 *   calls `/load`. The port and the request path come from the merged view control reads (`loadRootEnv`, Task 7). `whisperArgs` is the
 *   ONLY argument list that may hold the request path (K14: whisper-server has no other way to set it, so local processes can read it
 *   with `ps`; it guards against browser-origin and DNS-rebinding requests only).
 * - The process runs with `cwd` = the state directory, an environment of exactly PATH and HOME (`whisperEnv`), stdout DISCARDED (it
 *   may print segment text, K16) and only stderr appended to the private `<state>/whisper.log` (`realSpawnDetached`).
 * - The model file is never downloaded: `checkModelFile` refuses without it and says how to obtain one.
 * - Health: a GET of `<STT_URL>/health` through `node:http` with a fresh agent (never `fetch` or the global agent, which would follow
 *   NODE_USE_ENV_PROXY to a proxy and hand it the URL with its secret path: review A F10), loopback 127.0.0.1 only. A model loads
 *   slowly and a local model may be cold after 15 minutes idle (owner preference), so the waits are generous (120 s each) and run on
 *   the injected clock and timers.
 *
 * Nothing here prints, logs or puts in an error the STT URL, its path or the model path.
 */

export const WHISPER_BINARY = "whisper-server";
/** The health wait (a large model loads slowly). */
export const WHISPER_READY_WAIT_MS = 120_000;
export const WHISPER_POLL_MS = 500;
/** The first inference can be cold (owner preference: generous). */
export const WHISPER_WARM_TIMEOUT_MS = 120_000;
/** How long `stopWhisper` waits after SIGTERM before SIGKILL. */
export const WHISPER_STOP_GRACE_MS = 5_000;
export const WHISPER_STOP_POLL_MS = 100;
export const MIN_MODEL_BYTES = 1_000_000;
const MAX_HEALTH_BODY_BYTES = 4096;

export const MISSING_MODEL_SENTENCE =
  "No speech model at STT_MODEL_FILE. pnpm voice:up never downloads one: get a whisper.cpp ggml model (for example ggml-small.en.bin from the whisper.cpp project's model list), put it outside the repository and set STT_MODEL_FILE to its absolute path.";

/** The model file: a regular file (a symlink to one is fine) of at least MIN_MODEL_BYTES. A name without the label is only a warning. */
export function checkModelFile(file: string, label: string): { ok: true; warning?: string } | { ok: false; error: string } {
  let st: ReturnType<typeof statSync>;
  try { st = statSync(file); } catch { return { ok: false, error: MISSING_MODEL_SENTENCE }; }
  if (!st.isFile() || st.size < MIN_MODEL_BYTES) return { ok: false, error: MISSING_MODEL_SENTENCE };
  if (!path.basename(file).includes(label)) return { ok: true, warning: "the STT_MODEL_FILE name does not contain the STT_MODEL label: check that the file is the model STT_MODEL names" };
  return { ok: true };
}

const isPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * whisper-server's exact argument list. `--request-path` is always present (batch 2 review B F10): an empty path, or one under
 * MIN_STT_PATH_CHARS characters, is refused, because whisper-server's CORS header lets any web page that finds the port POST to
 * /inference and /load. (The omit-when-empty branch of K2 had no other caller and is gone.) Throws (a programming error of the
 * caller: `.env` and `startWhisper` refuse such a value first) for a port, path or folder that must not be passed.
 */
export function whisperArgs(o: { port: number; requestPath: string; modelFile: string; publicDir: string; tmpDir: string }): string[] {
  if (!isPort(o.port)) throw new Error("whisper-server needs a port from 1 to 65535");
  if (!isLongRequestPath(o.requestPath) || o.requestPath.endsWith("/") || !isRequestPath(o.requestPath)) throw new Error("whisper-server needs a request path of the STT_URL rule");
  for (const p of [o.modelFile, o.publicDir, o.tmpDir]) if (!path.isAbsolute(p)) throw new Error("whisper-server needs absolute paths");
  return [
    "--host", "127.0.0.1", "--port", String(o.port),
    "--request-path", o.requestPath,
    "-m", o.modelFile, "-sns", "--public", o.publicDir, "--tmp-dir", o.tmpDir,
  ];
}

/** Exactly PATH and HOME of `parent` (the ones that are set): no key, no STT_URL, no NODE_OPTIONS or loader variable reaches it. */
export function whisperEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (parent.PATH !== undefined) env.PATH = parent.PATH;
  if (parent.HOME !== undefined) env.HOME = parent.HOME;
  return env;
}

export type HealthAnswer = "ok" | "loading" | "down";

/** 200 with `{"status":"ok"}` is ok; any answer whose body says "loading model" is loading (its status is not verified, R7); else down. */
export function healthOf(status: number | null, body: string): HealthAnswer {
  if (status === null) return "down";
  if (body.includes("loading model")) return "loading";
  if (status !== 200) return "down";
  try { return (JSON.parse(body) as { status?: unknown }).status === "ok" ? "ok" : "down"; } catch { return "down"; }
}

export type WhisperStartErrorCode = "not_ready" | "warm_failed" | "exited" | "interrupted" | "bad_url" | "spawn_failed" | "not_stopped";
const START_SENTENCES: Record<WhisperStartErrorCode, string> = {
  not_ready: `whisper-server did not report ready within ${WHISPER_READY_WAIT_MS / 1000} s: it was stopped; see whisper.log in VOICE_STATE_DIR`,
  warm_failed: "whisper-server did not answer the warm-up request: it was stopped; see whisper.log in VOICE_STATE_DIR",
  exited: "whisper-server exited while starting: see whisper.log in VOICE_STATE_DIR (a wrong model file, or the port is taken)",
  interrupted: "interrupted while whisper-server was starting: it was stopped",
  bad_url: "STT_URL is not one whisper-server can serve: http://127.0.0.1:<port>/<path of at least 16 characters> (it binds 127.0.0.1 only)",
  spawn_failed: "whisper-server could not be started: install whisper.cpp (brew install whisper-cpp) so whisper-server is on PATH",
  not_stopped: "whisper-server failed to start and the process could not be stopped: stop it by hand and remove the state file (state.json in VOICE_STATE_DIR), then pnpm voice:up",
};
/** `code` says what happened; for `not_stopped`, `after` says why the start had failed before the stop failed too. */
export class WhisperStartError extends Error {
  constructor(readonly code: WhisperStartErrorCode, readonly after?: WhisperStartErrorCode) {
    super(START_SENTENCES[code]);
    this.name = "WhisperStartError";
  }
}

type Kill = (pid: number, sig: NodeJS.Signals | 0) => void;

/**
 * Stops a whisper-server THIS run spawned, through the spawn's handle (batch 2 review B F5): while `exited()` is false the pid is still
 * that child, so it is signalled directly (SIGTERM, then SIGKILL after `graceMs`), with no `ps` identity check that could fail and
 * leave it running. "not_stopped" when a signal is refused (anything but ESRCH). For a pid read back from the state file (no handle),
 * use `stopWhisper`.
 */
export async function stopSpawned(child: SpawnedChild, o: { kill: Kill; setTimer: SetTimer; graceMs: number }): Promise<"stopped" | "not_stopped"> {
  const send = (sig: NodeJS.Signals): "sent" | "gone" | "refused" => {
    try { o.kill(child.pid, sig); return "sent"; }
    catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "refused"; }
  };
  if (child.exited()) return "stopped";
  const term = send("SIGTERM");
  if (term !== "sent") return term === "gone" ? "stopped" : "not_stopped";
  for (let waited = 0; waited < o.graceMs; waited += WHISPER_STOP_POLL_MS) {
    if (child.exited()) return "stopped";
    await sleep(o.setTimer, WHISPER_STOP_POLL_MS);
  }
  if (child.exited()) return "stopped";
  return send("SIGKILL") === "refused" ? "not_stopped" : "stopped";
}

/** Whether `kill(pid, 0)` finds the process (EPERM: it exists, under another user). */
function exists(kill: Kill, pid: number): boolean {
  try { kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

/** A wait on the injected timer that an abort ends early (resolving "aborted"). */
function sleep(setTimer: SetTimer, ms: number, signal?: AbortSignal): Promise<"slept" | "aborted"> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve("aborted"); return; }
    const onAbort = (): void => { cancel(); resolve("aborted"); };
    const cancel = setTimer(() => { signal?.removeEventListener("abort", onAbort); resolve("slept"); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Starts whisper-server and waits until it is healthy and warm. `onStarted` receives the pid, `startedAt` (the injected clock right
 * after the spawn) and the comm: first synchronously right after the spawn with `whisper-server` (review B2 F7), then once more with the
 * `ps -o comm=` basename if that differs, all BEFORE the first health poll: Task 7 writes them into the state, so a crash, a kill or an
 * interrupt during the wait leaves nothing that `voice:down` cannot find. Rejects WhisperStartError after
 * stopping the process through its own handle (`stopSpawned`): `not_ready` (no ok within WHISPER_READY_WAIT_MS), `warm_failed`,
 * `exited` (it died while starting), `interrupted` (`signal` aborted: Task 7's Ctrl-C), `bad_url` and `spawn_failed` (nothing was
 * started); `not_stopped` (with `after` = the reason the start failed) when the process could not be stopped: then it may still run,
 * and the caller must keep the state that names it.
 */
export async function startWhisper(o: {
  spawnDetached: SpawnDetached; run: Run; kill: Kill; env: NodeJS.ProcessEnv; stateDir: string; sttUrl: URL; modelFile: string;
  health: () => Promise<HealthAnswer>; warm: () => Promise<void>; setTimer: SetTimer; now: () => number;
  onStarted: (w: { pid: number; startedAt: number; comm: string }) => void; signal?: AbortSignal; graceMs?: number;
}): Promise<SpawnedChild> {
  const port = Number(o.sttUrl.port);
  const requestPath = sttRequestPath(o.sttUrl);
  if (o.sttUrl.protocol !== "http:" || o.sttUrl.hostname !== "127.0.0.1" || !isPort(port) || o.sttUrl.search !== "" || o.sttUrl.hash !== ""
    || !isRequestPath(requestPath) || !isLongRequestPath(requestPath)) throw new WhisperStartError("bad_url");
  const publicDir = openPrivateSubdir(o.stateDir, "public", { empty: true });
  const tmpDir = openPrivateSubdir(o.stateDir, "tmp");
  const args = whisperArgs({ port, requestPath, modelFile: o.modelFile, publicDir, tmpDir });
  let child: SpawnedChild;
  try { child = o.spawnDetached(WHISPER_BINARY, args, { logFile: path.join(o.stateDir, "whisper.log"), env: whisperEnv(o.env), cwd: o.stateDir }); }
  catch { throw new WhisperStartError("spawn_failed"); }
  const { pid } = child;
  const startedAt = o.now();
  // Every failure from here stops the child through its own handle and says so only when it really stopped (review B F5).
  const fail = async (code: WhisperStartErrorCode): Promise<never> => {
    const r = await stopSpawned(child, { kill: o.kill, setTimer: o.setTimer, graceMs: o.graceMs ?? WHISPER_STOP_GRACE_MS });
    throw r === "stopped" ? new WhisperStartError(code) : new WhisperStartError("not_stopped", code);
  };
  // Review B2 F7: the record is handed over SYNCHRONOUSLY, before the first await, with the binary's own name (one exec: what ps
  // reports for it), so a CLI killed right after the spawn leaves a record voice:down can act on; then refined if ps says otherwise.
  o.onStarted({ pid, startedAt, comm: WHISPER_BINARY });
  const comm = await readComm(pid, o.run);
  if (comm === null) return fail("exited"); // gone already, or ps cannot see it: stopped through the handle, the caller drops the record
  if (comm !== WHISPER_BINARY) o.onStarted({ pid, startedAt, comm });
  for (;;) {
    if (o.signal?.aborted) return fail("interrupted");
    const answer = await o.health();
    if (o.signal?.aborted) return fail("interrupted");
    if (answer === "ok") break;
    if (answer === "down" && child.exited()) throw new WhisperStartError("exited");
    if (o.now() - startedAt >= WHISPER_READY_WAIT_MS) return fail("not_ready");
    if ((await sleep(o.setTimer, WHISPER_POLL_MS, o.signal)) === "aborted") return fail("interrupted");
  }
  try { await o.warm(); }
  catch { return fail(o.signal?.aborted ? "interrupted" : "warm_failed"); }
  if (o.signal?.aborted) return fail("interrupted");
  return child; // the handle: a later rollback of this run stops it with stopSpawned
}

/**
 * Stops the recorded whisper-server: "gone" when the pid no longer exists; "not_ours" when it exists but is not the process voice:up
 * started (`isOurWhisper`: comm, start time, `--port`), which is never signalled; "unknown" when `ps` cannot say (review B2 F4: the
 * caller keeps the record); else SIGTERM, then SIGKILL after `graceMs` (checked again before the SIGKILL), and "stopped".
 */
export async function stopWhisper(w: WhisperRecord, o: { run: Run; kill: Kill; setTimer: SetTimer; graceMs: number }): Promise<"stopped" | "not_ours" | "gone" | "unknown"> {
  if (!exists(o.kill, w.pid)) return "gone";
  const ident = await isOurWhisper(w, o.run);
  if (ident === "unknown") return exists(o.kill, w.pid) ? "unknown" : "gone";
  if (ident === "not_ours") return exists(o.kill, w.pid) ? "not_ours" : "gone";
  try { o.kill(w.pid, "SIGTERM"); } catch { return "gone"; }
  for (let waited = 0; waited < o.graceMs; waited += WHISPER_STOP_POLL_MS) {
    if (!exists(o.kill, w.pid)) return "stopped";
    await sleep(o.setTimer, WHISPER_STOP_POLL_MS);
  }
  if (!exists(o.kill, w.pid)) return "stopped";
  const again = await isOurWhisper(w, o.run);
  if (again === "unknown") return "unknown"; // still there and ps cannot say whose: no SIGKILL, the record stays
  if (again === "not_ours") return "stopped"; // it went, and the pid is someone else's now: leave that one alone
  try { o.kill(w.pid, "SIGKILL"); } catch { /* gone in between */ }
  return "stopped";
}

// ---- health and warm-up over loopback, without fetch ----

/** `<STT_URL>` without its trailing slash, as WhisperHttpSpeechToText builds it; null when it is not http://127.0.0.1:<port>. */
function baseOf(sttUrl: URL): URL | null {
  if (sttUrl.protocol !== "http:" || sttUrl.hostname !== "127.0.0.1" || sttUrl.port === "" || sttUrl.username !== "" || sttUrl.password !== "") return null;
  return sttUrl;
}
function endpoint(sttUrl: URL, name: "health" | "inference"): { port: number; path: string } | null {
  const base = baseOf(sttUrl);
  if (!base) return null;
  const p = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  return { port: Number(base.port), path: `${p}/${name}` };
}

type Answer = { status: number | null; body: string };
/** One request on 127.0.0.1 with a fresh agent (no env proxy, no keep-alive); the body read up to `limit` bytes. Never throws. */
function loopbackRequest(port: number, p: string, o: { method: "GET" | "POST"; headers?: Record<string, string>; body?: Buffer; signal: AbortSignal; limit: number }): Promise<Answer> {
  return new Promise<Answer>((resolve) => {
    let done = false;
    const finish = (a: Answer): void => { if (!done) { done = true; resolve(a); } };
    try {
      const req = http.request({ host: "127.0.0.1", port, path: p, method: o.method, agent: false, signal: o.signal, headers: { connection: "close", ...o.headers } }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => { size += c.length; if (size <= o.limit) chunks.push(c); else res.destroy(); });
        res.on("end", () => finish({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("close", () => finish({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => finish({ status: null, body: "" }));
      });
      req.on("error", () => finish({ status: null, body: "" }));
      req.end(o.body);
    } catch { finish({ status: null, body: "" }); }
  });
}

/** whisper-server's health at `<STT_URL>/health`, bounded by `timeoutMs` (default 2 s, injectable signal factory). Never throws or logs. */
export async function whisperHealth(sttUrl: URL, o: { timeoutMs?: number; timeout?: (ms: number) => AbortSignal } = {}): Promise<HealthAnswer> {
  const ep = endpoint(sttUrl, "health");
  if (!ep) return "down";
  let signal: AbortSignal;
  try { signal = (o.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(o.timeoutMs ?? 2_000); } catch { return "down"; }
  const a = await loopbackRequest(ep.port, ep.path, { method: "GET", signal, limit: MAX_HEALTH_BODY_BYTES });
  return healthOf(a.status, a.body);
}

/**
 * One warm-up inference: a 1 s silent 16 kHz WAV posted as multipart to `<STT_URL>/inference` (the fields A1a's client sends), bounded
 * by WHISPER_WARM_TIMEOUT_MS. Resolves on a 2xx answer; rejects with a fixed message (no URL, no port) otherwise.
 */
export async function whisperWarm(sttUrl: URL, o: { timeoutMs?: number; timeout?: (ms: number) => AbortSignal } = {}): Promise<void> {
  const ep = endpoint(sttUrl, "inference");
  if (!ep) throw new Error("whisper-server warm-up: STT_URL is not a loopback http address");
  const boundary = `----voice-ops-${randomBytes(12).toString("hex")}`;
  const part = (headers: string, body: Buffer | string): Buffer => Buffer.concat([Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\r\n")]);
  const body = Buffer.concat([
    part('Content-Disposition: form-data; name="file"; filename="segment.wav"\r\nContent-Type: audio/wav', Buffer.from(encodeWav(new Int16Array(16_000), 16_000))),
    part('Content-Disposition: form-data; name="response_format"', "verbose_json"),
    part('Content-Disposition: form-data; name="temperature"', "0.0"),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const signal = (o.timeout ?? ((ms: number) => AbortSignal.timeout(ms)))(o.timeoutMs ?? WHISPER_WARM_TIMEOUT_MS);
  const a = await loopbackRequest(ep.port, ep.path, {
    method: "POST", signal, limit: 256 * 1024, body,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
  });
  if (a.status === null || a.status < 200 || a.status >= 300) throw new Error("whisper-server did not answer the warm-up request");
}
