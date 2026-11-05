import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import { commandForPlayer, snapshotForPlayer, startedForPlayer, type StartedEvent } from "../player-copies.js";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

async function running() {
  const scenario = await loadScenario(fixture);
  const clock = new FakeClock(0);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hello host, lovely to be here"]), gmProvider: new MockModelProvider(), clock });
  host.join("host", "p1");
  await host.start();
  await host.onPlayerUtterance("host", "Hi Sam");
  await host.idle();
  await host.command({ command: "pause" });
  return { host, engine };
}

/** The 2a player snapshot, captured from the code before the allowlist refactor. Never regenerate it: a change here is a change in what players see. */
const TODAYS_PLAYER_SNAPSHOT = {
  status: "running", lastSeq: 6, scenarioId: "minimal-01", version: "0.1",
  roles: { guest: { kind: "npc" }, host: { kind: "player" } },
  currentScene: { id: "s1_open", enteredAt: 0, participants: ["host", "guest"], pausedMs: 0 },
  sceneHistory: [{ id: "s1_open", participants: ["host", "guest"] }],
  paused: true, pausedSince: 0,
  transcript: [
    { seq: 4, ts: 0, sceneId: "s1_open", roleId: "host", text: "Hi Sam", channel: "text" },
    { seq: 5, ts: 0, sceneId: "s1_open", roleId: "guest", text: "Hello host, lovely to be here", channel: "text" },
  ],
  injectsFired: [], npcs: {}, advanceRequested: false, gmVerdicts: {}, factsEarned: {}, aiRoles: [],
  whispers: [], // BUG-0023: the one deliberate addition since the pin was taken; empty without a whisper
};

const events = (engine: SessionEngine): SessionEvent[] => {
  const r = engine.eventsAfter(0);
  if (!r.complete) throw new Error("window incomplete");
  return [...r.events];
};
const find = <T extends SessionEvent["type"]>(engine: SessionEngine, type: T) => events(engine).find((e) => e.type === type) as Extract<SessionEvent, { type: T }>;

