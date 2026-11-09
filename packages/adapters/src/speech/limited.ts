import { SpeechRefusedError, SpeechTimeoutError, SpeechUnavailableError, isSpeechError, type AnySpeechError } from "./errors.js";
import type { SpeechSegment, SpeechToText, Transcript } from "./types.js";

/** STT_MAX_IN_FLIGHT: speech-to-text requests at once (protects the GPU the NPC model also uses). */
export const DEFAULT_STT_MAX_IN_FLIGHT = 2;
/** STT_MAX_RETRIES: retries after a transient failure, never past the segment's deadline. */
export const DEFAULT_STT_MAX_RETRIES = 2;
/** STT_RETRY_BASE_MS: the first retry waits this long, each next one twice as long (150, 300). */
export const DEFAULT_STT_RETRY_BASE_MS = 150;
/** STT_QUEUE_ALERT: the queue length that raises the queue alert (once each time it is reached). */
export const DEFAULT_STT_QUEUE_ALERT = 16;
/** STT_COLD_TIMEOUT_MS: the deadline of a cold call (a local model may have to load first). */
export const DEFAULT_STT_COLD_TIMEOUT_MS = 30_000;
/** STT_IDLE_COLD_MS: after this long without any call, the next call counts as cold (local models unload on their own). */
export const DEFAULT_STT_IDLE_COLD_MS = 600_000;
/** The largest delay a Node timer takes; a longer one would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;
const clampDelay = (ms: number): number => Math.min(MAX_TIMER_MS, Math.max(0, ms));

export type LimitedOptions = {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => () => void;
  maxInFlight?: number; maxRetries?: number; baseMs?: number; queueAlertAt?: number; onQueueAlert?: () => void;
  coldTimeoutMs?: number; idleColdMs?: number;
};

type Item = {
  seg: SpeechSegment; deadline: number; cold: boolean; ac: AbortController; queued: boolean; settled: boolean;
  resolve: (t: Transcript) => void; reject: (e: Error) => void; cancelTimer: () => void; offCaller: () => void;
};

/**
 * US-0070 (spec 7.3, AC-0399): the limits around any SpeechToText. At most `maxInFlight` inner calls at once and a FIFO queue beyond them
 * (nothing is dropped: an item whose deadline passes while queued fails with SpeechTimeoutError without an inner call). Each item gets an
 * AbortSignal that fires at its deadline (through the injected `setTimer`) or when the caller aborts. A transient failure is retried after
 * `baseMs * 2^(n-1)` (150, 300), at most `maxRetries` times, never past the deadline: a retry that cannot start before it fails with the
 * last error. SpeechRefusedError is never retried; an error of another type counts as SpeechUnavailableError.
 *
 * Cold start (owner preference 2026-11-08): a call made while the service is cold gets the deadline `max(seg.deadline, now +
 * coldTimeoutMs)`, so a model that is loading is not reported as a failure. Cold means: no answer since the start yet, or no call for
 * `idleColdMs`, or another cold call still pending (it is loading the model these calls wait on). An answer (a transcript, or a refusal:
 * the server spoke) makes it warm. Every warm call keeps the tight segment deadline, so a stuck request still fails fast. Results are per
 * item; the caller (the per-track pipeline) keeps one speaker's lines in segment order, so a longer deadline never reorders lines.
 */
export class LimitedSpeechToText implements SpeechToText {
  private readonly queue: Item[] = [];
  private running = 0;
  private coldPending = 0;
  private lastAnswerAt: number | null = null;
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  private alerted = false;
  private readonly maxInFlight: number;
  private readonly maxRetries: number;
  private readonly baseMs: number;
  private readonly queueAlertAt: number;
  private readonly coldTimeoutMs: number;
  private readonly idleColdMs: number;

  constructor(private readonly inner: SpeechToText, private readonly o: LimitedOptions) {
    const whole = (v: number | undefined, d: number, min: number, what: string): number => {
      const x = v ?? d;
      if (!Number.isSafeInteger(x) || x < min) throw new RangeError(`${what} must be a whole number of at least ${min}`);
      return x;
    };
    this.maxInFlight = whole(o.maxInFlight, DEFAULT_STT_MAX_IN_FLIGHT, 1, "maxInFlight");
    this.maxRetries = whole(o.maxRetries, DEFAULT_STT_MAX_RETRIES, 0, "maxRetries");
    this.baseMs = whole(o.baseMs, DEFAULT_STT_RETRY_BASE_MS, 0, "baseMs");
    this.queueAlertAt = whole(o.queueAlertAt, DEFAULT_STT_QUEUE_ALERT, 1, "queueAlertAt");
    this.coldTimeoutMs = whole(o.coldTimeoutMs, DEFAULT_STT_COLD_TIMEOUT_MS, 1, "coldTimeoutMs");
    this.idleColdMs = whole(o.idleColdMs, DEFAULT_STT_IDLE_COLD_MS, 1, "idleColdMs");
  }

