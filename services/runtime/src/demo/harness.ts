import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockModelProvider, selectModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { NpcRole, Scenario } from "@acr/script";
import { FakeClock, SystemClock, type Clock } from "../engine/clock.js";
import { JsonlEventLog, MemoryEventLog, type EventLog } from "../engine/event-log.js";
import { SessionEngine } from "../engine/session-engine.js";
import { SessionHost } from "../host/session-host.js";
import { startServer } from "../host/ws-server.js";
import { npcIntro } from "../agents/npc-prompt.js";
import { parseNpcTimeouts } from "../agents/timeouts.js";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";

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

/** A model provider that keeps every request it received (the mock providers do), for the prompt audit. */
export type RecordingProvider = ModelProvider & { readonly calls: ChatRequest[]; /** Scripted queues that ran dry (`<scene>|<role>`), for the scripted providers. */ readonly exhausted?: string[] };

export type System = {
  port: number; host: SessionHost; engine: SessionEngine; clock: Clock; fakeClock?: FakeClock;
  npc?: RecordingProvider; gm?: RecordingProvider;
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

/** A private temp dir for a run's data (the session log). Removed by cleanup(). */
export async function makeTempDataDir(parent: string = os.tmpdir()): Promise<{ root: string; dataDir: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(parent, "acr-showcase-run-"));
  return { root, dataDir: path.join(root, "data"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

export type MockScenePlan = { npc: Record<string, string[]>; gm: string[] };

/**
 * A scripted model for the showcase's mock run. Replies are picked per scene (and, for the AI characters, per character):
 * the NPC provider tells characters apart by the name in its system prompt, the Game Master provider by the scene id.
 * Within one scene and character the replies come out in the scripted order; when they run out, `exhausted` answers.
 */
export class SceneRoutedMock implements RecordingProvider {
  readonly name = "demo-scripted";
  readonly calls: ChatRequest[] = [];
  readonly exhausted: string[] = [];
  private readonly queues = new Map<string, string[]>();
  constructor(private readonly o: { sceneId: () => string | undefined; keyOf: (req: ChatRequest) => string | undefined; plan: Record<string, string[]>; exhausted: string }) {
    for (const [k, v] of Object.entries(o.plan)) this.queues.set(k, [...v]);
  }
  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    const who = this.o.keyOf(req);
    const key = `${this.o.sceneId() ?? ""}|${who ?? ""}`;
    const next = this.queues.get(key)?.shift();
    if (next === undefined) this.exhausted.push(key);
    const words = (next ?? this.o.exhausted).split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      yield i < words.length - 1 ? `${words[i]} ` : words[i]!;
    }
  }
}

/**
 * The showcase's mock system: scripted AI characters and Game Master (per scene), a fake clock, a real JSONL log on disk and
 * a real WebSocket server on port 0.
 */
export async function startShowcaseMockSystem(o: { scenario: Scenario; sessionId: string; dataDir: string; scenes: { scene: string; mock: MockScenePlan }[] }): Promise<System> {
  const ref: { engine?: SessionEngine } = {};
  const sceneId = () => ref.engine?.currentScene()?.id;
  const npcRoles = Object.values(o.scenario.roles).filter((r): r is NpcRole => r.type === "npc");
  const npcPlan: Record<string, string[]> = {}; const gmPlan: Record<string, string[]> = {};
  for (const { scene, mock } of o.scenes) {
    for (const [role, replies] of Object.entries(mock.npc)) npcPlan[`${scene}|${role}`] = replies;
    gmPlan[`${scene}|`] = mock.gm;
  }
  const npc = new SceneRoutedMock({ sceneId, plan: npcPlan, exhausted: "[mock reply]", keyOf: (req) => npcRoles.find((r) => req.system.includes(npcIntro(r)))?.id });
  const gm = new SceneRoutedMock({ sceneId, plan: gmPlan, exhausted: '{"verdict": false, "reasoning": "no scripted verdict left"}', keyOf: () => "" });
  const fakeClock = new FakeClock(T0);
  const sys = await buildSystem({ scenario: o.scenario, sessionId: o.sessionId, dataDir: o.dataDir, clock: fakeClock, fakeClock, npc, gm, npcProvider: npc, gmProvider: gm });
  ref.engine = sys.engine;
  return sys;
}

/** The live system: the configured provider, the real clock and the real ticker. */
export async function startLiveSystem(o: { scenario: Scenario; sessionId: string; dataDir: string; env: NodeJS.ProcessEnv }): Promise<System> {
  const timeouts = parseNpcTimeouts(o.env);
  if (!timeouts.ok) throw new Error(timeouts.errors.join("; "));
  const retry = parseModelRetry(o.env);
  if (!retry.ok) throw new Error(retry.errors.join("; "));
  // Live providers retry transient model errors like the real runtime does (no log line: the demo's host log means "background failure").
  const sys = await buildSystem({
    ...o, clock: new SystemClock(),
    npcProvider: withModelRetry(selectModelProvider(o.env, "npc", { sdkRetries: false }), retry, "NPC"), gmProvider: withModelRetry(selectModelProvider(o.env, "gm", { sdkRetries: false }), retry, "GM"),
    firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs,
  });
  sys.host.startTicker(1_000);
  return sys;
}

export async function buildSystem(o: {
  scenario: Scenario; sessionId: string; dataDir: string; clock: Clock; fakeClock?: FakeClock; npc?: RecordingProvider; gm?: RecordingProvider;
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
