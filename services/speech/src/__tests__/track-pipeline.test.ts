import { describe, expect, it, vi } from "vitest";
import { FakeSpeechToText, LimitedSpeechToText, SpeechRefusedError, SpeechTimeoutError, type SpeechSegment, type Transcript } from "@acr/adapters";
import { ActivityReporter } from "../activity.js";
import type { WorkerMessage } from "../protocol.js";
import { DEFAULT_SEGMENTER, Segmenter } from "../segmenter.js";
import { TrackPipeline, newSegmentId, type SegmentAudio } from "../track-pipeline.js";
import { VoiceGate } from "../voice-gate.js";
import { concat, frames, silence, tone } from "./signals.js";

type Answer = Transcript | Error;
type Holder = { roleId: string; participantId: string; recording: boolean };
const LOUD = -20;
const good = (text: string): Transcript => ({ text, durationMs: 100, noSpeechProb: 0.02, avgLogprob: -0.2 });

/** A pipeline for `roleId` over a real segmenter, a FakeSpeechToText and an injected clock. `answers` scripts the STT per call. */
function harness(o: { roleId?: string; answers?: (seg: SpeechSegment, call: number) => Answer | Promise<Answer>; holders?: Holder[] | null; paused?: boolean; onSegmentAudio?: (s: SegmentAudio) => void } = {}) {
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
    ...(o.onSegmentAudio ? { onSegmentAudio: o.onSegmentAudio } : {}),
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

  // F5 (review fix wave, privacy defence in depth): segments already handed to the limiter are cancelled by an opt-out, a pause or a
  // reissue: nothing queued behind the in-flight cap reaches speech-to-text after the worker applied the change.
  it("an opt-out with two segments queued behind the in-flight cap makes no further inner call", async () => {
    const roleId = "tech_lead";
    const sent: WorkerMessage[] = [];
    const clock = { t: 5_000_000 };
    const gate = new VoiceGate();
    gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId, participantId: "p1", recording: true }] });
    const d = deferredAnswers();
    const signals: (AbortSignal | undefined)[] = [];
    const inner = new FakeSpeechToText({ script: d.answers });
    const innerTranscribe = inner.transcribe.bind(inner);
    inner.transcribe = (seg, signal) => { signals.push(signal); return innerTranscribe(seg, signal); };
    const stt = new LimitedSpeechToText(inner, { now: () => clock.t, sleep: async () => {}, setTimer: () => () => {}, maxInFlight: 1 });
    const send = (m: WorkerMessage) => { sent.push(m); };
    let n = 0;
    const p = new TrackPipeline({ roleId, segmenter: new Segmenter(DEFAULT_SEGMENTER), stt, gate, activity: new ActivityReporter(send, () => clock.t), send, now: () => clock.t, newSegmentId: () => `seg${String(++n).padStart(3, "0")}`, deadlineMs: 5000 });
    for (const f of frames(concat(BURST, BURST, BURST))) { clock.t += 20; p.push(f); }
    await settle();
    expect(inner.calls).toHaveLength(1); // one in flight, two queued
    gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId, participantId: "p1", recording: false }] });
    p.stop();
    expect(signals[0]?.aborted).toBe(true); // the one in flight is told to stop as well
    d.pending[0]!(good("too late"));
    await settle();
    expect(inner.calls).toHaveLength(1);
    expect(sent.filter((m) => m.type === "voice_line")).toEqual([]);
  });

  it("a pipeline stopped once still transcribes what it segments afterwards (the cancel is renewed)", async () => {
    const h = harness();
    h.p.stop();
    h.feed(BURST);
    await h.p.flush();
    await settle();
    expect(h.lines()).toEqual([expect.objectContaining({ text: "line 1" })]);
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

describe("TrackPipeline and seat generations (US-0071, A1b Task 7, Review Focus 2)", () => {
  const G1 = "11111111";
  const G2 = "22222222";
  const withGen = (g: string) => [{ roleId: "tech_lead", participantId: "p1", recording: true, generation: g }];

  it("TrackPipeline drops a frame whose generation is not the gate's (not even segmented)", async () => {
    const h = harness({ holders: withGen(G2) });
    for (const f of frames(BURST)) { h.clock.t += 20; h.p.push(f, G1); }
    await settle();
    expect(h.pushes()).toBe(0);
    expect(h.sent).toEqual([]);
    for (const f of frames(BURST)) { h.clock.t += 20; h.p.push(f, undefined); } // a frame with no generation while the gate has one
    await settle();
    expect(h.pushes()).toBe(0);
    for (const f of frames(BURST)) { h.clock.t += 20; h.p.push(f, G2); }
    await settle();
    expect(h.lines().map((m) => m.participantId)).toEqual(["p1"]);
  });

  it("a frame with a generation while the gate has none (file ingest) is dropped too", async () => {
    const h = harness();
    for (const f of frames(BURST)) { h.clock.t += 20; h.p.push(f, G1); }
    await settle();
    expect(h.pushes()).toBe(0);
  });

  it("stops the open segment when it does: nothing of the old generation's audio is transcribed", async () => {
    const h = harness({ holders: withGen(G1) });
    const loud = frames(concat(silence(300), tone(600, LOUD)));
    for (const f of loud) { h.clock.t += 20; h.p.push(f, G1); } // a segment is open (speech, no closing silence yet)
    expect(h.sent.some((m) => m.type === "speech_activity" && m.active)).toBe(true);
    h.p.push(frames(tone(20, LOUD))[0]!, G2); // a frame of another generation arrives: the open segment is discarded
    for (const f of frames(silence(900))) { h.clock.t += 20; h.p.push(f, G1); }
    await settle();
    expect(h.lines()).toEqual([]);
    expect(h.stt.calls).toHaveLength(0);
  });
});

describe("TrackPipeline onSegmentAudio hook (US-0073, Task 7a)", () => {
  it("fires once per delivered segment with the right fields, before the send", async () => {
    const order: string[] = [];
    const got: SegmentAudio[] = [];
    const answers = [good("  hello there "), good(""), new SpeechTimeoutError()];
    const h = harness({
      answers: (_s, n) => answers[n]!,
      onSegmentAudio: (s) => { got.push(s); order.push(`hook:${s.segmentId}`); },
    });
    const origSent = h.sent.push.bind(h.sent);
    h.sent.push = (...m: WorkerMessage[]) => { for (const x of m) if (x.type === "voice_line" || x.type === "segment_failed") order.push(`send:${x.segmentId}`); return origSent(...m); };
    h.feed(concat(BURST, BURST, BURST));
    await settle();
    expect(got.map((g) => [g.segmentId, g.outcome, g.raw])).toEqual([["seg001", "text", "hello there"], ["seg002", "empty", undefined], ["seg003", "stt_failed", undefined]]);
    expect(order).toEqual(["hook:seg001", "send:seg001", "hook:seg002", "send:seg002", "hook:seg003", "send:seg003"]);
    const first = got[0]!;
    expect(first).toMatchObject({ roleId: "tech_lead", participantId: "p1" });
    expect(first.pcm).toBeInstanceOf(Int16Array);
    expect(first.pcm.length).toBeGreaterThan(0);
    expect(first.endMs).toBeGreaterThanOrEqual(first.startMs);
    const line = h.lines()[0]!;
    expect(line).toMatchObject({ startMs: first.startMs, endMs: first.endMs });
    expect("raw" in got[1]!).toBe(false);
  });

  it("never fires for an aborted segment", async () => {
    const d = deferredAnswers();
    const hook = vi.fn();
    const h = harness({ answers: d.answers, onSegmentAudio: hook });
    h.feed(BURST);
    await settle();
    h.p.stop();
    d.pending[0]!(good("late"));
    await settle();
    expect(hook).not.toHaveBeenCalled();
    expect(h.sent.filter((m) => m.type === "voice_line" || m.type === "segment_failed")).toEqual([]);
  });

  it("never fires for a segment whose participant changed or opted out meanwhile", async () => {
    const d = deferredAnswers();
    const hook = vi.fn();
    const h = harness({ answers: d.answers, onSegmentAudio: hook });
    h.feed(BURST);
    await settle();
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p2", recording: true }] });
    d.pending[0]!(good("hello"));
    await settle();
    expect(hook).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([]);
  });

  it("never fires for a segment whose generation changed meanwhile", async () => {
    const d = deferredAnswers();
    const hook = vi.fn();
    const h = harness({ answers: d.answers, onSegmentAudio: hook, holders: [{ roleId: "tech_lead", participantId: "p1", recording: true, generation: "11111111" } as Holder] });
    for (const f of frames(BURST)) { h.clock.t += 20; h.p.push(f, "11111111"); }
    await settle();
    h.gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: true, generation: "22222222" }] });
    d.pending[0]!(good("hello"));
    await settle();
    expect(hook).not.toHaveBeenCalled();
    expect(h.lines()).toEqual([]);
  });

  it("a throwing hook still sends, and later deliveries still happen", async () => {
    const hook = vi.fn(() => { throw new Error("disk"); });
    const h = harness({ onSegmentAudio: hook });
    h.feed(concat(BURST, BURST));
    await settle();
    expect(hook).toHaveBeenCalledTimes(2);
    expect(h.lines().map((m) => m.type === "voice_line" && m.text)).toEqual(["line 1", "line 2"]);
  });
});
