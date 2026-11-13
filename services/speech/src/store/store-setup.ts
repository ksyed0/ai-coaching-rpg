import { DEFAULT_LOCK_STALE_MS, SessionLock, SessionLockError } from "@acr/runtime/files";
import type { WorkerConfig } from "../config.js";
import type { WorkerMessage } from "../protocol.js";
import { AudioStore, type WriteResult } from "./audio-store.js";
import { ensureAudioRoot } from "./paths.js";

/** The store as the worker uses it (same shape as `WorkerStore` in worker.ts). */
export type OpenedStore = { write: AudioStore["write"]; markEnded(): void; readonly stopped: boolean };

/** Backoff step and the whole window: an old worker (control restart) may hold the lock up to DEFAULT_LOCK_STALE_MS, plus slack. */
export const LOCK_RETRY_STEP_MS = 250;
export const LOCK_WAIT_MS = DEFAULT_LOCK_STALE_MS + 5_000;

const stoppedStore: OpenedStore = { write: (): WriteResult => "stopped", markEnded: () => undefined, stopped: true };

/**
 * US-0073 (A2a Task 7c): opens the audio store behind its `<logIdentity>.store.lock`. Never throws. The audio folder is created and
 * checked first (the lock needs an existing private directory). A `locked` acquire is retried every LOCK_RETRY_STEP_MS until LOCK_WAIT_MS
 * has passed on the injected clock; any other failure is not retried. A failure sends `store_stopped { write_error }` once and returns a
 * store that writes nothing, so the worker keeps working as transcript-only. `release()` frees the lock (idempotent); a released lock does
 * NOT stop writes, so the caller must call it only after the last write and `markEnded`. Never logs a path, an id or an error message.
 */
export async function openStore(o: {
  cfg: NonNullable<WorkerConfig["store"]>;
  now: () => number;
  send: (m: WorkerMessage) => boolean;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  acquireLock?: typeof SessionLock.acquire;
  makeStore?: (opts: ConstructorParameters<typeof AudioStore>[0]) => AudioStore;
  /** Aborted when the parent is gone: the wait ends at once, nothing is sent (nobody listens) and nothing is held. */
  signal?: AbortSignal;
}): Promise<{ store: OpenedStore; release(): void }> {
  const acquire = o.acquireLock ?? SessionLock.acquire.bind(SessionLock);
  const make = o.makeStore ?? ((opts) => new AudioStore(opts));
  const stopSent = { done: false };
  const reportStopped = (reason: "disk_low" | "write_error"): void => {
    if (stopSent.done) return;
    stopSent.done = true;
    o.send({ type: "store_stopped", reason });
  };
  const failed = (): { store: OpenedStore; release(): void } => { reportStopped("write_error"); return { store: stoppedStore, release: () => undefined }; };

  const gone = (): { store: OpenedStore; release(): void } => ({ store: stoppedStore, release: () => undefined });
  if (o.signal?.aborted) return gone();
  let lock: SessionLock | undefined;
  try {
    ensureAudioRoot(o.cfg.audioDir);
    let store: AudioStore | undefined;
    const deadline = o.now() + LOCK_WAIT_MS;
    for (;;) {
      try { lock = acquire(o.cfg.audioDir, o.cfg.logIdentity, { suffix: "store", onLost: () => store?.lockLost() }); break; }
      catch (err) {
        if (o.signal?.aborted) return gone();
        if (!(err instanceof SessionLockError) || err.code !== "locked" || o.now() >= deadline) return failed();
        try { await o.sleep(LOCK_RETRY_STEP_MS, o.signal); } catch { if (o.signal?.aborted) return gone(); throw new Error("sleep failed"); }
      }
    }
    const held = lock;
    if (o.signal?.aborted) { held.release(); return gone(); }
    store = make({ audioDir: o.cfg.audioDir, logIdentity: o.cfg.logIdentity, sessionId: o.cfg.sessionId, sessionsDir: o.cfg.sessionsDir, minFreeMb: o.cfg.minFreeMb, now: o.now, lock: held, onStopped: reportStopped });
    let released = false;
    return { store, release: () => { if (released) return; released = true; try { held.release(); } catch { /* nothing more to do */ } } };
  } catch {
    try { lock?.release(); } catch { /* best effort */ }
    return failed();
  }
}

/**
 * The decision right after the store wait (main.ts): when the parent is gone (IPC closed, or SIGTERM/disconnect aborted the wait) release
 * the store lock if held and exit 0 before the worker starts. Returns true when it exited.
 */
export function afterStoreWait(o: { connected: boolean; aborted: boolean; release(): void; exit(code: number): void }): boolean {
  if (o.connected && !o.aborted) return false;
  o.release(); o.exit(0);
  return true;
}
