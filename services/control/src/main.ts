import http from "node:http";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createApi } from "./api.js";
import { loadControlConfig, loadControlEnv } from "./config.js";
import { listScenarios } from "./scenarios.js";
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
  opts: { log?: (m: string) => void; spawn?: SpawnFn; port?: number } = {},
): Promise<RunningControl> {
  const config = loadControlConfig(env);
  const log = opts.log ?? (() => {});
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const scenarios = () => listScenarios(config.scenariosDir, (folder) => log(`scenario folder skipped: ${folder}`));
  const supervisor = new Supervisor({
    config, list: new SessionList(config.listFile), scenarios, spawn: opts.spawn ?? forkSpawn(), log, parentEnv: env,
  });
  await supervisor.resumeAll();

  const server = http.createServer(createApi({ config, supervisor, scenarios, log }));
  // Create, restart and a whole-session reissue can take up to readyTimeoutMs + 2 * graceMs (a start, then a stop and a forced stop),
  // so no limit may be shorter than that (Ruling R10). Node's requestTimeout bounds only the time to RECEIVE a request (the bodies here
  // are at most 4 KB), not the response, and `timeout` (idle socket) is off by default; both are set explicitly so a Node default
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
    await supervisor.shutdown(); // resumed children must not outlive a service that never started
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
      await supervisor.shutdown(); // in-flight creates fail as their children go
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
