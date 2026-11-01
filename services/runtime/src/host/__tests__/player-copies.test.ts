import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "@acr/events";
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
  injectsFired: [], npcs: {}, advanceRequested: false, gmVerdicts: {}, factsEarned: {},
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
