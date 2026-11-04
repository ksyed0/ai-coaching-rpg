import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { parseAiPlayerSettings, type AiPlayerSettings } from "@acr/runtime/players";
import { BotHost } from "../../bots/bot-host.js";
import { BOT_ALERTS } from "../../bots/bot-alerts.js";
import { type BotSocket, type BotSocketOptions } from "../../bots/bot-socket.js";
import { parseBotFrame } from "../../bots/bot-frames.js";
import { IntentLog, intentFileName } from "../../bots/intent-log.js";

const SCENARIO_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const SCENE1 = "s1_huddle";
const PARTICIPANTS = ["delivery_lead", "tech_lead", "account_manager"];
const SID = "sess-1";
const SECRET = "CODE-SECRET-1";

let scenario: Scenario;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
const parsed = parseAiPlayerSettings({});
if (!parsed.ok) throw new Error("defaults must parse");
const baseSettings: AiPlayerSettings = parsed.settings;

type FakeSock = { opts: BotSocketOptions; live: boolean; closeCalls: number };
let dir: string;
let socks: FakeSock[];
let liveNow: number;
let liveMax: number;
let openFails: number;
let strings: string[];
let alerts: { sessionId: string; roleId: string; message: string }[];
let logs: string[];
let intents: IntentLog;
let hosts: BotHost[];
let reissue: ReturnType<typeof vi.fn<(s: string, r: string) => Promise<string>>>;

const open = async (o: BotSocketOptions): Promise<BotSocket> => {
  strings.push(o.sessionId, o.roleId);
  if (openFails > 0) { openFails -= 1; throw new Error("open failed"); }
  const f: FakeSock = { opts: o, live: true, closeCalls: 0 };
  liveNow += 1; liveMax = Math.max(liveMax, liveNow);
  socks.push(f);
  const end = () => { if (f.live) { f.live = false; liveNow -= 1; } };
  return { say: () => undefined, close: async () => { f.closeCalls += 1; await Promise.resolve(); end(); } } as unknown as BotSocket;
};

const flush = async () => { for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0); };
const adv = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(); };

