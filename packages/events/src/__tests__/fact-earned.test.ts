import { describe, expect, it } from "vitest";
import { EVENT_TYPES, initialState, isKnownEventType, reduce, reduceReplay, type SessionEvent } from "../index.js";

// US-0034: the facilitator-only `gm.fact_earned` event records that the Game Master judged a hidden fact's earned_when condition true.
const env = (seq: number) => ({ seq, ts: 1_000 + seq, sessionId: "s1" });
const started: SessionEvent = { ...env(1), type: "session.started", scenarioId: "x", version: "1", roles: { p: { kind: "player" }, cfo: { kind: "npc" } } };
const entered: SessionEvent = { ...env(2), type: "scene.entered", sceneId: "a", participants: ["p", "cfo"] };
const earned = (seq: number, fact: number, extra: Partial<Extract<SessionEvent, { type: "gm.fact_earned" }>> = {}): SessionEvent =>
  ({ ...env(seq), type: "gm.fact_earned", sceneId: "a", roleId: "cfo", fact, reasoning: "r", ...extra });

describe("gm.fact_earned", () => {
  it("is a known event type", () => {
    expect(EVENT_TYPES).toContain("gm.fact_earned");
    expect(isKnownEventType("gm.fact_earned")).toBe(true);
  });

  it("starts empty and records each earned fact once per role, in fact order, across scenes", () => {
    expect(initialState().factsEarned).toEqual({});
    let s = reduce(reduce(initialState(), started), entered);
    s = reduce(s, earned(3, 2));
    s = reduce(s, earned(4, 1, { autoRelease: true, via: "strict" }));
    s = reduce(s, earned(5, 2)); // a duplicate in a hand-edited log changes nothing
    s = reduce(s, { ...env(6), type: "scene.exited", sceneId: "a", reason: "facilitator_advance" });
    s = reduce(s, { ...env(7), type: "scene.entered", sceneId: "b", participants: ["p", "cfo"] });
    expect(s.factsEarned).toEqual({ cfo: [1, 2] });
    expect(s.gmVerdicts).toEqual({}); // never an exit verdict: an earned_when text equal to a gm_detects condition cannot end a scene
    expect(s.lastSeq).toBe(7);
  });

  it("does not touch the exit verdicts or the NPC state", () => {
    const before = reduce(reduce(initialState(), started), entered);
    const after = reduce(before, earned(3, 1));
    expect(after).toEqual({ ...before, lastSeq: 3, factsEarned: { cfo: [1] } });
  });

  it("reduceReplay agrees with reduce", () => {
    const evs = [started, entered, earned(3, 1), earned(4, 3)];
    expect(evs.reduce((s, e) => reduceReplay(s, e), initialState())).toEqual(evs.reduce((s, e) => reduce(s, e), initialState()));
  });
});
