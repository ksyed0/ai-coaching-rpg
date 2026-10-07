import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadScenario, validateScenario } from "@acr/script";
import { describeModelProvider, selectModelProvider } from "@acr/adapters";
import { isValidSessionId } from "./engine/event-log.js";
import { SessionStoreError, openSession, parseLockStaleMs, parseStartMode, type OpenedSession } from "./engine/session-store.js";
import { SystemClock } from "./engine/clock.js";
import { SessionHost } from "./host/session-host.js";
import { startServer } from "./host/ws-server.js";
import { parseNpcTimeouts } from "./agents/timeouts.js";
import { parseTokenBudgets } from "./agents/token-budgets.js";
import { parseTemperatures } from "./agents/temperatures.js";
import { parseModelRetry, withModelRetry } from "./agents/retry-config.js";
import { parseGmConfig } from "./agents/gm-config.js";
import { createGmTraceWriter, parseGmTraceEnv } from "./agents/gm-trace.js";
import { OPEN_SERVER_WARNING, parseSecurityConfig } from "./host/security.js";

/** services/runtime/src/main.ts: the repo root is three levels up from this file's directory. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type Runtime = { port: number; host: SessionHost; stop(): Promise<void> };
export type BootstrapResult = { ok: true; runtime: Runtime } | { ok: false; errors: string[] };

/** Builds and starts one session. Never calls process.exit and never logs environment values (API keys). */
export async function bootstrap(opts: {
  env: NodeJS.ProcessEnv; root?: string; now?: () => Date; log?: (m: string) => void; warn?: (m: string) => void; logDir?: string; tickMs?: number;
}): Promise<BootstrapResult> {
  // Validate the session id before ANY filesystem action: it becomes a file name under the data dir.
  const requestedId = (opts.env.SESSION_ID ?? "local");
  if (!isValidSessionId(requestedId)) {
    return { ok: false, errors: [`SESSION_ID ${JSON.stringify(requestedId.slice(0, 40))} is invalid: use 1 to 64 letters, digits, '_' or '-'`] };
  }
  const root = opts.root ?? REPO_ROOT;
  // <root>/.env is optional; real environment variables win over it. Values are never logged.
  const envFile = path.join(root, ".env");
  let fileEnv: NodeJS.ProcessEnv = {};
  if (existsSync(envFile)) {
    try { fileEnv = parseEnv(readFileSync(envFile, "utf8")); }
    catch (err) { return { ok: false, errors: [`cannot read ${envFile}: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`] }; }
  }
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...opts.env };
  // An EMPTY real FACILITATOR_TOKEN (for example `FACILITATOR_TOKEN=` exported by a wrapper) is "unset", so it cannot silently
  // switch off the token that .env holds. The real environment wins only when it has a value.
  if ((opts.env.FACILITATOR_TOKEN ?? "") === "" && (fileEnv.FACILITATOR_TOKEN ?? "") !== "") env.FACILITATOR_TOKEN = fileEnv.FACILITATOR_TOKEN;
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const scenarioDir = path.resolve(root, env.SCENARIO_DIR ?? "scenarios/friday-escalation"); // absolute values are used as given
  const sessionId = env.SESSION_ID ?? "local";
  if (!isValidSessionId(sessionId)) { // an id coming from <root>/.env gets the same check
    return { ok: false, errors: [`SESSION_ID ${JSON.stringify(sessionId.slice(0, 40))} is invalid: use 1 to 64 letters, digits, '_' or '-'`] };
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

  let scenario;
  try { scenario = await loadScenario(scenarioDir); }
  catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }
  const { errors, warnings } = validateScenario(scenario);
  for (const w of warnings) warn(`warning: ${w}`);
  if (errors.length) return { ok: false, errors };

  const dataDir = opts.logDir ?? path.join(root, "data", "sessions");
  const traceEnv = parseGmTraceEnv(env.GM_TRACE_FILE, dataDir);
  if (!traceEnv.ok) return { ok: false, errors: [traceEnv.error] };

  // US-0018: take the session lock, then resume the log (default), or move it aside (SESSION_START=fresh, or a session that had ended).
  const clock = new SystemClock();
  let store: OpenedSession;
  try { store = await openSession({ scenario, sessionId, dataDir, clock, mode: startMode.mode, now: opts.now, lock: { staleMs: lockStale.staleMs, onLost: () => warn("ERROR: the session lock was removed or taken over by another process; this server no longer writes the session log") } }); }
  catch (err) { return { ok: false, errors: [err instanceof SessionStoreError ? err.message : `cannot open the session log: ${err instanceof Error ? err.message : String(err)}`] }; }
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
    host = new SessionHost({ scenario, engine, npcProvider, gmProvider: wrap(selectModelProvider(env, "gm", noSdkRetries), "GM"), clock, log: hostLog, firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs, npcMaxTokens: budgets.npcMaxTokens, gmMaxTokens: budgets.gmMaxTokens, npcTemperature: temps.npcTemperature, gmTemperature: temps.gmTemperature, gmTimeoutMs: gmCfg.timeoutMs, gmReask: gmCfg.reask, gmEveryN: gmCfg.everyNUtterances, gmTrace });
    if (store.resume) host.resumeFrom(store.resume);
  } catch (err) { gmTrace?.close(); await store.close(); return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }

  host.startTicker(opts.tickMs ?? 1_000);
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer({
      port, hosts: new Map([[sessionId, host]]), log, host: security.config.host, facilitatorToken: security.config.facilitatorToken,
      limits: security.config.limits, allowedOrigins: security.config.allowedOrigins, trustProxy: security.config.trustProxy,
    }); }
  catch (err) { host.stopTicker(); gmTrace?.close(); await store.close(); return { ok: false, errors: [`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`] }; }
  if (security.config.trustProxy && !/^(localhost|::1|127(\.\d{1,3}){3})$/i.test(security.config.host)) {
    warn("WARNING: TRUST_PROXY=1 but RUNTIME_HOST is not a loopback address: a client that reaches the port directly can forge X-Forwarded-For and dodge the per-address limits; bind 127.0.0.1 behind the proxy");
  }
  if (security.config.facilitatorToken === undefined) warn(OPEN_SERVER_WARNING); // one line, no secret
  else log("facilitator token required (FACILITATOR_TOKEN is set)");
  log(`scenario "${scenario.meta.title}" v${scenario.meta.version}; session "${sessionId}"; players: ${Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).join(", ")}`);
  if (store.resume) {
    const r = store.resume;
    log(`session RESUMED from its log after a restart (${r.events} events${r.sceneId ? `, scene ${r.sceneId}` : ""}); it is PAUSED until the facilitator sends /resume${r.pendingLine ? ", which also answers the last player line" : ""}. Participants rejoin and claim their roles again`);
    if (r.partialTailBytes > 0) warn(`warning: the session log ended in a cut-off line (${r.partialTailBytes} bytes, an event that was never confirmed); it is dropped`);
    if (r.format === 0) warn("warning: the session log predates log format 1 (no scenario hash); it was resumed on a matching scenario id and version only");
  }
  return { ok: true, runtime: { port: server.port, host, stop: async () => { host.stopTicker(); await server.close(); gmTrace?.close(); await store.close(); } } };
}

async function main(): Promise<void> {
  try { await run(); }
  catch (err) { console.error(`error: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
}

async function run(): Promise<void> {
  const result = await bootstrap({ env: process.env });
  if (!result.ok) {
    for (const e of result.errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  const { runtime } = result;
  const shutdown = () => { void runtime.stop().then(() => process.exit(0)); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly (tsx src/main.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
