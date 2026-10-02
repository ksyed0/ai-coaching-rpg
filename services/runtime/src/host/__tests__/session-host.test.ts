import { describe, expect, it, beforeEach } from "vitest";
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

describe("SessionHost.snapshotFor", () => {
  it("gives a player a snapshot without NPC goals/knowledge, GM verdicts or other scenes' lines; the facilitator sees all", async () => {
    host.join("host", "p1");
    await host.start();
    await host.onPlayerUtterance("host", "Hi Sam");
    const snap = host.snapshotFor("host");
    expect(snap.npcs).toEqual({});
    expect(snap.gmVerdicts).toEqual({});
    expect(snap.injectsFired).toEqual([]);
    expect(JSON.stringify(snap)).not.toMatch(/Be welcomed|check-in|Leave early/);
    expect(snap.transcript.map((u) => u.text)).toContain("Hi Sam");
    const fac = host.snapshotFor("facilitator");
    expect(Object.keys(fac.npcs)).toEqual(["guest"]);
  });
});
