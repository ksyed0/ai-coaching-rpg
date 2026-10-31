import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadScenario, validateScenario } from "@acr/script";
import { describeModelProvider, selectModelProvider } from "@acr/adapters";
import { NOTICE_VERSION_RULE_TEXT, SESSION_ID_RULE_TEXT, isNoticeVersion, isValidSessionId } from "@acr/events";
import { SessionStoreError, openSession, parseLockStaleMs, parseStartMode, type OpenedSession } from "./engine/session-store.js";
import { SystemClock } from "./engine/clock.js";
import { loadConsentNotice } from "./engine/consent-notice.js";
import type { ConsentNotice } from "./engine/consent.js";
import { SessionHost } from "./host/session-host.js";
import { startServer } from "./host/ws-server.js";
import { parseNpcTimeouts } from "./agents/timeouts.js";
import { parseTokenBudgets } from "./agents/token-budgets.js";
import { parseTemperatures } from "./agents/temperatures.js";
import { parseModelRetry, withModelRetry } from "./agents/retry-config.js";
import { parseGmConfig } from "./agents/gm-config.js";
import { createGmTraceWriter, parseGmTraceEnv } from "./agents/gm-trace.js";
import { openParentChannel, type ParentChannel, type ParentMessage } from "./host/parent-channel.js";
import { reissueRole } from "./host/reissue.js";
import { OPEN_SERVER_WARNING, parseSecurityConfig } from "./host/security.js";

/** services/runtime/src/main.ts: the repo root is three levels up from this file's directory. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type Runtime = { port: number; host: SessionHost; stop(): Promise<void> };
export type BootstrapResult = { ok: true; runtime: Runtime } | { ok: false; errors: string[] };

/** US-0034: printed once at startup when GM_AUTO_RELEASE=1 (a constant: no value from the environment). */
export const GM_AUTO_RELEASE_WARNING = "WARNING: GM_AUTO_RELEASE=1: the Game Master releases a hidden fact itself when it judges the fact's earned_when condition met (recorded as a Game Master action); a participant who persuades it releases the fact without the facilitator";

