import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { AiPlayerBot } from "../../bots/bot.js";
import { BotHost } from "../../bots/bot-host.js";
import { type BotSocket, type BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import { SessionBudget } from "../../bots/budget.js";
import { IntentLog } from "../../bots/intent-log.js";

// US-0070 (Task 9, AC-0400, overview C8): AI players wake once per voice turn. While the runtime reports a voice turn open (voice_turn),
// a bot begins no reply or nudge and keeps only the LAST human line it saw; on close it observes that one line and re-arms. The prompt
// reservation hold is a separate flag. Fake timers only: no real time.
const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SCENE1 = "s1_huddle";
const PARTICIPANTS = ["delivery_lead", "tech_lead", "account_manager"];
let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
const parsed = parseAiPlayerSettings({});
if (!parsed.ok) throw new Error("defaults must parse");
const settings: AiPlayerSettings = parsed.settings;

type FakeSock = { opts: BotSocketOptions; said: string[] };
let dir: string;
let socks: FakeSock[];
let bots: AiPlayerBot[];
let hosts: BotHost[];
const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  const f: FakeSock = { opts: o, said: [] };
  socks.push(f);
  return { say: (text: string) => { f.said.push(text); }, close: async () => undefined } as unknown as BotSocket;
};
const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };
const setTimer = (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); };
const frame = (f: unknown) => parseBotFrame(JSON.stringify(f));
const joinedFrame = (roleId: string) => ({
  type: "joined", roleId, brief: "You own the platform", privateFacts: [], reconnectToken: "TOKEN-1",
  state: { status: "running", paused: false, aiRoles: [roleId], currentScene: { id: SCENE1, participants: PARTICIPANTS }, lastSeq: 5, transcript: [] },
  scenes: [{ id: SCENE1, title: "Huddle", goal: "Agree a position" }],
});
const feed = (s: FakeSock, f: unknown) => s.opts.onFrame(frame(f));
const ev = (s: FakeSock, event: Record<string, unknown>) => feed(s, { type: "event", event });
const human = (s: FakeSock, seq: number, roleId = "delivery_lead") => ev(s, { seq, type: "utterance", roleId, text: `line ${seq}` });
const own = (s: FakeSock, seq: number) => ev(s, { seq, type: "utterance", roleId: "tech_lead", text: "I hear you" });

function makeBot() {
  const provider = new MockModelProvider();
  provider.defaultReply = "Let us look at the rollback plan first.";
  const bot = new AiPlayerBot({
    sessionId: "sess-1", roleId: "tech_lead", scenario, provider, settings, budget: new SessionBudget(60), intents: new IntentLog(dir),
    alert: () => undefined, needCode: () => undefined, now: () => Date.now(), setTimer, open,
  });
  bots.push(bot);
  return { bot, provider };
}
async function up(bot: AiPlayerBot): Promise<FakeSock> {
  await bot.attach(4000, "CODE-1");
  const s = socks[socks.length - 1]!;
  feed(s, joinedFrame("tech_lead"));
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), "bot-voice-"));
  socks = []; bots = []; hosts = [];
});
afterEach(async () => {
  for (const b of bots) await b.stop();
  for (const h of hosts) await h.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("AiPlayerBot and voice turns (US-0070, AC-0400)", () => {
  it("three human lines in an open voice turn give one reply after close", async () => {
    const { bot, provider } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    human(s, 6); human(s, 7, "account_manager"); human(s, 8);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    bot.setVoiceTurn(false);
    await adv(6_000);
    expect(s.said).toHaveLength(1);
    own(s, 9);
    await adv(30_000);
    expect(s.said).toHaveLength(1);
    // The view still holds every line, in order: only the policy's observation was coalesced.
    const req = JSON.stringify(provider.calls[0]);
    for (const n of [6, 7, 8]) expect(req).toContain(`line ${n}`);
  });

  it("no wake is armed while open", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    human(s, 6);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    bot.setVoiceTurn(true);
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    human(s, 7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a prompted turn (reservation) still runs while a voice turn is open", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    bot.setHeld(true); // the reservation
    expect(bot.runPrompt("say something about the budget")).toBe(true);
    await flush();
    expect(s.said).toHaveLength(1);
  });

  it("closing with no deferred line only re-arms", async () => {
    const { bot, provider } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    bot.setVoiceTurn(false);
    await adv(6_000);
    expect(s.said).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    human(s, 6); // and the bot still answers a line after the close
    await adv(6_000);
    expect(s.said).toHaveLength(1);
  });

  it("releasing a reservation does not end the voice hold", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    bot.setHeld(true);
    human(s, 6);
    bot.setHeld(false);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
    bot.setVoiceTurn(false);
    await adv(6_000);
    expect(s.said).toHaveLength(1);
  });

  it("a voice close does not end a reservation hold", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setHeld(true);
    bot.setVoiceTurn(true);
    human(s, 6);
    bot.setVoiceTurn(false);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
    bot.setHeld(false);
    await flush();
    expect(s.said).toHaveLength(1);
  });

  it("a pause observed while open drops the deferred line", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    human(s, 6);
    ev(s, { seq: 7, type: "facilitator.command", command: "pause" });
    ev(s, { seq: 8, type: "facilitator.command", command: "resume" });
    bot.setVoiceTurn(false);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
  });

  it("an AI player's line during an open turn is observed at once (it is not a human line)", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(true);
    own(s, 6);
    bot.setVoiceTurn(false);
    await adv(60_000);
    expect(s.said).toHaveLength(0); // the bot's own line never asks for a reply
  });

  it("setVoiceTurn with the same value twice changes nothing", async () => {
    const { bot } = makeBot();
    const s = await up(bot);
    bot.setVoiceTurn(false);
    human(s, 6);
    bot.setVoiceTurn(false);
    await adv(6_000);
    expect(s.said).toHaveLength(1);
  });
});

