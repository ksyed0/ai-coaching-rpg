/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.1): the per-track energy segmenter. Pure: no clock, no I/O. Times are stream milliseconds from the
 * first frame pushed (frame i covers [i * frameMs, (i + 1) * frameMs)).
 *
 * A frame is speech when its RMS is at or above `thresholdDbfs`. A segment opens at the first speech frame with up to `leadInMs` of the
 * frames before it, and closes after `hangoverMs` of continuous non-speech (`reason: "silence"`; its audio ends with those hangover frames).
 * A segment with less than `minSpeechMs` of speech frames is not emitted (`dropped` reports its last speech time instead), except the rest of
 * a forced split (`continued`: the same speech, cut only for length), which is kept with any speech at all (F4, review fix wave). When an open
 * segment reaches `maxSegmentMs` on a speech frame it is split after the quietest frame of its last `splitSearchMs` (ties: the latest
 * frame), `reason: "split"`, and the rest continues as the next segment (no frame is ever emitted twice). A segment that reaches the
 * maximum inside its hangover is not split: it closes at the hangover's end (at most `hangoverMs` longer). Hangover and maximum are
 * counted in whole frames, rounded up.
 */
export type SegmenterSettings = {
  /** VOICE_HANGOVER_MS, 300 to 600. */
  hangoverMs: number;
  /** VOICE_MAX_SEGMENT_MS, 2000 to 6000. */
  maxSegmentMs: number;
  frameMs: 20; thresholdDbfs: -45; leadInMs: 200; minSpeechMs: 300; splitSearchMs: 1000;
};

export const DEFAULT_SEGMENTER: SegmenterSettings = { hangoverMs: 500, maxSegmentMs: 2500, frameMs: 20, thresholdDbfs: -45, leadInMs: 200, minSpeechMs: 300, splitSearchMs: 1000 };
export const SAMPLE_RATE = 16_000;
export const HANGOVER_RANGE = [300, 600] as const;
export const MAX_SEGMENT_RANGE = [2000, 6000] as const;

export type SegmentOut = {
  pcm: Int16Array;
  startMs: number;
  endMs: number;
  /** Milliseconds of speech frames in the segment. */
  speechMs: number;
  /** The end of the segment's last speech frame. */
  lastSpeechMs: number;
  reason: "silence" | "split" | "flush";
  /** The RMS of the whole segment (lead-in and hangover included), in dBFS; -Infinity for digital silence. */
  meanDbfs: number;
};

export type PushResult = {
  /** A speech onset: a segment opened from silence (a split's continuation is not one). */
  started?: true;
  segments: SegmentOut[];
  /** An open segment closed with too little speech to emit: when its last speech frame ended. */
  dropped?: { lastSpeechMs: number };
};

type Frame = { pcm: Int16Array; index: number; energy: number; speech: boolean };

const FIXED = { frameMs: 20, thresholdDbfs: -45, leadInMs: 200, minSpeechMs: 300, splitSearchMs: 1000 } as const;

function inRange(v: number, [lo, hi]: readonly [number, number]): boolean { return Number.isInteger(v) && v >= lo && v <= hi; }

/** Mean square of the samples (full scale = 32768). */
function energyOf(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) { const x = pcm[i]! / 32768; sum += x * x; }
  return pcm.length === 0 ? 0 : sum / pcm.length;
}
const dbfs = (meanSquare: number): number => (meanSquare <= 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(meanSquare));

export class Segmenter {
  private readonly frameSamples: number;
  private readonly hangoverFrames: number;
  private readonly maxFrames: number;
  private readonly leadInFrames: number;
  private readonly searchFrames: number;
  private readonly threshold: number;
  private readonly minSpeechFrames: number;
  private pushed = 0;
  /** Frames before an onset, at most leadInFrames. */
  private lead: Frame[] = [];
  /** The open segment's frames, or null when idle. */
  private open: Frame[] | null = null;
  private trailing = 0;
  private lastSpeechIndex = -1;
  /** The open segment is the rest of a forced split (F4): the minimum-speech drop does not apply to it. */
  private continued = false;

