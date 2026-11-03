import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider, type ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { AiPlayerBot, BOT_SAY_CONFIRM_MS, type BotDeps } from "../../bots/bot.js";
import { BOT_AUTH_BACKOFF_MS, type BotSocket, type BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import type { BotAlert } from "../../bots/bot-alerts.js";
import { SessionBudget } from "../../bots/budget.js";
import { IntentLog, type IntentEntry } from "../../bots/intent-log.js";

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SCENE1 = "s1_huddle";
const SCENE2 = "s2_client_call";
const PARTICIPANTS = ["delivery_lead", "tech_lead", "account_manager"];
const CODE = "CODE-SECRET-1";

let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });

const base = parseAiPlayerSettings({});
if (!base.ok) throw new Error("defaults must parse");
const baseSettings: AiPlayerSettings = base.settings;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
const deferred = <T = void>(): Deferred<T> => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

type FakeSock = { opts: BotSocketOptions; said: { text: string; sceneId: string }[]; closeCalls: number; closeGate: Deferred<void> | null; socket: BotSocket };

class RecordingLog extends IntentLog {
  entries: IntentEntry[] = [];
  override append(sessionId: string, roleId: string, e: IntentEntry): void { this.entries.push(e); super.append(sessionId, roleId, e); }
}

let dir: string;
let socks: FakeSock[];
let alerts: BotAlert[];
let needCode: ReturnType<typeof vi.fn<() => void>>;
let intents: RecordingLog;
let bots: AiPlayerBot[];

const open = vi.fn(async (o: BotSocketOptions): Promise<BotSocket> => {
  const f = { opts: o, said: [], closeCalls: 0, closeGate: null } as unknown as FakeSock;
  f.socket = {
    say: (text: string, sceneId: string) => { f.said.push({ text, sceneId }); },
    close: () => { f.closeCalls += 1; return f.closeGate ? f.closeGate.promise : Promise.resolve(); },
  } as unknown as BotSocket;
  socks.push(f);
  return f.socket;
});

const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

function make(over: Partial<BotDeps> = {}, settings: Partial<AiPlayerSettings> = {}) {
  const provider = over.provider ?? new MockModelProvider();
  if (provider instanceof MockModelProvider) provider.defaultReply = "I hear you, let us look at the rollback plan first.";
  const bot = new AiPlayerBot({
    sessionId: "sess-1", roleId: "tech_lead", scenario, provider, settings: { ...baseSettings, ...settings }, budget: new SessionBudget(60), intents,
    alert: (a) => alerts.push(a), needCode: () => needCode(), now: () => Date.now(),
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, open, ...over,
  });
  bots.push(bot);
  return { bot, provider };
}

const frame = (f: unknown) => parseBotFrame(JSON.stringify(f));
const joinedFrame = (over: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  type: "joined", roleId: "tech_lead", brief: "You own the platform", privateFacts: ["Migration is risky"], reconnectToken: "TOKEN-1",
  state: { status: "running", paused: false, aiRoles: ["tech_lead"], currentScene: { id: SCENE1, participants: PARTICIPANTS }, lastSeq: 5, transcript: [], ...state },
  scenes: [{ id: SCENE1, title: "Huddle", goal: "Agree a position" }, { id: SCENE2, title: "Client call", goal: "Hold the line" }], ...over,
});
const feed = (s: FakeSock, f: unknown) => s.opts.onFrame(frame(f));
const ev = (s: FakeSock, event: Record<string, unknown>) => feed(s, { type: "event", event });
const human = (s: FakeSock, seq: number, text = "We need a plan for the migration") => ev(s, { seq, type: "utterance", roleId: "delivery_lead", text });
const own = (s: FakeSock, seq: number) => ev(s, { seq, type: "utterance", roleId: "tech_lead", text: "I hear you" });
const roster = (s: FakeSock, ready: boolean, extra: Record<string, unknown> = {}) =>
  feed(s, { type: "roster", audience: "peers", entries: [{ roleId: "delivery_lead", ready, ai: false, ...extra }, { roleId: "tech_lead", ready: true, ai: true }] });

