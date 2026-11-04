import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { BOT_ALERTS } from "../../bots/bot-alerts.js";
import { BotHost, PROMPT_DEBOUNCE_MS, RESERVATION_TTL_MS } from "../../bots/bot-host.js";
import type { BotSocket, BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import { IntentLog, type IntentEntry } from "../../bots/intent-log.js";

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SCENE1 = "s1_huddle";
const PARTICIPANTS = ["delivery_lead", "tech_lead", "account_manager"];
const SID = "sess-1";
const HINT = "HINT-SECRET-91";
const CODE = (r: string): string => `code-${r}`;

let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
const parsed = parseAiPlayerSettings({});
if (!parsed.ok) throw new Error("defaults must parse");
const baseSettings: AiPlayerSettings = parsed.settings;

type FakeSock = { opts: BotSocketOptions; said: { text: string; sceneId: string }[] };
class RecLog extends IntentLog {
  entries: IntentEntry[] = [];
  override append(s: string, r: string, e: IntentEntry): void { this.entries.push(e); super.append(s, r, e); }
}
let dir: string, socks: FakeSock[], strings: string[], alerts: string[], logs: string[], intents: RecLog, hosts: BotHost[], requests: ChatRequest[];

const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  const f: FakeSock = { opts: o, said: [] };
  socks.push(f);
  return { say: (text: string, sceneId: string) => { f.said.push({ text, sceneId }); }, close: async () => undefined } as unknown as BotSocket;
};
const flush = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

function mk(over: { provider?: ModelProvider; settings?: Partial<AiPlayerSettings> } = {}) {
  const provider = over.provider ?? new MockModelProvider();
  if (provider instanceof MockModelProvider) provider.defaultReply = "Let us look at the rollback plan first.";
  const h = new BotHost({
    provider: { name: "spy", stream: (r: ChatRequest) => { requests.push(r); return provider.stream(r); } } as ModelProvider,
    settings: { ...baseSettings, ...over.settings }, intents, scenarioFor: async () => scenario,
    reissue: async () => "NEW", alert: (_s, _r, m) => { alerts.push(m); strings.push(m); },
    log: (m) => { logs.push(m); strings.push(m); }, now: () => Date.now(), setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); }, open,
  });
  hosts.push(h);
  return h;
}
const frame = (f: unknown) => parseBotFrame(JSON.stringify(f));
const joinedFrame = (roleId: string) => ({
  type: "joined", roleId, brief: "You own the platform", privateFacts: [], reconnectToken: "TOKEN-1",
  state: { status: "running", paused: false, aiRoles: ["tech_lead", "account_manager"], currentScene: { id: SCENE1, participants: PARTICIPANTS }, lastSeq: 5, transcript: [] },
  scenes: [{ id: SCENE1, title: "Huddle", goal: "Agree a position" }],
});
const feed = (s: FakeSock, f: unknown) => s.opts.onFrame(frame(f));
const humanLine = (s: FakeSock, seq: number) => feed(s, { type: "event", event: { seq, type: "utterance", roleId: "delivery_lead", text: "We need a plan for the migration" } });
const ownLine = (s: FakeSock, seq: number, role = "tech_lead") => feed(s, { type: "event", event: { seq, type: "utterance", roleId: role, text: "said" } });
const humansReady = (s: FakeSock) => feed(s, { type: "roster", audience: "peers", entries: [{ roleId: "delivery_lead", ready: true, ai: false }] });
const sockFor = (role: string) => [...socks].reverse().find((s) => s.opts.roleId === role)!;