describe("BotHost.voiceTurn (US-0070)", () => {
  function mk() {
    const h = new BotHost({
      provider: new MockModelProvider(), settings, intents: new IntentLog(dir), scenarioFor: async () => scenario,
      reissue: async () => "CODE-2", alert: () => undefined, now: () => Date.now(), setTimer, open,
    });
    hosts.push(h);
    return h;
  }

  it("BotHost.voiceTurn for an unknown session does nothing", () => {
    const h = mk();
    expect(() => h.voiceTurn("nope", true)).not.toThrow();
    expect(() => h.voiceTurn("nope", false)).not.toThrow();
    expect(h.isAiConnected("nope", "tech_lead")).toBe(false);
  });

  // F3 (review fix wave): the new runtime's voice turn starts closed and never sends open:false for the old one, so a detach must
  // release the hold; the line deferred by the old turn belongs to the old socket and is not answered.
  it("a runtime restart during an open voice turn releases the hold (and drops the deferred line)", async () => {
    const h = mk();
    await h.attach("sess-1", { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "CODE-1" }] });
    await flush();
    const s = socks.at(-1)!;
    feed(s, joinedFrame("tech_lead"));
    h.voiceTurn("sess-1", true);
    human(s, 6);
    await h.detach("sess-1"); // the runtime exited mid-turn
    await flush();
    expect(s.said).toHaveLength(0);
    await h.attach("sess-1", { port: 4001, aiRoles: ["tech_lead"] });
    await flush();
    const s2 = socks.at(-1)!;
    expect(s2).not.toBe(s);
    feed(s2, joinedFrame("tech_lead"));
    await adv(60_000);
    expect(s2.said).toHaveLength(0); // nothing deferred from the old turn is answered
    human(s2, 7);
    await adv(60_000);
    expect(s2.said).toHaveLength(1); // no voice_turn open:false ever came, and the bot is awake
  });

  it("reaches the session's bots, and a bot that attaches during an open turn starts held", async () => {
    const h = mk();
    await h.attach("sess-1", { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "CODE-1" }] });
    await flush();
    const s = socks.at(-1)!;
    feed(s, joinedFrame("tech_lead"));
    h.voiceTurn("sess-1", true);
    human(s, 6);
    await adv(60_000);
    expect(s.said).toHaveLength(0);
    h.voiceTurn("sess-1", false);
    await adv(6_000);
    expect(s.said).toHaveLength(1);

    h.voiceTurn("sess-1", true);
    await h.attach("sess-1", { port: 4000, aiRoles: ["tech_lead", "account_manager"], codes: [{ roleId: "account_manager", code: "CODE-3" }] });
    await flush();
    const s2 = socks.find((x) => x.opts.roleId === "account_manager")!;
    feed(s2, joinedFrame("account_manager"));
    human(s2, 20);
    await adv(60_000);
    expect(s2.said).toHaveLength(0);
    h.voiceTurn("sess-1", false);
    await adv(6_000);
    expect(s2.said).toHaveLength(1);
  });
});
