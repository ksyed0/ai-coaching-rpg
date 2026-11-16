import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider, type ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { AiPlayerBot, BOT_SAY_CONFIRM_MS, type BotDeps } from "../../bots/bot.js";
import type { BotSocket, BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import { SessionBudget } from "../../bots/budget.js";
import { IntentLog } from "../../bots/intent-log.js";

// US-0082 (AC-0483, AC-0489, AC-0491): the bot reports its turns (only to a runtime that says it takes them), replies at once to a line
// addressed to it, and sends the addressee its model chose (the runtime validates it).

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SCENE1 = "s1_huddle";
const PARTICIPANTS = ["delivery_lead", "tech_lead", "account_manager"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
const base = parseAiPlayerSettings({});
if (!base.ok) throw new Error("defaults must parse");
const settings: AiPlayerSettings = base.settings;

type FakeSock = { opts: BotSocketOptions; said: { text: string; sceneId: string; to?: string }[]; activity: unknown[] };
let socks: FakeSock[]; let bots: AiPlayerBot[]; let dir: string;
const open = vi.fn(async (o: BotSocketOptions): Promise<BotSocket> => {
  const f: FakeSock = { opts: o, said: [], activity: [] };
  socks.push(f);
  return {
    say: (text: string, sceneId: string, to?: string) => { f.said.push({ text, sceneId, ...(to !== undefined ? { to } : {}) }); },
    activity: (state: string, outcome?: string) => { f.activity.push(outcome !== undefined ? [state, outcome] : [state]); },
    close: () => Promise.resolve(),
  } as unknown as BotSocket;
});
const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
function make(provider: ModelProvider) {
  const bot = new AiPlayerBot({
    sessionId: "sess-1", roleId: "tech_lead", scenario, provider, settings, budget: new SessionBudget(60), intents: new IntentLog(dir),
    alert: () => {}, needCode: () => {}, now: () => Date.now(), setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, open,
  } satisfies BotDeps);
  bots.push(bot);
  return bot;
}
const feed = (s: FakeSock, f: unknown) => s.opts.onFrame(parseBotFrame(JSON.stringify(f)));
const joined = (over: Record<string, unknown> = {}) => ({
  type: "joined", roleId: "tech_lead", brief: "b", privateFacts: [], reconnectToken: "TOKEN-1",
  state: { status: "running", paused: false, aiRoles: ["tech_lead"], currentScene: { id: SCENE1, participants: PARTICIPANTS }, lastSeq: 5, transcript: [] },
  scenes: [{ id: SCENE1, title: "Huddle", goal: "Agree" }], ...over,
});
async function up(bot: AiPlayerBot, j: Record<string, unknown> = {}): Promise<FakeSock> {
  await bot.attach(4000, "CODE");
  const s = socks.at(-1)!;
  feed(s, joined(j));
  return s;
}
const line = (s: FakeSock, seq: number, roleId: string, text: string, to?: string) => feed(s, { type: "event", event: { seq, type: "utterance", roleId, text, ...(to ? { to } : {}) } });

beforeEach(() => { vi.useFakeTimers(); socks = []; bots = []; open.mockClear(); dir = mkdtempSync(path.join(tmpdir(), "bot-act-")); });
afterEach(async () => { for (const b of bots) await b.stop(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("AiPlayerBot activity and addressing (US-0082)", () => {
  it("test_bot_reports_thinking_then_lets_its_line_end_it", async () => {
    const s = await up(make(new MockModelProvider(["@delivery_lead can you confirm the date?"])), { activity: true });
    line(s, 6, "delivery_lead", "Tech lead, can you size it?", "tech_lead");
    await adv(0); // addressed: no settle wait
    expect(s.activity).toEqual([["thinking"]]);
    expect(s.said).toEqual([{ text: "can you confirm the date?", sceneId: SCENE1, to: "delivery_lead" }]);
    line(s, 7, "tech_lead", "can you confirm the date?", "delivery_lead");
    expect(s.activity).toEqual([["thinking"], ["idle"]]);
  });
  it("test_bot_reports_the_timeout_outcome_and_a_dropped_say", async () => {
    const failing: ModelProvider = { name: "x", async *stream() { throw new Error("boom"); } };
    const s = await up(make(failing), { activity: true });
    line(s, 6, "delivery_lead", "Thoughts?");
    await adv(settings.turn.settleMs);
    expect(s.activity).toEqual([["thinking"], ["idle", "failed"]]);
    const s2 = await up(make(new MockModelProvider(["Sure."])), { activity: true });
    line(s2, 6, "delivery_lead", "Thoughts?");
    await adv(settings.turn.settleMs);
    await adv(BOT_SAY_CONFIRM_MS); // never confirmed
    expect(s2.activity).toEqual([["thinking"], ["idle"]]);
  });
  it("test_bot_sends_no_activity_to_an_older_runtime", async () => {
    const s = await up(make(new MockModelProvider(["Sure."])));
    line(s, 6, "delivery_lead", "Thoughts?");
    await adv(settings.turn.settleMs);
    expect(s.said).toHaveLength(1);
    expect(s.activity).toEqual([]);
  });
  it("test_bot_line_for_someone_else_is_not_answered", async () => {
    const s = await up(make(new MockModelProvider(["Sure."])), { activity: true });
    line(s, 6, "delivery_lead", "Account manager, price?", "account_manager");
    await adv(settings.turn.settleMs * 2);
    expect(s.said).toEqual([]);
  });
});