/** A host with bots for `roles` attached and joined. */
async function up(roles: string[] = ["tech_lead"], over: Parameters<typeof mk>[0] = {}, aiCalls?: number) {
  const h = mk(over);
  await h.attach(SID, { port: 4000, aiRoles: roles, codes: roles.map((r) => ({ roleId: r, code: CODE(r) })), ...(aiCalls !== undefined ? { aiCalls } : {}) });
  await flush();
  for (const r of roles) { feed(sockFor(r), joinedFrame(r)); }
  await flush();
  return h;
}
const code = (fn: () => unknown): string | undefined => { try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code; } };

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), "bot-prompt-"));
  socks = []; strings = []; alerts = []; logs = []; hosts = []; requests = [];
  intents = new RecLog(dir);
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("BotHost prompted turns", () => {
  it("reserve then run starts a prompt turn that ignores the gap, and records the cleaned hint in the intent log", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    const t = h.reserve(SID, "tech_lead");
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    h.run(SID, "tech_lead", t, "  Push for the rollback  ");
    await flush();
    expect(s.said).toHaveLength(1);
    ownLine(s, 6);
    expect(intents.entries).toEqual([expect.objectContaining({ trigger: "prompt", outcome: "spoken", sceneId: SCENE1, hint: "Push for the rollback" })]);
    // 5 s later (the reply gap is 15 s) a second prompt is still allowed
    await adv(PROMPT_DEBOUNCE_MS);
    h.run(SID, "tech_lead", h.reserve(SID, "tech_lead"), null);
    await flush();
    expect(s.said).toHaveLength(2);
  });

  it("while a reservation is held, a human line followed by the settle delay starts no policy turn, and run then succeeds", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    humansReady(s);
    const t = h.reserve(SID, "tech_lead");
    humanLine(s, 6);
    await adv(baseSettings.turn.settleMs + 1_000);
    expect(s.said).toHaveLength(0);
    expect(requests).toHaveLength(0);
    h.run(SID, "tech_lead", t, "go");
    await flush();
    expect(s.said).toHaveLength(1);
  });

  it("a second reserve while a reservation is held, a turn is in flight, or 4 s after a run is ai_busy; 5 s after it succeeds", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    const t = h.reserve(SID, "tech_lead");
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy");
    h.run(SID, "tech_lead", t, "go");
    await flush();
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy"); // in flight (awaiting its own line)
    ownLine(s, 6);
    await adv(4_000);
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy");
    await adv(1_000);
    const t2 = h.reserve(SID, "tech_lead");
    h.release(SID, "tech_lead", t2);
  });

  it("a reservation unused for RESERVATION_TTL_MS is ai_expired at run and the policy is released", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    humansReady(s);
    const t = h.reserve(SID, "tech_lead");
    humanLine(s, 6);
    await adv(RESERVATION_TTL_MS);
    expect(code(() => h.run(SID, "tech_lead", t, "go"))).toBe("ai_expired");
    await flush();
    await adv(1_000);
    expect(s.said).toHaveLength(1); // the held reply became due when the hold ended
  });

  it("run with another role's reservation, a made-up token or a used token is ai_expired, and the real reservation survives a wrong guess", async () => {
    const h = await up(["tech_lead", "account_manager"]);
    const t = h.reserve(SID, "tech_lead");
    expect(code(() => h.run(SID, "account_manager", t, "go"))).toBe("ai_expired");
    const other = h.reserve(SID, "account_manager");
    expect(code(() => h.run(SID, "account_manager", t, "go"))).toBe("ai_expired");
    expect(code(() => h.run(SID, "tech_lead", "0".repeat(32), "go"))).toBe("ai_expired");
    expect(code(() => h.run(SID, "tech_lead", "short", "go"))).toBe("ai_expired");
    h.run(SID, "tech_lead", t, "go");
    expect(code(() => h.run(SID, "tech_lead", t, "go"))).toBe("ai_expired"); // consumed once
    h.release(SID, "account_manager", other);
  });

  it("reserve with the budget used up is ai_budget", async () => {
    const h = await up(["tech_lead"], {}, baseSettings.callsPerSession);
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_budget");
  });

  it("reserve for a human role, an unknown session or a bot that has not joined is ai_absent", async () => {
    const h = mk();
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_absent"); // nothing attached
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: CODE("tech_lead") }] });
    await flush();
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_absent"); // socket open, not joined
    feed(sockFor("tech_lead"), joinedFrame("tech_lead"));
    await flush();
    expect(code(() => h.reserve(SID, "delivery_lead"))).toBe("ai_absent");
    expect(code(() => h.reserve("other", "tech_lead"))).toBe("ai_absent");
    const t = h.reserve(SID, "tech_lead");
    h.release(SID, "tech_lead", t);
  });

  it("release frees the reservation and the policy at once, and is idempotent", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    humansReady(s);
    const t = h.reserve(SID, "tech_lead");
    humanLine(s, 6);
    await adv(baseSettings.turn.settleMs + 500);
    expect(s.said).toHaveLength(0);
    h.release(SID, "tech_lead", t);
    h.release(SID, "tech_lead", t);
    h.release(SID, "tech_lead", "f".repeat(32));
    await flush();
    expect(s.said).toHaveLength(1);
    expect(code(() => h.run(SID, "tech_lead", t, "go"))).toBe("ai_expired");
  });

  it("a prompt whose model never answers frees the bot at hardTimeoutMs and its late reply is not sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const never: ModelProvider = { name: "never", stream: () => (async function* () { await gate; yield "far too late"; })() };
    const h = await up(["tech_lead"], { provider: never, settings: { firstTokenTimeoutMs: 600_000, replyTimeoutMs: 600_000, hardTimeoutMs: 1_000 } });
    const s = sockFor("tech_lead");
    h.run(SID, "tech_lead", h.reserve(SID, "tech_lead"), "go");
    await flush();
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy");
    await adv(1_000);
    expect(intents.entries).toEqual([expect.objectContaining({ trigger: "prompt", outcome: "skipped", reason: "timeout" })]);
    release(); await flush();
    expect(s.said).toHaveLength(0);
    await adv(PROMPT_DEBOUNCE_MS);
    h.release(SID, "tech_lead", h.reserve(SID, "tech_lead")); // the bot is free again
  });

  it("a prompt takes a budget unit: with one unit left it speaks, and the next reserve is ai_budget", async () => {
    const h = await up(["tech_lead"], {}, baseSettings.callsPerSession - 1);
    const s = sockFor("tech_lead");
    h.run(SID, "tech_lead", h.reserve(SID, "tech_lead"), "go");
    await flush();
    expect(s.said).toHaveLength(1);
    ownLine(s, 6);
    await adv(PROMPT_DEBOUNCE_MS);
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_budget");
  });

  describe("reservations end with the bot's session state", () => {
    it("detach: run is ai_expired, and after a re-attach a human line is answered (the hold is gone)", async () => {
      const h = await up();
      const t = h.reserve(SID, "tech_lead");
      await h.detach(SID);
      expect(code(() => h.run(SID, "tech_lead", t, "go"))).toBe("ai_expired");
      await h.attach(SID, { port: 4001, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: CODE("tech_lead") }] });
      await flush();
      const s = sockFor("tech_lead");
      feed(s, joinedFrame("tech_lead")); humansReady(s);
      humanLine(s, 6);
      await adv(baseSettings.turn.settleMs + 1_000);
      expect(s.said).toHaveLength(1);
    });

    it("removeRoles: that role's run is ai_expired, the other role's reservation survives", async () => {
      const h = await up(["tech_lead", "account_manager"]);
      const t1 = h.reserve(SID, "tech_lead");
      const t2 = h.reserve(SID, "account_manager");
      await h.removeRoles(SID, ["tech_lead"]);
      expect(code(() => h.run(SID, "tech_lead", t1, "go"))).toBe("ai_expired");
      h.run(SID, "account_manager", t2, "go");
      await flush();
      expect(sockFor("account_manager").said).toHaveLength(1);
    });

    it("end: run is ai_expired", async () => {
      const h = await up();
      const t = h.reserve(SID, "tech_lead");
      await h.end(SID);
      expect(code(() => h.run(SID, "tech_lead", t, "go"))).toBe("ai_expired");
    });

    it("a reservation left outstanding at close() leaves no timer behind (the afterEach checks the timer count)", async () => {
      const h = await up();
      h.reserve(SID, "tech_lead");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      void h;
    });
  });

  it("release with the wrong token does not clear the hold: the real token still runs", async () => {
    const h = await up();
    const s = sockFor("tech_lead");
    humansReady(s);
    const t = h.reserve(SID, "tech_lead");
    humanLine(s, 6);
    h.release(SID, "tech_lead", "f".repeat(32));
    await adv(baseSettings.turn.settleMs + 1_000);
    expect(s.said).toHaveLength(0);
    h.run(SID, "tech_lead", t, "go");
    await flush();
    expect(s.said).toHaveLength(1);
  });

  it("a non-ASCII token of the right length is ai_expired, never a RangeError", async () => {
    const h = await up();
    const t = h.reserve(SID, "tech_lead");
    expect(code(() => h.run(SID, "tech_lead", "é".repeat(32), "go"))).toBe("ai_expired");
    expect(() => h.release(SID, "tech_lead", "é".repeat(32))).not.toThrow();
    h.release(SID, "tech_lead", t);
  });

  it("reserve before the start or outside the scene is ai_busy (the policy could not begin a prompt)", async () => {
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: CODE("tech_lead") }] });
    await flush();
    const s = sockFor("tech_lead");
    const j = joinedFrame("tech_lead") as any;
    j.state.status = "idle";
    feed(s, j);
    await flush();
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy");
    feed(s, { type: "event", event: { seq: 6, type: "session.started", aiRoles: ["tech_lead"] } });
    feed(s, { type: "event", event: { seq: 7, type: "scene.entered", sceneId: SCENE1, participants: PARTICIPANTS } });
    await flush();
    h.release(SID, "tech_lead", h.reserve(SID, "tech_lead"));
    feed(s, { type: "event", event: { seq: 8, type: "facilitator.command", command: "pause" } });
    expect(code(() => h.reserve(SID, "tech_lead"))).toBe("ai_busy");
  });

  it("the budget used up between reserve and run: run still starts, the bot records skipped/budget and raises the budget alert once", async () => {
    const h = await up(["tech_lead", "account_manager"], {}, baseSettings.callsPerSession - 1);
    const t1 = h.reserve(SID, "tech_lead");
    const t2 = h.reserve(SID, "account_manager");
    h.run(SID, "account_manager", t2, "go"); // takes the last unit
    await flush();
    expect(() => h.run(SID, "tech_lead", t1, "go")).not.toThrow();
    await flush();
    expect(intents.entries.filter((e) => e.outcome === "skipped")).toEqual([expect.objectContaining({ trigger: "prompt", reason: "budget" })]);
    expect(alerts.filter((m) => m === BOT_ALERTS.budget)).toHaveLength(1);
    expect(sockFor("tech_lead").said).toHaveLength(0);
  });

  it("the hint never appears in a log line, an alert, a bot_alert message or an error", async () => {
    const bad = new MockModelProvider([new Error(`boom ${HINT}`)]);
    const h = await up(["tech_lead"], { provider: bad });
    const t = h.reserve(SID, "tech_lead");
    const errs: string[] = [];
    try { h.run(SID, "account_manager", t, HINT); } catch (e) { errs.push(String(inspect(e))); }
    h.run(SID, "tech_lead", t, HINT);
    await flush();
    try { h.run(SID, "tech_lead", t, HINT); } catch (e) { errs.push(String(inspect(e))); }
    const all = [...strings, ...logs, ...alerts, ...errs].join("\n");
    expect(all).not.toContain(HINT);
    expect(all.length).toBeGreaterThan(0);
  });

  it("an invalid hint object is run as no hint", async () => {
    const h = await up();
    h.run(SID, "tech_lead", h.reserve(SID, "tech_lead"), { text: "x" });
    await flush();
    expect(sockFor("tech_lead").said).toHaveLength(1);
    ownLine(sockFor("tech_lead"), 6);
    expect(intents.entries[0]).not.toHaveProperty("hint");
  });
});