  /** Items waiting for a slot. */
  get queued(): number { return this.queue.length; }
  /** Inner calls running now (an aborted one counts until it has settled). */
  get inFlight(): number { return this.running; }

  transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript> {
    if (signal?.aborted) return Promise.reject(new SpeechTimeoutError());
    const now = this.o.now();
    const cold = this.isCold(now);
    const deadline = cold ? Math.max(seg.deadline, now + this.coldTimeoutMs) : seg.deadline;
    this.touch(now);
    return new Promise<Transcript>((resolve, reject) => {
      const item: Item = { seg, deadline, cold, ac: new AbortController(), queued: true, settled: false, resolve, reject, cancelTimer: () => {}, offCaller: () => {} };
      if (cold) this.coldPending += 1;
      item.cancelTimer = this.o.setTimer(() => this.expire(item), clampDelay(deadline - now));
      if (signal) {
        const onAbort = () => this.expire(item);
        signal.addEventListener("abort", onAbort, { once: true });
        item.offCaller = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(item);
      this.pump();
      this.noteQueue();
    });
  }

  health(signal?: AbortSignal): Promise<boolean> { return this.inner.health(signal); }

  /** The inner warm-up under the cold deadline; an answer makes the limiter warm, a failure leaves it cold. Outside the in-flight cap. */
  async warmUp(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SpeechTimeoutError();
    const start = this.o.now();
    this.touch(start);
    const ac = new AbortController();
    const cancel = this.o.setTimer(() => ac.abort(), clampDelay(this.coldTimeoutMs));
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.inner.warmUp(ac.signal);
      this.lastAnswerAt = this.o.now();
    } catch (err) {
      if (err instanceof SpeechRefusedError) this.lastAnswerAt = this.o.now();
      if (ac.signal.aborted) throw new SpeechTimeoutError();
      throw isSpeechError(err) ? err : new SpeechUnavailableError();
    } finally {
      cancel();
      signal?.removeEventListener("abort", onAbort);
      this.touch(this.o.now());
    }
  }

  private isCold(now: number): boolean {
    return this.coldPending > 0 || this.lastAnswerAt === null || now - this.lastActivityAt >= this.idleColdMs;
  }

  private touch(now: number): void { if (now > this.lastActivityAt) this.lastActivityAt = now; }

  private pump(): void {
    while (this.running < this.maxInFlight && this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.queued = false;
      if (item.settled) continue;
      if (this.o.now() >= item.deadline) { this.settle(item, new SpeechTimeoutError()); continue; }
      this.running += 1;
      void this.run(item).finally(() => { this.running -= 1; this.pump(); this.noteQueue(); });
    }
  }

  private async run(item: Item): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let failure: unknown;
      try {
        const t = await this.inner.transcribe(item.seg, item.ac.signal);
        this.lastAnswerAt = this.o.now();
        this.settle(item, t);
        return;
      } catch (err) { failure = err; }
      if (item.settled) return;
      if (item.ac.signal.aborted) { this.settle(item, new SpeechTimeoutError()); return; }
      const e: AnySpeechError = isSpeechError(failure) ? failure : new SpeechUnavailableError();
      if (e instanceof SpeechRefusedError) this.lastAnswerAt = this.o.now(); // the server answered: it is not cold
      if (!e.transient || attempt >= this.maxRetries) { this.settle(item, e); return; }
      const delay = this.baseMs * 2 ** attempt;
      if (this.o.now() + delay >= item.deadline) { this.settle(item, e); return; }
      try { await this.o.sleep(delay, item.ac.signal); } catch { this.settle(item, new SpeechTimeoutError()); return; }
      if (item.settled) return;
    }
  }

  /** The deadline passed or the caller aborted: a queued item leaves the queue, a running one is aborted; either fails with a timeout. */
  private expire(item: Item): void {
    if (item.settled) return;
    if (item.queued) { const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1); item.queued = false; }
    item.ac.abort();
    this.settle(item, new SpeechTimeoutError());
    this.noteQueue();
  }

  private settle(item: Item, out: Transcript | Error): void {
    if (item.settled) return;
    item.settled = true;
    item.cancelTimer();
    item.offCaller();
    if (item.cold) this.coldPending -= 1;
    this.touch(this.o.now());
    if (out instanceof Error) item.reject(out); else item.resolve(out);
  }

  private noteQueue(): void {
    if (this.queue.length >= this.queueAlertAt) {
      if (!this.alerted) { this.alerted = true; try { this.o.onQueueAlert?.(); } catch { /* an alert hook must not break the queue */ } }
    } else this.alerted = false;
  }
}
