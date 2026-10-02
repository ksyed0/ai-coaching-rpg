import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadScenario, validateScenario } from "@acr/script";
import { selectModelProvider } from "@acr/adapters";
import { SessionEngine } from "./engine/session-engine.js";
import { JsonlEventLog } from "./engine/event-log.js";
import { SystemClock } from "./engine/clock.js";
import { SessionHost } from "./host/session-host.js";
import { startServer } from "./host/ws-server.js";

/** services/runtime/src/main.ts: the repo root is three levels up from this file's directory. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type Runtime = { port: number; host: SessionHost; stop(): Promise<void> };
export type BootstrapResult = { ok: true; runtime: Runtime } | { ok: false; errors: string[] };

/** Builds and starts one session. Never calls process.exit and never logs environment values (API keys). */
export async function bootstrap(opts: {
  env: NodeJS.ProcessEnv; root?: string; log?: (m: string) => void; warn?: (m: string) => void; logDir?: string; tickMs?: number;
}): Promise<BootstrapResult> {
  const root = opts.root ?? REPO_ROOT;
  // <root>/.env is optional; real environment variables win over it. Values are never logged.
  const envFile = path.join(root, ".env");
  const env: NodeJS.ProcessEnv = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}), ...opts.env };
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.warn;
  const scenarioDir = path.resolve(root, env.SCENARIO_DIR ?? "scenarios/friday-escalation"); // absolute values are used as given
  const sessionId = env.SESSION_ID ?? "local";
  const port = Number(env.RUNTIME_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return { ok: false, errors: [`RUNTIME_PORT '${env.RUNTIME_PORT}' is not a valid port`] };

  let scenario;
  try { scenario = await loadScenario(scenarioDir); }
  catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }
  const { errors, warnings } = validateScenario(scenario);
  for (const w of warnings) warn(`warning: ${w}`);
  if (errors.length) return { ok: false, errors };

  let host: SessionHost;
  try {
    const clock = new SystemClock();
    const engine = new SessionEngine({ scenario, log: new JsonlEventLog(sessionId, opts.logDir ?? path.join(root, "data", "sessions")), clock });
    const npcProvider = selectModelProvider(env, "npc");
    log(`model provider: ${npcProvider.name}; scenario dir: ${scenarioDir}`);
    host = new SessionHost({ scenario, engine, npcProvider, gmProvider: selectModelProvider(env, "gm"), clock, log: (m) => console.error(m) });
  } catch (err) { return { ok: false, errors: [err instanceof Error ? err.message : String(err)] }; }

  host.startTicker(opts.tickMs ?? 1_000);
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer({ port, hosts: new Map([[sessionId, host]]), log }); }
  catch (err) { host.stopTicker(); return { ok: false, errors: [`cannot listen on port ${port}: ${err instanceof Error ? err.message : String(err)}`] }; }
  log(`scenario "${scenario.meta.title}" v${scenario.meta.version}; session "${sessionId}"; players: ${Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).join(", ")}`);
  return { ok: true, runtime: { port: server.port, host, stop: async () => { host.stopTicker(); await server.close(); } } };
}

async function main(): Promise<void> {
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
