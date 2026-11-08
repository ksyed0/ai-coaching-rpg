import { describe, expect, it } from "vitest";
import { FakeSpeechToText, SpeechRefusedError, SpeechTimeoutError, type SpeechSegment, type Transcript } from "@acr/adapters";
import { ActivityReporter } from "../activity.js";
import type { WorkerMessage } from "../protocol.js";
import { DEFAULT_SEGMENTER, Segmenter } from "../segmenter.js";
import { TrackPipeline, newSegmentId } from "../track-pipeline.js";
import { VoiceGate } from "../voice-gate.js";
import { concat, frames, silence, tone } from "./signals.js";

type Answer = Transcript | Error;
type Holder = { roleId: string; participantId: string; recording: boolean };
const LOUD = -20;
const good = (text: string): Transcript => ({ text, durationMs: 100, noSpeechProb: 0.02, avgLogprob: -0.2 });

/** A pipeline for `roleId` over a real segmenter, a FakeSpeechToText and an injected clock. `answers` scripts the STT per call. */
function harness(o: { roleId?: string; answers?: (seg: SpeechSegment, call: number) => Answer | Promise<Answer>; holders?: Holder[] | null; paused?: boolean } = {}) {
  const roleId = o.roleId ?? "tech_lead";
  const sent: WorkerMessage[] = [];
  const clock = { t: 5_000_000 };
  const gate = new VoiceGate();
  if (o.holders !== null) gate.update({ type: "voice_state", paused: o.paused ?? false, ended: false, holders: o.holders ?? [{ roleId, participantId: "p1", recording: true }] });
  const stt = new FakeSpeechToText({ script: o.answers ?? ((_s, n) => good(`line ${n + 1}`)) });
  const segmenter = new Segmenter(DEFAULT_SEGMENTER);
  let pushes = 0;
  const realPush = segmenter.push.bind(segmenter);
  segmenter.push = (f) => { pushes++; return realPush(f); };
  const send = (m: WorkerMessage) => { sent.push(m); };
  let n = 0;
  const p = new TrackPipeline({
    roleId, segmenter, stt, gate, activity: new ActivityReporter(send, () => clock.t), send, now: () => clock.t,
    newSegmentId: () => `seg${String(++n).padStart(3, "0")}`, deadlineMs: 5000,
  });
  /** Pushes the signal frame by frame, advancing the clock 20 ms per frame (real-time pacing, simulated). */
  const feed = (pcm: Int16Array) => { for (const f of frames(pcm)) { clock.t += 20; p.push(f); } };
  const lines = () => sent.filter((m) => m.type === "voice_line");
  const failures = () => sent.filter((m) => m.type === "segment_failed");
  return { p, sent, clock, gate, stt, feed, lines, failures, pushes: () => pushes, segmenter };
}

/** Lets pending promise chains run (no real timer). */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function deferredAnswers() {
  const pending: ((a: Answer) => void)[] = [];
  return { answers: () => new Promise<Answer>((r) => { pending.push(r); }), pending };
}

const BURST = concat(silence(300), tone(800, LOUD), silence(800));

