import { describe, expect, it, beforeEach } from "vitest";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let host: SessionHost; let engine: SessionEngine; let npc: MockModelProvider; let clock: FakeClock;

beforeEach(async () => {
  const scenario = await loadScenario(fixture);
  clock = new FakeClock(0);
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock });
  npc = new MockModelProvider(["Hello host, lovely to be here"]);
  host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock });
});

describe("SessionHost.join", () => {
  it("assigns a player role and returns the private brief", () => {
    const r = host.join("host", "p1");
    expect(r.brief).toMatch(/hosting/);
    expect(r.privateFacts).toEqual(["You have five minutes"]);
  });
  it("refuses a second participant for the same role, and keeps the first", () => {
    host.join("host", "p1");
    expect(() => host.join("host", "p2")).toThrow(/role_taken/);
    expect(host.assignments).toEqual({ host: "p1" });
  });
  it("refuses NPC roles and unknown roles", () => {
    expect(() => host.join("guest", "p1")).toThrow(/npc_role/);
    expect(() => host.join("nobody", "p1")).toThrow(/unknown_role/);
  });
  it("frees the role on release so the same participant can rejoin, and a stranger cannot release it", () => {
    host.join("host", "p1");
    host.release("host", "p2");
    expect(host.assignments).toEqual({ host: "p1" });
    host.release("host", "p1");
    expect(host.assignments).toEqual({});
    expect(host.join("host", "p3").brief).toMatch(/hosting/);
  });
});

describe("SessionHost.onPlayerUtterance", () => {
  it("records the line, has the NPC reply, and runs a GM tick", async () => {
    host.join("host", "p1");
    await host.start();
    await host.onPlayerUtterance("host", "Hi Sam");
    await host.idle();
    expect(engine.state.transcript.map((u) => `${u.roleId}:${u.text}`)).toEqual(["host:Hi Sam", "guest:Hello host, lovely to be here"]);
    expect(npc.calls).toHaveLength(1);
  });

  it("rejects before the session has started", async () => {
    host.join("host", "p1");
    await expect(host.onPlayerUtterance("host", "Hi")).rejects.toMatchObject({ code: "not_started" });
  });

  it("while paused: rejects with EngineError paused, appends nothing, never calls the NPC provider", async () => {
    host.join("host", "p1");
    await host.start();
    await host.command({ command: "pause" });
    const before = engine.state.transcript.length;
    await expect(host.onPlayerUtterance("host", "Anyone there?")).rejects.toMatchObject({ name: "EngineError", code: "paused" });
    expect(engine.state.transcript).toHaveLength(before);
    expect(npc.calls).toHaveLength(0);
  });

  it("does not let a failing subscriber abort the NPC turn or other subscribers", async () => {
    host.join("host", "p1");
    await host.start();
    const seen: string[] = [];
    host.subscribe(() => { throw new Error("boom"); });
    host.subscribe((e) => { seen.push(e.type); });
    await host.onPlayerUtterance("host", "Hi Sam");
    await host.idle();
    expect(seen).toContain("utterance");
    expect(engine.state.transcript.at(-1)?.roleId).toBe("guest");
  });
});

describe("SessionHost ticker", () => {
  it("survives a tick that throws and reports it through the log callback", async () => {
    const scenario = await loadScenario(fixture);
    const logs: string[] = [];
    const h = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock, log: (m) => logs.push(m) });
    h.join("host", "p1");
    await h.start();
    const orig = engine.tick.bind(engine);
    let n = 0;
    engine.tick = async () => { n++; if (n === 1) throw new Error("tick exploded"); return orig(); };
    h.startTicker(5);
    await new Promise((r) => setTimeout(r, 60));
    h.stopTicker();
    expect(logs.join("\n")).toMatch(/tick exploded/);
    expect(n).toBeGreaterThan(1);
  });
});

describe("SessionHost start (I6)", () => {
  it("is not wedged when engine.start rejects: a later start succeeds", async () => {
    host.join("host", "p1");
    const orig = engine.start.bind(engine);
    let first = true;
    engine.start = async (a) => { if (first) { first = false; throw new Error("disk full"); } return orig(a); };
    await expect(host.start()).rejects.toThrow(/disk full/);
    await host.start();
    expect(engine.state.status).toBe("running");
  });
});

describe("SessionHost round coalescing (R25)", () => {
  it("K rapid utterances during a running round produce exactly one follow-up round that sees the latest transcript", async () => {
    const scenario = await loadScenario(fixture);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void; const inFlight = new Promise<void>((r) => { started = r; });
    const requests: ChatRequest[] = [];
    const provider: ModelProvider = { name: "gated", async *stream(req: ChatRequest) {
      requests.push(req);
      if (requests.length === 1) { started(); await gate; }
      yield "ok";
    } };
    const logs: string[] = [];
    const h = new SessionHost({ scenario, engine, npcProvider: provider, gmProvider: new MockModelProvider(), clock, log: (m) => logs.push(m) });
    h.join("host", "p1");
    await h.start();
    await h.onPlayerUtterance("host", "say 0");
    await inFlight; // round 1 is running and held open
    for (let i = 1; i < 10; i++) await h.onPlayerUtterance("host", `say ${i}`);
    release();
    await h.idle();
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(requests.at(-1))).toContain("say 9");
    const hostLines = engine.state.transcript.filter((u) => u.roleId === "host").map((u) => u.text);
    expect(hostLines).toEqual(Array.from({ length: 10 }, (_, i) => `say ${i}`));
    expect(logs).toEqual([]);
  });
});

