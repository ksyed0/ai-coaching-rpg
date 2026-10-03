import { describe, expect, it } from "vitest";
import { initialState, reduce, visibleTranscript, type SessionEvent } from "../index.js";

const env = (seq: number) => ({ seq, ts: 1_000 + seq, sessionId: "s1" });

const started: SessionEvent = {
  ...env(1),
  type: "session.started",
  scenarioId: "esc-scope-creep-01",
  version: "1.2",
  roles: {
    delivery_lead: { kind: "player", participantId: "p1" },
    client_sponsor: { kind: "npc" },
  },
};

describe("reduce", () => {
  it("starts a session and enters the first scene", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    expect(s.status).toBe("running");
    expect(s.currentScene?.id).toBe("s1_huddle");
    expect(s.currentScene?.enteredAt).toBe(1_002);
  });

  it("appends utterances to the transcript with scene and seq", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    s = reduce(s, { ...env(3), type: "utterance", roleId: "delivery_lead", text: "Hi all", channel: "text" });
    expect(s.transcript).toEqual([{ seq: 3, ts: 1_003, sceneId: "s1_huddle", roleId: "delivery_lead", text: "Hi all", channel: "text" }]);
  });

  it("tracks pause and resume", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "facilitator.command", command: "pause" });
    expect(s.paused).toBe(true);
    s = reduce(s, { ...env(3), type: "facilitator.command", command: "resume" });
    expect(s.paused).toBe(false);
  });

  it("applies NPC goal updates", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "npc.updated", roleId: "client_sponsor", goals: ["Get a yes"], knowledge: ["CFO asked"] });
    expect(s.npcs.client_sponsor).toEqual({ goals: ["Get a yes"], knowledge: ["CFO asked"], released: [] });
  });

  it("ends the session", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "session.ended", reason: "script_complete" });
    expect(s.status).toBe("ended");
  });

  it("rejects an event whose seq is not the next one", () => {
    const s = reduce(initialState(), started);
    expect(() => reduce(s, { ...env(5), type: "facilitator.command", command: "pause" })).toThrow(/seq/);
  });
});

describe("visibleTranscript", () => {
  it("shows a role only the scenes it participated in", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    s = reduce(s, { ...env(3), type: "utterance", roleId: "delivery_lead", text: "internal only", channel: "text" });
    s = reduce(s, { ...env(4), type: "scene.exited", sceneId: "s1_huddle", reason: "facilitator_advance" });
    s = reduce(s, { ...env(5), type: "scene.entered", sceneId: "s2_client_call", participants: ["delivery_lead", "client_sponsor"] });
    s = reduce(s, { ...env(6), type: "utterance", roleId: "delivery_lead", text: "Hi Priya", channel: "text" });
    expect(visibleTranscript(s, "client_sponsor").map((u) => u.text)).toEqual(["Hi Priya"]);
    expect(visibleTranscript(s, "delivery_lead").map((u) => u.text)).toEqual(["internal only", "Hi Priya"]);
  });
});

describe("reduce: advance request and GM verdicts", () => {
  const enter = (seq: number, sceneId: string) => ({ ...env(seq), type: "scene.entered" as const, sceneId, participants: ["delivery_lead"] });
  const inScene = () => reduce(reduce(initialState(), started), enter(2, "a"));

  it("starts with no advance request and no verdicts", () => {
    expect(initialState().advanceRequested).toBe(false);
    expect(initialState().gmVerdicts).toEqual({});
  });

  it("advance command sets the flag and scene.entered resets it", () => {
    let s = reduce(inScene(), { ...env(3), type: "facilitator.command", command: "advance" });
    expect(s.advanceRequested).toBe(true);
    s = reduce(s, enter(4, "b"));
    expect(s.advanceRequested).toBe(false);
  });

  it("records gm.decision for the current scene keyed by condition", () => {
    const before = inScene();
    const s = reduce(before, { ...env(3), type: "gm.decision", sceneId: "a", condition: "said hello", verdict: true, reasoning: "r" });
    expect(s.gmVerdicts).toEqual({ "said hello": true });
    expect(before.gmVerdicts).toEqual({});
  });

  it("ignores gm.decision for a different scene", () => {
    const s = reduce(inScene(), { ...env(3), type: "gm.decision", sceneId: "zzz", condition: "c", verdict: true, reasoning: "r" });
    expect(s.gmVerdicts).toEqual({});
  });

  it("resets verdicts on scene.entered and scene.exited", () => {
    let s = reduce(inScene(), { ...env(3), type: "gm.decision", sceneId: "a", condition: "c", verdict: true, reasoning: "r" });
    const exited = reduce(s, { ...env(4), type: "scene.exited", sceneId: "a", reason: "time_box_elapsed" });
    expect(exited.gmVerdicts).toEqual({});
    s = reduce(s, enter(4, "b"));
    expect(s.gmVerdicts).toEqual({});
  });
});
