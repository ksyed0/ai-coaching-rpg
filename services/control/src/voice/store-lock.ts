import { SessionLock, SessionLockError } from "@acr/runtime/files";

/**
 * US-0075 (A2b-1b, spec section 5): the one way control takes a session's audio store lock (`<id>.store.lock`), shared by the retention
 * sweep and the facilitator delete.
 *
 * - `IdentityMutex` is an in-process TRY-lock per identity (never a queue): both callers need "held means skip or report pending".
 * - `SessionLock.acquire` throws the same `locked` for a hold inside this process and for another process. Taking the mutex FIRST makes
 *   the two distinguishable: a held mutex is `locked_here`; a `locked` with the mutex ours is `locked_other`. That is sound only while every
 *   non-test store-lock acquire in control goes through `acquireStoreLock` (a source-scan test in `store-lock.test.ts` pins it).
 * - `not_a_file` (the lock is a link, has extra hard links, or belongs to another user) never clears on its own: `unsafe`.
 * - Reports nothing itself: callers log fixed sentences (never a path, an id or an identity).
 */

/** One in-process try-lock per identity. */
export class IdentityMutex {
  private readonly held = new Set<string>();

  /** Takes `identity` when free and returns its release (idempotent: a second call never frees a later holder); null while held. */
  tryTake(identity: string): (() => void) | null {
    if (this.held.has(identity)) return null;
    this.held.add(identity);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.held.delete(identity);
    };
  }
}

export type StoreLock = {
  kind: "held";
  /** Releases the store lock and then the mutex. Never throws; idempotent. */
  release(): void;
  /** Verifies NOW that the lock file is still ours (not the heartbeat-driven `lost` flag); false once lost or released. Never rejects. */
  assertHeld(): Promise<boolean>;
};
export type StoreLockResult = StoreLock | { kind: "locked_other" } | { kind: "locked_here" } | { kind: "unsafe" } | { kind: "error" };

/** Takes `mutex` for `id`, then `SessionLock.acquire(dir, id, { suffix: "store" })` without waiting. Never throws. */
export function acquireStoreLock(dir: string, id: string, mutex: IdentityMutex): StoreLockResult {
  const freeMutex = mutex.tryTake(id);
  if (freeMutex === null) return { kind: "locked_here" };
  let lock: SessionLock;
  try { lock = SessionLock.acquire(dir, id, { suffix: "store" }); } catch (err) {
    freeMutex();
    if (err instanceof SessionLockError && err.code === "locked") return { kind: "locked_other" };
    if (err instanceof SessionLockError && err.code === "not_a_file") return { kind: "unsafe" };
    return { kind: "error" };
  }
  let released = false;
  return {
    kind: "held",
    release(): void {
      if (released) return;
      released = true;
      try { lock.release(); } catch { /* SessionLock.release never throws; a leftover lock of ours goes stale */ }
      freeMutex();
    },
    // The runtime's `assertHeld()` resolves (void) or rejects ("lost" / "closed"), re-checking once on a miss; folded to a boolean here.
    async assertHeld(): Promise<boolean> {
      if (released) return false;
      try { await lock.assertHeld(); return true; } catch { return false; }
    },
  };
}