/** Builds and starts one session. Never calls process.exit and never logs environment values (API keys). */
export async function bootstrap(opts: {
  env: NodeJS.ProcessEnv; root?: string; now?: () => Date; log?: (m: string) => void; warn?: (m: string) => void; logDir?: string; tickMs?: number;
  /**
   * Called once when the session stops for good (the log could not be written, or the session lock was lost): the ticker is already
   * stopped and the clients told. The process owner should drain briefly, stop the runtime and exit non-zero so a supervisor restarts
   * it; the restart resumes from the log. Default: nothing (bootstrap never exits the process).
   */
  onFatal?: () => void;
  /** Tests only: runs right before bootstrap's own check that it still holds the session lock. */
  testHooks?: { beforeLockCheck?: () => void };
  /**
   * US-0033: receives the player join codes ONCE, when this start issued them (never when the codes issued earlier still apply).
   * Deliberately not `log` or `warn`: the codes never go through the log channel. Default: printJoinCodes to stdout.
   */
  showJoinCodes?: (codes: { roleId: string; code: string }[]) => void;
  /** US-0053: where `notice-<CONSENT_NOTICE_VERSION>.md` lives. Default `<repo>/consent`, whatever `root` is (it ships with the code). */
  consentDir?: string;
  /**
   * US-0058: the IPC channel to the control service that forked this process (null/absent: the terminal; behaviour unchanged).
   * With one, the join codes go to the parent instead of stdout, `ready` follows once listening, and `ended` when the session ends.
   */
  parent?: ParentChannel | null;
}): Promise<BootstrapResult> {
  // Validate the session id before ANY filesystem action: it becomes a file name under the data dir.
  const requestedId = (opts.env.SESSION_ID ?? "local");
  if (!isValidSessionId(requestedId)) {
    return { ok: false, errors: [`SESSION_ID ${JSON.stringify(requestedId.slice(0, 40))} is invalid: use ${SESSION_ID_RULE_TEXT}`] };
  }
  const root = opts.root ?? REPO_ROOT;
  // <root>/.env is optional; real environment variables win over it. Values are never logged.
  // US-0058: the control service forks this process with CONTROL_MANAGED=1 (which implies NO_DOTENV=1; NO_DOTENV=1 alone also works):
  // the file is then not read at all, so a stray .env can neither set SESSION_START=fresh nor supply a FACILITATOR_TOKEN.
  // Both flags are read from the REAL environment only (opts.env): a .env cannot switch managed mode on or off.
  const managed = opts.env.CONTROL_MANAGED === "1";
  const skipDotenv = managed || opts.env.NO_DOTENV === "1";
  const envFile = path.join(root, ".env");
  let fileEnv: NodeJS.ProcessEnv = {};
  if (!skipDotenv) {
    // One read; a missing .env is no error (never exists-then-read: L-0003).
    try { fileEnv = parseEnv(readFileSync(envFile, "utf8")); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return { ok: false, errors: [`cannot read ${envFile}: ${code ?? "unreadable"}`] };
    }
  }
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...opts.env };
  // An EMPTY real FACILITATOR_TOKEN (for example `FACILITATOR_TOKEN=` exported by a wrapper) is "unset", so it cannot silently
  // switch off the token that .env holds. The real environment wins only when it has a value.
  if ((opts.env.FACILITATOR_TOKEN ?? "") === "" && (fileEnv.FACILITATOR_TOKEN ?? "") !== "") env.FACILITATOR_TOKEN = fileEnv.FACILITATOR_TOKEN;
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const parent = opts.parent ?? null;
  const scenarioDir = path.resolve(root, env.SCENARIO_DIR ?? "scenarios/friday-escalation"); // absolute values are used as given
  const sessionId = env.SESSION_ID ?? "local";
  if (!isValidSessionId(sessionId)) { // an id coming from <root>/.env gets the same check
    return { ok: false, errors: [`SESSION_ID ${JSON.stringify(sessionId.slice(0, 40))} is invalid: use ${SESSION_ID_RULE_TEXT}`] };
  }
  const port = Number(env.RUNTIME_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return { ok: false, errors: [`RUNTIME_PORT '${env.RUNTIME_PORT}' is not a valid port`] };
  const timeouts = parseNpcTimeouts(env);
  if (!timeouts.ok) return { ok: false, errors: timeouts.errors };
  const budgets = parseTokenBudgets(env);
  if (!budgets.ok) return { ok: false, errors: budgets.errors };
  const temps = parseTemperatures(env);
  if (!temps.ok) return { ok: false, errors: temps.errors };
  const retry = parseModelRetry(env);
  if (!retry.ok) return { ok: false, errors: retry.errors };
  const gmCfg = parseGmConfig(env, timeouts.replyTimeoutMs);
  if (!gmCfg.ok) return { ok: false, errors: gmCfg.errors };
  const security = parseSecurityConfig(env); // its errors never contain the token
  if (!security.ok) return { ok: false, errors: security.errors };
  const startMode = parseStartMode(env.SESSION_START);
  if (!startMode.ok) return { ok: false, errors: [startMode.error] };
  const lockStale = parseLockStaleMs(env.SESSION_LOCK_STALE_MS);
  if (!lockStale.ok) return { ok: false, errors: [lockStale.error] };
  // US-0053: the notice players agree to; the value is never echoed.
  const noticeVersion = (env.CONSENT_NOTICE_VERSION ?? "").trim() || "v1";
  if (!isNoticeVersion(noticeVersion)) return { ok: false, errors: [`CONSENT_NOTICE_VERSION must be ${NOTICE_VERSION_RULE_TEXT}`] };
  let consentNotice: ConsentNotice;
  try { consentNotice = loadConsentNotice(opts.consentDir ?? path.join(REPO_ROOT, "consent"), noticeVersion); }
  catch (err) { return { ok: false, errors: [`cannot start without the consent notice: ${(err as Error).message}`] }; }

  let scenario;
  try { scenario = await loadScenario(scenarioDir); }
  catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }
  const { errors, warnings } = validateScenario(scenario);
  for (const w of warnings) warn(`warning: ${w}`);
  if (errors.length) return { ok: false, errors };

  // US-0058: SESSION_DATA_DIR (set by the control service, from the merged env like the other settings) names the data directory; it must be absolute, and a refusal never echoes it.
  const sessionDataDir = env.SESSION_DATA_DIR;
  if (opts.logDir === undefined && sessionDataDir !== undefined && sessionDataDir !== "" && !path.isAbsolute(sessionDataDir)) {
    return { ok: false, errors: ["SESSION_DATA_DIR must be an absolute path"] };
  }
  const dataDir = opts.logDir ?? (sessionDataDir ? sessionDataDir : path.join(root, "data", "sessions"));
  const traceEnv = parseGmTraceEnv(env.GM_TRACE_FILE, dataDir);
  if (!traceEnv.ok) return { ok: false, errors: [traceEnv.error] };

  // US-0018: take the session lock, then resume the log (default), or move it aside (SESSION_START=fresh, or a session that had ended).
  const clock = new SystemClock();
  let store: OpenedSession;
  const lost: { halt?: () => void } = {};
  try { store = await openSession({ scenario, sessionId, dataDir, clock, mode: startMode.mode, now: opts.now, joinCodes: true, consentNotice, managed, lock: { staleMs: lockStale.staleMs, onLost: () => lost.halt?.() } }); }
  catch (err) { return { ok: false, errors: [err instanceof SessionStoreError ? err.message : `cannot open the session log: ${err instanceof Error ? err.message : String(err)}`] }; }
  /**
   * US-0033 (review I-1): every failure from here on withdraws join codes this start issued but never showed, then closes the store,
   * so the next start issues and shows new ones instead of keeping codes nobody has. (The codes are written before they are shown,
   * never after: a code on screen must already be durable, or a crash right after the display would lose codes people hold.)
   */
  const failOpened = async (errors: string[]): Promise<BootstrapResult> => {
    if (!store.discardIssuedCodes()) errors.push(`the join codes this start issued could not be withdrawn: move ${sessionId}.codes.json in the data directory aside before the next start, or nobody can join`);
    await store.close();
    return { ok: false, errors };
  };
  for (const note of store.notes) warn(note);
  if (store.rotatedTo) log(`previous session log moved aside${store.rotatedBecause === "ended" ? " (that session had ended)" : ""}: ${store.rotatedTo}`);

  let host: SessionHost;
  let gmTrace: ReturnType<typeof createGmTraceWriter> | undefined;
  try {
    // GM_TRACE_FILE (off by default): the raw Game Master replies, for the offline gm-eval. Owner-only file; never logged by name.
    gmTrace = traceEnv.file ? createGmTraceWriter(traceEnv.file, { forbid: [path.join(dataDir, `${sessionId}.jsonl`), path.join(dataDir, `${sessionId}.lock`)], forbidDir: dataDir }) : undefined;
    const engine = store.engine;
    // Live providers retry transient errors inside the NPC deadlines; the scripted mock is never wrapped.
    const hostLog = (m: string) => console.error(m);
    const wrap = (p: ReturnType<typeof selectModelProvider>, role: "NPC" | "GM") => (p.name === "mock" ? p : withModelRetry(p, retry, role, hostLog));
    const noSdkRetries = { sdkRetries: false }; // the wrapper is the only retry layer
    const npcProvider = wrap(selectModelProvider(env, "npc", noSdkRetries), "NPC");
    // Never log the provider object, its name, an endpoint or any env-derived value: describeModelProvider returns a
    // fixed label plus a literal yes/no for "custom endpoint".
    log(`model provider: ${describeModelProvider(env)}`);
    host = new SessionHost({ scenario, engine, npcProvider, gmProvider: wrap(selectModelProvider(env, "gm", noSdkRetries), "GM"), clock, log: hostLog, firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs, npcMaxTokens: budgets.npcMaxTokens, gmMaxTokens: budgets.gmMaxTokens, npcTemperature: temps.npcTemperature, gmTemperature: temps.gmTemperature, gmTimeoutMs: gmCfg.timeoutMs, gmReask: gmCfg.reask, gmEveryN: gmCfg.everyNUtterances, gmAutoRelease: gmCfg.autoRelease, gmTranscriptWindow: gmCfg.transcriptWindow, gmTrace, seats: store.seats });
    if (store.resume) host.resumeFrom(store.resume);
    // Fail-stop (US-0018): a lost lock stops the engine too; one log line (no paths or values), then the owner's onFatal.
    let fatalSeen = false;
    host.onFatal(() => {
      if (fatalSeen) return;
      fatalSeen = true;
      warn("FATAL: the session log can no longer be written safely (a write or sync failed, or the session lock was lost); the server stops accepting input and must be restarted, which resumes the session from its log");
      try { opts.onFatal?.(); } catch { /* the owner's handler must not throw into the engine */ }
    });
    // Registered first, then checked: a lock lost (or found missing) before this point still ends in FATAL and the owner's exit.
    lost.halt = () => store.engine.halt("the session lock was lost");
    opts.testHooks?.beforeLockCheck?.();
    if (store.lock.lost || !store.lock.verify()) lost.halt();
  } catch (err) { gmTrace?.close(); return failOpened([err instanceof Error ? err.message : String(err)]); }

  host.startTicker(opts.tickMs ?? 1_000);
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer({
      port, hosts: new Map([[sessionId, host]]), log, host: security.config.host, facilitatorToken: security.config.facilitatorToken,
      ...(store.joinCodes ? { joinCodes: new Map([[sessionId, store.joinCodes.codes]]) } : {}),
      limits: security.config.limits, allowedOrigins: security.config.allowedOrigins, trustProxy: security.config.trustProxy,
    }); }
  catch (err) { host.stopTicker(); gmTrace?.close(); return failOpened([`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`]); }
  if (security.config.trustProxy && !/^(localhost|::1|127(\.\d{1,3}){3})$/i.test(security.config.host)) {
    warn("WARNING: TRUST_PROXY=1 but RUNTIME_HOST is not a loopback address: a client that reaches the port directly can forge X-Forwarded-For and dodge the per-address limits; bind 127.0.0.1 behind the proxy");
  }
  if (security.config.facilitatorToken === undefined) warn(OPEN_SERVER_WARNING); // one line, no secret
  else log("facilitator token required (FACILITATOR_TOKEN is set)");
  if (gmCfg.autoRelease) warn(GM_AUTO_RELEASE_WARNING); // US-0034: an operator opt-in; a constant line
  log(`scenario "${scenario.meta.title}" v${scenario.meta.version}; session "${sessionId}"; players: ${Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).join(", ")}`);
  // US-0033: the codes are shown once, through their own channel (never log/warn), and only by the start that issued them.
  if (store.joinCodes?.issued) {
    const issued = Object.entries(store.joinCodes.issued).map(([roleId, code]) => ({ roleId, code }));
    // Codes nobody saw lock everyone out: a display that fails stops the start (and withdraws them), never silently.
    try {
      const r: unknown = (opts.showJoinCodes ?? (parent ? sendCodesToParent(parent) : printJoinCodes))(issued);
      // review I-A: an async display could fail after the start reported success; refuse it (and never leave its rejection unhandled).
      if (r !== undefined && typeof (r as { then?: unknown }).then === "function") { (r as Promise<unknown>).then(undefined, () => undefined); throw new Error("async display"); }
    }
    catch { host.stopTicker(); await server.close(); gmTrace?.close(); return failOpened(["could not show the player join codes (the start was stopped and the codes withdrawn; start again)"]); }
  } else if (store.joinCodes) {
    log("player join codes: the codes issued earlier for this session still apply (they are not shown again; to issue new ones, stop the server, move the session's .codes.json file in the data directory aside and start it again)");
  }
  if (store.resume) {
    const r = store.resume;
    log(`session RESUMED from its log after a restart (${r.events} events${r.sceneId ? `, scene ${r.sceneId}` : ""}); it is PAUSED until the facilitator sends /resume${r.pendingLine ? ", which also answers the last player line" : ""}. Participants rejoin with the same join codes`);
    if (r.partialTailBytes > 0) warn(`warning: the session log ended in a cut-off line (${r.partialTailBytes} bytes, an event that was never confirmed); it is dropped`);
    if (r.format === 0) warn("warning: the session log predates log format 1 (no scenario hash); it was resumed on a matching scenario id and version only");
    const notes = store.resumeNotes;
    if (notes && notes.clockBehindSecs > 0) warn(`warning: the system clock is ${notes.clockBehindSecs} s behind the last event in the session log (it moved backwards); the downtime is unknown and counted as 0 s, and new events keep the last recorded time until the clock catches up`);
    if (notes && notes.repairs.length > 0) log(`the restart completed what the crash cut short: ${notes.repairs.join(", ")}`);
  }
  let unsubscribeEnded: (() => void) | undefined;
  if (parent) {
    // `ready` comes after the codes (sent above, inside the display hook), so the parent never sees a ready session whose codes it lacks.
    const logIdentity = store.seats?.credentials.logIdentity ?? store.resume?.logIdentity;
    const sent = parent.send({ type: "ready", port: server.port, ...(logIdentity ? { logIdentity } : {}), status: store.resume ? "resumed" : "new" /* an empty-lobby restart reports "new" with no codes (they are kept); the supervisor treats ready-without-codes as normal */, modelLabel: describeModelProvider(env) });
    if (!sent) {
      // A start failure, but the join codes are deliberately NOT withdrawn: the parent already holds them (they were sent first), and
      // withdrawing would make them stale. The parent reissues them if it restarts this session. Nothing may stay running or locked.
      host.stopTicker(); await server.close(); gmTrace?.close();
      await store.close();
      return { ok: false, errors: ["could not report the session as ready to the control service (the start was stopped; start again)"] };
    }
    let endedSent = false;
    unsubscribeEnded = host.subscribe((e) => { if (e.type === "session.ended" && !endedSent) { endedSent = true; parent.send({ type: "ended" }); } });
    // US-0058: the only way a code is ever reissued. The replies carry the new code (reissued) or a FIXED reason (reissue_failed): never
    // a path, a value or an Error message. The handler never throws (the channel does not isolate handler exceptions).
    let current = store.joinCodes?.codes;
    const seats = store.seats;
    const answer = (m: ParentMessage) => {
      if (!current || !seats) { parent.send({ type: "reissue_failed", requestId: m.requestId, reason: "this session has no join codes to reissue" }); return; }
      if (!host.hasPlayerRole(m.roleId)) { parent.send({ type: "reissue_failed", requestId: m.requestId, reason: "not a player role of this session" }); return; }
      reissueRole({
        host, seats, sessionId, server,
        codes: () => current!,
        setCodes: (c) => { current = c; server.replaceCodes(sessionId, c); },
        writeCodes: (c) => store.writeJoinCodes(c),
        report: (what, err) => warn(`${what}: ${err instanceof Error ? err.name : "error"}`), // the name only: a message could quote a path
      }, m.roleId, m.by).then(
        (code) => { if (!parent.send({ type: "reissued", requestId: m.requestId, code })) warn("a reissued code could not be handed to the control service; reissue it again"); },
        () => { parent.send({ type: "reissue_failed", requestId: m.requestId, reason: "the code could not be reissued" }); },
      );
    };
    parent.onMessage((m) => { try { answer(m); } catch { parent.send({ type: "reissue_failed", requestId: m.requestId, reason: "the code could not be reissued" }); } });
  }
  return { ok: true, runtime: { port: server.port, host, stop: async () => { unsubscribeEnded?.(); host.stopTicker(); await server.close(); gmTrace?.close(); await store.close(); } } };
}