describe("SessionHost.viewFor fails closed (runtime)", () => {
  it("denies an event of an unknown type to players; the facilitator may see it", () => {
    const weird = { seq: 1, ts: 0, sessionId: "s", type: "future.event", secret: "x" } as never;
    expect(host.viewFor("host", weird)).toBeNull();
    expect(host.filterFor("host")(weird)).toBe(false);
    expect(host.filterFor("facilitator")(weird)).toBe(true);
  });
});

describe("SessionHost non-blocking rounds (I3)", () => {
  it("onPlayerUtterance and command resolve while an NPC round is still in flight", async () => {
    const scenario = await loadScenario(fixture);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void; const inFlight = new Promise<void>((r) => { started = r; });
    const slow: ModelProvider = { name: "slow", async *stream(_r: ChatRequest) { started(); await gate; yield "late reply"; } };
    const h = new SessionHost({ scenario, engine, npcProvider: slow, gmProvider: new MockModelProvider(), clock });
    h.join("host", "p1");
    await h.start();
    await h.onPlayerUtterance("host", "Hi");
    await inFlight; // the NPC round is now blocked on the gate
    await h.command({ command: "pause" }); // must not wait for the round
    expect(engine.state.paused).toBe(true);
    release();
    await h.idle();
    expect(engine.state.transcript.map((u) => u.roleId)).toEqual(["host"]); // stale reply dropped, paused
  });

  it("reports a failing background round through the log callback, never an unhandled rejection", async () => {
    const scenario = await loadScenario(fixture);
    const logs: string[] = [];
    const boom: ModelProvider = { name: "boom", async *stream() { throw new Error("provider down"); } };
    const h = new SessionHost({ scenario, engine, npcProvider: boom, gmProvider: new MockModelProvider(), clock, log: (m) => logs.push(m) });
    h.join("host", "p1");
    await h.start();
    const orig = engine.tick.bind(engine);
    engine.tick = async () => { throw new Error("tick failed"); };
    await h.onPlayerUtterance("host", "Hi");
    await h.idle();
    engine.tick = orig;
    expect(logs.join("\n")).toMatch(/tick failed/);
  });
});

describe("SessionHost.filterFor", () => {
  it("hides scenes a player is not in and injects not addressed to them", async () => {
    host.join("host", "p1");
    await host.start();
    const forHost = host.filterFor("host");
    const forFac = host.filterFor("facilitator");
    const inject = { seq: 9, ts: 0, sessionId: "s", type: "inject.fired" as const, injectId: "x", sceneId: "s1_open", to: ["guest"], content: "secret" };
    expect(forHost(inject)).toBe(false);
    expect(forFac(inject)).toBe(true);
    const line = await engine.say("guest", "hi"); // host and guest share s1_open
    expect(forHost(line)).toBe(true);
  });

  it("never shows a player NPC internals, GM decisions, alerts, other roles' whispers or stance changes", () => {
    const forHost = host.filterFor("host");
    const base = { seq: 1, ts: 0, sessionId: "s" };
    expect(forHost({ ...base, type: "npc.updated", roleId: "guest", goals: ["x"], knowledge: ["secret"] })).toBe(false);
    expect(forHost({ ...base, type: "gm.decision", sceneId: "s1_open", condition: "c", verdict: true, reasoning: "r" })).toBe(false);
    expect(forHost({ ...base, type: "facilitator.alert", level: "info", message: "m" })).toBe(false);
    expect(forHost({ ...base, type: "facilitator.command", command: "whisper", roleId: "guest", text: "psst" })).toBe(false);
    expect(forHost({ ...base, type: "facilitator.command", command: "whisper", roleId: "host", text: "psst" })).toBe(true);
    expect(forHost({ ...base, type: "facilitator.command", command: "set_npc_stance", roleId: "guest", goals: ["g"] })).toBe(false);
    expect(forHost({ ...base, type: "facilitator.command", command: "fire_inject", injectId: "x" })).toBe(false);
    expect(forHost({ ...base, type: "facilitator.command", command: "pause" })).toBe(true);
  });
});

