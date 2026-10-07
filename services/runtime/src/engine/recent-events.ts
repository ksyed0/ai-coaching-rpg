import type { SessionEvent } from "@acr/events";

/**
 * US-0013: how many of the most recent events the engine keeps in memory for replay-from-seq. A rejoining client is replayed from this
 * window only (never from disk), so a rejoin costs at most this many filter decisions, whatever the length of the log. A client that
 * is further behind gets no replay (`complete: false`) and relies on its join snapshot, as a client without `lastSeq` does.
 */
export const MAX_RETAINED_EVENTS = 4096;

/**
 * A ring of the last `capacity` session events, with contiguous seqs. Filled by the engine as each event is applied (live, and when a
 * log is restored after a restart), so its head is always the engine state's lastSeq.
 */
export class RecentEvents {
  private readonly buf: (SessionEvent | undefined)[];
  /** Index in `buf` of the oldest retained event. */
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number = MAX_RETAINED_EVENTS) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("capacity must be a whole number of events greater than 0");
    this.buf = new Array<SessionEvent | undefined>(capacity);
  }

  get size(): number { return this.count; }
  /** seq of the newest retained event (0 when empty). */
  get head(): number { return this.count === 0 ? 0 : this.at(this.count - 1).seq; }
  /** seq of the oldest retained event (head + 1 when empty, so `covers(head)` holds). */
  get oldest(): number { return this.count === 0 ? 1 : this.at(0).seq; }

  private at(i: number): SessionEvent { return this.buf[(this.start + i) % this.capacity]!; }

  push(e: SessionEvent): void {
    // Seqs are contiguous in the engine. If one ever were not, restart the window rather than claim to cover a range it lacks.
    if (this.count > 0 && e.seq !== this.head + 1) this.clear();
    if (this.count < this.capacity) { this.buf[(this.start + this.count) % this.capacity] = e; this.count++; return; }
    this.buf[this.start] = e;
    this.start = (this.start + 1) % this.capacity;
  }

  clear(): void { this.buf.fill(undefined); this.start = 0; this.count = 0; }

  /** True when every event after `afterSeq` up to the head is retained (so a replay from it has no gap). */
  covers(afterSeq: number): boolean {
    return Number.isSafeInteger(afterSeq) && afterSeq >= this.oldest - 1 && afterSeq <= this.head;
  }

  /** The retained events with seq > afterSeq, oldest first. Throws RangeError for a range the window does not cover. */
  *after(afterSeq: number): Generator<SessionEvent, void, undefined> {
    if (!this.covers(afterSeq)) throw new RangeError("the requested seq is outside the retained window");
    const total = this.count;
    for (let i = afterSeq - this.oldest + 1; i < total; i++) yield this.at(i);
  }
}
