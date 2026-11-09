import { randomBytes } from "node:crypto";
import { SpeechTimeoutError, type SpeechSegment, type SpeechToText, type Transcript } from "@acr/adapters";

/** A slot id: 16 lower-case hex (the protocol's SlotIdSchema). */
export function newSlotId(): string { return randomBytes(8).toString("hex"); }

/**
 * US-0071 (EPIC-0003 voice A1b, Task 6, AC-0409): the worker's half of control's global speech-to-text budget. Every inner call
 * (`transcribe` and `warmUp`) first asks control for a slot (`request`, sent as `stt_slot_request`), waits for `granted` (control's
 * `stt_slot_grant`), runs, and gives the slot back in `finally` (`release`, `stt_slot_release`). An abort while waiting withdraws the
 * request (`release`) and rejects SpeechTimeoutError without an inner call; a grant nobody waits for any more (it crossed that release)
 * is given back at once. `health` takes no slot. The limiter around this wrapper keeps its own per-worker cap and deadlines, so the slot
 * wait counts against the segment's deadline. Nothing here logs.
 */
export class SlotSpeechToText implements SpeechToText {
  private readonly waiting = new Map<string, () => void>();

  constructor(private readonly inner: SpeechToText, private readonly o: { request(slot: string): void; release(slot: string): void; newSlot(): string }) {}

  /** Control granted `slot`. */
  granted(slot: string): void {
    const go = this.waiting.get(slot);
    if (!go) { this.send("release", slot); return; }
    this.waiting.delete(slot);
    go();
  }

  transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript> {
    return this.inSlot(() => this.inner.transcribe(seg, signal), signal);
  }

  warmUp(signal?: AbortSignal): Promise<void> {
    return this.inSlot(() => this.inner.warmUp(signal), signal);
  }

  health(signal?: AbortSignal): Promise<boolean> { return this.inner.health(signal); }

  private async inSlot<T>(run: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) throw new SpeechTimeoutError();
    const slot = this.o.newSlot();
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.waiting.has(slot)) return;
        this.waiting.delete(slot);
        this.send("release", slot);
        reject(new SpeechTimeoutError());
      };
      this.waiting.set(slot, () => { signal?.removeEventListener("abort", onAbort); resolve(); });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send("request", slot);
    });
    try { return await run(); } finally { this.send("release", slot); }
  }

  /** A closed IPC channel must not turn into another error type: the slot is control's to reclaim (worker exit, or its lease). */
  private send(what: "request" | "release", slot: string): void {
    try { this.o[what](slot); } catch { /* the parent is gone */ }
  }
}
