import { randomBytes } from "node:crypto";
import { isFileSafeId } from "@acr/events";
import type { SpeechToText, Transcript } from "@acr/adapters";
import type { ActivityReporter } from "./activity.js";
import { gate } from "./noise-gate.js";
import { normalise } from "./normalise.js";
import type { WorkerMessage } from "./protocol.js";
import { DEFAULT_SEGMENTER, SAMPLE_RATE, type Segmenter, type SegmentOut } from "./segmenter.js";
import type { VoiceGate } from "./voice-gate.js";

/** STT_DEADLINE_MS: how long a segment's text stays useful (the limiter enforces it; a cold model gets its own longer deadline). */
export const STT_DEADLINE_MS = 5000;

/** A server-made segment id: 16 hex characters (a file-safe id, unique across restarts by chance alone). */
export function newSegmentId(): string { return randomBytes(8).toString("hex"); }

const SEGMENT_FRAME_MS = DEFAULT_SEGMENTER.frameMs;

type Outcome = { kind: "text"; text: string } | { kind: "failed"; status: "empty" | "stt_failed" };

/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.3, AC-0398, AC-0399): one track's pipeline: segment, transcribe, gate, clean, deliver.
 *
 * Privacy invariant (the worker's half): a frame is IGNORED, not even segmented, unless `gate.recordingFor(roleId)` names a participant.
 * When that changes (opt-out, pause, end, a lost seat, another participant) the open segment and the lead-in are discarded, never
 * transcribed, and the speech edge is closed. A segment belongs to the participant who held the seat at its START; its result is
 * delivered only if that participant still records for the role (else it is dropped silently: the runtime would refuse it anyway).
 *
 * Order: transcriptions run concurrently (the limiter caps them), but one track's results are delivered strictly in segment order (per-
 * track FIFO): a later answer waits for every earlier one, and a failed or empty segment is delivered as `segment_failed` in its place.
 * Nothing is ever logged here.
 */
export class TrackPipeline {
  private tail: Promise<void> = Promise.resolve();
  /** The participant whose audio is in the segmenter (lead-in or open segment); null when it holds nothing. */
  private feeding: string | null = null;
  /** The stream time (ms) at the end of the last frame pushed into the segmenter. */
  private pushedEnd = 0;

  constructor(private readonly o: {
    roleId: string; segmenter: Segmenter; stt: SpeechToText; gate: VoiceGate; activity: ActivityReporter;
    send: (m: WorkerMessage) => void; now: () => number; newSegmentId: () => string; deadlineMs: number;
  }) {}

  push(frame: Int16Array): void {
    const rec = this.o.gate.recordingFor(this.o.roleId);
    if (rec === null) { if (this.feeding !== null) this.stop(); return; }
    // Another participant now holds the seat: nothing of the previous one's audio (not even the lead-in) may become theirs.
    if (this.feeding !== null && this.feeding !== rec.participantId) this.stop();
    this.feeding = rec.participantId;
    const r = this.o.segmenter.push(frame);
    this.pushedEnd += SEGMENT_FRAME_MS;
    if (r.started) this.o.activity.speechStarted(this.o.roleId);
    for (const s of r.segments) {
      const delivered = this.enqueue(s, rec.participantId);
      if (s.reason === "silence") this.o.activity.segmentClosed(this.o.roleId, this.wallOf(s.lastSpeechMs), delivered);
    }
    if (r.dropped) this.o.activity.segmentClosed(this.o.roleId, this.wallOf(r.dropped.lastSpeechMs), this.tail);
  }

  /** The role stopped recording: drop the open segment and the lead-in, close the edge. Results already in flight are re-checked on delivery. */
  stop(): void {
    this.o.segmenter.discard();
    this.feeding = null;
    this.o.activity.stop(this.o.roleId);
  }

  /** Emits the open segment (session end) and resolves once every result of this track has been delivered. */
  async flush(): Promise<void> {
    const rec = this.o.gate.recordingFor(this.o.roleId);
    const owner = this.feeding;
    const segs = this.o.segmenter.flush();
    this.feeding = null;
    if (rec !== null && owner === rec.participantId) {
      for (const s of segs) this.o.activity.segmentClosed(this.o.roleId, this.wallOf(s.lastSpeechMs), this.enqueue(s, owner));
    }
    await this.tail;
  }

  /** Wall-clock time of a stream time: the frame pushed last ended now. */
  private wallOf(streamMs: number): number {
    return Math.max(0, Math.round(this.o.now() - (this.pushedEnd - streamMs)));
  }

  /** Starts the transcription now and queues its delivery behind every earlier one of this track; resolves when it is delivered. */
  private enqueue(s: SegmentOut, participantId: string): Promise<void> {
    const segmentId = this.o.newSegmentId();
    if (!isFileSafeId(segmentId)) return this.tail; // never happens with the real generator; never used as an id
    const startMs = this.wallOf(s.startMs);
    const endMs = Math.max(startMs, this.wallOf(s.endMs));
    const result: Promise<Outcome> = this.o.stt
      .transcribe({ id: segmentId, pcm: s.pcm, sampleRate: SAMPLE_RATE, deadline: this.o.now() + this.o.deadlineMs })
      .then((t) => outcomeOf(s, t), (): Outcome => ({ kind: "failed", status: "stt_failed" }));
    const roleId = this.o.roleId;
    this.tail = this.tail.then(async () => {
      const out = await result;
      const still = this.o.gate.recordingFor(roleId);
      if (still === null || still.participantId !== participantId) return; // replaced, opted out, paused or ended meanwhile
      if (out.kind === "text") this.o.send({ type: "voice_line", segmentId, roleId, participantId, text: out.text, startMs, endMs });
      else this.o.send({ type: "segment_failed", segmentId, roleId, participantId, status: out.status });
    }).catch(() => undefined); // a throwing send must not stop the track's later deliveries
    return this.tail;
  }
}

function outcomeOf(s: SegmentOut, t: Transcript): Outcome {
  if (!gate(s, t).keep) return { kind: "failed", status: "empty" };
  const text = normalise(t.text);
  return text === "" ? { kind: "failed", status: "empty" } : { kind: "text", text };
}
