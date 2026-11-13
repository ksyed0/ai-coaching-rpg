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
import { loadControlConfig, loadControlEnv, type ControlConfig } from "./config.js";
import { ReportAccessStore } from "./report-access.js";
import { createParticipantWriteService, warnIfReportsNotWritable } from "./participant-writes.js";
import { createReportService } from "./reports.js";
import { listScenarios, scenarioDir } from "./scenarios.js";
import { SessionList } from "./session-list.js";
import { forkSpawn } from "./spawn.js";
import { Supervisor, type SetTimer, type SpawnFn } from "./supervisor.js";
import { speechSpawn } from "./voice/speech-spawn.js";
import { randomBytes } from "node:crypto";
import { createRoomAdmin, mintParticipantToken, mintWorkerToken } from "@acr/adapters/livekit";
import { liveKitStartProblems, parseLiveKitConfig, voiceTokensWanted } from "./voice/livekit-config.js";
import { AudioCatalog } from "./voice/audio-catalog.js";
import { AudioService } from "./voice/audio-routes.js";
import { AuditLog } from "./voice/audit-log.js";
import { makeFallbackIdentity } from "./voice/log-identity.js";
import { IdentityMutex } from "./voice/store-lock.js";
import { startAudioSweep, stopWithin } from "./voice/sweep.js";
import { livekitProbe } from "./voice/livekit-probe.js";
import { timingLogSink } from "./voice/timing-log.js";
import { VoiceTokens } from "./voice/tokens.js";
import { VoiceHost, type SpeechSpawnFn } from "./voice/voice-host.js";

/** The service listens on loopback only: the BFF is the single caller. */
export const CONTROL_HOST = "127.0.0.1";
/** Time allowed for a request's headers. Small: a legitimate caller sends them at once. */
const HEADERS_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** Slack added to the longest operation before any server-side limit applies. */
const MARGIN_MS = 10_000;
/** The BFF waits 120 s for a create, restart or whole-session reissue; the longest of those here must stay below this (with margin). */
export const BFF_SAFE_OPERATION_MS = 110_000;

const realSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };

/**
 * US-0074 (voice A2b-1a, Task 8): the facilitator's audio listing and replay. Built whenever control runs, independent of VOICE_ENABLED and
 * of the voice host (audio recorded before a rollback to VOICE_ENABLED=0 stays replayable until the sweep removes it). The catalog falls
 * back to the session log's identity (`<sessionsDir>/<id>.jsonl`) for folders recorded before session markers existed.
 */
