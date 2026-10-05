import { constants as fsConstants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadScenario, validateScenario } from "@acr/script";
import { describeModelProvider, selectModelProvider } from "@acr/adapters";
import { SessionEngine } from "./engine/session-engine.js";
import { JsonlEventLog, isValidSessionId } from "./engine/event-log.js";
import { SystemClock } from "./engine/clock.js";
import { SessionHost } from "./host/session-host.js";
import { startServer } from "./host/ws-server.js";
import { parseNpcTimeouts } from "./agents/timeouts.js";
import { parseModelRetry, withModelRetry } from "./agents/retry-config.js";

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
  const retry = parseModelRetry(env);
  if (!retry.ok) return { ok: false, errors: retry.errors };

  let scenario;
  try { scenario = await loadScenario(scenarioDir); }
  catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }
  const { errors, warnings } = validateScenario(scenario);
  for (const w of warnings) warn(`warning: ${w}`);
  if (errors.length) return { ok: false, errors };

  const dataDir = opts.logDir ?? path.join(root, "data", "sessions");
  try {
    const rotatedTo = rotateStaleLog(dataDir, sessionId, (opts.now ?? (() => new Date()))());
    if (rotatedTo) log(`previous session log moved aside: ${rotatedTo}`);
  } catch (err) { return { ok: false, errors: [`cannot rotate the previous session log in ${dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`] }; }

  let host: SessionHost;
  try {
    const clock = new SystemClock();
    const engine = new SessionEngine({ scenario, log: new JsonlEventLog(sessionId, dataDir), clock });
    // Live providers retry transient errors inside the NPC deadlines; the scripted mock is never wrapped.
    const hostLog = (m: string) => console.error(m);
    const wrap = (p: ReturnType<typeof selectModelProvider>, role: "NPC" | "GM") => (p.name === "mock" ? p : withModelRetry(p, retry, role, hostLog));
    const npcProvider = wrap(selectModelProvider(env, "npc"), "NPC");
    // Never log the provider object, its name, an endpoint or any env-derived value: describeModelProvider returns a
    // fixed label plus a literal yes/no for "custom endpoint".
    log(`model provider: ${describeModelProvider(env)}`);
    host = new SessionHost({ scenario, engine, npcProvider, gmProvider: wrap(selectModelProvider(env, "gm"), "GM"), clock, log: hostLog, firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs });
  } catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }

  host.startTicker(opts.tickMs ?? 1_000);
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer({ port, hosts: new Map([[sessionId, host]]), log }); }
  catch (err) { host.stopTicker(); return { ok: false, errors: [`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`] }; }
  log(`scenario "${scenario.meta.title}" v${scenario.meta.version}; session "${sessionId}"; players: ${Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).join(", ")}`);
  return { ok: true, runtime: { port: server.port, host, stop: async () => { host.stopTicker(); await server.close(); } } };
}

/** Both paths must stay inside `dir`: defense in depth on top of the session id check. */
function assertInside(dir: string, file: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to touch a path outside the data dir`);
}

/** linkSync errors that mean "this filesystem has no hard links": fall back to a copy. */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"]);

/**
 * Slice 1 does not resume sessions: a non-empty regular `<id>.jsonl` from an earlier run is moved aside (never
 * deleted) to `<id>.<UTC timestamp>.jsonl`, with a numeric suffix on collision. The move is link + unlink (or, where hard links are unsupported, an exclusive copy + unlink), never a
 * bare rename, so an existing target can never be overwritten (EEXIST -> next suffix). Missing or empty files are
 * left alone; a directory or symlink in that place is an error and is not touched.
 */
function rotateStaleLog(dir: string, sessionId: string, now: Date): string | null {
  const file = path.join(dir, `${sessionId}.jsonl`);
  assertInside(dir, file);
  let st;
  try { st = lstatSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  if (!st.isFile()) throw new Error(`${file} is not a regular file; move it away and retry`);
  if (st.size === 0) return null;
  const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  for (let n = 0; n < 1_000; n++) {
    const target = path.join(dir, `${sessionId}.${stamp}${n === 0 ? "" : `-${n}`}.jsonl`);
    assertInside(dir, target);
    let copied = false;
    try { linkSync(file, target); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
      // This filesystem cannot hard-link (some bind mounts, NFS/SMB): copy instead, still never overwriting.
      try { copyFileSync(file, target, fsConstants.COPYFILE_EXCL); }
      catch (cerr) { if ((cerr as NodeJS.ErrnoException).code === "EEXIST") continue; throw cerr; }
      copied = true;
    }
    try { unlinkSync(file); }
    catch (uerr) {
      // The source is only ever removed after the target exists; if that last step fails, say so, so nobody retries blindly.
      throw new Error(`${copied ? "a copy of" : "a second hard link to"} the old log was made at ${path.basename(target)} but ${path.basename(file)} could not be removed (${(uerr as NodeJS.ErrnoException).code ?? "error"}); remove or move ${path.basename(file)} by hand and start again`);
    }
    return target;
  }
  throw new Error(`no free rotation name for ${file} after 1000 tries`);
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
