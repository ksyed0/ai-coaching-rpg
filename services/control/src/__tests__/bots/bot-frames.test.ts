import { describe, expect, it } from "vitest";
import { parseBotFrame } from "../../bots/bot-frames.js";

const state = { status: "running", paused: false, aiRoles: ["tech_lead"], currentScene: { id: "s1", participants: ["tech_lead", "cfo"] }, lastSeq: 7, transcript: [{ seq: 6, ts: 1, roleId: "cfo", text: "hi", sceneId: "s1" }] };
const joined = { type: "joined", roleId: "tech_lead", brief: "You are the tech lead", privateFacts: ["f1"], reconnectToken: "tok", state, scenes: [{ id: "s1", title: "T", goal: "G", timeBoxMinutes: 5 }] };
const j = (o: unknown) => JSON.stringify(o);

describe("parseBotFrame", () => {
  it("parses a joined frame and drops extra keys (timeBoxMinutes, ts)", () => {
    const f = parseBotFrame(j(joined));
    expect(f).toEqual({
      type: "joined", roleId: "tech_lead", brief: "You are the tech lead", privateFacts: ["f1"], reconnectToken: "tok",
      state: { status: "running", paused: false, aiRoles: ["tech_lead"], currentScene: { id: "s1", participants: ["tech_lead", "cfo"] }, lastSeq: 7, transcript: [{ seq: 6, roleId: "cfo", text: "hi", sceneId: "s1" }] },
      scenes: [{ id: "s1", title: "T", goal: "G" }],
    });
  });
  it("joined.scenes absent parses as []", () => {
    const { scenes: _s, ...rest } = joined;
    const f = parseBotFrame(j(rest));
    expect(f.type).toBe("joined");
    if (f.type === "joined") expect(f.scenes).toEqual([]);
  });
  it("an unknown type, a joined without brief and an event with a numeric roleId are ignored", () => {
    const { brief: _b, ...noBrief } = joined;
    expect(parseBotFrame(j({ type: "mystery" }))).toEqual({ type: "ignored" });
    expect(parseBotFrame(j(noBrief))).toEqual({ type: "ignored" });
    expect(parseBotFrame(j({ type: "event", event: { seq: 1, type: "utterance", roleId: 5, text: "x" } }))).toEqual({ type: "ignored" });
    for (const raw of ["", "not json", "null", "[]", "42", j({})]) expect(parseBotFrame(raw)).toEqual({ type: "ignored" });
  });
  it("a joined with a flattened state (no state object) or 1001 transcript lines is ignored", () => {
    const { state: _st, ...flat } = joined;
    expect(parseBotFrame(j({ ...flat, ...state }))).toEqual({ type: "ignored" });
    const long = { ...joined, state: { ...state, transcript: Array.from({ length: 1001 }, (_, i) => ({ seq: i, roleId: "cfo", text: "x", sceneId: null })) } };
    expect(parseBotFrame(j(long))).toEqual({ type: "ignored" });
    const ok = { ...joined, state: { ...state, transcript: Array.from({ length: 1000 }, (_, i) => ({ seq: i, roleId: "cfo", text: "x", sceneId: null })) } };
    expect(parseBotFrame(j(ok)).type).toBe("joined");
    const manyScenes = { ...joined, scenes: Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, title: "t", goal: "g" })) };
    expect(parseBotFrame(j(manyScenes))).toEqual({ type: "ignored" });
  });
  it("a peers roster keeps ai only when exactly true; a facilitator roster is ignored", () => {
    const f = parseBotFrame(j({ type: "roster", audience: "peers", entries: [{ roleId: "a", ready: true, ai: true, name: "x" }, { roleId: "b", ready: false }, { roleId: "c", ready: true, ai: "true" }, { roleId: "d", ready: true, ai: 1 }] }));
    expect(f).toEqual({ type: "roster", audience: "peers", entries: [{ roleId: "a", ready: true, ai: true }, { roleId: "b", ready: false, ai: false }, { roleId: "c", ready: true, ai: false }, { roleId: "d", ready: true, ai: false }] });
    expect(parseBotFrame(j({ type: "roster", audience: "facilitator", entries: [] }))).toEqual({ type: "ignored" });
  });
  it("parses the event kinds and ignores other facilitator commands", () => {
    const ev = (event: unknown) => parseBotFrame(j({ type: "event", event }));
    expect(ev({ seq: 2, ts: 5, type: "utterance", roleId: "cfo", text: "hello", channel: "x" })).toEqual({ type: "event", event: { seq: 2, type: "utterance", roleId: "cfo", text: "hello" } });
    expect(ev({ seq: 3, type: "scene.entered", sceneId: "s2", participants: ["a"], extra: 1 })).toEqual({ type: "event", event: { seq: 3, type: "scene.entered", sceneId: "s2", participants: ["a"] } });
    expect(ev({ seq: 4, type: "scene.exited", sceneId: "s2", reason: "x" })).toEqual({ type: "event", event: { seq: 4, type: "scene.exited", sceneId: "s2" } });
    expect(ev({ seq: 1, type: "session.started", aiRoles: ["tech_lead"], roles: {} })).toEqual({ type: "event", event: { seq: 1, type: "session.started", aiRoles: ["tech_lead"] } });
    expect(ev({ seq: 1, type: "session.started" })).toEqual({ type: "event", event: { seq: 1, type: "session.started", aiRoles: [] } });
    expect(ev({ seq: 9, type: "session.ended", reason: "x" })).toEqual({ type: "event", event: { seq: 9, type: "session.ended" } });
    expect(ev({ seq: 8, type: "session.resumed", downFromTs: 1 })).toEqual({ type: "event", event: { seq: 8, type: "session.resumed" } });
    expect(ev({ seq: 5, type: "facilitator.command", command: "pause" })).toEqual({ type: "event", event: { seq: 5, type: "facilitator.command", command: "pause" } });
    expect(ev({ seq: 5, type: "facilitator.command", command: "advance" })).toEqual({ type: "ignored" });
    expect(ev({ seq: 5, type: "inject.fired" })).toEqual({ type: "ignored" });
    expect(ev({ seq: -1, type: "session.ended" })).toEqual({ type: "ignored" });
    expect(ev({ seq: 1.5, type: "session.ended" })).toEqual({ type: "ignored" });
  });
  it("parses an error frame and caps long strings", () => {
    expect(parseBotFrame(j({ type: "error", code: "unauthorized", message: "no", ref: "r" }))).toEqual({ type: "error", code: "unauthorized", message: "no" });
    expect(parseBotFrame(j({ type: "error", code: "c".repeat(501), message: "m" }))).toEqual({ type: "ignored" });
    expect(parseBotFrame(j({ type: "event", event: { seq: 1, type: "utterance", roleId: "cfo", text: "x".repeat(100_000) } }))).toEqual({ type: "ignored" });
  });
});