describe("SessionHost.filterFor is default-deny per event type (I1)", () => {
  const base = { seq: 1, ts: 0, sessionId: "s" };
  const events: [string, SessionEvent, boolean, boolean][] = [
    // [name, event, participant (host) sees it, non-participant (outsider) sees it]
    ["session.started", { ...base, type: "session.started", scenarioId: "x", version: "1", roles: { host: { kind: "player", participantId: "P" } } }, true, true],
    ["scene.entered", { ...base, type: "scene.entered", sceneId: "s1_open", participants: ["host", "guest"] }, true, false],
    ["scene.exited", { ...base, type: "scene.exited", sceneId: "s1_open", reason: "time_box_elapsed" }, true, false],
    ["utterance (unknown seq)", { ...base, seq: 999, type: "utterance", roleId: "guest", text: "t", channel: "text" }, false, false],
    ["inject.fired to host", { ...base, type: "inject.fired", injectId: "i", sceneId: "s1_open", to: ["host"], content: "c" }, true, false],
    ["inject.fired to guest", { ...base, type: "inject.fired", injectId: "i", sceneId: "s1_open", to: ["guest"], content: "c" }, false, false],
    ["npc.updated", { ...base, type: "npc.updated", roleId: "guest", goals: [], knowledge: [] }, false, false],
    ["gm.decision", { ...base, type: "gm.decision", sceneId: "s1_open", condition: "c", verdict: true, reasoning: "r" }, false, false],
    ["facilitator.alert", { ...base, type: "facilitator.alert", level: "info", message: "m" }, false, false],
    ["facilitator.command advance", { ...base, type: "facilitator.command", command: "advance" }, false, false],
    ["session.ended", { ...base, type: "session.ended", reason: "script_complete" }, true, true],
  ];
  for (const [name, ev, participant, outsider] of events) {
    it(`${name}: participant=${participant}, non-participant=${outsider}`, async () => {
      host.join("host", "p1");
      await host.start();
      expect(host.filterFor("host")(ev)).toBe(participant);
      expect(host.filterFor("outsider")(ev)).toBe(outsider);
      expect(host.filterFor("facilitator")(ev)).toBe(true);
    });
  }

  it("redacts participant ids from session.started for players but not for the facilitator", async () => {
    host.join("host", "p1");
    await host.start();
    const ev = events[0][1];
    const forPlayer = host.viewFor("host", ev) as Extract<SessionEvent, { type: "session.started" }>;
    expect(forPlayer.roles).toEqual({ host: { kind: "player" } });
    expect(JSON.stringify(forPlayer)).not.toMatch(/"P"/);
    expect(host.viewFor("facilitator", ev)).toBe(ev);
  });
});

describe("SessionHost.snapshotFor scene visibility (M4)", () => {
  it("shows a player only the scenes they take part in, agreeing with viewFor", async () => {
    host.join("host", "p1");
    await host.start();
    const enteredForOutsider = host.viewFor("outsider", { seq: 1, ts: 0, sessionId: "s", type: "scene.entered", sceneId: "s1_open", participants: ["host", "guest"] });
    expect(enteredForOutsider).toBeNull();
    const out = host.snapshotFor("outsider");
    expect(out.currentScene).toBeNull();
    expect(out.sceneHistory).toEqual([]);
    const mine = host.snapshotFor("host");
    expect(mine.currentScene?.id).toBe("s1_open");
    expect(mine.sceneHistory.map((s) => s.id)).toEqual(["s1_open"]);
  });
});

describe("SessionHost.snapshotFor", () => {
  it("gives a player a snapshot without NPC goals/knowledge, GM verdicts or other scenes' lines; the facilitator sees all", async () => {
    host.join("host", "p1");
    await host.start();
    await host.onPlayerUtterance("host", "Hi Sam");
    await host.idle();
    const snap = host.snapshotFor("host");
    expect(snap.npcs).toEqual({});
    expect(snap.gmVerdicts).toEqual({});
    expect(snap.injectsFired).toEqual([]);
    expect(JSON.stringify(snap)).not.toMatch(/Be welcomed|check-in|Leave early/);
    expect(snap.transcript.map((u) => u.text)).toContain("Hi Sam");
    expect(snap.roles).toEqual({ host: { kind: "player" }, guest: { kind: "npc" } });
    expect(JSON.stringify(snap)).not.toMatch(/p1/);
    const fac = host.snapshotFor("facilitator");
    expect(Object.keys(fac.npcs)).toEqual(["guest"]);
  });
});

describe("SessionHost NPC timeouts", () => {
  const npcAgents = (h: SessionHost) => [...(h as unknown as { npcs: Map<string, { timeouts: { firstTokenMs: number; replyMs: number } }> }).npcs.values()];
  it("gives every NPC the shared defaults when none are passed", async () => {
    const scenario = await loadScenario(fixture);
    const h = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock });
    expect(npcAgents(h).length).toBeGreaterThan(0);
    for (const a of npcAgents(h)) expect(a.timeouts).toEqual({ firstTokenMs: 10_000, replyMs: 20_000 });
  });
  it("passes configured timeouts to every NPC", async () => {
    const scenario = await loadScenario(fixture);
    const h = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock, firstTokenTimeoutMs: 1234, replyTimeoutMs: 5678 });
    for (const a of npcAgents(h)) expect(a.timeouts).toEqual({ firstTokenMs: 1234, replyMs: 5678 });
  });
});
