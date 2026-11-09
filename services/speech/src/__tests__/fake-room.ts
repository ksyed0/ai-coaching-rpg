import type { RoomConn, RoomPort, RoomTrack } from "../ingest/room-port.js";

/**
 * US-0071 (EPIC-0003 voice A1b, Task 7): a fake LiveKit room for the ingest tests. It records `subscribe`/`unsubscribe`, lets a test
 * publish and unpublish tracks and push audio, and — like rtc-node's AudioStream, whose already-buffered frames stay readable after an
 * unsubscribe (rtc-node 1.2.1 `AudioStreamSource.teardown`) — **keeps yielding queued and newly pushed frames to every open iterator of
 * a track after `unsubscribe`**. So nothing in the ingest may rely on an unsubscribe stopping the frames: only its own per-frame check.
 */
export class FakeRoomPort implements RoomPort {
  readonly opened: { url: string; token: string }[] = [];
  readonly conns: FakeConn[] = [];
  /** The next `open` rejects with this (then it is cleared). */
  failNext: Error | null = null;
  /** Tracks every new connection starts with (already in the room before the worker joins). */
  initial: RoomTrack[] = [];

  async open(url: string, token: string): Promise<RoomConn> {
    this.opened.push({ url, token });
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    const c = new FakeConn(this.initial);
    this.conns.push(c);
    return c;
  }
}

type Iter = { queue: Int16Array[]; wait: ((r: IteratorResult<Int16Array>) => void) | null; done: boolean };

export class FakeConn implements RoomConn {
  readonly calls: string[] = [];
  disconnected = false;
  private readonly published = new Map<string, RoomTrack>();
  private readonly iters = new Map<string, Iter[]>();
  private trackFns: ((t: RoomTrack) => void)[] = [];
  private goneFns: ((t: { identity: string; trackSid: string }) => void)[] = [];
  private discFns: (() => void)[] = [];

  constructor(initial: RoomTrack[]) { for (const t of initial) this.published.set(t.trackSid, t); }

  onTrack(fn: (t: RoomTrack) => void): void { this.trackFns.push(fn); for (const t of this.published.values()) fn(t); }
  onTrackGone(fn: (t: { identity: string; trackSid: string }) => void): void { this.goneFns.push(fn); }
  onDisconnected(fn: () => void): void { this.discFns.push(fn); }
  subscribe(trackSid: string): void { this.calls.push(`subscribe ${trackSid}`); }
  unsubscribe(trackSid: string): void { this.calls.push(`unsubscribe ${trackSid}`); }

  frames(trackSid: string, sampleRate: 16000, channels: 1): AsyncIterable<Int16Array> {
    if (sampleRate !== 16000 || channels !== 1) throw new Error("the fake room only serves 16 kHz mono");
    this.calls.push(`frames ${trackSid}`);
    const it: Iter = { queue: [], wait: null, done: false };
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
          it.done = true; it.queue = [];
          const w = it.wait; it.wait = null; w?.({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
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
      if (w) { it.wait = null; w({ value: chunk, done: false }); } else it.queue.push(chunk);
    }
  }
  /** Test side: the server ends the track's streams (as rtc-node does at an `eos`). */
  endStream(trackSid: string): void { for (const it of this.iters.get(trackSid) ?? []) { it.done = true; const w = it.wait; it.wait = null; w?.({ value: undefined, done: true }); } }
  /** Test side: the connection drops without the worker asking. */
  drop(): void { this.disconnected = true; this.endAll(); for (const f of this.discFns) f(); }
  openIterators(trackSid: string): number { return (this.iters.get(trackSid) ?? []).filter((i) => !i.done).length; }

  private endAll(): void { for (const sid of this.iters.keys()) this.endStream(sid); }
}

/** A microphone track of `identity`. */
export const mic = (identity: string, trackSid: string): RoomTrack => ({ identity, trackSid, kind: "audio", source: "microphone" });
/** A 320-sample chunk whose every sample is `v` (so a test can tell frames apart). */
export const chunk = (v: number, n = 320): Int16Array => new Int16Array(n).fill(v);
