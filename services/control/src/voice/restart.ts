/**
 * US-0071 (EPIC-0003 voice A1b, Task 8, AC-0410, K10): the speech worker's restart budget. A worker that stops unexpectedly (or cannot
 * be spawned) is started again after `restartDelay(n)` for the n-th failure in a row: 500, 1000, 2000, 4000, 8000 ms. When the worker
 * started by the 5th restart fails too (RESTART_TRIES restarts in a row have failed), voice is off for the session. A worker that has
 * been `worker_ready` for RESTART_STABLE_MS resets the count, so a long session with rare, unrelated faults keeps its voice. Code
 * review constants, not settings.
 */
export const RESTART_TRIES = 5;
export const RESTART_BASE_MS = 500;
export const RESTART_STABLE_MS = 60_000;

/** The delay before the restart after the `attempt`-th consecutive failure (1 to RESTART_TRIES). */
export function restartDelay(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RESTART_TRIES) throw new RangeError(`attempt must be 1 to ${RESTART_TRIES}`);
  return RESTART_BASE_MS * 2 ** (attempt - 1);
}

/**
 * US-0072 (EPIC-0003 voice A1c, Task 11, "Restart budget: the decision"): while LiveKit does not answer control's probe (a LiveKit
 * outage), no worker runs and the outage does not spend the budget above; the probe is asked again after `livekitRetryDelay(n)` for
 * the n-th retry: 2, 4, 8, 16 s, then every 30 s, with no cap on the number of retries (a loopback GET every 30 s costs nothing, and the
 * session goes on by text). Code review constants, not settings.
 */
export const LIVEKIT_RETRY_BASE_MS = 2000;
export const LIVEKIT_RETRY_MAX_MS = 30_000;

/** The delay before the `n`-th probe retry of an outage (an integer, 1 or more): min(30 000, 2000 x 2^(n-1)) ms. */
export function livekitRetryDelay(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("n must be an integer of 1 or more");
  return Math.min(LIVEKIT_RETRY_MAX_MS, LIVEKIT_RETRY_BASE_MS * 2 ** (n - 1));
}
