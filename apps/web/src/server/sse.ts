import { ROBOTS_TAG } from "./headers";
import type { SetTimer } from "./runtime-connection";
import type { ReplaySummary } from "./wire";

/** `write` returns false when the consumer has not taken the chunk yet (backpressure) or is gone. */
export type SseOut = { write(chunk: string): boolean; end(): void };

export const RETRY_MS = 3_000;
export const HEARTBEAT_MS = 15_000;
export const DEFAULT_MAX_PENDING_BYTES = 256 * 1024;

// JSON.stringify escapes CR and LF, so a data line can never break the SSE framing.
export const sseFrame = (event: string, data: unknown, id?: number): string =>
  `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform: no proxy may compress (and so buffer) the stream.
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Robots-Tag": ROBOTS_TAG,
};
export function sseHeaders(setCookie?: string): Headers {
  const h = new Headers(SSE_HEADERS);
  if (setCookie !== undefined) h.set("Set-Cookie", setCookie);
  return h;
}
/**
 * A stream that is over before it starts. `reconnecting` lets the browser's EventSource come back after `retry` with its Last-Event-ID
 * kept (no id is sent here); `signed_out`, `removed`, `ended` and `superseded` are final (the page closes its EventSource).
 */
export function sseFinal(event: string, data: unknown = {}, setCookie?: string): Response {
  return new Response(`retry: ${RETRY_MS}\n\n${sseFrame(event, data)}`, { status: 200, headers: sseHeaders(setCookie) });
}

/** The browser's Last-Event-ID (the last seq it holds); anything that is not a plain safe integer resumes from 0. */
export function lastSeqOf(v: string | null): number {
  if (v === null || !/^\d{1,16}$/.test(v)) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

/** The browser's projection cannot be continued from this replay: it is missing or incomplete (lastSeq too old or past the head). */
export const replayIncomplete = (replay: ReplaySummary | undefined): boolean => !replay || !replay.complete;

/** Writes to `out`, counting the bytes written while the consumer signalled backpressure; past the cap it reports `stalled`. */
export class SseWriter {
  private pendingBytes = 0;
  constructor(private readonly out: SseOut, private readonly maxPendingBytes: number) {}
  write(chunk: string): "ok" | "stalled" | "gone" {
    let taken: boolean;
    try { taken = this.out.write(chunk); } catch { return "gone"; }
    if (taken) { this.pendingBytes = 0; return "ok"; }
    this.pendingBytes += Buffer.byteLength(chunk);
    return this.pendingBytes > this.maxPendingBytes ? "stalled" : "ok";
  }
}

/** Calls `beat` every HEARTBEAT_MS, re-arming while it returns true. Returns the cancel. */
export function heartbeat(setTimer: SetTimer, beat: () => boolean): () => void {
  let cancel = () => {};
  const arm = () => {
    cancel = setTimer(() => { if (beat()) arm(); }, HEARTBEAT_MS);
  };
  arm();
  return () => cancel();
}

/** Bytes the body may hold before `write` reports backpressure. */
const DEFAULT_HIGH_WATER_BYTES = 64 * 1024;

/**
 * A streaming response body for server-sent events, and the `out` writer the hub writes to. `write` returns false once the consumer
 * has fallen behind (the queue is at its high-water mark), which is what lets the hub's stall cap drop a client that stopped reading;
 * it throws once the body is closed or the browser went away, which the hub treats as the end. `onCancel` runs when the browser goes.
 */
export function sseBody(highWaterBytes = DEFAULT_HIGH_WATER_BYTES) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let cancelled = () => {};
  const stream = new ReadableStream<Uint8Array>(
    { start(c) { controller = c; }, cancel() { closed = true; cancelled(); } },
    new ByteLengthQueuingStrategy({ highWaterMark: highWaterBytes }),
  );
  const out: SseOut = {
    write(chunk) {
      if (closed) throw new Error("the stream is closed");
      controller.enqueue(encoder.encode(chunk));
      return (controller.desiredSize ?? 0) > 0;
    },
    end() {
      if (closed) return;
      closed = true;
      controller.close();
    },
  };
  return { stream, out, onCancel(fn: () => void) { cancelled = fn; } };
}