describe("TrackPipeline (US-0070, AC-0398): segment, transcribe, gate, clean, deliver in order", () => {
  it("unconsented track produces nothing (no voice_state, a text-only holder, an unheld role, an AI role absent from holders)", async () => {
    const cases: Parameters<typeof harness>[0][] = [
      { holders: null }, // before the first voice_state
      { holders: [{ roleId: "tech_lead", participantId: "p1", recording: false }] }, // a holder who chose text
      { holders: [] }, // an unheld seat
      { roleId: "ai_seat", holders: [{ roleId: "tech_lead", participantId: "p1", recording: true }] }, // an AI seat is never listed
      { paused: true }, // a recording holder while paused
    ];
    for (const c of cases) {
      const h = harness(c);
      h.feed(concat(BURST, BURST, tone(7000, LOUD), silence(800)));
      await h.p.flush();
      await settle();
      expect(h.pushes(), JSON.stringify(c)).toBe(0); // never even segmented
      expect(h.stt.calls, JSON.stringify(c)).toEqual([]);
      expect(h.sent, JSON.stringify(c)).toEqual([]);
    }
  });

  it("one tone gives one voice_line with normalised text and startMs/endMs from the wall clock", async () => {
    const h = harness({ answers: () => good("  It costs $11,000 dollars.​ ") });
    const t0 = h.clock.t;
    h.feed(BURST);
    await settle();
    expect(h.lines()).toEqual([{ type: "voice_line", segmentId: "seg001", roleId: "tech_lead", participantId: "p1", text: "It costs $11,000.", startMs: t0 + 100, endMs: t0 + 1600 }]);
    expect(h.stt.calls).toEqual(["seg001"]);
    // The speech edges: true at the onset, false only after the line, measured from the last speech frame (1100 ms on the clock) to when
    // the edge went out (the feed had reached 1900 ms while the answer was pending): 800 ms.
    const edges = h.sent.filter((m) => m.type === "speech_activity");
    expect(edges).toEqual([{ type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 800 }]);
    expect(h.sent.findIndex((m) => m.type === "voice_line")).toBeLessThan(h.sent.findIndex((m) => m.type === "speech_activity" && !m.active));
  });

  it("the segment sent to STT carries 16 kHz audio and a deadline of now + deadlineMs", async () => {
    const seen: SpeechSegment[] = [];
    const h = harness({ answers: (s) => { seen.push(s); return good("ok"); } });
    h.feed(BURST);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sampleRate).toBe(16000);
    expect(seen[0]!.pcm.length).toBe(16 * 1500);
    expect(seen[0]!.deadline).toBe(h.clock.t + 5000 - 800 + 500); // closed 500 ms of hangover after the tone, 300 ms before the feed ended
  });

  it("out-of-order answers are delivered in segment order", async () => {
    const d = deferredAnswers();
    const h = harness({ answers: d.answers });
    h.feed(concat(BURST, BURST, BURST));
    await settle();
    expect(h.stt.calls).toEqual(["seg001", "seg002", "seg003"]);
    d.pending[2]!(good("third"));
    d.pending[1]!(good("second"));
    await settle();
    expect(h.lines()).toEqual([]); // the first is still out: nothing may overtake it
    d.pending[0]!(good("first"));
    await settle();
    expect(h.lines().map((m) => m.type === "voice_line" && m.text)).toEqual(["first", "second", "third"]);
    expect(h.lines().map((m) => m.type === "voice_line" && m.segmentId)).toEqual(["seg001", "seg002", "seg003"]);
  });

  it("a failed segment takes its place in the order", async () => {
    const d = deferredAnswers();
    const h = harness({ answers: d.answers });
    h.feed(concat(BURST, BURST));
    await settle();
    d.pending[1]!(good("second"));
    d.pending[0]!(new SpeechRefusedError());
    await settle();
    expect(h.sent.filter((m) => m.type === "voice_line" || m.type === "segment_failed").map((m) => m.type)).toEqual(["segment_failed", "voice_line"]);
  });

  it("an empty answer gives segment_failed empty and no voice_line", async () => {
    for (const answer of [good(""), good("   "), good("​‎"), { text: "Thank you.", durationMs: 90, noSpeechProb: 0.95 }]) {
      const h = harness({ answers: () => answer });
      h.feed(BURST);
      await settle();
      expect(h.lines(), JSON.stringify(answer)).toEqual([]);
      expect(h.failures()).toEqual([{ type: "segment_failed", segmentId: "seg001", roleId: "tech_lead", participantId: "p1", status: "empty" }]);
    }
  });

  it("a Refused or Timeout gives segment_failed stt_failed", async () => {
    for (const err of [new SpeechRefusedError(), new SpeechTimeoutError(), new Error("not a speech error")]) {
      const h = harness({ answers: () => err });
      h.feed(BURST);
      await settle();
      expect(h.lines()).toEqual([]);
      expect(h.failures()).toEqual([{ type: "segment_failed", segmentId: "seg001", roleId: "tech_lead", participantId: "p1", status: "stt_failed" }]);
      // The "speech stopped" edge still goes out, after the failure.
      expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", active: false });
    }
  });

  it("voice_state change discards the open segment (opt-out mid-tone: no STT call for it)", async () => {
    const h = harness();
    h.feed(concat(silence(300), tone(1200, LOUD)));
    expect(h.segmenter.speaking).toBe(true);
    const { stopped } = h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: false }] });
    expect(stopped).toEqual(["tech_lead"]);
    if (stopped.includes("tech_lead")) h.p.stop();
    h.feed(concat(tone(1200, LOUD), silence(800), BURST));
    await h.p.flush();
    await settle();
    expect(h.stt.calls).toEqual([]);
    expect(h.lines()).toEqual([]);
    expect(h.sent).toEqual([{ type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 0 }]);
  });

  it("a gate change noticed only at the next frame also discards (defence in depth: stop() not called)", async () => {
    const h = harness();
    h.feed(concat(silence(300), tone(1200, LOUD)));
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [] });
    h.feed(concat(tone(500, LOUD), silence(800)));
    await h.p.flush();
    await settle();
    expect(h.stt.calls).toEqual([]);
    expect(h.sent.filter((m) => m.type !== "speech_activity")).toEqual([]);
    expect(h.sent.at(-1)).toEqual({ type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 0 });
  });

  it("pause mid-tone discards it, and resume starts a fresh segment", async () => {
    const h = harness();
    const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true }];
    h.feed(concat(silence(300), tone(1000, LOUD)));
    h.gate.update({ type: "voice_state", paused: true, ended: false, holders });
    h.p.stop();
    h.feed(concat(tone(1000, LOUD), silence(800)));
    expect(h.stt.calls).toEqual([]);
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders });
    h.feed(BURST);
    await settle();
    expect(h.stt.calls).toEqual(["seg001"]);
    expect(h.lines()).toHaveLength(1);
  });

  it("a participant change at the next frame discards the old participant's open segment", async () => {
    const h = harness();
    h.feed(concat(silence(300), tone(1000, LOUD)));
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p2", recording: true }] });
    h.feed(concat(tone(400, LOUD), silence(800)));
    await settle();
    // The 400 ms after the change is p2's own segment; nothing of p1's speech is in it or attributed to p2.
    expect(h.stt.calls).toEqual(["seg001"]);
    expect(h.lines()).toEqual([expect.objectContaining({ participantId: "p2" })]);
  });

  it("a delivery for a participant replaced since segment start is dropped", async () => {
    const d = deferredAnswers();
    const h = harness({ answers: d.answers });
    h.feed(BURST);
    await settle();
    expect(h.stt.calls).toEqual(["seg001"]);
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p2", recording: true }] });
    d.pending[0]!(good("p1 said this"));
    await settle();
    expect(h.lines()).toEqual([]);
    expect(h.failures()).toEqual([]);
  });

  it("flush at end transcribes the open segment once", async () => {
    const h = harness();
    h.feed(concat(silence(300), tone(900, LOUD)));
    await h.p.flush();
    await h.p.flush();
    expect(h.stt.calls).toEqual(["seg001"]);
    expect(h.lines()).toEqual([expect.objectContaining({ text: "line 1" })]);
  });

  it("a forced split sends two lines and only one pair of speech edges", async () => {
    const h = harness();
    h.feed(concat(tone(4000, LOUD), silence(800)));
    await settle();
    expect(h.lines()).toHaveLength(2);
    expect(h.sent.filter((m) => m.type === "speech_activity").map((m) => m.type === "speech_activity" && m.active)).toEqual([true, false]);
  });

  it("a dropped short burst still closes the speech edge", async () => {
    const h = harness();
    h.feed(concat(silence(300), tone(200, LOUD), silence(800)));
    await settle();
    expect(h.stt.calls).toEqual([]);
    expect(h.sent).toEqual([{ type: "speech_activity", roleId: "tech_lead", active: true }, { type: "speech_activity", roleId: "tech_lead", active: false, silentMs: 800 }]);
  });

  it("an invalid segment id is never used (the segment is dropped, nothing reaches STT)", async () => {
    const h = harness();
    const bad = new TrackPipeline({
      roleId: "tech_lead", segmenter: new Segmenter(DEFAULT_SEGMENTER), stt: h.stt, gate: h.gate, activity: new ActivityReporter(() => {}, () => 0),
      send: (m) => { h.sent.push(m); }, now: () => h.clock.t, newSegmentId: () => "../x", deadlineMs: 5000,
    });
    for (const f of frames(BURST)) bad.push(f);
    await bad.flush();
    expect(h.stt.calls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("segment ids are 16 hex and unique across 1000 segments", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) { const id = newSegmentId(); expect(id).toMatch(/^[0-9a-f]{16}$/); ids.add(id); }
    expect(ids.size).toBe(1000);
  });
});
