import type { BrowserRoom } from "../voice-client";
import type { AudioContextLike, MediaStreamLike } from "../mic-level";

// US-0071 (A1b Task 15): stand-ins for the browser's microphone, audio graph and animation frames, and for the LiveKit room behind the
// BrowserRoom seam. No test opens a real microphone or needs a LiveKit server; nothing here waits in real time.

/** A LiveKit room as VoiceClient sees it: records every call in order; the test decides when a call fails or the server drops it. */
export class FakeRoom implements BrowserRoom {
  static made: FakeRoom[] = [];
  static reset(): void { FakeRoom.made = []; }
  readonly calls: string[];
  connected = false;
  /** Whether a microphone track is published (enable publishes, disable unpublishes). */
  published = false;
  failConnect = false;
  failEnable: Error | null = null;
  failDisable = false;
  private readonly dropFns: (() => void)[] = [];
  constructor(log: string[] = []) { this.calls = log; FakeRoom.made.push(this); }
  async connect(url: string, token: string): Promise<void> {
    this.calls.push(`connect ${url} ${token}`);
    if (this.failConnect) throw new Error("could not connect");
    this.connected = true;
  }
  async enableMicrophone(): Promise<void> {
    this.calls.push("enable");
    if (this.failEnable) throw this.failEnable;
    this.published = true;
  }
  async disableMicrophone(): Promise<void> {
    this.calls.push("disable");
    if (this.failDisable) throw new Error("could not unpublish");
    this.published = false;
  }
  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    const was = this.connected;
    this.connected = false;
    this.published = false;
    if (was) for (const fn of this.dropFns) fn();
  }
  onDisconnected(fn: () => void): void { this.dropFns.push(fn); }
  /** The server dropped this browser (a removal, a LiveKit restart). */
  serverDrop(): void {
    this.connected = false;
    this.published = false;
    for (const fn of this.dropFns) fn();
  }
}

/** requestAnimationFrame by hand: `frame(t)` runs every callback queued so far with the timestamp t. */
export function manualFrames() {
  let next = 1;
  const queued = new Map<number, (t: number) => void>();
  return {
    raf: (fn: (t: number) => void): number => { const id = next++; queued.set(id, fn); return id; },
    caf: (id: number): void => { queued.delete(id); },
    frame(t: number): void {
      const fns = [...queued.values()];
      queued.clear();
      for (const fn of fns) fn(t);
    },
    get pending(): number { return queued.size; },
  };
}

export class FakeTrack {
  stopped = false;
  stop(): void { this.stopped = true; }
}
export class FakeStream implements MediaStreamLike {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] { return this.tracks; }
}

/** An AudioContext whose analyser hands out a constant buffer the test sets (`amplitude`), as a full-band signal of that RMS. */
export class FakeAudioContext implements AudioContextLike {
  static made: FakeAudioContext[] = [];
  static reset(): void { FakeAudioContext.made = []; }
  resumed = 0;
  closed = false;
  connected = false;
  analyserDisconnected = false;
  sourceDisconnected = false;
  /** The time-domain samples the analyser reports next. */
  samples: (n: number) => Float32Array = (n) => new Float32Array(n);
  constructor(public readonly log: string[] = []) { FakeAudioContext.made.push(this); }
  resume(): Promise<void> { this.resumed++; this.log.push("resume"); return Promise.resolve(); }
  close(): Promise<void> { this.closed = true; return Promise.resolve(); }
  createMediaStreamSource() {
    return { connect: () => { this.connected = true; }, disconnect: () => { this.sourceDisconnected = true; } };
  }
  createAnalyser() {
    const ctx = this;
    return {
      fftSize: 2048,
      getFloatTimeDomainData(buf: Float32Array) { buf.set(ctx.samples(buf.length)); },
      disconnect: () => { this.analyserDisconnected = true; },
    };
  }
  /** Constant samples of this dBFS level (the RMS of a constant equals its absolute value). */
  level(dbfs: number): void {
    const a = dbfs === -Infinity ? 0 : 10 ** (dbfs / 20);
    this.samples = (n) => new Float32Array(n).fill(a);
  }
}

/** A DOMException-like error with a name, as getUserMedia rejects. */
export const mediaError = (name: string): Error => Object.assign(new Error(name), { name });
