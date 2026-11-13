import { describe, expect, it } from "vitest";
import { initialState, reduce, initPlayerView, applyPlayerEvent, type PlayerSnapshot, type PlayerView, type SessionEvent, type SessionState } from "../index.js";

const env = (seq: number, ts = 1_000 + seq) => ({ seq, ts, sessionId: "s1" });
const started: SessionEvent = { ...env(1), type: "session.started", scenarioId: "sc", version: "1", roles: { me: { kind: "player" }, npc: { kind: "npc" } } };
const entered = (seq: number, ts?: number): SessionEvent => ({ ...env(seq, ts), type: "scene.entered", sceneId: "s1", participants: ["me"] });
const said = (seq: number, text = "hi"): SessionEvent => ({ ...env(seq), type: "utterance", roleId: "me", text, channel: "text" });
const cmd = (seq: number, ts: number, command: "pause" | "resume"): SessionEvent => ({ seq, ts, sessionId: "s1", type: "facilitator.command", command });

/** The redacted join snapshot of a player (what SessionHost.snapshotFor returns): roles reduced to kinds, no internals. */
const snapshot = (over: Partial<PlayerSnapshot> = {}): PlayerSnapshot => ({ ...initialState(), whispers: [], status: "running", lastSeq: 5, scenarioId: "sc", version: "1",
  roles: { me: { kind: "player" } }, currentScene: { id: "s1", enteredAt: 1_002, participants: ["me"], pausedMs: 40 },
  transcript: [{ seq: 3, ts: 1_003, sceneId: "s1", roleId: "me", text: "earlier", channel: "text" }], injectsFired: ["i1"], ...over });

/** A snapshot of a session that has not started. */
const idle = (): PlayerSnapshot => ({ ...initialState(), whispers: [] });