/** A bot attached and joined (running, scene 1, `tech_lead` is the AI seat); the socket it opened. */
async function up(m: ReturnType<typeof make>, joined: Record<string, unknown> = {}): Promise<FakeSock> {
  await m.bot.attach(4000, CODE);
  const s = socks[socks.length - 1]!;
  feed(s, joinedFrame(joined));
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), "bot-test-"));
  socks = []; alerts = []; bots = []; needCode = vi.fn<() => void>(); open.mockClear();
  intents = new RecordingLog(dir);
});
afterEach(async () => {
  for (const b of bots) await b.stop();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("AiPlayerBot turns", () => {
  it("a human line, then 6 s, makes the bot say the mock reply with expectSceneId scene 1, and the intent is spoken once its own utterance event arrives", async () => {
    const m = make();
    const s = await up(m);
    human(s, 6);
    await adv(5_999);
    expect(s.said).toHaveLength(0);
    await adv(1);
    expect(s.said).toHaveLength(1);
    expect(s.said[0]!.text).toContain("rollback plan");
    expect(s.said[0]!.sceneId).toBe(SCENE1);
    expect(intents.entries).toEqual([]);
    expect(m.bot.speaking).toBe(true);
    own(s, 7);
    expect(intents.entries).toHaveLength(1);
    expect(intents.entries[0]).toMatchObject({ outcome: "spoken", trigger: "reply", sceneId: SCENE1 });
    expect(m.bot.speaking).toBe(false);
  });

  it("a say answered by an error frame (paused) records dropped, not spoken, and does not count toward linesThisScene", async () => {
    const m = make({}, { turn: { ...baseSettings.turn, linesPerScene: 1 } });
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    expect(s.said).toHaveLength(1);
    feed(s, { type: "error", code: "paused", message: "the session is paused" });
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
    expect(m.bot.speaking).toBe(false);
    human(s, 7, "Any thoughts on the rollback?");
    await adv(6_000);
    expect(s.said).toHaveLength(2); // a dropped line did not use the cap of 1
  });

  it("a say that gets neither an utterance nor an error within 10 s is dropped, and a late utterance of its own changes nothing", async () => {
    const m = make();
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    await adv(BOT_SAY_CONFIRM_MS - 1);
    expect(intents.entries).toEqual([]);
    await adv(1);
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
    own(s, 7);
    expect(intents.entries).toHaveLength(1);
  });

  it("the transcript in joined seeds the view and never triggers a reply", async () => {
    const m = make();
    const s = await up(m, {});
    s.opts.onFrame(frame(joinedFrame({}, {
      transcript: [
        { seq: 1, roleId: "delivery_lead", text: "Earlier question about the cutover", sceneId: SCENE1 },
        { seq: 2, roleId: "account_manager", text: "Client wants a date", sceneId: SCENE1 },
      ],
    })));
    roster(s, true);
    await adv(30_000);
    expect(m.provider instanceof MockModelProvider && m.provider.calls).toHaveLength(0);
    human(s, 6);
    await adv(6_000);
    const calls = (m.provider as MockModelProvider).calls;
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain("Earlier question about the cutover");
    expect(sent).toContain("Client wants a date");
  });

  it("an event with seq <= joined.lastSeq is replayed history: it never sets a pending reply", async () => {
    const m = make();
    const s = await up(m);
    human(s, 5);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
    expect((m.provider as MockModelProvider).calls).toHaveLength(0);
  });

  it("the request never contains the participant name sent in the roster", async () => {
    const m = make();
    const s = await up(m);
    roster(s, true, { displayName: "Zorblat Quimby" });
    human(s, 6);
    await adv(6_000);
    const calls = (m.provider as MockModelProvider).calls;
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).not.toContain("Zorblat");
    expect(JSON.stringify(calls[0])).not.toContain("Quimby");
  });

  it("the view keeps only the last 200 lines", async () => {
    const m = make();
    const s = await up(m);
    for (let i = 0; i < 250; i++) human(s, 6 + i, `unique line number ${i} end`);
    await adv(6_000);
    const sent = JSON.stringify((m.provider as MockModelProvider).calls[0]);
    expect(sent).toContain("unique line number 249 end");
    expect(sent).not.toContain("unique line number 49 end");
  });

  it("participantId starts with ai- and stays the same across re-attach", async () => {
    const m = make();
    await m.bot.attach(4000, CODE);
    await m.bot.attach(4000, CODE);
    expect(m.bot.participantId).toMatch(/^ai-[0-9a-f]{16}$/);
    expect(socks.map((x) => x.opts.participantId)).toEqual([m.bot.participantId, m.bot.participantId]);
  });

  it("a re-attach presents the code and the last reconnect token; the first attach has no token", async () => {
    const m = make();
    const s = await up(m);
    expect(s.opts.reconnectToken).toBeUndefined();
    await m.bot.attach(4001, CODE);
    expect(socks[1]!.opts.reconnectToken).toBe("TOKEN-1");
    expect(socks[1]!.opts.port).toBe(4001);
    expect(socks[1]!.opts.code).toBe(CODE);
  });
});

describe("AiPlayerBot late replies", () => {
  const gated = () => {
    const gate = deferred();
    const calls: number[] = [];
    const provider: ModelProvider = { name: "gated", stream: () => (async function* () { calls.push(1); await gate.promise; yield "A late but fine reply about the plan."; })() };
    return { provider, gate, calls };
  };

  it("a reply that returns after detach and re-attach is dropped and never sent", async () => {
    const g = gated();
    const m = make({ provider: g.provider });
    const s1 = await up(m);
    human(s1, 6);
    await adv(6_000);
    expect(g.calls).toHaveLength(1);
    await m.bot.detach();
    const s2 = await up(m);
    g.gate.resolve();
    await flush();
    expect(s1.said).toHaveLength(0);
    expect(s2.said).toHaveLength(0);
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
    expect(m.bot.speaking).toBe(false);
  });

  it.each([
    ["pause", { type: "facilitator.command", command: "pause" }],
    ["a scene change", { type: "scene.entered", sceneId: SCENE2, participants: PARTICIPANTS }],
    ["the end", { type: "session.ended" }],
  ])("a reply that returns after %s is dropped", async (_name, event) => {
    const g = gated();
    const m = make({ provider: g.provider });
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    expect(g.calls).toHaveLength(1);
    ev(s, { seq: 7, ...event });
    g.gate.resolve();
    await flush();
    expect(s.said).toHaveLength(0);
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
    expect(m.bot.speaking).toBe(false);
  });

  it("a never-yielding provider: at hardTimeoutMs the turn ends skipped/timeout, the in-flight flag clears, one alert skippedTimeout is raised, and the later result is ignored", async () => {
    const gate = deferred();
    const provider: ModelProvider = { name: "never", stream: () => (async function* () { await gate.promise; yield "far too late to matter"; })() };
    const m = make({ provider }, { firstTokenTimeoutMs: 600_000, replyTimeoutMs: 600_000, hardTimeoutMs: 1_000 });
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    expect(m.bot.speaking).toBe(true);
    await adv(1_000);
    expect(m.bot.speaking).toBe(false);
    expect(intents.entries).toHaveLength(1);
    expect(intents.entries[0]).toMatchObject({ outcome: "skipped", reason: "timeout", trigger: "reply" });
    expect(alerts).toEqual(["skippedTimeout"]);
    gate.resolve();
    await flush();
    expect(s.said).toHaveLength(0);
    expect(intents.entries).toHaveLength(1);
    expect(alerts).toEqual(["skippedTimeout"]);
  });
});

describe("AiPlayerBot skips, nudges and budget", () => {
  it("three model failures in a row raise one alert", async () => {
    const m = make({ provider: new MockModelProvider([new Error("boom"), new Error("boom"), new Error("boom")]) });
    const s = await up(m);
    for (let i = 0; i < 3; i++) { human(s, 6 + i); await adv(6_000); }
    expect(intents.entries.map((e) => `${e.outcome}/${e.reason}`)).toEqual(["skipped/model_failed", "skipped/model_failed", "skipped/model_failed"]);
    expect(alerts).toEqual(["skippedModel"]);
  });

  it("a spoken line ends a skip streak, so the next skip alerts again", async () => {
    const m = make({ provider: new MockModelProvider([new Error("boom"), "Fine, here is my view.", new Error("boom")]) });
    const s = await up(m);
    human(s, 6); await adv(6_000);
    human(s, 7); await adv(6_000);
    own(s, 8);
    human(s, 9); await adv(15_000);
    expect(alerts).toEqual(["skippedModel", "skippedModel"]);
  });

  it("no nudge is taken while the peers roster shows no human ready, and one is taken 90 s after a human becomes ready", async () => {
    const m = make();
    const s = await up(m);
    roster(s, false);
    await adv(200_000);
    expect((m.provider as MockModelProvider).calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    roster(s, true);
    await adv(89_999);
    expect((m.provider as MockModelProvider).calls).toHaveLength(0);
    await adv(1);
    expect((m.provider as MockModelProvider).calls).toHaveLength(1);
    expect(s.said).toHaveLength(1);
    own(s, 6);
    expect(intents.entries[0]).toMatchObject({ outcome: "spoken", trigger: "nudge" });
  });

  it("after 3 consecutive failed nudges the bot stops nudging until a human line arrives, and then replies", async () => {
    const m = make({ provider: new MockModelProvider([new Error("a"), new Error("b"), new Error("c")]) });
    const s = await up(m);
    roster(s, true);
    await adv(90_000);
    await adv(90_000);
    await adv(90_000);
    const calls = (m.provider as MockModelProvider).calls;
    expect(calls).toHaveLength(3);
    await adv(1_000_000);
    expect(calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    human(s, 6);
    await adv(6_000);
    expect(calls).toHaveLength(4);
    expect(s.said).toHaveLength(1);
  });

  it("a human line in between resets the count of failed nudges", async () => {
    const m = make({ provider: new MockModelProvider([new Error("a"), new Error("b"), "Spoken at last after a line.", new Error("c"), new Error("d"), new Error("e")]) });
    const s = await up(m);
    roster(s, true);
    await adv(90_000);
    await adv(90_000);
    human(s, 6); // a human line: the count restarts, and this reply is the third scripted answer
    await adv(6_000);
    own(s, 7);
    for (let i = 0; i < 3; i++) await adv(90_000);
    await adv(500_000);
    expect((m.provider as MockModelProvider).calls).toHaveLength(6);
  });

  it("the 61st call is not made: intent skipped/budget and one budget alert", async () => {
    const budget = new SessionBudget(60, 59);
    const m = make({ budget });
    const s = await up(m);
    human(s, 6); await adv(6_000);
    own(s, 7);
    expect(budget.used).toBe(60);
    human(s, 8); await adv(15_000);
    human(s, 9); await adv(15_000);
    expect((m.provider as MockModelProvider).calls).toHaveLength(1);
    expect(intents.entries.map((e) => `${e.outcome}/${e.reason ?? ""}`)).toEqual(["spoken/", "skipped/budget", "skipped/budget"]);
    expect(alerts).toEqual(["budget"]);
  });

  it("every begun turn takes a budget unit before the call, even when its line is dropped", async () => {
    const gate = deferred();
    const provider: ModelProvider = { name: "g", stream: () => (async function* () { await gate.promise; yield "too late"; })() };
    const budget = new SessionBudget(10);
    const m = make({ provider, budget });
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    expect(budget.used).toBe(1); // taken while the model is still being waited for
    ev(s, { seq: 7, type: "facilitator.command", command: "pause" });
    gate.resolve();
    await flush();
    expect(budget.used).toBe(1);
    expect(s.said).toHaveLength(0);
  });
});

describe("AiPlayerBot prompt", () => {
  it("runPrompt is false when not connected; true once connected, begins a prompt turn with the hint, and is false while in flight", async () => {
    const m = make();
    expect(m.bot.runPrompt("be brief")).toBe(false);
    const s = await up(m);
    expect(m.bot.runPrompt("press on the deadline")).toBe(true);
    expect(m.bot.runPrompt("again")).toBe(false);
    await flush();
    const calls = (m.provider as MockModelProvider).calls;
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0])).toContain("press on the deadline");
    expect(s.said).toHaveLength(1);
    own(s, 6);
    expect(intents.entries[0]).toMatchObject({ outcome: "spoken", trigger: "prompt", hint: "press on the deadline" });
    expect(m.bot.runPrompt("next")).toBe(true);
  });

  it("runPrompt is false before the session is running", async () => {
    const m = make();
    await up(m, { state: { ...joinedFrame().state, status: "idle", currentScene: null } });
    expect(m.bot.runPrompt("go")).toBe(false);
  });
});

