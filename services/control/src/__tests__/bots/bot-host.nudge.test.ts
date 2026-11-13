import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { ADDRESS_RULE, nudgeIntent, parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { BotHost } from "../../bots/bot-host.js";
import { type BotSocket, type BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import { IntentLog } from "../../bots/intent-log.js";

/**
 * US-0081 (AC-0470, AC-0471, AC-0473, TC-0250, TC-0251, TC-0253): two AI players and one silent human, through the REAL BotHost and bots
 * over a fake room that echoes every said line to every seat as the runtime would. Fake timers; the test controls order, never elapsed time.
 */
const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SID = "sess-n";
const SCENE1 = "s1_huddle";
const SCENE1_PARTS = ["delivery_lead", "tech_lead", "account_manager"];
const AI = ["delivery_lead", "tech_lead"];

let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
const parsed = parseAiPlayerSettings({});
if (!parsed.ok) throw new Error("defaults must parse");
const settings: AiPlayerSettings = parsed.settings;
const NUDGE = settings.turn.nudgeMs;

/** Answers every call with a fresh line and records the request. */
class Recorder implements ModelProvider {
  readonly name = "recorder";
  readonly calls: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.calls.push(req);
    yield `Line number ${this.calls.length} from an AI player.`;
  }
}

type Seat = { opts: BotSocketOptions };
let dir: string;
let seats: Seat[];
let seq: number;
let spoken: { roleId: string; text: string }[];
let hosts: BotHost[];

const frame = (f: unknown) => parseBotFrame(JSON.stringify(f));
/** Every seat of the room hears the event (the runtime's fan-out). */
const broadcast = (event: Record<string, unknown>) => { for (const s of seats) s.opts.onFrame(frame({ type: "event", event: { seq: ++seq, ...event } })); };
const say = (roleId: string, text: string) => { spoken.push({ roleId, text }); broadcast({ type: "utterance", roleId, text }); };

const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  const seat: Seat = { opts: o };
  seats.push(seat);
  // the runtime records the bot's line and sends it back to everyone, the bot itself included
  return { say: (text: string) => { queueMicrotask(() => say(o.roleId, text)); }, close: async () => undefined } as unknown as BotSocket;
};

const flush = async () => { for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

function joinAll(o: { participants?: string[]; ready?: Record<string, boolean>; aiRoles?: string[] } = {}) {
  const participants = o.participants ?? SCENE1_PARTS;
  const aiRoles = o.aiRoles ?? AI;
  for (const s of seats) {
    s.opts.onFrame(frame({
      type: "joined", roleId: s.opts.roleId, brief: "Your brief", privateFacts: [], reconnectToken: "TOKEN",
      state: { status: "running", paused: false, aiRoles, currentScene: { id: SCENE1, participants }, lastSeq: seq, transcript: [] },
      scenes: [{ id: SCENE1, title: "Huddle", goal: "Agree a position on the module" }],
    }));
  }
  const ready = o.ready ?? { account_manager: true };
  const entries = [...Object.entries(ready).map(([roleId, r]) => ({ roleId, ready: r, ai: false })), ...aiRoles.map((roleId) => ({ roleId, ready: true, ai: true }))];
  for (const s of seats) s.opts.onFrame(frame({ type: "roster", audience: "peers", entries }));
}

async function room(o: { aiRoles?: string[]; participants?: string[]; ready?: Record<string, boolean> } = {}) {
  const provider = new Recorder();
  const h = new BotHost({
    provider, settings, intents: new IntentLog(dir), scenarioFor: async () => scenario,
    reissue: async () => "CODE", alert: () => undefined, now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, open,
  });
  hosts.push(h);
  const aiRoles = o.aiRoles ?? AI;
  await h.attach(SID, { port: 4000, aiRoles, codes: aiRoles.map((roleId) => ({ roleId, code: `code-${roleId}` })) });
  await flush();
  joinAll(o);
  await flush();
  return { h, provider };
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), "bot-nudge-"));
  seats = []; seq = 10; spoken = []; hosts = [];
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("AI players prompt the quiet human (US-0081)", () => {
  it("test_bot_host_two_ai_players_and_one_silent_human_make_exactly_one_nudge_then_silence", async () => {
    const { provider } = await room();
    await adv(NUDGE);
    expect(spoken).toHaveLength(1); // one AI player nudged ...
    await adv(20 * NUDGE);
    expect(spoken).toHaveLength(1); // ... and nobody spoke again, not the other AI player either
    expect(provider.calls).toHaveLength(1);
    expect(AI).toContain(spoken[0]!.roleId);
  });

  it("test_bot_host_the_nudge_addresses_the_human_by_role_title_and_forbids_names", async () => {
    const { provider } = await room();
    await adv(NUDGE);
    const sys = provider.calls[0]!.system;
    expect(sys).toContain(nudgeIntent("Account manager"));
    expect(sys).toContain(ADDRESS_RULE);
    expect(sys).toContain("## Who is in this scene");
    expect(sys).toContain("- Account manager: their lines are shown as [account_manager]");
  });

  it("test_bot_host_a_human_line_reopens_the_floor_for_one_more_nudge", async () => {
    const { provider } = await room();
    await adv(NUDGE);
    expect(spoken).toHaveLength(1);
    say("account_manager", "I would offer a phased module after go-live.");
    await adv(settings.turn.settleMs + settings.turn.minGapMs);
    expect(spoken.slice(2).length).toBeGreaterThanOrEqual(1); // the human line is answered
    const before = spoken.length;
    await adv(2 * NUDGE);
    expect(spoken.length - before).toBe(1); // one more nudge, then silence again
    await adv(20 * NUDGE);
    expect(spoken.length - before).toBe(1);
    expect(provider.calls.length).toBe(spoken.length - 1);
  });

  it("test_bot_host_ai_players_do_not_answer_each_others_nudge", async () => {
    const { provider } = await room();
    await adv(NUDGE);
    await adv(10 * settings.turn.settleMs);
    expect(provider.calls.filter((c) => c.system.includes("React to what was just said"))).toHaveLength(0);
  });

  it("test_bot_host_no_nudge_when_no_human_seat_is_in_the_scene", async () => {
    // scene 1 holds only the two AI players and an AI character; the human is connected but not in the scene
    const { provider } = await room({ participants: ["delivery_lead", "tech_lead", "client_sponsor"] });
    await adv(20 * NUDGE);
    expect(provider.calls).toHaveLength(0);
    expect(spoken).toHaveLength(0);
  });

  it("test_bot_host_the_nudge_targets_the_human_who_spoke_least", async () => {
    // one AI player (tech_lead); two humans; the delivery lead speaks, the account manager stays quiet
    const { provider } = await room({ aiRoles: ["tech_lead"], ready: { delivery_lead: true, account_manager: true } });
    say("delivery_lead", "We cannot add the module before go-live.");
    await adv(settings.turn.settleMs);
    expect(spoken).toHaveLength(2); // the reply
    await adv(2 * NUDGE);
    const nudge = provider.calls.at(-1)!.system;
    expect(nudge).toContain(nudgeIntent("Account manager"));
    expect(nudge).not.toContain(nudgeIntent("Delivery lead"));
  });
});
