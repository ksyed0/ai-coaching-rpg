import { SpeechTimeoutError } from "./errors.js";
import type { SpeechSegment, SpeechToText, Transcript } from "./types.js";

type ScriptResult = Transcript | Error;

/**
 * US-0070: a scripted SpeechToText for the pipeline tests and the offline demo. `script(seg, call)` (call counts from 0) returns the
 * transcript, or an Error to throw, or a promise of either. The text is trimmed (the contract). An aborted signal is a SpeechTimeoutError,
 * also while the script's promise is pending. `calls` holds the segment ids in call order; warm-ups are counted apart.
 */
export class FakeSpeechToText implements SpeechToText {
  readonly calls: string[] = [];
  warmUps = 0;
  constructor(private readonly o: { script: (seg: SpeechSegment, call: number) => ScriptResult | Promise<ScriptResult>; healthy?: () => boolean }) {}

  async transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript> {
    if (signal?.aborted) throw new SpeechTimeoutError();
    const call = this.calls.length;
    this.calls.push(seg.id);
    const out = await abortable(Promise.resolve(this.o.script(seg, call)), signal);
    if (out instanceof Error) throw out;
    return { ...out, text: out.text.trim(), durationMs: Math.max(0, out.durationMs) };
  }

  async health(): Promise<boolean> {
    try { return this.o.healthy?.() ?? true; } catch { return false; }
  }

  async warmUp(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SpeechTimeoutError();
    this.warmUps += 1;
  }
}

/** `p`, or a SpeechTimeoutError as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SpeechTimeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); });
  });
}
