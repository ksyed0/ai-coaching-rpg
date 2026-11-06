/**
 * The review-lock retry shared by the participant writes and the moderation service: 5 attempts, waiting 100/200/400/800 ms ±25%
 * between them, then the caller answers busy. `sleep` and `random` are injected so tests run without real delays.
 */
export const LOCK_ATTEMPTS = 5;
const BASE_DELAY_MS = 100;
const JITTER = 0.25;

/** The wait after failed attempt `attempt` (1-based): 100 × 2^(attempt-1) ms, scaled by 0.75 to 1.25 from `random()` in [0, 1]. */
export function lockBackoffMs(attempt: number, random: () => number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) * (1 - JITTER + random() * 2 * JITTER);
}

/** Runs `run` until it is not busy or the attempts are spent; returns the last result (still busy when every attempt was). */
export async function retryWhileBusy<T>(
  run: () => Promise<T>,
  isBusy: (r: T) => boolean,
  o: { sleep: (ms: number) => Promise<void>; random: () => number },
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const r = await run();
    if (!isBusy(r) || attempt >= LOCK_ATTEMPTS) return r;
    await o.sleep(lockBackoffMs(attempt, o.random));
  }
}
