import { MESSAGES } from "./messages";

// US-0071 (A1b Task 15): the mic check's level meter. The level is the RMS of the analyser's time-domain buffer in dBFS, read about ten
// times a second on animation frames (whose timestamps are also the history's clock, so tests drive it by hand). The words follow the
// plan's thresholds: "Hearing you" when the level stayed at or above -40 dBFS for at least 300 ms within the last second; "Too quiet"
// when the loudest level of the last 2 s is from -60 up to -40 dBFS; "No sound yet" otherwise (below -60, or no level yet).

/** What silence reads as (the meter's minimum): a level of -Infinity dBFS cannot be shown. */
export const LEVEL_FLOOR_DBFS = -100;
/** About ten updates a second. */
export const LEVEL_INTERVAL_MS = 100;
const HEARING_DBFS = -40;
const QUIET_DBFS = -60;
const HEARING_RUN_MS = 300;
const HEARING_WINDOW_MS = 1_000;
const QUIET_WINDOW_MS = 2_000;

/** The parts of the Web Audio API the meter uses (the test hands in a fake). */
export type AudioContextLike = {
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(stream: never): { connect(node: never): void; disconnect(): void };
  createAnalyser(): { fftSize: number; getFloatTimeDomainData(buf: Float32Array<ArrayBuffer>): void; disconnect(): void };
};
export type MediaStreamLike = { getTracks(): { stop(): void }[] };
export type Raf = (fn: (t: number) => void) => number;
export type Caf = (id: number) => void;

/** dBFS of a buffer of samples in [-1, 1]: 20 log10(RMS), at most 0, silence at the floor. */
export function dbfsOf(buf: Float32Array): number {
  let sum = 0;
  for (const x of buf) sum += x * x;
  const rms = Math.sqrt(sum / Math.max(1, buf.length));
  if (rms === 0) return LEVEL_FLOOR_DBFS;
  return Math.min(0, Math.max(LEVEL_FLOOR_DBFS, 20 * Math.log10(rms)));
}

/**
 * Starts reading the level of `stream` through `ctx` (which the caller created and resumed inside the click). Returns the stop, which
 * cancels the frames and disconnects the graph; it does not stop the tracks or close the context (the caller owns both).
 */
export function micLevel(ctx: AudioContextLike, stream: MediaStreamLike, onLevel: (dbfs: number, t: number) => void, raf: Raf, caf: Caf): () => void {
  const source = ctx.createMediaStreamSource(stream as never);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser as never);
  const buf = new Float32Array(analyser.fftSize);
  let last = -Infinity;
  let stopped = false;
  let id = 0;
  const frame = (t: number) => {
    if (stopped) return;
    if (t - last >= LEVEL_INTERVAL_MS) {
      last = t;
      analyser.getFloatTimeDomainData(buf);
      onLevel(dbfsOf(buf), t);
    }
    id = raf(frame);
  };
  id = raf(frame);
  return () => {
    if (stopped) return;
    stopped = true;
    caf(id);
    source.disconnect();
    analyser.disconnect();
  };
}

/** The last 2 s of levels, by frame timestamp, and the words they give. */
export class LevelHistory {
  private readonly samples: { t: number; db: number }[] = [];

  add(t: number, db: number): void {
    this.samples.push({ t, db });
    while (this.samples.length > 0 && this.samples[0]!.t < t - QUIET_WINDOW_MS) this.samples.shift();
  }

  get size(): number { return this.samples.length; }

  words(): string {
    const now = this.samples.at(-1)?.t;
    if (now === undefined) return MESSAGES.micNoSound;
    // A run of consecutive levels at or above -40 dBFS lasting 300 ms, any part of it within the last second.
    let runStart: number | null = null;
    for (const s of this.samples) {
      if (s.db >= HEARING_DBFS) {
        runStart ??= s.t;
        if (s.t - runStart >= HEARING_RUN_MS && s.t >= now - HEARING_WINDOW_MS) return MESSAGES.micHearing;
      } else runStart = null;
    }
    const loudest = Math.max(...this.samples.map((s) => s.db));
    return loudest >= QUIET_DBFS && loudest < HEARING_DBFS ? MESSAGES.micTooQuiet : MESSAGES.micNoSound;
  }
}
