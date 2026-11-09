import type { RoomConn, RoomPort, RoomTrack } from "../ingest/room-port.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): a fake LiveKit room for the ingest tests. It records `subscribe`/`unsubscribe`, lets a test
 * publish and unpublish tracks and push audio, and — like rtc-node's AudioStream, whose already-buffered frames stay readable after an
 * unsubscribe (rtc-node 1.2.1 `AudioStreamSource.teardown`) — **keeps yielding queued and newly pushed frames to every open iterator of
 * a track after `unsubscribe`**. So nothing in the ingest may rely on an unsubscribe stopping the frames: only its own per-frame check.
 *
 * Batch 3 review F2/F11: like a real async generator, `return()` called while a `next()` is pending does NOT settle that `next()`: it is
 * queued until the stream's next chunk (which the pending `next()` still receives) or its end. And with `lagUnsubscribe` the stale-track
 * race of rtc-node is modelled: an `unsubscribe` takes effect later (`flushUnsubscribed`), when it ends every stream of the track that
 * is open by then, including one started by a fast re-subscribe (rtc-node's `TrackUnsubscribed` and `track.closeAudioStreams()`).
 */
export class FakeRoomPort implements RoomPort {
  readonly opened: { url: string; token: string }[] = [];
  readonly conns: FakeConn[] = [];
  /** The next `open` rejects with this (then it is cleared). */
  failNext: Error | null = null;
  /** Tracks every new connection starts with (already in the room before the worker joins). */
  initial: RoomTrack[] = [];
  /** New connections deliver their unsubscribes late (see the class comment). */
  lagUnsubscribe = false;

  async open(url: string, token: string): Promise<RoomConn> {
    this.opened.push({ url, token });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const c = new FakeConn(this.initial);
    c.lagUnsubscribe = this.lagUnsubscribe;
    this.conns.push(c);
    return c;
  }
}

type Iter = {
  queue: Int16Array[]; wait: ((r: IteratorResult<Int16Array>) => void) | null; done: boolean;
  /** A `return()` that waits for the pending `next()` to settle (a real async generator's queue). */
  returning: (() => void) | null;
};

export class FakeConn implements RoomConn {
  readonly calls: string[] = [];
  disconnected = false;
  lagUnsubscribe = false;
  /** Unsubscribes not yet delivered (with `lagUnsubscribe`). */
  private readonly lagging: string[] = [];
  /** The next `subscribe` throws this (then it is cleared). */
  subscribeThrows: Error | null = null;
  private readonly published = new Map<string, RoomTrack>();
  private readonly iters = new Map<string, Iter[]>();
  private trackFns: ((t: RoomTrack) => void)[] = [];
  private goneFns: ((t: { identity: string; trackSid: string }) => void)[] = [];
  private discFns: (() => void)[] = [];

  constructor(initial: RoomTrack[]) { for (const t of initial) this.published.set(t.trackSid, t); }

  onTrack(fn: (t: RoomTrack) => void): void { this.trackFns.push(fn); for (const t of this.published.values()) fn(t); }
  onTrackGone(fn: (t: { identity: string; trackSid: string }) => void): void { this.goneFns.push(fn); }
  onDisconnected(fn: () => void): void { this.discFns.push(fn); }
  subscribe(trackSid: string): void {
    this.calls.push(`subscribe ${trackSid}`);
    if (this.subscribeThrows) { const e = this.subscribeThrows; this.subscribeThrows = null; throw e; }
  }
  unsubscribe(trackSid: string): void { this.calls.push(`unsubscribe ${trackSid}`); if (this.lagUnsubscribe) this.lagging.push(trackSid); }
  /** Test side: rtc-node's late `TrackUnsubscribed` for every unsubscribe so far: every stream of those tracks open now ends. */
  flushUnsubscribed(): void { for (const sid of this.lagging.splice(0)) this.endStream(sid); }

  frames(trackSid: string, sampleRate: 16000, channels: 1): AsyncIterable<Int16Array> {
    if (sampleRate !== 16000 || channels !== 1) throw new Error("the fake room only serves 16 kHz mono");
    this.calls.push(`frames ${trackSid}`);
    const it: Iter = { queue: [], wait: null, done: false, returning: null };
    const list = this.iters.get(trackSid) ?? [];
    list.push(it);
    this.iters.set(trackSid, list);
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<Int16Array>> => {
          const v = it.queue.shift();
          if (v) return Promise.resolve({ value: v, done: false });
          if (it.done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => { it.wait = r; });
        },
        return: (): Promise<IteratorResult<Int16Array>> => {
          this.calls.push(`return ${trackSid}`);
          it.queue = [];
          if (it.wait === null || it.done) { it.done = true; return Promise.resolve({ value: undefined, done: true }); }
          // A pending next(): the return waits for it (it still gets the next chunk, or the end), like a real async generator.
          return new Promise((r) => { it.returning = () => r({ value: undefined, done: true }); });
        },
      }),
    };
  }

  async disconnect(): Promise<void> { this.disconnected = true; this.calls.push("disconnect"); this.endAll(); }

  /** Test side: a participant publishes a track (the ingest hears of it through onTrack). */
  publish(t: RoomTrack): void { this.published.set(t.trackSid, t); for (const f of this.trackFns) f(t); }
  unpublish(identity: string, trackSid: string): void { this.published.delete(trackSid); for (const f of this.goneFns) f({ identity, trackSid }); }
  /** Test side: audio arrives on a track: every open iterator of it gets the chunk, subscribed or not (see the class comment). */
  push(trackSid: string, chunk: Int16Array): void {
    for (const it of this.iters.get(trackSid) ?? []) {
      if (it.done) continue;
      const w = it.wait;
      if (w) { it.wait = null; w({ value: chunk, done: false }); FakeConn.finishReturn(it); }
      else if (it.returning === null) it.queue.push(chunk);
    }
  }
  /** Test side: the server ends the track's streams (as rtc-node does at an `eos`). */
  endStream(trackSid: string): void {
    for (const it of this.iters.get(trackSid) ?? []) { const w = it.wait; it.wait = null; w?.({ value: undefined, done: true }); FakeConn.finishReturn(it); it.done = true; }
  }
  /** Test side: the connection drops without the worker asking. */
  drop(): void { this.disconnected = true; this.endAll(); for (const f of this.discFns) f(); }
  openIterators(trackSid: string): number { return (this.iters.get(trackSid) ?? []).filter((i) => !i.done).length; }
  /** Iterators of the track with a `next()` waiting for audio. */
  waitingIterators(trackSid: string): number { return (this.iters.get(trackSid) ?? []).filter((i) => !i.done && i.wait !== null).length; }

  private static finishReturn(it: Iter): void {
    const r = it.returning;
    if (r === null) return;
    it.returning = null; it.done = true; it.queue = [];
    r();
  }

  private endAll(): void { for (const sid of this.iters.keys()) this.endStream(sid); }
}

/** A microphone track of `identity`. */
export const mic = (identity: string, trackSid: string): RoomTrack => ({ identity, trackSid, kind: "audio", source: "microphone" });
/** A 320-sample chunk whose every sample is `v` (so a test can tell frames apart). */
export const chunk = (v: number, n = 320): Int16Array => new Int16Array(n).fill(v);
