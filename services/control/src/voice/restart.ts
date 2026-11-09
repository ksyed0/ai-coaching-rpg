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
