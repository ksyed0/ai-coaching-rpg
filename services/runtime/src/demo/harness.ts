import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockModelProvider, selectModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { Scenario } from "@acr/script";
import { FakeClock, SystemClock, type Clock } from "../engine/clock.js";
import { JsonlEventLog, MemoryEventLog, type EventLog } from "../engine/event-log.js";
import { SessionEngine } from "../engine/session-engine.js";
import { SessionHost } from "../host/session-host.js";
import { startServer } from "../host/ws-server.js";
import { parseNpcTimeouts } from "../agents/timeouts.js";

/** A distinctive fake key set in the runner's own env object. It is never used to call anything; the audit proves it never leaks. */
export const FAKE_KEY = "sk-ant-demo-FAKE-DO-NOT-USE-0123456789abcdefghijklmnop";
export const MIN = 60_000;
/** Scenario time zero for the fake clock. */
export const T0 = 1_800_000_000_000;

export type TempRoot = { root: string; dataDir: string; scenarioDir: string; cleanup(): Promise<void> };

/** A private temp tree holding a copy of the scenario (so bootstrap() can run against it) and the data dir. Removed by cleanup(). */
export async function makeTempRoot(repoRoot: string): Promise<TempRoot> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acr-demo-"));
  const scenarioDir = path.join(root, "scenarios", "friday-escalation");
  await cp(path.join(repoRoot, "scenarios", "friday-escalation"), scenarioDir, { recursive: true });
  return { root, dataDir: path.join(root, "data"), scenarioDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export type System = {
  port: number; host: SessionHost; engine: SessionEngine; clock: Clock; fakeClock?: FakeClock;
  npc?: MockModelProvider; gm?: MockModelProvider;
  /** Lines the host's background workers reported (must stay empty) and the server's own log lines. */
  hostLog: string[]; serverLog: string[];
  logFile: string;
  stop(): Promise<void>;
};

/** The scripted models for the mock run. Order matters: it is the whole Game Master / NPC script. */
export const NPC_SCRIPT = [
  "Thanks for calling. So, can you confirm the reconciliation module for go-live?",
  "I hear you. What would phasing actually look like for Finance?",
  "Hm. Can you put a number on that?",
  "Alright. Send me the phased plan by Monday and I will take it to the CFO.",
];
export const GM_MALFORMED = "I am not able to decide right now, sorry.";
export const GM_SCRIPT = [
  '{"verdict": false, "reasoning": "still discussing"}',
  GM_MALFORMED,
  '{"verdict": true, "reasoning": "delivery lead summarised one position and the others agreed"}',
  '{"verdict": false, "reasoning": "no next step yet"}',
  '{"verdict": true, "reasoning": "a phased plan by Monday was agreed"}',
];

/** The mock system: scripted models, a fake clock, a real JSONL log on disk and a real WebSocket server on port 0. */
export async function startMockSystem(o: { scenario: Scenario; sessionId: string; dataDir: string }): Promise<System> {
  const fakeClock = new FakeClock(T0);
  const npc = new MockModelProvider(NPC_SCRIPT);
  const gm = new MockModelProvider(GM_SCRIPT);
  return buildSystem({ ...o, clock: fakeClock, fakeClock, npc, gm, npcProvider: npc, gmProvider: gm });
}

/** The live system: the configured provider, the real clock and the real ticker. */
export async function startLiveSystem(o: { scenario: Scenario; sessionId: string; dataDir: string; env: NodeJS.ProcessEnv }): Promise<System> {
  const timeouts = parseNpcTimeouts(o.env);
  if (!timeouts.ok) throw new Error(timeouts.errors.join("; "));
  const sys = await buildSystem({
    ...o, clock: new SystemClock(), npcProvider: selectModelProvider(o.env, "npc"), gmProvider: selectModelProvider(o.env, "gm"),
    firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs,
  });
  sys.host.startTicker(1_000);
  return sys;
}

async function buildSystem(o: {
  scenario: Scenario; sessionId: string; dataDir: string; clock: Clock; fakeClock?: FakeClock; npc?: MockModelProvider; gm?: MockModelProvider;
  npcProvider: ModelProvider; gmProvider: ModelProvider; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; log?: EventLog; heartbeatMs?: number;
}): Promise<System> {
  const hostLog: string[] = []; const serverLog: string[] = [];
  const log = o.log ?? new JsonlEventLog(o.sessionId, o.dataDir);
  const engine = new SessionEngine({ scenario: o.scenario, log, clock: o.clock });
  const host = new SessionHost({
    scenario: o.scenario, engine, npcProvider: o.npcProvider, gmProvider: o.gmProvider, clock: o.clock,
    log: (m) => hostLog.push(m), firstTokenTimeoutMs: o.firstTokenTimeoutMs, replyTimeoutMs: o.replyTimeoutMs,
  });
  const server = await startServer({ port: 0, hosts: new Map([[o.sessionId, host]]), log: (m) => serverLog.push(m), heartbeatMs: o.heartbeatMs });
  return {
    port: server.port, host, engine, clock: o.clock, fakeClock: o.fakeClock, npc: o.npc, gm: o.gm, hostLog, serverLog,
    logFile: path.join(o.dataDir, `${o.sessionId}.jsonl`),
    stop: async () => { host.stopTicker(); await server.close(); },
  };
}

/**
 * A model that misbehaves on purpose for the side room: its first call stalls until aborted (first-token timeout), its
 * second returns an empty reply, later calls answer normally.
 */
export class MisbehavingProvider implements ModelProvider {
  readonly name = "demo-misbehaving";
  readonly calls: ChatRequest[] = [];
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    const n = this.calls.length;
    if (n === 1) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }
    if (n === 2) { yield ""; return; }
    yield "Fine, go on.";
  }
}

export const LAB_HEARTBEAT_MS = 200;
export const LAB_FIRST_TOKEN_MS = 400;
export const LAB_REPLY_MS = 800;

/** The side room: short heartbeat and NPC timeouts and a misbehaving NPC model, on its own in-memory log and port. */
export async function startLabSystem(o: { scenario: Scenario; sessionId: string }): Promise<System & { npcProvider: MisbehavingProvider }> {
  const npcProvider = new MisbehavingProvider();
  const clock = new FakeClock(T0);
  const sys = await buildSystem({
    scenario: o.scenario, sessionId: o.sessionId, dataDir: "", clock, fakeClock: clock, log: new MemoryEventLog(o.sessionId),
    npcProvider, gmProvider: new MockModelProvider(), firstTokenTimeoutMs: LAB_FIRST_TOKEN_MS, replyTimeoutMs: LAB_REPLY_MS, heartbeatMs: LAB_HEARTBEAT_MS,
  });
  return Object.assign(sys, { npcProvider });
}
