import { describe, expect, it } from "vitest";
import { FakeSpeechToText } from "@acr/adapters";
import type { ControlConfig } from "../../config.js";
import type { ParentMessage } from "../../protocol.js";
import { VoiceHost, type SpeechSpawnFn, type WorkerHandle } from "../../voice/voice-host.js";
import { ActivityReporter } from "../../../../speech/src/activity.js";
import { DEFAULT_SEGMENTER, Segmenter } from "../../../../speech/src/segmenter.js";
import { TrackPipeline } from "../../../../speech/src/track-pipeline.js";
import { VoiceGate } from "../../../../speech/src/voice-gate.js";
import { concat, frames, silence, tone } from "../../../../speech/src/__tests__/signals.js";
import { AI_CONFIG } from "../fake-child.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 12; review C I1): what `end_to_append_ms` measures, end to end through the speech worker's real
 * segmenter and track pipeline, the voice_line, VoiceHost and the runtime's ack, on ONE injected clock. A segment's `endMs` is the
 * voice detector's end of the segment: the last speech frame PLUS the hangover (VOICE_HANGOVER_MS, the silence that closes a segment),
 * so `end_to_append_ms` includes the hangover. `start_to_append_ms` starts at the segment's first frame (the 200 ms lead-in included).
 */
const ID = "d".repeat(32);

async function run(hangoverMs: number): Promise<string[]> {
  const clock = { t: 7_000_000 };
  const sink: string[] = [];
  const toRuntime: ParentMessage[] = [];
  let emit: (m: unknown) => void = () => {};
  const spawn: SpeechSpawnFn = () => {
    const msg: ((raw: unknown) => void)[] = [];
    emit = (m) => { for (const f of msg) f(m); };
    const w: WorkerHandle = { send: () => true, onMessage: (fn) => { msg.push(fn); }, onExit: () => {}, kill: () => {}, forceKill: () => {}, disconnect: () => {} };
    return w;
  };
  const v = new VoiceHost({
    spawn, config: { graceMs: 1, logDir: "/nonexistent", ...AI_CONFIG } as ControlConfig, parentEnv: { PATH: "/bin", STT_PROVIDER: "fake" }, log: () => {},
    setTimer: () => () => {}, toRuntime: (_id, m) => { toRuntime.push(m); return true; }, now: () => clock.t, timingLog: (l) => { sink.push(l); },
  });
  v.attach(ID, { voice: true, roles: ["tech_lead"] });
  emit({ type: "worker_ready", stt: "ok" });
  const gate = new VoiceGate();
  gate.update({ type: "voice_state", paused: false, ended: false, holders: [{ roleId: "tech_lead", participantId: "p1", recording: true }] });
  const send = (m: unknown): void => { emit(m); };
  const p = new TrackPipeline({
    roleId: "tech_lead", segmenter: new Segmenter({ ...DEFAULT_SEGMENTER, hangoverMs }), stt: new FakeSpeechToText({ script: () => ({ text: "We ship in May.", durationMs: 100, noSpeechProb: 0.02, avgLogprob: -0.2 }) }),
    gate, activity: new ActivityReporter(send, () => clock.t), send, now: () => clock.t, newSegmentId: () => "seg001", deadlineMs: 5000,
  });
  const t0 = clock.t;
  // 300 ms silence, 800 ms speech (its last frame ends at t0 + 1100), 800 ms silence; the clock moves 20 ms per frame.
  for (const f of frames(concat(silence(300), tone(800, -20), silence(800)))) { clock.t += 20; p.push(f); }
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  const line = toRuntime.find((m) => m.type === "voice_line");
  expect(line).toBeDefined();
  expect(clock.t).toBe(t0 + 1900); // the ack comes 800 ms after the last speech frame
  v.fromRuntime(ID, { type: "voice_line_ack", segmentId: "seg001", seq: 1 });
  return sink;
}

describe("end_to_append_ms is measured from the voice detector's end, the hangover included (review C I1)", () => {
  it("hangover 500 ms (the default): 800 ms after the last speech frame reads 300", async () => {
    expect(await run(500)).toEqual([`session ${ID} voice line timing end_to_append_ms=300 start_to_append_ms=1800`]);
  });

  it("hangover 300 ms: the same moment reads 500 (end_to_append_ms + hangover = time since the last speech frame)", async () => {
    expect(await run(300)).toEqual([`session ${ID} voice line timing end_to_append_ms=500 start_to_append_ms=1800`]);
  });
});