/**
 * US-0058: the display hook of a managed start. It is synchronous (an async return is refused) and THROWS when the channel did not take
 * the message, which triggers the abort-and-withdraw path. `process.send` returning false is backpressure, not loss, but the start is
 * still treated as failed: aborting and withdrawing is safe, whereas a start whose codes may not have arrived is not.
 */
function sendCodesToParent(parent: ParentChannel): (codes: { roleId: string; code: string }[]) => void {
  return (codes) => { if (!parent.send({ type: "codes", codes })) throw new Error("parent channel refused the codes"); };
}

/**
 * US-0058: when the parent goes away, stop the runtime and exit 0 (an orphaned session must not keep running). Never throws.
 * A stop that hangs (for example on a log stuck in a failing write) must not leave an orphan holding the session lock: an unref'd
 * timer exits FATAL_HARD_EXIT_MS after the disconnect whatever happens. The exit runs at most once.
 */
export function watchParent(parent: ParentChannel, stop: () => Promise<void>, exit: (code: number) => void, hardMs: number = FATAL_HARD_EXIT_MS): void {
  let seen = false;
  let exited = false;
  const exitOnce = () => { if (!exited) { exited = true; exit(0); } };
  parent.onDisconnect(() => {
    if (seen) return;
    seen = true;
    setTimeout(exitOnce, hardMs).unref();
    let p: Promise<void>;
    try { p = stop(); } catch { p = Promise.resolve(); }
    void p.catch(() => undefined).finally(exitOnce);
  });
}

