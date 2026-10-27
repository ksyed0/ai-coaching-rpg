import { describe, expect, it } from "vitest";
import { initialState, reduce, initPlayerView, applyPlayerEvent, type SessionEvent, type SessionState } from "../index.js";

const env = (seq: number, ts = 1_000 + seq) => ({ seq, ts, sessionId: "s1" });
const started: SessionEvent = { ...env(1), type: "session.started", scenarioId: "sc", version: "1", roles: { me: { kind: "player" }, npc: { kind: "npc" } } };
const entered = (seq: number, ts?: number): SessionEvent => ({ ...env(seq, ts), type: "scene.entered", sceneId: "s1", participants: ["me"] });
const said = (seq: number, text = "hi"): SessionEvent => ({ ...env(seq), type: "utterance", roleId: "me", text, channel: "text" });
const cmd = (seq: number, ts: number, command: "pause" | "resume"): SessionEvent => ({ seq, ts, sessionId: "s1", type: "facilitator.command", command });

/** The redacted join snapshot of a player (what SessionHost.snapshotFor returns): roles reduced to kinds, no internals. */
const snapshot = (over: Partial<SessionState> = {}): SessionState => ({ ...initialState(), status: "running", lastSeq: 5, scenarioId: "sc", version: "1",
  roles: { me: { kind: "player" } }, currentScene: { id: "s1", enteredAt: 1_002, participants: ["me"], pausedMs: 40 },
  transcript: [{ seq: 3, ts: 1_003, sceneId: "s1", roleId: "me", text: "earlier", channel: "text" }], injectsFired: ["i1"], ...over });

describe("initPlayerView", () => {
  it("initPlayerView takes the redacted snapshot as is", () => {
    const v = initPlayerView(snapshot({ paused: true, pausedSince: 1_500 }));
    expect(v).toEqual({ lastSeq: 5, status: "running", paused: true, pausedSince: 1_500, scene: { id: "s1", enteredAt: 1_002, pausedMs: 40 },
      transcript: [{ seq: 3, ts: 1_003, roleId: "me", text: "earlier", sceneId: "s1" }], injects: [], ended: null });
  });
});