describe("initPlayerView", () => {
  it("initPlayerView takes the redacted snapshot as is", () => {
    const v = initPlayerView(snapshot({ paused: true, pausedSince: 1_500 }));
    expect(v).toEqual({ lastSeq: 5, status: "running", paused: true, pausedSince: 1_500, scene: { id: "s1", enteredAt: 1_002, pausedMs: 40, participants: ["me"] },
      transcript: [{ seq: 3, ts: 1_003, roleId: "me", text: "earlier", sceneId: "s1" }], injects: [], ended: null, aiRoles: [], lastExit: null });
  });
  it("initPlayerView takes aiRoles from the snapshot and [] when absent", () => {
    expect(initPlayerView(snapshot({ aiRoles: ["them"] })).aiRoles).toEqual(["them"]);
    const bare = snapshot() as Partial<PlayerSnapshot>;
    delete bare.aiRoles;
    expect(initPlayerView(bare as PlayerSnapshot).aiRoles).toEqual([]);
    expect(initPlayerView({ ...snapshot(), aiRoles: ["ok", 5] } as unknown as PlayerSnapshot).aiRoles).toEqual(["ok"]);
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
  it("a whisper that reached this player is shown with the updates; it changes nothing else", () => {
    const v0 = initPlayerView(snapshot());
    const v = applyPlayerEvent(v0, { ...env(6), type: "facilitator.command", command: "whisper", roleId: "me", text: "Keep the price out" });
    expect(v.injects).toEqual([{ seq: 6, content: "Keep the price out", sceneId: "s1", private: true }]);
    expect({ ...v, injects: [], lastSeq: v0.lastSeq }).toEqual(v0);
  });
  it("BUG-0023: the player's own whispers in the snapshot are private updates, in seq order, kept once", () => {
    const v = initPlayerView(snapshot({ whispers: [{ seq: 4, sceneId: "s1", text: "second" }, { seq: 2, sceneId: null, text: "first" }, { seq: 4, sceneId: "s1", text: "dup" }] }));
    expect(v.injects).toEqual([{ seq: 2, content: "first", sceneId: "", private: true }, { seq: 4, content: "second", sceneId: "s1", private: true }]);
  });
  it("BUG-0023: a snapshot without whispers (an older runtime) or with a malformed list gives none", () => {
    const old = snapshot() as Partial<PlayerSnapshot>;
    delete old.whispers;
    expect(initPlayerView(old as PlayerSnapshot).injects).toEqual([]);
    expect(initPlayerView({ ...snapshot(), whispers: "no" } as unknown as PlayerSnapshot).injects).toEqual([]);
    const bad = [null, 7, { seq: "x", text: "a" }, { seq: 3, text: 9 }, { seq: 1.5, text: "b" }, { seq: 5, text: "ok" }];
    expect(initPlayerView({ ...snapshot(), whispers: bad } as unknown as PlayerSnapshot).injects).toEqual([{ seq: 5, content: "ok", sceneId: "", private: true }]);
  });
  it("BUG-0023: the same whisper delivered again by the replay after the snapshot is shown once", () => {
    const v0 = initPlayerView(snapshot({ lastSeq: 7, whispers: [{ seq: 6, sceneId: "s1", text: "once" }] }));
    const v1 = applyPlayerEvent(v0, { ...env(6), type: "facilitator.command", command: "whisper", roleId: "me", text: "once" });
    expect(v1).toBe(v0);
    expect(v1.injects).toHaveLength(1);
  });
  it("BUG-0023: a whisper kept by the snapshot and a later live one are both shown, in order, with an inject between them", () => {
    let v = initPlayerView(snapshot({ lastSeq: 6, whispers: [{ seq: 6, sceneId: "s1", text: "w1" }] }));
    v = applyPlayerEvent(v, { ...env(7), type: "inject.fired", injectId: "i2", sceneId: "s1", to: ["me"], content: "Note" });
    v = applyPlayerEvent(v, { ...env(8), type: "facilitator.command", command: "whisper", roleId: "me", text: "w2" });
    expect(v.injects.map((x) => [x.seq, x.content, x.private ?? false])).toEqual([[6, "w1", true], [7, "Note", false], [8, "w2", true]]);
  });
  it("scene.entered and scene.exited set and clear the scene", () => {
    let v = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), entered(6, 2_000));
    expect(v.scene).toEqual({ id: "s1", enteredAt: 2_000, pausedMs: 0, participants: ["me"] });
    v = applyPlayerEvent(v, { ...env(7), type: "scene.exited", sceneId: "s1", reason: "facilitator_advance" } as SessionEvent);
    expect(v.scene).toBeNull();
  });
  it("test_applyPlayerEvent_scene_exited_records_lastExit_with_seq_scene_and_reason (US-0080)", () => {
    let v = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), entered(6, 2_000));
    expect(v.lastExit).toBeNull();
    v = applyPlayerEvent(v, { ...env(7), type: "scene.exited", sceneId: "s1", reason: "gm_detects" });
    expect(v.lastExit).toEqual({ seq: 7, sceneId: "s1", reason: "gm_detects" });
    // The next scene does not clear it (the dialog names the next scene from it); a later exit replaces it.
    v = applyPlayerEvent(v, { ...env(8), type: "scene.entered", sceneId: "s2", participants: ["me"] });
    expect(v.lastExit).toEqual({ seq: 7, sceneId: "s1", reason: "gm_detects" });
    v = applyPlayerEvent(v, { ...env(9), type: "scene.exited", sceneId: "s2", reason: "time_box_elapsed" });
    expect(v.lastExit).toEqual({ seq: 9, sceneId: "s2", reason: "time_box_elapsed" });
    // A duplicate or stale copy changes nothing.
    expect(applyPlayerEvent(v, { ...env(7), type: "scene.exited", sceneId: "s1", reason: "gm_detects" })).toBe(v);
  });
  it("test_applyPlayerEvent_a_malformed_scene_exited_clears_the_scene_but_records_no_lastExit (US-0080)", () => {
    const start = applyPlayerEvent(initPlayerView(snapshot({ currentScene: null })), entered(6, 2_000));
    for (const bad of [{ sceneId: 5, reason: "gm_detects" }, { sceneId: "s1", reason: 7 }, { sceneId: "s1" }]) {
      const v = applyPlayerEvent(start, { ...env(7), type: "scene.exited", ...bad } as unknown as SessionEvent);
      expect(v.scene, JSON.stringify(bad)).toBeNull();
      expect(v.lastExit, JSON.stringify(bad)).toBeNull();
    }
  });
  it("test_initPlayerView_never_has_a_lastExit: a join or reload after the fact shows no scene-ended dialog (US-0080)", () => {
    expect(initPlayerView(snapshot({ currentScene: null, sceneHistory: [{ id: "s1", participants: ["me"] }] })).lastExit).toBeNull();
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
  it("session.ended copies a string message into ended and ignores a non-string one", () => {
    const base = initPlayerView(snapshot());
    const withMsg = applyPlayerEvent(base, { ...env(6), type: "session.ended", reason: "facilitator_end", message: "Thanks all <b>all</b>" });
    expect(withMsg.ended).toEqual({ reason: "facilitator_end", message: "Thanks all <b>all</b>" });
    const bad = applyPlayerEvent(base, { ...env(6), type: "session.ended", reason: "facilitator_end", message: { x: 1 } as unknown as string });
    expect(bad.ended).toEqual({ reason: "facilitator_end" });
    expect("message" in bad.ended!).toBe(false);
  });
  it("session.ended sets ended", () => {
    const v = applyPlayerEvent(initPlayerView(snapshot()), { ...env(6), type: "session.ended", reason: "script_complete" });
    expect(v).toMatchObject({ status: "ended", ended: { reason: "script_complete" }, scene: null });
  });
  it("session.started marks the session running and keeps no roles", () => {
    const v = applyPlayerEvent(initPlayerView(idle()), started);
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

/** Small deterministic PRNG (mulberry32) so a failing sequence can be replayed from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A gap-free sequence of events a player could receive, with non-monotonic and equal timestamps. */
function randomSequence(seed: number, length: number): SessionEvent[] {
  const rnd = prng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: SessionEvent[] = [];
  let ts = 10_000;
  if (rnd() < 0.8) out.push(started);
  for (let i = out.length; i < length; i++) {
    const seq = i + 1;
    ts = rnd() < 0.2 ? ts : ts + Math.floor((rnd() - 0.3) * 2_000); // equal sometimes, going backwards sometimes
    const e = { seq, ts, sessionId: "s1" };
    const kind = pick(["pause", "resume", "advance", "scene.entered", "scene.exited", "utterance", "inject.fired", "session.resumed", "facilitator.alert", "session.ended"]);
    switch (kind) {
      case "pause": case "resume": case "advance": out.push({ ...e, type: "facilitator.command", command: kind }); break;
      case "scene.entered": out.push({ ...e, type: "scene.entered", sceneId: pick(["a", "b", "c"]), participants: ["me"] }); break;
      case "scene.exited": out.push({ ...e, type: "scene.exited", sceneId: "a", reason: "facilitator_advance" } as SessionEvent); break;
      case "utterance": out.push({ ...e, type: "utterance", roleId: "me", text: `t${seq}`, channel: "text" }); break;
      case "inject.fired": out.push({ ...e, type: "inject.fired", injectId: `i${seq}`, sceneId: "a", to: ["me"], content: "c" }); break;
      case "session.resumed": out.push({ ...e, type: "session.resumed", downFromTs: ts + Math.floor((rnd() - 0.7) * 3_000) }); break;
      case "facilitator.alert": out.push({ ...e, type: "facilitator.alert", level: "info", message: "m" }); break;
      default: out.push({ ...e, type: "session.ended", reason: "facilitator_end" });
    }
  }
  return out;
}
const projectState = (s: SessionState) => ({ paused: s.paused, pausedSince: s.pausedSince,
  scene: s.currentScene && { id: s.currentScene.id, enteredAt: s.currentScene.enteredAt, pausedMs: s.currentScene.pausedMs, participants: s.currentScene.participants },
  transcript: s.transcript.map((u) => ({ seq: u.seq, ts: u.ts, roleId: u.roleId, text: u.text, sceneId: u.sceneId })), status: s.status });
const projectView = (v: PlayerView) => ({ paused: v.paused, pausedSince: v.pausedSince, scene: v.scene, transcript: v.transcript, status: v.status });

describe("applyPlayerEvent against reduce", () => {
  it("agrees with reduce on every prefix of many random gap-free sequences", () => {
    for (let seed = 1; seed <= 400; seed++) {
      let s = initialState(); let v = initPlayerView(idle());
      for (const e of randomSequence(seed, 40)) {
        s = reduce(s, e); v = applyPlayerEvent(v, e);
        expect(projectView(v), `seed ${seed} seq ${e.seq} ${e.type}`).toEqual(projectState(s));
      }
    }
  });
  it("applies without throwing when events are dropped at random (gaps), and lastSeq follows the highest seq seen", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = prng(seed * 7919);
      const kept = randomSequence(seed, 40).filter(() => rnd() < 0.6);
      let v = initPlayerView(idle());
      for (const e of kept) v = applyPlayerEvent(v, e);
      expect(v.lastSeq).toBe(kept.at(-1)?.seq ?? 0);
      expect(Number.isFinite(v.pausedSince ?? 0)).toBe(true);
      expect(v.scene === null || Number.isFinite(v.scene.pausedMs)).toBe(true);
    }
  });
});

describe("applyPlayerEvent with malformed events", () => {
  const v0 = () => initPlayerView(snapshot({ currentScene: { id: "s1", enteredAt: 1_000, participants: ["me"], pausedMs: 5 } }));
  const bad = (over: Record<string, unknown>) => ({ ...said(6), ...over }) as unknown as SessionEvent;
  it("a seq that is not a safe positive-order integer leaves the view unchanged", () => {
    const v = v0();
    for (const seq of [Number.NaN, undefined, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3, 7.5, "7"]) expect(applyPlayerEvent(v, bad({ seq }))).toBe(v);
  });
  it("a null or undefined event leaves the view unchanged", () => {
    const v = v0();
    expect(applyPlayerEvent(v, null as unknown as SessionEvent)).toBe(v);
    expect(applyPlayerEvent(v, undefined as unknown as SessionEvent)).toBe(v);
  });
  it("after a malformed seq a later good event and a duplicate still behave", () => {
    let v = applyPlayerEvent(v0(), bad({ seq: Number.NaN }));
    v = applyPlayerEvent(v, said(6));
    expect(v.lastSeq).toBe(6);
    expect(applyPlayerEvent(v, said(6, "dup"))).toBe(v);
  });
  it("a non-finite ts never reaches pausedSince, pausedMs or enteredAt", () => {
    for (const ts of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      let v = applyPlayerEvent(v0(), { ...cmd(6, 0, "pause"), ts } as unknown as SessionEvent);
      expect(v.pausedSince === null || Number.isFinite(v.pausedSince)).toBe(true);
      v = applyPlayerEvent(applyPlayerEvent(v0(), cmd(6, 2_000, "pause")), { ...cmd(7, 0, "resume"), ts } as unknown as SessionEvent);
      expect(Number.isFinite(v.scene!.pausedMs)).toBe(true);
      v = applyPlayerEvent(v0(), { ...entered(6), ts } as unknown as SessionEvent);
      expect(v.scene === null || Number.isFinite(v.scene.enteredAt)).toBe(true);
      expect(v.scene).toEqual(v0().scene);
      v = applyPlayerEvent(v0(), { ...env(6), type: "session.resumed", downFromTs: 1, ts } as unknown as SessionEvent);
      expect(v.pausedSince === null || Number.isFinite(v.pausedSince)).toBe(true);
    }
  });
  it("an utterance without text is not added", () => {
    const v = v0();
    expect(applyPlayerEvent(v, bad({ text: undefined })).transcript).toEqual(v.transcript);
  });
});

describe("applyPlayerEvent aiRoles (US-0060)", () => {
  it("applyPlayerEvent sets aiRoles from session.started and a duplicate seq changes nothing", () => {
    const v0 = initPlayerView(snapshot({ lastSeq: 0, status: "idle" }));
    const ev = { ...started, aiRoles: ["them", 4] } as SessionEvent;
    const v1 = applyPlayerEvent(v0, ev);
    expect(v1.aiRoles).toEqual(["them"]);
    expect(applyPlayerEvent(v1, { ...ev, aiRoles: ["other"] } as SessionEvent)).toBe(v1);
    expect(applyPlayerEvent(v0, started).aiRoles).toEqual([]);
    expect(applyPlayerEvent(v1, { ...started, ...env(2), aiRoles: undefined } as SessionEvent).aiRoles).toEqual([]);
  });
});
