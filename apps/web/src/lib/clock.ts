// The scene timer's arithmetic and the clock it reads. Components take a Clock so tests move time by hand.

export type Clock = { now(): number; every(ms: number, fn: () => void): () => void };

export const realClock: Clock = {
  now: () => Date.now(),
  every: (ms, fn) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

export type TimerInput = { timeBoxMinutes: number; enteredAt: number; pausedMs: number; paused: boolean; pausedSince: number | null };

/**
 * Time left in the scene: the time box less the time spent in it, where closed pauses (pausedMs) do not count and an open pause
 * stops the count at its start (so the timer freezes). Clamped to [0, time box]: a browser clock behind the server's shows a full box.
 */
export function remainingMs(t: TimerInput, now: number): number {
  const box = t.timeBoxMinutes * 60_000;
  const until = t.paused && t.pausedSince !== null ? t.pausedSince : now;
  const spent = Math.max(0, until - t.enteredAt - t.pausedMs);
  return Math.max(0, Math.min(box, box - spent));
}

const two = (n: number) => String(n).padStart(2, "0");

/** mm:ss (h:mm:ss from an hour), rounded up so 00:00 shows only when the time is really up. */
export function formatRemaining(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}
