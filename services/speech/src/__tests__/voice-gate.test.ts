import { describe, expect, it } from "vitest";
import { VoiceGate } from "../voice-gate.js";

const state = (holders: { roleId: string; participantId: string; recording: boolean }[], o: { paused?: boolean; ended?: boolean } = {}) =>
  ({ type: "voice_state" as const, paused: o.paused ?? false, ended: o.ended ?? false, holders });

describe("VoiceGate (US-0070, the worker's half of the privacy invariant)", () => {
  it("null before any voice_state (contradiction C6: nothing records until control says so)", () => {
    const g = new VoiceGate();
    expect(g.recordingFor("tech_lead")).toBeNull();
    expect(g.paused).toBe(false);
    expect(g.ended).toBe(false);
  });

  it("recording holders only", () => {
    const g = new VoiceGate();
    g.update(state([{ roleId: "tech_lead", participantId: "p1", recording: true }, { roleId: "pm", participantId: "p2", recording: false }]));
    expect(g.recordingFor("tech_lead")).toEqual({ participantId: "p1" });
    expect(g.recordingFor("pm")).toBeNull(); // a holder who chose text
    expect(g.recordingFor("designer")).toBeNull(); // an unheld or AI seat is never listed
    for (const proto of ["__proto__", "constructor", "toString", "hasOwnProperty"]) expect(g.recordingFor(proto)).toBeNull();
  });

  it("null while paused or ended", () => {
    const g = new VoiceGate();
    const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true }];
    g.update(state(holders, { paused: true }));
    expect(g.paused).toBe(true);
    expect(g.recordingFor("tech_lead")).toBeNull();
    g.update(state(holders));
    expect(g.recordingFor("tech_lead")).toEqual({ participantId: "p1" });
    g.update(state(holders, { ended: true }));
    expect(g.ended).toBe(true);
    expect(g.recordingFor("tech_lead")).toBeNull();
  });

  it("update reports the roles that stopped (opt-out, lost seat, another participant, pause, end)", () => {
    const g = new VoiceGate();
    const a = { roleId: "a", participantId: "p1", recording: true };
    const b = { roleId: "b", participantId: "p2", recording: true };
    expect(g.update(state([a, b]))).toEqual({ stopped: [] });
    expect(g.update(state([a, { ...b, recording: false }]))).toEqual({ stopped: ["b"] });
    expect(g.update(state([a, b]))).toEqual({ stopped: [] });
    expect(g.update(state([b]))).toEqual({ stopped: ["a"] });
    expect(g.update(state([{ ...b, participantId: "p3" }]))).toEqual({ stopped: ["b"] }); // a rebind: the open segment was p2's
    expect(g.update(state([a, b], { paused: true })).stopped.sort()).toEqual(["b"]);
    expect(g.update(state([a, b]))).toEqual({ stopped: [] });
    expect(g.update(state([a, b], { ended: true })).stopped.sort()).toEqual(["a", "b"]);
  });

  it("a later voice_state replaces the earlier one entirely", () => {
    const g = new VoiceGate();
    g.update(state([{ roleId: "a", participantId: "p1", recording: true }]));
    g.update(state([]));
    expect(g.recordingFor("a")).toBeNull();
  });
});