function mk(over: { provider?: ModelProvider; settings?: Partial<AiPlayerSettings> } = {}) {
  const provider = over.provider ?? new MockModelProvider();
  const h = new BotHost({
    provider, settings: { ...baseSettings, ...over.settings }, intents, scenarioFor: async () => scenario,
    reissue: (s, r) => reissue(s, r), alert: (s, r, m) => { alerts.push({ sessionId: s, roleId: r, message: m }); strings.push(s, r, m); },
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
const joined = (s: FakeSock) => s.opts.onFrame(frame(joinedFrame(s.opts.roleId)));
const dropped = (s: FakeSock, code = 1006) => { if (s.live) { s.live = false; liveNow -= 1; } s.opts.onClose(code, { byUs: false }); };
const human = (s: FakeSock, seq: number) => s.opts.onFrame(frame({ type: "event", event: { seq, type: "utterance", roleId: "delivery_lead", text: "We need a plan for the migration" } }));
const lastFor = (role: string) => [...socks].reverse().find((s) => s.opts.roleId === role)!;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(path.join(tmpdir(), "bot-host-"));
  socks = []; liveNow = 0; liveMax = 0; openFails = 0; strings = []; alerts = []; logs = []; hosts = [];
  intents = new IntentLog(dir);
  reissue = vi.fn(async () => "REISSUED-CODE");
});
afterEach(async () => {
  for (const h of hosts) await h.close();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("BotHost", () => {
  it("attach with aiRoles [tech_lead] and no code reissues tech_lead once and attaches with the reissued code", async () => {
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(reissue).toHaveBeenCalledWith(SID, "tech_lead");
    expect(socks).toHaveLength(1);
    expect(socks[0]!.opts.code).toBe("REISSUED-CODE");
    expect(socks[0]!.opts.port).toBe(4000);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(false); // open, not yet joined
    joined(socks[0]!);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(true);
  });

  it("attach with codes stores the code first: no reissue, and one socket opens with that code", async () => {
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: SECRET }] });
    await flush();
    expect(reissue).not.toHaveBeenCalled();
    expect(socks).toHaveLength(1);
    expect(socks[0]!.opts.code).toBe(SECRET);
    expect(strings.filter((x) => x === SECRET)).toEqual([]); // never logged or alerted
  });

  it("a code for a role that was removed is taken when the role is in aiRoles of the same attach; a code for a role not in aiRoles is dropped", async () => {
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: [] });
    await h.removeRoles(SID, ["tech_lead"]);
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "IGNORED" }]);
    await flush();
    expect(socks).toHaveLength(0);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "NEW-1" }, { roleId: "account_manager", code: "NOPE" }] });
    await flush();
    expect(reissue).not.toHaveBeenCalled();
    expect(socks.map((x) => [x.opts.roleId, x.opts.code])).toEqual([["tech_lead", "NEW-1"]]);
  });

  it("attach with the same port and code of a connected bot does not bounce it", async () => {
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "C1" }] });
    await flush();
    joined(socks[0]!);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: "C1" }] });
    await flush();
    expect(socks).toHaveLength(1);
    expect(socks[0]!.closeCalls).toBe(0);
  });

  it("after close() an attach queued before it (for a session not yet created) opens nothing, and later operations are no-ops", async () => {
    const h = mk();
    const a = h.attach("never-seen", { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: SECRET }] });
    const c = h.close();
    await Promise.all([a, c]);
    await flush();
    expect(socks).toHaveLength(0);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"], codes: [{ roleId: "tech_lead", code: SECRET }] });
    await flush();
    expect(socks).toHaveLength(0);
  });

  it("a refusal from reissue (code ai_role) is a quiet no-op: one log line, no alert, no socket", async () => {
    reissue.mockRejectedValue(Object.assign(new Error("switch the role back to human first"), { code: "ai_role" }));
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(logs).toEqual([`session ${SID} AI player could not get a code`]);
    expect(alerts).toEqual([]);
    expect(socks).toHaveLength(0);
  });

  it("a failing reissue logs 'could not get a code' and nothing else", async () => {
    reissue.mockRejectedValue(new Error("boom " + SECRET));
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(logs).toEqual([`session ${SID} AI player could not get a code`]);
    expect(alerts).toEqual([{ sessionId: SID, roleId: "tech_lead", message: BOT_ALERTS.rejoinFailed }]);
    expect(socks).toHaveLength(0);
    expect(strings.join(" ")).not.toContain(SECRET);
  });

  it("attach([]) and attach([tech_lead]) issued back to back run in order: the bot ends attached", async () => {
    const h = mk();
    const a = h.attach(SID, { port: 4000, aiRoles: [] });
    const b = h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await Promise.all([a, b]);
    await flush();
    joined(lastFor("tech_lead"));
    expect(h.isAiConnected(SID, "tech_lead")).toBe(true);
    expect(liveNow).toBe(1);
  });

  it("a failing operation does not poison the chain: the error name is logged and the next operation runs", async () => {
    const h = mk();
    vi.spyOn(intents, "remove").mockImplementationOnce(() => { throw new Error("x"); });
    await h.removeRoles(SID, ["account_manager"]);
    expect(logs).toEqual([`session ${SID} bot host operation failed: Error`]);
    await h.setCodes(SID, [{ roleId: "tech_lead", code: SECRET }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    joined(lastFor("tech_lead"));
    expect(h.isAiConnected(SID, "tech_lead")).toBe(true);
  });

  it("a reissue result that arrives after detach does not reconnect and raises no alert", async () => {
    let resolve!: (c: string) => void;
    reissue.mockImplementation(() => new Promise<string>((res) => { resolve = res; }));
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await h.detach(SID);
    resolve("LATE-CODE");
    await adv(10 * 60_000);
    expect(socks).toHaveLength(0);
    expect(alerts).toEqual([]);
  });

  it("setCodes after attach ignores a role that is not AI (no bot, no code stored) and a role removed by removeRoles", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await h.setCodes(SID, [{ roleId: "account_manager", code: "c2" }]);
    expect(socks.filter((x) => x.opts.roleId === "account_manager")).toHaveLength(0);
    expect(logs).toContain(`session ${SID} ignored a code for a non-AI role account_manager`);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead", "account_manager"] });
    await flush();
    expect(reissue).toHaveBeenCalledWith(SID, "account_manager"); // the ignored code was not stored
    await h.removeRoles(SID, ["tech_lead"]);
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "late" }]);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(false);
    expect(socks.some((x) => x.opts.code === "late")).toBe(false);
    for (const l of logs) expect(l).not.toContain("c2");
  });

  it("a setCodes for a role removed before any attach is ignored", async () => {
    const h = mk();
    await h.removeRoles(SID, ["tech_lead"]);
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "late" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it("attach skips a bot already connected on the same port with the same code, and re-attaches on a changed port, a changed code or a disconnected bot", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    expect(socks).toHaveLength(1);
    await h.attach(SID, { port: 4001, aiRoles: ["tech_lead"] });
    expect(socks).toHaveLength(2);
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c2" }]);
    expect(socks).toHaveLength(3);
    dropped(lastFor("tech_lead"), 4001);
    await h.attach(SID, { port: 4001, aiRoles: ["tech_lead"] });
    expect(socks).toHaveLength(4);
  });

  it("a reissue that never resolves does not block a later detach on the same session", async () => {
    reissue.mockImplementation(() => new Promise<string>(() => undefined));
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await h.detach(SID);
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it("the budget seeded from aiCalls 59 allows one call across all bots of the session", async () => {
    const provider = new MockModelProvider();
    provider.defaultReply = "I hear you, let us look at the rollback plan first.";
    const h = mk({ provider });
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }, { roleId: "account_manager", code: "c2" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead", "account_manager"], aiCalls: 59 });
    await flush();
    for (const r of ["tech_lead", "account_manager"]) { const s = lastFor(r); joined(s); human(s, 6); }
    await adv(60_000);
    expect(provider.calls).toHaveLength(1);
    expect(alerts.filter((a) => a.message === BOT_ALERTS.budget)).toHaveLength(1);
    // a second attach does not reseed the budget
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead", "account_manager"], aiCalls: 0 });
    await flush();
    for (const r of ["tech_lead", "account_manager"]) { const s = lastFor(r); joined(s); human(s, 7); }
    await adv(60_000);
    expect(provider.calls).toHaveLength(1);
  });

  it("eight bots re-attached to a new port open at most eight sockets at any time", async () => {
    const roles = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"];
    const h = mk();
    await h.setCodes(SID, roles.map((roleId) => ({ roleId, code: "c-" + roleId })));
    await h.attach(SID, { port: 4000, aiRoles: roles });
    expect(liveNow).toBe(8);
    await h.attach(SID, { port: 5000, aiRoles: roles });
    await flush();
    expect(liveNow).toBe(8);
    expect(liveMax).toBeLessThanOrEqual(8);
    expect(socks.filter((s) => s.opts.port === 5000)).toHaveLength(8);
  });

  it("removeRoles stops the bot, forgets the code and deletes its intent file", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    intents.append(SID, "tech_lead", { ts: 1, sceneId: null, trigger: "reply", outcome: "skipped" });
    expect(h.intents(SID, "tech_lead")).toHaveLength(1);
    await h.removeRoles(SID, ["tech_lead"]);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(false);
    expect(liveNow).toBe(0);
    expect(h.intents(SID, "tech_lead")).toEqual([]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it("after removeRoles a late model reply does not recreate the intent file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = false;
    const provider: ModelProvider = {
      name: "gated",
      async *stream(_req: ChatRequest) { entered = true; await gate; yield "I hear you, let us look at the rollback plan first."; },
    } as unknown as ModelProvider;
    const h = mk({ provider });
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    const s = lastFor("tech_lead");
    joined(s); human(s, 6);
    await adv(6_000);
    expect(entered).toBe(true);
    await h.removeRoles(SID, ["tech_lead"]);
    release();
    await adv(1_000);
    expect(existsSync(path.join(dir, intentFileName(SID, "tech_lead")))).toBe(false);
  });

  it("end forgets codes: a later attach reissues; end keeps the intent files", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    intents.append(SID, "tech_lead", { ts: 1, sceneId: null, trigger: "reply", outcome: "skipped" });
    await h.end(SID);
    expect(liveNow).toBe(0);
    expect(h.intents(SID, "tech_lead")).toHaveLength(1);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
  });

  it("forget deletes the session's intent files", async () => {
    const h = mk();
    intents.append(SID, "tech_lead", { ts: 1, sceneId: null, trigger: "reply", outcome: "skipped" });
    intents.append(SID, "account_manager", { ts: 1, sceneId: null, trigger: "reply", outcome: "skipped" });
    await h.forget(SID);
    expect(h.intents(SID, "tech_lead")).toEqual([]);
    expect(h.intents(SID, "account_manager")).toEqual([]);
  });

  it("detach keeps codes: a later attach does not reissue", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await h.detach(SID);
    expect(liveNow).toBe(0);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(false);
    await h.attach(SID, { port: 4001, aiRoles: ["tech_lead"] });
    await flush();
    expect(reissue).not.toHaveBeenCalled();
    expect(lastFor("tech_lead").opts.code).toBe("c1");
    expect(lastFor("tech_lead").opts.port).toBe(4001);
  });

  it("attach stops bots whose role left aiRoles", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }, { roleId: "account_manager", code: "c2" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead", "account_manager"] });
    joined(lastFor("tech_lead"));
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    expect(h.isAiConnected(SID, "account_manager")).toBe(false);
    expect(h.isAiConnected(SID, "tech_lead")).toBe(true);
  });

  it("a bot that gets unauthorized makes the host reissue once and attach with the new code", async () => {
    const h = mk();
    await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    lastFor("tech_lead").opts.onFrame(frame({ type: "error", code: "unauthorized", message: "no" }));
    await flush();
    expect(reissue).toHaveBeenCalledTimes(1);
    expect(lastFor("tech_lead").opts.code).toBe("REISSUED-CODE");
    expect(socks).toHaveLength(2);
  });

  describe("re-attach after a drop (B18)", () => {
    async function up(h: BotHost) {
      await h.setCodes(SID, [{ roleId: "tech_lead", code: "c1" }]);
      await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
      const s = lastFor("tech_lead");
      joined(s);
      return s;
    }

    it("a non-final close re-attaches with the remembered port and code after 2 s, then 4 s", async () => {
      const h = mk();
      const s = await up(h);
      dropped(s);
      await adv(1_999);
      expect(socks).toHaveLength(1);
      await adv(1);
      expect(socks).toHaveLength(2);
      expect(socks[1]!.opts.code).toBe("c1");
      expect(socks[1]!.opts.port).toBe(4000);
      dropped(socks[1]!); // closed before joined: a failed re-attach
      await adv(3_999);
      expect(socks).toHaveLength(2);
      await adv(1);
      expect(socks).toHaveLength(3);
    });

    it.each([4001, 4002, 4003, 4004])("close code %i is final: no re-attach, no alert, a log line by session id and role only", async (code) => {
      const h = mk();
      const s = await up(h);
      dropped(s, code);
      await adv(120_000);
      expect(socks).toHaveLength(1);
      expect(alerts).toEqual([]);
      expect(logs.length).toBeGreaterThan(0);
      for (const l of logs) expect(l).not.toContain("c1");
    });

    it("five consecutive failed re-attaches raise rejoinFailed once and stop retrying; a new host attach re-arms", async () => {
      const h = mk();
      const s = await up(h);
      openFails = 100;
      dropped(s);
      await adv(10 * 60_000);
      expect(alerts.filter((a) => a.message === BOT_ALERTS.rejoinFailed)).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ sessionId: SID, roleId: "tech_lead" });
      expect(socks).toHaveLength(1);
      await adv(10 * 60_000);
      expect(alerts).toHaveLength(1);
      openFails = 0;
      await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
      await flush();
      expect(socks).toHaveLength(2);
    });

    it("the backoff doubles up to 30 s", async () => {
      const h = mk();
      const s = await up(h);
      openFails = 4;
      dropped(s);
      await adv(2_000); await adv(4_000); await adv(8_000); await adv(16_000);
      expect(openFails).toBe(0);
      expect(socks).toHaveLength(1);
      await adv(30_000);
      expect(socks).toHaveLength(2);
    });

    it("a joined resets the failure count", async () => {
      const h = mk();
      let s = await up(h);
      for (let i = 0; i < 8; i++) {
        dropped(s);
        await adv(2_000);
        s = lastFor("tech_lead");
        joined(s);
      }
      expect(alerts).toEqual([]);
      expect(socks).toHaveLength(9);
    });

    it("failures before a joined count; joined resets them: the next delay is 2 s and only the 5th consecutive failure alerts", async () => {
      const h = mk();
      let s = await up(h);
      openFails = 3;
      dropped(s);
      await adv(2_000); await adv(4_000); await adv(8_000); // three failed attempts (fails = 3)
      await adv(16_000);
      s = lastFor("tech_lead");
      expect(socks).toHaveLength(2);
      joined(s);
      dropped(s);
      await adv(1_999);
      expect(socks).toHaveLength(2);
      await adv(1);
      expect(socks).toHaveLength(3);
      openFails = 100;
      dropped(lastFor("tech_lead"));
      await adv(2_000); await adv(4_000); await adv(8_000); await adv(16_000);
      expect(alerts).toEqual([]);
      await adv(30_000);
      expect(alerts.filter((a) => a.message === BOT_ALERTS.rejoinFailed)).toHaveLength(1);
    });

    it("detach, end, removeRoles and forget cancel a pending re-attach", async () => {
      for (const op of ["detach", "end", "removeRoles", "forget"] as const) {
        socks.length = 0;
        const h = mk();
        const s = await up(h);
        dropped(s);
        if (op === "removeRoles") await h.removeRoles(SID, ["tech_lead"]); else await h[op](SID);
        expect(vi.getTimerCount()).toBe(0);
        await adv(120_000);
        expect(socks).toHaveLength(1);
        await h.close();
      }
    });
  });

  it("no log line or alert argument ever contains a code", async () => {
    reissue.mockImplementation(async () => SECRET);
    const h = mk();
    await h.attach(SID, { port: 4000, aiRoles: ["tech_lead"] });
    await flush();
    const s = lastFor("tech_lead");
    joined(s);
    dropped(s, 4002);
    openFails = 3;
    await h.setCodes(SID, [{ roleId: "tech_lead", code: SECRET }]);
    dropped(lastFor("tech_lead"));
    await adv(10 * 60_000);
    await h.end(SID);
    expect(socks.some((x) => x.opts.code === SECRET)).toBe(true);
    expect(inspect(strings, { depth: 5 })).not.toContain(SECRET);
    expect(strings.join("\n")).not.toContain(SECRET);
  });
});