describe("player copies (a new field is denied until it is listed)", () => {
  it("pins today's player snapshot (2a sees no change)", async () => {
    const { host } = await running();
    const snap = host.snapshotFor("host");
    expect(Object.keys(snap).sort()).toEqual(Object.keys(TODAYS_PLAYER_SNAPSHOT).sort());
    expect(snap).toEqual(TODAYS_PLAYER_SNAPSHOT);
  });

  it("a player snapshot of a session started with tech_lead as AI lists [\"tech_lead\"]", () => {
    const e = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1",
      roles: { tech_lead: { kind: "player" }, delivery_lead: { kind: "player" } }, aiRoles: ["tech_lead"] } as StartedEvent;
    const st = reduce(initialState(), e);
    const snap = snapshotForPlayer(st, "delivery_lead");
    expect(snap.aiRoles).toEqual(["tech_lead"]);
    expect(snap.aiRoles).not.toBe(st.aiRoles);
  });

  it("a player's session.started carries aiRoles equal to but not the same array as the event's, and a poison key aiSecret never", () => {
    const e = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", roles: { a: { kind: "player" }, b: { kind: "player" } },
      aiRoles: ["b", 9], aiSecret: "LEAK-AI" } as unknown as StartedEvent;
    const out = startedForPlayer(e, "a");
    expect(out.aiRoles).toEqual(["b"]);
    expect(out.aiRoles).not.toBe(e.aiRoles);
    expect(JSON.stringify(out)).not.toContain("LEAK-AI");
    expect(Object.hasOwn(out, "aiSecret")).toBe(false);
  });

  it("a player's copy of session.started has no includeInGroup key", () => {
    const e = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", roles: { a: { kind: "player" }, b: { kind: "player" } },
      aiRoles: ["b"], includeInGroup: false } as StartedEvent;
    const out = startedForPlayer(e, "a");
    expect(out.aiRoles).toEqual(["b"]);
    expect(Object.hasOwn(out, "includeInGroup")).toBe(false);
    expect(JSON.stringify(out)).not.toContain("includeInGroup");
  });

  it("a session.started without aiRoles reaches a player without the key", () => {
    const base = { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", roles: { a: { kind: "player" } } } as StartedEvent;
    expect(Object.hasOwn(startedForPlayer(base, "a"), "aiRoles")).toBe(false);
    expect(Object.hasOwn(startedForPlayer({ ...base, aiRoles: [] }, "a"), "aiRoles")).toBe(false);
  });

  it("BUG-0023: a whisper is in the addressed player's snapshot as seq, sceneId and text only, and in nobody else's", async () => {
    const { host, engine } = await running();
    await host.command({ command: "resume" });
    await host.command({ command: "whisper", roleId: "host", text: "Keep the price out" }, { by: "LEAK-BY" });
    const mine = host.snapshotFor("host");
    expect(mine.whispers).toEqual([{ seq: engine.state.lastSeq, sceneId: "s1_open", text: "Keep the price out" }]);
    expect(Object.keys(mine.whispers[0]!).sort()).toEqual(["sceneId", "seq", "text"]);
    expect(JSON.stringify(mine)).not.toMatch(/LEAK-BY|"by"|"ref"|"ack"/);
    expect(host.snapshotFor("guest").whispers).toEqual([]);
    expect(JSON.stringify(host.snapshotFor("guest"))).not.toContain("Keep the price out");
    expect(Array.isArray(mine.whispers)).toBe(true); // a list for this player, never the record keyed by role
    // the facilitator's snapshot is the state whole (it sent the whisper)
    expect(host.snapshotFor("facilitator").whispers.host).toHaveLength(1);
  });

  it("BUG-0023: with two players each snapshot holds only its own whispers, and an unknown or prototype-named viewer gets none", () => {
    let st = reduce(initialState(), { type: "session.started", seq: 1, ts: 1, sessionId: "s", scenarioId: "sc", version: "1", roles: { a: { kind: "player" }, b: { kind: "player" }, n: { kind: "npc" } } } as StartedEvent);
    st = reduce(st, { type: "scene.entered", seq: 2, ts: 2, sessionId: "s", sceneId: "s1", participants: ["a", "n"] });
    st = reduce(st, { type: "facilitator.command", seq: 3, ts: 3, sessionId: "s", command: "whisper", roleId: "a", text: "TO-A" });
    st = reduce(st, { type: "facilitator.command", seq: 4, ts: 4, sessionId: "s", command: "whisper", roleId: "b", text: "TO-B" });
    expect(snapshotForPlayer(st, "a").whispers).toEqual([{ seq: 3, sceneId: "s1", text: "TO-A" }]);
    expect(snapshotForPlayer(st, "b").whispers).toEqual([{ seq: 4, sceneId: null, text: "TO-B" }]);
    expect(JSON.stringify(snapshotForPlayer(st, "a"))).not.toContain("TO-B");
    expect(JSON.stringify(snapshotForPlayer(st, "b"))).not.toContain("TO-A");
    for (const who of ["n", "ghost", "__proto__", "constructor", "toString"]) expect(snapshotForPlayer(st, who).whispers).toEqual([]);
  });

  it("the facilitator snapshot carries talk and no player snapshot does", async () => {
    const { host } = await running();
    expect(host.snapshotFor("facilitator").talk).toEqual({ host: { words: 2, lines: 1 }, guest: { words: 6, lines: 1 } });
    expect(Object.hasOwn(host.snapshotFor("host"), "talk")).toBe(false);
    expect(Object.hasOwn(host.snapshotFor("guest"), "talk")).toBe(false);
  });

  it("a pause or resume reaches a player with exactly type, seq, ts, sessionId and command", async () => {
    const { host, engine } = await running();
    const pause = { ...find(engine, "facilitator.command"), by: "LEAK-BY", note: "LEAK-N" } as unknown as SessionEvent;
    const v = host.viewFor("host", pause);
    expect(Object.keys(v!).sort()).toEqual(["command", "seq", "sessionId", "ts", "type"]);
    expect(JSON.stringify(v)).not.toContain("LEAK");
  });

  it("a whisper reaches only its role, with roleId and text and nothing else", async () => {
    const { host, engine } = await running();
    const base = find(engine, "facilitator.command");
    const whisper = { ...base, command: "whisper", roleId: "host", text: "psst", by: "LEAK-BY", note: "LEAK-N" } as unknown as SessionEvent;
    const v = host.viewFor("host", whisper);
    expect(Object.keys(v!).sort()).toEqual(["command", "roleId", "seq", "sessionId", "text", "ts", "type"]);
    expect(JSON.stringify(v)).not.toContain("LEAK");
    expect(host.viewFor("guest", whisper)).toBeNull();
  });

  it("other facilitator commands never reach a player", async () => {
    const { host, engine } = await running();
    const base = find(engine, "facilitator.command");
    for (const c of [{ command: "advance" }, { command: "fire_inject", injectId: "x" }, { command: "release_hidden", roleId: "guest", fact: 1 }, { command: "set_npc_stance", roleId: "guest", goals: ["g"] }]) {
      expect(host.viewFor("host", { ...base, ...c } as unknown as SessionEvent)).toBeNull();
    }
  });

  it("a prompt_ai command is null for every role, the addressed AI role included (US-0060)", async () => {
    const { host, engine } = await running();
    const base = find(engine, "facilitator.command");
    const prompt = { ...base, command: "prompt_ai", roleId: "host", by: "LEAK-BY" } as unknown as SessionEvent;
    expect(commandForPlayer(prompt as never, "host")).toBeNull();
    expect(commandForPlayer(prompt as never, "guest")).toBeNull();
    expect(host.viewFor("host", prompt)).toBeNull();
    expect(host.viewFor("guest", prompt)).toBeNull();
  });

  it("session.ended reaches a player as type, seq, ts, sessionId and reason only", async () => {
    const { host } = await running();
    const ended = { type: "session.ended", seq: 99, ts: 1, sessionId: "s", reason: "script_complete", note: "LEAK-N", by: "LEAK-BY" } as unknown as SessionEvent;
    const v = host.viewFor("host", ended);
    expect(Object.keys(v!).sort()).toEqual(["reason", "seq", "sessionId", "ts", "type"]);
  });

  it("the facilitator still receives every event and the state unchanged", async () => {
    const { host, engine } = await running();
    const e = find(engine, "facilitator.command");
    expect(host.viewFor("facilitator", e)).toBe(e);
    expect(host.snapshotFor("facilitator")).toBe(engine.state);
  });

  it("replayFor uses the same copies", async () => {
    const { host, engine } = await running();
    const r = host.replayFor("host", 0);
    expect(r.complete).toBe(true);
    const cmd = r.events.find((e) => e.type === "facilitator.command");
    expect(Object.keys(cmd!).sort()).toEqual(["command", "seq", "sessionId", "ts", "type"]);
    expect(events(engine).length).toBeGreaterThan(r.events.length - 1);
  });
});
