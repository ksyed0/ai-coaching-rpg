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
/** US-0073: one delivered segment's audio and its outcome; `raw` is the normalised text for `text` only. */
export type SegmentAudio = {
  roleId: string; participantId: string; segmentId: string; startMs: number; endMs: number; pcm: Int16Array;
  outcome: "text" | "empty" | "stt_failed"; raw?: string;
};

export function newSegmentId(): string { return randomBytes(8).toString("hex"); }

const SEGMENT_FRAME_MS = DEFAULT_SEGMENTER.frameMs;

type Outcome = { kind: "text"; text: string } | { kind: "failed"; status: "empty" | "stt_failed" };

/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.3, AC-0398, AC-0399): one track's pipeline: segment, transcribe, gate, clean, deliver.
 *
 * Privacy invariant (the worker's half): a frame is IGNORED, not even segmented, unless `gate.recordingFor(roleId)` names a participant
 * and (US-0071, A1b Task 7) the frame's seat generation is exactly the gate's (both absent for file ingest): a frame of an old identity
 * still queued in a LiveKit stream is never attributed to the seat's new holder.
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
  /** US-0071: the seat generation of the audio in the segmenter (undefined for file ingest). */
  private feedingGeneration: string | undefined = undefined;
  /** The stream time (ms) at the end of the last frame pushed into the segmenter. */
  private pushedEnd = 0;
  /**
   * F5 (privacy defence in depth): cancels every transcription started before the last `stop` (opt-out, pause, reissue, a lost seat): a
   * segment queued behind the limiter's in-flight cap leaves the queue and one in flight is aborted. Renewed on every `stop`.
   */
  private cancel = new AbortController();

  constructor(private readonly o: {
    /** US-0073: called for each delivered segment, after the abort and "still recording" checks and before the send; a throw is swallowed. */
    onSegmentAudio?: (s: SegmentAudio) => void;
    roleId: string; segmenter: Segmenter; stt: SpeechToText; gate: VoiceGate; activity: ActivityReporter;
    send: (m: WorkerMessage) => void; now: () => number; newSegmentId: () => string; deadlineMs: number;
  }) {}

  push(frame: Int16Array, generation?: string): void {
    const rec = this.o.gate.recordingFor(this.o.roleId);
    if (rec === null) { if (this.feeding !== null) this.stop(); return; }
    // US-0071: a frame of another seat generation (an old identity's queued audio, or a second track) is never used, and whatever is in
    // the segmenter is discarded with it, so no segment can mix the two.
    if (generation !== rec.generation) { if (this.feeding !== null) this.stop(); return; }
    // Another participant now holds the seat: nothing of the previous one's audio (not even the lead-in) may become theirs.
    if (this.feeding !== null && (this.feeding !== rec.participantId || this.feedingGeneration !== rec.generation)) this.stop();
    this.feeding = rec.participantId;
    this.feedingGeneration = rec.generation;
    const r = this.o.segmenter.push(frame);
    this.pushedEnd += SEGMENT_FRAME_MS;
    if (r.started) this.o.activity.speechStarted(this.o.roleId);
    for (const s of r.segments) {
      const delivered = this.enqueue(s, rec.participantId, rec.generation);
      if (s.reason === "silence") this.o.activity.segmentClosed(this.o.roleId, this.wallOf(s.lastSpeechMs), delivered);
    }
    if (r.dropped) this.o.activity.segmentClosed(this.o.roleId, this.wallOf(r.dropped.lastSpeechMs), this.tail);
  }

  /** The role stopped recording: drop the open segment and the lead-in, close the edge. Results already in flight are re-checked on delivery. */
  stop(): void {
    this.cancel.abort();
    this.cancel = new AbortController();
    this.o.segmenter.discard();
    this.feeding = null;
    this.feedingGeneration = undefined;
    this.o.activity.stop(this.o.roleId);
  }

  /** Emits the open segment (session end, or the end of an ingest file), closes the speech edge, and resolves once every result of this track has been delivered. */
  async flush(): Promise<void> {
    const rec = this.o.gate.recordingFor(this.o.roleId);
    const owner = this.feeding;
    const ownerGeneration = this.feedingGeneration;
    const segs = this.o.segmenter.flush();
    this.feeding = null;
    this.feedingGeneration = undefined;
    if (rec !== null && owner === rec.participantId && ownerGeneration === rec.generation) {
      for (const s of segs) this.o.activity.segmentClosed(this.o.roleId, this.wallOf(s.lastSpeechMs), this.enqueue(s, owner, ownerGeneration));
      // F2: an open segment too short to keep still closes the speech edge (after any earlier outcome of this track).
      if (segs.length === 0) this.o.activity.segmentClosed(this.o.roleId, this.o.now(), this.tail);
    }
    await this.tail;
  }

  /** Wall-clock time of a stream time: the frame pushed last ended now. */
  private wallOf(streamMs: number): number {
    return Math.max(0, Math.round(this.o.now() - (this.pushedEnd - streamMs)));
  }

  /** Starts the transcription now and queues its delivery behind every earlier one of this track; resolves when it is delivered. */
  private enqueue(s: SegmentOut, participantId: string, generation: string | undefined): Promise<void> {
    const segmentId = this.o.newSegmentId();
    if (!isFileSafeId(segmentId)) return this.tail; // never happens with the real generator; never used as an id
    const startMs = this.wallOf(s.startMs);
    const endMs = Math.max(startMs, this.wallOf(s.endMs));
    const signal = this.cancel.signal;
    const result: Promise<Outcome> = this.o.stt
      .transcribe({ id: segmentId, pcm: s.pcm, sampleRate: SAMPLE_RATE, deadline: this.o.now() + this.o.deadlineMs }, signal)
      .then((t) => outcomeOf(s, t), (): Outcome => ({ kind: "failed", status: "stt_failed" }));
    const roleId = this.o.roleId;
    this.tail = this.tail.then(async () => {
      const out = await result;
      if (signal.aborted) return; // cancelled by a stop: never a line, never a failure notice
      const still = this.o.gate.recordingFor(roleId);
      if (still === null || still.participantId !== participantId || still.generation !== generation) return; // replaced, opted out, paused or ended meanwhile
      if (this.o.onSegmentAudio) {
        const base = { roleId, participantId, segmentId, startMs, endMs, pcm: s.pcm }; // s.pcm is a fresh array per segment (segmenter), never reused
        try {
          this.o.onSegmentAudio(out.kind === "text" ? { ...base, outcome: "text", raw: out.text } : { ...base, outcome: out.status });
        } catch { /* a failing store must not stop the send or later deliveries */ }
      }
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
