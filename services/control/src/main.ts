import http from "node:http";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startLivePlayerProvider } from "@acr/runtime/players";
import { collectSecrets } from "@acr/runtime/reports";
import { loadScenario, type Scenario } from "@acr/script";
import { BotHost } from "./bots/bot-host.js";
import { IntentLog } from "./bots/intent-log.js";
import { aiRolesFor } from "./ai-roles.js";
import { createApi } from "./api.js";
import type { EvalSpawnFn } from "./eval-child.js";
import { ModerationService } from "./moderation.js";
import { ReportJobService } from "./report-job.js";
import { loadControlConfig, loadControlEnv } from "./config.js";
import { ReportAccessStore } from "./report-access.js";
import { createParticipantWriteService, warnIfReportsNotWritable } from "./participant-writes.js";
import { createReportService } from "./reports.js";
import { listScenarios, scenarioDir } from "./scenarios.js";
import { SessionList } from "./session-list.js";
import { forkSpawn } from "./spawn.js";
import { Supervisor, type SpawnFn } from "./supervisor.js";

/** The service listens on loopback only: the BFF is the single caller. */
export const CONTROL_HOST = "127.0.0.1";
/** Time allowed for a request's headers. Small: a legitimate caller sends them at once. */
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** Slack added to the longest operation before any server-side limit applies. */
const MARGIN_MS = 10_000;
/** The BFF waits 120 s for a create, restart or whole-session reissue; the longest of those here must stay below this (with margin). */
export const BFF_SAFE_OPERATION_MS = 110_000;

export type RunningControl = {
  port: number;
  /** Stops listening, disconnects every runtime child and waits for them (bounded by the grace period), then closes the server. */
  close(): Promise<void>;
  /** The longest `close()` can legitimately take; the entry point arms a hard-exit timer a little beyond it. */
  shutdownBudgetMs: number;
};

/**
 * Starts the control service from an environment (already merged with `.env`, see `loadControlEnv`). Throws ONE plain Error for bad
 * settings (no values), for a port that cannot be bound, or for an unusable session list. Existing sessions are resumed BEFORE
 * listening, so the API never answers while a resume is half done. `opts` is for tests (`port: 0`, a fake `spawn`).
 */
export async function startControl(
  env: NodeJS.ProcessEnv,
  opts: { log?: (m: string) => void; spawn?: SpawnFn; port?: number; /** Tests: a stand-in for the evaluate child. */ evalSpawn?: EvalSpawnFn } = {},
): Promise<RunningControl> {
  const config = loadControlConfig(env);
  const log = opts.log ?? (() => {});
  const longest = config.readyTimeoutMs + 2 * config.graceMs;
  if (longest > BFF_SAFE_OPERATION_MS)
    log(`warning: CONTROL_READY_TIMEOUT_MS + 2 * CONTROL_GRACE_MS is ${longest} ms; the web server gives up on a create or restart after 120000 ms, so keep the sum under ${BFF_SAFE_OPERATION_MS} ms`);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const scenarios = () => listScenarios(config.scenariosDir, (folder) => log(`scenario folder skipped: ${folder}`));
  const list = new SessionList(config.listFile);
  const intents = new IntentLog(config.intentsDir, log);
  const provider = startLivePlayerProvider(env, config.aiPlayer);
  // BotHost caches the scenario per session itself.
  const scenarioFor = async (sessionId: string): Promise<Scenario> => {
    const entry = list.read().find((e) => e.sessionId === sessionId);
    if (!entry) throw new Error("unknown session");
    return loadScenario(scenarioDir(config.scenariosDir, entry.scenarioId));
  };
  const supervisor = new Supervisor({
    config, list, scenarios, spawn: opts.spawn ?? forkSpawn(), log, parentEnv: env,
    bots: (deps) => new BotHost({ provider, settings: config.aiPlayer, intents, scenarioFor, log, ...deps }),
  });
  await supervisor.resumeAll();
  // ONE store for the whole service: two instances on one file would lose each other's updates, and a stale list could undo a revoke.
  const store = new ReportAccessStore({ file: config.reportAccessFile, days: config.reportAccessDays, now: Date.now });
  const secrets = collectSecrets(env);
  // The AI-role guard reads each session's own log (US-0060); an unreadable set fails issue and reissue closed.
  const reports = createReportService({ config, store, secrets, now: Date.now, log, aiRoles: (id) => aiRolesFor(config, list, id) });
  const participantWrites = createParticipantWriteService({
    config, store, secrets, now: Date.now, log, random: Math.random,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
  await warnIfReportsNotWritable(config.reportsDir, log);
  // The evaluate job and the review operations need each other: the job opens the review when it is done, the review service reads the job.
  // `env` is the .env-merged environment the supervisor gets, so a model key that lives only in .env reaches the evaluate child (which runs with NO_DOTENV=1).
  let moderation: ModerationService | undefined;
  const jobs = new ReportJobService({
    config, parentEnv: env, log, ...(opts.evalSpawn ? { spawn: opts.evalSpawn } : {}),
    sessions: { get: (id) => { const s = supervisor.get(id); return s ? { scenarioId: s.scenarioId, ended: s.status === "ended" } : undefined; } },
    onDone: async (id, _outputDir, by) => {
      let opened = false;
      try { opened = (await moderation?.open(id, by))?.status === 200; } catch { /* logged below */ }
      if (!opened) log("report open after evaluate did not complete");
    },
  });
  moderation = new ModerationService({ config, jobs, secrets });

  const server = http.createServer(createApi({ config, supervisor, scenarios, log, reports, participantWrites, jobs, moderation }));
  // Create, restart and a whole-session reissue can take up to readyTimeoutMs + 2 * graceMs (a start, then a stop and a forced stop),
  // so no limit may be shorter than that (Ruling R10). Node's requestTimeout bounds only the time to RECEIVE a request (the bodies here
  // are at most 64 KB), not the response, and `timeout` (idle socket) is off by default; both are set explicitly so a Node default
  // change cannot cut a long operation. Only the header wait stays short, against a stalled connection.
  const longestOp = config.readyTimeoutMs + 2 * config.graceMs;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = longestOp + MARGIN_MS;
  server.timeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  const port = opts.port ?? config.port;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, CONTROL_HOST, () => { server.off("error", reject); resolve(); });
    });
  } catch (err) {
    await Promise.all([supervisor.shutdown(), jobs.shutdown()]); // resumed children (and bots) must not outlive a service that never started
    throw new Error(`cannot listen on ${CONTROL_HOST}:${port} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  server.on("error", () => log("server error"));
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await Promise.all([supervisor.shutdown(), jobs.shutdown()]); // in-flight creates fail as their children go; a running evaluate child is stopped
      server.closeAllConnections();
      await stopped;
    })();
    return closing;
  };
  return { port: boundPort, close, shutdownBudgetMs: 2 * config.graceMs + MARGIN_MS };
}

async function main(): Promise<void> {
  let running: RunningControl;
  try {
    running = await startControl(loadControlEnv(), { log: (m) => console.log(m) });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : "the control service could not start"}`);
    process.exit(1);
  }
  console.log(`control service listening on ${CONTROL_HOST}:${running.port}`);
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    // Backstop: a hung shutdown must not keep this process alive (the children exit by themselves when the IPC channel closes).
    setTimeout(() => process.exit(1), running.shutdownBudgetMs).unref();
    void running.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only run when executed directly (tsx src/main.ts), never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