/** The one display of newly issued player join codes (stdout, not the log). Each person should get only their own role's code. */
export function printJoinCodes(codes: { roleId: string; code: string }[], write: (text: string) => void = (t) => { process.stdout.write(t); }): void {
  const width = Math.max(...codes.map((c) => c.roleId.length), 4);
  write([
    "",
    "PLAYER JOIN CODES (shown only now: note them down; give each person the code of THEIR role, privately):",
    ...codes.map((c) => `  ${c.roleId.padEnd(width)}  ${c.code}`),
    "A player needs the code to claim the role: pnpm play --role <role> --name <name> asks for it (or set JOIN_CODE).",
    "",
  ].join("\n") + "\n");
}

/** After a fatal log failure: how long the clients get to receive the notice before the process exits (non-zero) for a restart. */
export const FATAL_DRAIN_MS = 2_000;
/** Hard backstop: exit(1) this long after a fatal failure even if stopping hangs (for example on a log stuck in a failing write). */
export const FATAL_HARD_EXIT_MS = 5_000;

/** After a fatal failure: drain FATAL_DRAIN_MS, stop, exit(1); and exit(1) after FATAL_HARD_EXIT_MS whatever happens (timer unref'd). */
export function scheduleFatalExit(o: { stop: () => Promise<void>; exit: (code: number) => void; drainMs?: number; hardMs?: number }): void {
  let exited = false;
  const exit = () => { if (!exited) { exited = true; o.exit(1); } };
  setTimeout(exit, o.hardMs ?? FATAL_HARD_EXIT_MS).unref();
  setTimeout(() => { void o.stop().catch(() => undefined).finally(exit); }, o.drainMs ?? FATAL_DRAIN_MS);
}

async function main(): Promise<void> {
  try { await run(); }
  catch (err) { console.error(`error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
}

async function run(): Promise<void> {
  const fatal: { handler?: () => void } = {};
  // US-0058: the IPC channel exists only for a process the control service forked (CONTROL_MANAGED=1).
  const parent = process.env.CONTROL_MANAGED === "1" ? openParentChannel() : null;
  const result = await bootstrap({ env: process.env, onFatal: () => fatal.handler?.(), parent });
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  const { runtime } = result;
  const shutdown = () => { void runtime.stop().then(() => process.exit(0)); };
  fatal.handler = () => scheduleFatalExit({ stop: () => runtime.stop(), exit: (c) => process.exit(c) });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (parent) watchParent(parent, () => runtime.stop(), (c) => process.exit(c));
}

// Only run when executed directly (tsx src/main.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