describe("AiPlayerBot connection", () => {
  it("unauthorized calls needCode once; a refusal of the new code waits 65 s before one more try; a third refusal raises rejoinFailed and stops", async () => {
    const m = make();
    await m.bot.attach(4000, "OLD-CODE");
    feed(socks[0]!, { type: "error", code: "unauthorized", message: "no" });
    expect(needCode).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([]);
    await m.bot.attach(4000, "NEW-CODE");
    expect(open).toHaveBeenCalledTimes(2);
    feed(socks[1]!, { type: "error", code: "unauthorized", message: "no" });
    expect(needCode).toHaveBeenCalledTimes(1);
    await adv(BOT_AUTH_BACKOFF_MS - 1);
    expect(open).toHaveBeenCalledTimes(2);
    await adv(1);
    expect(open).toHaveBeenCalledTimes(3);
    expect(socks[2]!.opts.code).toBe("NEW-CODE");
    feed(socks[2]!, { type: "error", code: "unauthorized", message: "no" });
    expect(alerts).toEqual(["rejoinFailed"]);
    expect(needCode).toHaveBeenCalledTimes(1);
    await adv(10 * BOT_AUTH_BACKOFF_MS);
    expect(open).toHaveBeenCalledTimes(3);
    expect(m.bot.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a successful join clears the refusal count", async () => {
    const m = make();
    await m.bot.attach(4000, "OLD-CODE");
    feed(socks[0]!, { type: "error", code: "unauthorized", message: "no" });
    await m.bot.attach(4000, "NEW-CODE");
    feed(socks[1]!, joinedFrame());
    feed(socks[1]!, { type: "error", code: "unauthorized", message: "no" });
    expect(needCode).toHaveBeenCalledTimes(2);
  });

  it("attach awaits the old socket's close before opening the new one", async () => {
    const m = make();
    await m.bot.attach(4000, CODE);
    const gate = deferred();
    socks[0]!.closeGate = gate;
    const p = m.bot.attach(4000, CODE);
    await flush();
    expect(socks[0]!.closeCalls).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    gate.resolve();
    await p;
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("a 4002 close does not reconnect (nor any other close); the host's next attach does", async () => {
    const m = make();
    const s = await up(m);
    s.opts.onClose(4002, { byUs: false });
    await flush();
    expect(m.bot.connected).toBe(false);
    await adv(300_000);
    expect(open).toHaveBeenCalledTimes(1);
    await m.bot.attach(4000, CODE);
    expect(open).toHaveBeenCalledTimes(2);
    expect(m.bot.connected).toBe(true);
  });

  it("a close caused by us, or by an old socket, is ignored", async () => {
    const m = make();
    const s1 = await up(m);
    await m.bot.attach(4000, CODE);
    s1.opts.onClose(1000, { byUs: true });
    s1.opts.onClose(1006, { byUs: false }); // the old generation
    expect(m.bot.connected).toBe(true);
    socks[1]!.opts.onClose(1000, { byUs: true });
    expect(m.bot.connected).toBe(true);
  });

  it("frames from an old socket are ignored", async () => {
    const m = make();
    const s1 = await up(m);
    const s2 = await up(m);
    human(s1, 6);
    human(s2, 6);
    await adv(6_000);
    expect(s1.said).toHaveLength(0);
    expect(s2.said).toHaveLength(1);
  });

  it("a frame on a socket that closed mid-turn drops the turn: nothing is said after the loss", async () => {
    const gate = deferred();
    const provider: ModelProvider = { name: "g", stream: () => (async function* () { await gate.promise; yield "Reply after the socket was lost."; })() };
    const m = make({ provider });
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    s.opts.onClose(1006, { byUs: false });
    gate.resolve();
    await flush();
    expect(s.said).toHaveLength(0);
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
  });

  it("no timers remain after detach or stop", async () => {
    const gate = deferred();
    const provider: ModelProvider = { name: "g", stream: () => (async function* () { await gate.promise; yield "x"; })() };
    const m = make({ provider });
    const s = await up(m);
    roster(s, true);
    expect(vi.getTimerCount()).toBe(1); // exactly one: the wake at the nudge deadline
    human(s, 6);
    expect(vi.getTimerCount()).toBe(1); // re-armed, not added
    await adv(6_000);
    await m.bot.detach();
    gate.resolve();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    const s2 = await up(m);
    roster(s2, true);
    expect(vi.getTimerCount()).toBe(1);
    await m.bot.stop();
    expect(vi.getTimerCount()).toBe(0);
    await m.bot.attach(4000, CODE); // a stopped bot never reconnects
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("a say pending its confirmation leaves no timer after detach", async () => {
    const m = make();
    const s = await up(m);
    human(s, 6);
    await adv(6_000);
    expect(s.said).toHaveLength(1);
    await m.bot.detach();
    expect(vi.getTimerCount()).toBe(0);
    expect(intents.entries.map((e) => e.outcome)).toEqual(["dropped"]);
  });

  it("an open that fails rejects attach without leaving the bot connected", async () => {
    const m = make({ open: vi.fn(async () => { throw new Error("bot socket could not connect (ECONNREFUSED)"); }) });
    await expect(m.bot.attach(4000, CODE)).rejects.toThrow(/could not connect/);
    expect(m.bot.connected).toBe(false);
  });
});

describe("AiPlayerBot secrets", () => {
  it(`no alert argument, intent entry, Error or inspected field ever contains the code "${CODE}"`, async () => {
    const failing = vi.fn(async () => { throw new Error("bot socket could not connect (ECONNREFUSED)"); });
    const m = make({ provider: new MockModelProvider([new Error("boom"), "Fine, here it is."]), budget: new SessionBudget(2) });
    const s = await up(m);
    human(s, 6); await adv(6_000); // skipped: alert
    human(s, 7); await adv(6_000); // spoken
    own(s, 8);
    human(s, 9); await adv(15_000); // budget
    feed(s, { type: "error", code: "unauthorized", message: "bad code" });
    await m.bot.attach(4000, CODE);
    feed(socks[1]!, { type: "error", code: "unauthorized", message: "bad code" });
    await adv(BOT_AUTH_BACKOFF_MS);
    feed(socks[2]!, { type: "error", code: "unauthorized", message: "bad code" });
    const errors: string[] = [];
    const bad = make({ open: failing });
    await bad.bot.attach(4000, CODE).catch((e: Error) => errors.push(e.message));
    expect(alerts.length).toBeGreaterThanOrEqual(3);
    for (const blob of [JSON.stringify(alerts), JSON.stringify(intents.entries), JSON.stringify(errors), inspect(m.bot, { depth: 3, showHidden: true }), JSON.stringify(intents.read("sess-1", "tech_lead"))]) {
      expect(blob).not.toContain(CODE);
    }
  });
});