export function buildAudioService(
  config: Pick<ControlConfig, "audioDir" | "sessionsDir">,
  deps: {
    audit: Pick<AuditLog, "append">;
    /** US-0075: the identity mutex shared with the sweep (default: a private one). */
    mutex?: IdentityMutex;
    /** US-0075: `VoiceHost.isLive` (default: never live). */
    isLive?: (sessionId: string) => boolean;
  },
): AudioService {
  const catalog = new AudioCatalog({ audioDir: config.audioDir, fallbackIdentity: makeFallbackIdentity(config.sessionsDir) });
  return new AudioService({
    catalog, audit: deps.audit, audioDir: config.audioDir, now: Date.now,
    ...(deps.mutex ? { mutex: deps.mutex } : {}), ...(deps.isLive ? { isLive: deps.isLive } : {}),
  });
}

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
  opts: {
    log?: (m: string) => void; spawn?: SpawnFn; port?: number; /** Tests: a stand-in for the evaluate child. */ evalSpawn?: EvalSpawnFn;
    /** Tests and the voice demo: a stand-in for the speech worker fork, and a way to reach the VoiceHost (V-07 kills a worker by pid). */
    speechSpawn?: SpeechSpawnFn; onVoiceHost?: (v: VoiceHost) => void;
    /** Tests: a stand-in for control's LiveKit probe (US-0072); the service probes LIVEKIT_HOST. */ livekitReachable?: () => Promise<boolean>;
  } = {},
): Promise<RunningControl> {
  const config = loadControlConfig(env);
  // US-0071 (A1b Task 5): a bad LiveKit setting, or SPEECH_INGEST=livekit without LiveKit, stops the start (variables named, no value).
  const lkProblems = liveKitStartProblems(env);
  if (lkProblems.length > 0) throw new Error(`invalid control service settings: ${lkProblems.join("; ")}`);
  // US-0072 (A1c Task 12): the room test's timing record, off by default; anything but 0 or 1 stops the start (the variable named only).
  const timingRaw = env.VOICE_TIMING_LOG ?? "";
  if (timingRaw !== "" && timingRaw !== "0" && timingRaw !== "1") throw new Error("invalid control service settings: VOICE_TIMING_LOG must be 0 or 1");
  const lk = parseLiveKitConfig(env);
  const liveKit = lk.ok ? lk.cfg : null;
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
  // US-0073 (A2a Task 8): the audio audit log (opt-in, opt-out, recording stops, sweep deletions), under AUDIO_DIR with its own lock per identity.
  const audit = new AuditLog({ audioDir: config.audioDir, now: Date.now, log });
  // US-0075: ONE identity mutex for the process, shared by the sweep and the facilitator delete (a held identity is skipped or pending).
  const mutex = new IdentityMutex();
  // US-0075: the delete's live check reads the VoiceHost the Supervisor builds below (none without voice hosting: never live).
  let voiceHost: VoiceHost | undefined;
  const supervisor = new Supervisor({
    config, list, scenarios, spawn: opts.spawn ?? forkSpawn(), log, parentEnv: env,
    bots: (deps) => new BotHost({ provider, settings: config.aiPlayer, intents, scenarioFor, log, ...deps }),
    // US-0070: one speech worker per session whose runtime reports voice (VOICE_ENABLED=1 accepted at its bootstrap); none otherwise.
    voice: (deps) => {
      // US-0071: the seat rooms, generations and tokens exist only when control has LiveKit settings and the workers read LiveKit
      // (batch 3 review F8: never with SPEECH_INGEST=file); the key and secret stay here.
      const lkWanted = voiceTokensWanted(env, liveKit) ? liveKit : null;
      const tokens = lkWanted ? new VoiceTokens({
        cfg: lkWanted, admin: createRoomAdmin({ host: lkWanted.host, apiKey: lkWanted.apiKey, apiSecret: lkWanted.apiSecret }),
        mint: mintParticipantToken, mintWorker: mintWorkerToken, random: randomBytes, setTimer: realSetTimer, log,
      }) : undefined;
      // US-0072 (A1c Task 11): the LiveKit probe goes with the tokens (same condition), so an outage is told from a fault.
      const v = new VoiceHost({
        spawn: opts.speechSpawn ?? speechSpawn(), config, parentEnv: env, log, setTimer: realSetTimer, ...deps, now: Date.now,
        ...(timingRaw === "1" ? { timingLog: timingLogSink(config.logDir, { log }) } : {}),
        ...(tokens && lkWanted ? { tokens, livekitReachable: opts.livekitReachable ?? livekitProbe(lkWanted.host) } : {}),
        audit,
      });
      voiceHost = v;
      opts.onVoiceHost?.(v);
      return v;
    },
  });
  await supervisor.resumeAll();
  // US-0073 (A2a Task 9b): the audio retention sweep runs whenever control runs, NOT only with voice hosting: a rollback to VOICE_ENABLED=0
  // must not strand recordings the notice promises to delete. Stopped in close().
  const sweep = startAudioSweep(config, { audit, setTimer: realSetTimer, log, mutex });
  // US-0074: the audio routes, under the same rule (and the same audit log, so a replay's line sits with the sweep's). US-0075: the same mutex.
  const audio = buildAudioService(config, { audit, mutex, isLive: (id) => voiceHost?.isLive(id) ?? false });
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
  // US-0068: the overview's "AI player, not scored" rows read the same source as the link guard (one reader of the log, no shared memo).
  moderation = new ModerationService({ config, jobs, secrets, aiRoles: (id) => aiRolesFor(config, list, id) });

  const server = http.createServer(createApi({ config, supervisor, scenarios, log, reports, participantWrites, jobs, moderation, audio }));
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
    await Promise.all([stopWithin(sweep, realSetTimer), supervisor.shutdown(), jobs.shutdown()]); // resumed children (and bots) must not outlive a service that never started
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
      // The sweep is awaited (bounded) alongside the children, so a deletion that was renamed aside can still write its audit line.
      await Promise.all([stopWithin(sweep, realSetTimer), supervisor.shutdown(), jobs.shutdown()]); // in-flight creates fail as their children go; a running evaluate child is stopped
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