describe("applyPlayerEvent", () => {
  it("applyPlayerEvent skips a gap and keeps going", () => {
    let v = initPlayerView(snapshot());
    v = applyPlayerEvent(v, said(9, "after a gap"));
    expect(v.lastSeq).toBe(9);
    expect(v.transcript.at(-1)).toEqual({ seq: 9, ts: 1_009, roleId: "me", text: "after a gap", sceneId: "s1" });
  });
  it("a duplicate seq is ignored", () => {
    const v0 = applyPlayerEvent(initPlayerView(snapshot()), said(6));
    const v1 = applyPlayerEvent(v0, said(6, "again"));
    const v2 = applyPlayerEvent(v0, said(2, "stale"));
    expect(v1).toBe(v0); expect(v2).toBe(v0);
  });
  it("is pure: the input view is not changed", () => {
    const v0 = initPlayerView(snapshot());
    const copy = structuredClone(v0);
    applyPlayerEvent(applyPlayerEvent(v0, said(6)), { ...env(7), type: "inject.fired", injectId: "i2", sceneId: "s1", to: ["me"], content: "Note" });
    expect(v0).toEqual(copy);
  });
  it("records an inject with its content and scene", () => {
    const v = applyPlayerEvent(initPlayerView(snapshot()), { ...env(6), type: "inject.fired", injectId: "i2", sceneId: "s1", to: ["me"], content: "Note" });
    expect(v.injects).toEqual([{ seq: 6, content: "Note", sceneId: "s1" }]);
  });
  it("scene.entered and scene.exited set and clear the scene", () => {
    let v = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), entered(6, 2_000));
    expect(v.scene).toEqual({ id: "s1", enteredAt: 2_000, pausedMs: 0 });
    v = applyPlayerEvent(v, { ...env(7), type: "scene.exited", sceneId: "s1", reason: "facilitator_advance" } as SessionEvent);
    expect(v.scene).toBeNull();
  });
  it("an utterance outside a scene has sceneId null", () => {
    const v = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), said(6));
    expect(v.transcript.at(-1)?.sceneId).toBeNull();
  });
  it("pause and resume set paused, pausedSince and pausedMs by the engine's rule (state.ts)", () => {
    let v = initPlayerView(snapshot({ currentScene: { id: "s1", enteredAt: 1_000, participants: ["me"], pausedMs: 0 } }));
    v = applyPlayerEvent(v, cmd(6, 2_000, "pause"));
    expect(v).toMatchObject({ paused: true, pausedSince: 2_000 });
    v = applyPlayerEvent(v, cmd(7, 2_700, "pause")); // a second pause keeps the first start
    expect(v.pausedSince).toBe(2_000);
    v = applyPlayerEvent(v, cmd(8, 3_000, "resume"));
    expect(v).toMatchObject({ paused: false, pausedSince: null, scene: { pausedMs: 1_000 } });
    expect(applyPlayerEvent(v, cmd(9, 4_000, "resume")).scene?.pausedMs).toBe(1_000); // resume while running changes nothing
  });
  it("a scene entered while paused is frozen from its entry", () => {
    let v = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), cmd(6, 2_000, "pause"));
    v = applyPlayerEvent(v, entered(7, 2_500));
    expect(v.pausedSince).toBe(2_500);
    v = applyPlayerEvent(v, cmd(8, 3_000, "resume"));
    expect(v.scene?.pausedMs).toBe(500);
  });
  it("session.resumed comes back paused, from downFromTs but never after its own ts", () => {
    let v = applyPlayerEvent(initPlayerView(snapshot()), { ...env(6, 5_000), type: "session.resumed", downFromTs: 4_000 });
    expect(v).toMatchObject({ paused: true, pausedSince: 4_000 });
    v = applyPlayerEvent(initPlayerView(snapshot()), { ...env(6, 5_000), type: "session.resumed", downFromTs: 9_000 });
    expect(v.pausedSince).toBe(5_000);
  });
  it("session.ended sets ended", () => {
    const v = applyPlayerEvent(initPlayerView(snapshot()), { ...env(6), type: "session.ended", reason: "script_complete" });
    expect(v).toMatchObject({ status: "ended", ended: { reason: "script_complete" }, scene: null });
  });
  it("session.started marks the session running and keeps no roles", () => {
    const v = applyPlayerEvent(initPlayerView({ ...initialState() }), started);
    expect(v.status).toBe("running");
    expect(JSON.stringify(v)).not.toContain("participantId");
    expect(v).not.toHaveProperty("roles");
  });
  it("an event type the view does not know is ignored, not thrown", () => {
    const v0 = initPlayerView(snapshot());
    const odd = { ...env(6), type: "future.thing", x: 1 } as unknown as SessionEvent;
    expect(() => applyPlayerEvent(v0, odd)).not.toThrow();
    const alert: SessionEvent = { ...env(7), type: "facilitator.alert", level: "info", message: "m" };
    expect(applyPlayerEvent(v0, alert).transcript).toEqual(v0.transcript);
  });
});

describe("applyPlayerEvent against reduce", () => {
  const seq: SessionEvent[] = [started, entered(2), said(3), cmd(4, 3_000, "pause"), cmd(5, 3_900, "resume"), said(6, "b"),
    { ...env(7), type: "inject.fired", injectId: "i", sceneId: "s1", to: ["me"], content: "c" },
    { ...env(8), type: "scene.exited", sceneId: "s1", reason: "facilitator_advance" } as SessionEvent, entered(9, 9_000), cmd(10, 9_100, "pause"),
    { ...env(11, 9_500), type: "session.resumed", downFromTs: 9_200 }, cmd(12, 9_800, "resume"), said(13, "c"),
    { ...env(14), type: "session.ended", reason: "facilitator_end" }];
  const project = (s: SessionState) => ({ paused: s.paused, pausedSince: s.pausedSince, scene: s.currentScene && { id: s.currentScene.id, enteredAt: s.currentScene.enteredAt, pausedMs: s.currentScene.pausedMs },
    transcript: s.transcript.map((u) => ({ seq: u.seq, ts: u.ts, roleId: u.roleId, text: u.text, sceneId: u.sceneId })), status: s.status });

  it("agrees with reduce on every prefix of a gap-free sequence", () => {
    let s = initialState(); let v = initPlayerView(s);
    for (const e of seq) {
      s = reduce(s, e); v = applyPlayerEvent(v, e);
      expect({ paused: v.paused, pausedSince: v.pausedSince, scene: v.scene, transcript: v.transcript, status: v.status }).toEqual(project(s));
    }
  });
  it("does not throw when any single event is removed (gaps)", () => {
    for (let skip = 0; skip < seq.length; skip++) {
      let v = initPlayerView(initialState());
      expect(() => { for (const e of seq.filter((_, i) => i !== skip)) v = applyPlayerEvent(v, e); }).not.toThrow();
    }
  });
});