  constructor(private readonly s: SegmenterSettings) {
    if (!inRange(s.hangoverMs, HANGOVER_RANGE)) throw new RangeError("the hangover must be a whole number of milliseconds from 300 to 600");
    if (!inRange(s.maxSegmentMs, MAX_SEGMENT_RANGE)) throw new RangeError("the maximum segment must be a whole number of milliseconds from 2000 to 6000");
    for (const k of Object.keys(FIXED) as (keyof typeof FIXED)[]) if (s[k] !== FIXED[k]) throw new RangeError("the segmenter constants cannot be changed");
    this.frameSamples = (SAMPLE_RATE * s.frameMs) / 1000;
    this.hangoverFrames = Math.ceil(s.hangoverMs / s.frameMs);
    this.maxFrames = Math.ceil(s.maxSegmentMs / s.frameMs);
    this.leadInFrames = s.leadInMs / s.frameMs;
    this.searchFrames = s.splitSearchMs / s.frameMs;
    this.minSpeechFrames = Math.ceil(s.minSpeechMs / s.frameMs);
    this.threshold = s.thresholdDbfs;
  }

  /** True while a segment is open. */
  get speaking(): boolean { return this.open !== null; }

  push(frame: Int16Array): PushResult {
    if (frame.length !== this.frameSamples) throw new RangeError("a frame must hold exactly 20 ms of 16 kHz samples");
    const energy = energyOf(frame);
    const f: Frame = { pcm: frame.slice(), index: this.pushed++, energy, speech: dbfs(energy) >= this.threshold };
    const out: PushResult = { segments: [] };
    if (this.open === null) {
      if (!f.speech) {
        this.lead.push(f);
        if (this.lead.length > this.leadInFrames) this.lead.shift();
        return out;
      }
      this.open = [...this.lead, f];
      this.lead = [];
      this.trailing = 0;
      this.continued = false;
      this.lastSpeechIndex = f.index;
      out.started = true;
      this.maybeSplit(out);
      return out;
    }
    this.open.push(f);
    if (f.speech) { this.trailing = 0; this.lastSpeechIndex = f.index; } else this.trailing++;
    if (this.trailing >= this.hangoverFrames) { this.close("silence", out); return out; }
    this.maybeSplit(out);
    return out;
  }

  /** Emits the open segment as `flush` (subject to minSpeechMs) and goes idle. */
  flush(): SegmentOut[] {
    const out: PushResult = { segments: [] };
    if (this.open !== null) this.close("flush", out);
    this.lead = [];
    return out.segments;
  }

  /** Drops the open segment and the lead-in buffer. */
  discard(): void {
    this.open = null;
    this.lead = [];
    this.trailing = 0;
    this.continued = false;
  }

  private maybeSplit(out: PushResult): void {
    const seg = this.open!;
    if (seg.length < this.maxFrames || this.trailing > 0) return;
    let cut = seg.length - 1;
    for (let i = seg.length - 1; i >= Math.max(0, seg.length - this.searchFrames); i--) if (seg[i]!.energy < seg[cut]!.energy) cut = i;
    const head = seg.slice(0, cut + 1);
    const rest = seg.slice(cut + 1);
    const e = this.emit(head, "split");
    if (e) out.segments.push(e);
    this.open = rest;
    this.continued = true;
    if (rest.some((x) => x.speech)) {
      let t = 0;
      for (let i = rest.length - 1; i >= 0 && !rest[i]!.speech; i--) t++;
      this.trailing = t;
    } // else the silent run continues across the cut: `trailing` stays
  }

  private close(reason: "silence" | "flush", out: PushResult): void {
    const seg = this.open!;
    this.open = null;
    this.trailing = 0;
    const e = this.emit(seg, reason);
    this.continued = false;
    if (e) out.segments.push(e);
    else if (this.lastSpeechIndex >= 0) out.dropped = { lastSpeechMs: (this.lastSpeechIndex + 1) * this.s.frameMs };
  }

  /** The segment of `frames`, or null when it holds too little speech (no speech at all, for the rest of a split). */
  private emit(frames: Frame[], reason: SegmentOut["reason"]): SegmentOut | null {
    const speech = frames.filter((x) => x.speech);
    if (frames.length === 0 || speech.length < (this.continued ? 1 : this.minSpeechFrames)) return null;
    const pcm = new Int16Array(frames.length * this.frameSamples);
    frames.forEach((x, i) => pcm.set(x.pcm, i * this.frameSamples));
    const ms = this.s.frameMs;
    return {
      pcm, startMs: frames[0]!.index * ms, endMs: (frames.at(-1)!.index + 1) * ms, speechMs: speech.length * ms,
      lastSpeechMs: (speech.at(-1)!.index + 1) * ms, reason, meanDbfs: dbfs(frames.reduce((n, x) => n + x.energy, 0) / frames.length),
    };
  }
}
