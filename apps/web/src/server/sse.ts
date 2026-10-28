import type { SseOut } from "./stream-hub";

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
