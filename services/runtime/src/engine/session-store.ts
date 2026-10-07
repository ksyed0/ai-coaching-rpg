import path from "node:path";
import type { Scenario } from "@acr/script";
import type { Clock } from "./clock.js";
import { JsonlEventLog, LogCorruptError } from "./event-log.js";
import { DEFAULT_LOCK_STALE_MS, MAX_LOCK_STALE_MS, MIN_LOCK_STALE_MS, SessionLock, SessionLockError, ensurePrivateDir, finishInterruptedRotation, rotateStaleLog, type LockOptions } from "./log-files.js";
import { RestoreError, SessionEngine, type ResumeInfo, type ResumeNotes } from "./session-engine.js";

export type StartMode = "resume" | "fresh";

/** SESSION_START: resume (default) or fresh. The value is never echoed. */
export function parseStartMode(raw: string | undefined): { ok: true; mode: StartMode } | { ok: false; error: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "resume") return { ok: true, mode: "resume" };
  if (v === "fresh") return { ok: true, mode: "fresh" };
  return { ok: false, error: "SESSION_START must be resume or fresh" };
}

/** SESSION_LOCK_STALE_MS: how long without a heartbeat before another process may take the session lock over. */
export function parseLockStaleMs(raw: string | undefined): { ok: true; staleMs: number } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, staleMs: DEFAULT_LOCK_STALE_MS };
  const t = raw.trim();
  const n = /^[0-9]{1,9}$/.test(t) ? Number(t) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < MIN_LOCK_STALE_MS || n > MAX_LOCK_STALE_MS) return { ok: false, error: `SESSION_LOCK_STALE_MS must be a whole number of milliseconds from ${MIN_LOCK_STALE_MS} to ${MAX_LOCK_STALE_MS}` };
  return { ok: true, staleMs: n };
}

export type OpenedSession = {
  engine: SessionEngine; log: JsonlEventLog; lock: SessionLock;
  /** new: no previous log. resumed: a running session was restored (and marked resumed, paused). rotated: an old log was moved aside. */
  outcome: "new" | "resumed" | "rotated";
  /** Where the old log went (rotated only), and why. */
  rotatedTo?: string; rotatedBecause?: "fresh" | "ended";
  resume?: ResumeInfo;
  /** What the resume found worth telling the operator (downtime, a clock that went backwards, completed steps). */
  resumeNotes?: ResumeNotes;
  /** Operator notes (no secrets, no paths from the environment). */
  notes: string[];
  /** Closes the log handle and releases the lock. Never throws. */
  close(): Promise<void>;
};

export class SessionStoreError extends Error {
  constructor(readonly code: "lock" | "resume_refused" | "io", message: string) { super(message); this.name = "SessionStoreError"; }
}

const FRESH_HINT = "start a fresh session with SESSION_START=fresh (the old log is moved aside, never deleted)";

/**
 * Opens one session's log for a server process (US-0018):
 * 1. the data directory is made owner-only (0700, never widened);
 * 2. the session lock is taken (SessionLock: one process per log; refused while another live process holds it);
 * 3. SESSION_START=fresh moves a non-empty log aside (AC-0058); resume (the default) restores a running session from its log, paused
 *    (AC-0056), moves an ENDED session's log aside and starts fresh, and starts fresh on a missing or empty log. A log that cannot be
 *    resumed (corruption beyond a cut-off last line, another scenario, a newer format) is refused and left untouched.
 * The engine's appends refuse to run once the lock is lost.
 */
export async function openSession(o: {
  scenario: Scenario; sessionId: string; dataDir: string; clock: Clock; mode: StartMode; now?: () => Date; lock?: LockOptions; maxLogBytes?: number;
}): Promise<OpenedSession> {
  const notes: string[] = [];
  const now = o.now ?? (() => new Date());
  try { const w = ensurePrivateDir(o.dataDir); if (w) notes.push(`warning: ${w}`); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EUNSAFE") throw new SessionStoreError("io", `cannot use the data directory: ${(err as Error).message}`);
    throw new SessionStoreError("io", `cannot create the data directory ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let lock: SessionLock;
  try { lock = SessionLock.acquire(o.dataDir, o.sessionId, o.lock); }
  catch (err) {
    if (err instanceof SessionLockError) throw new SessionStoreError("lock", `cannot open the session: ${err.message}`);
    throw new SessionStoreError("io", `cannot lock the session log in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  // A crash between a rotation's link and unlink leaves the log under two names: finish that rotation (the data stays rotated).
  try {
    const finished = finishInterruptedRotation(o.dataDir, o.sessionId);
    if (finished) notes.push(`warning: an interrupted rotation was finished: the previous log stays aside as ${finished}`);
  } catch (err) { lock.release(); throw new SessionStoreError("io", `cannot finish an interrupted log rotation in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`); }
  const make = () => {
    const log = new JsonlEventLog(o.sessionId, o.dataDir, { guard: () => lock.assertHeld(), maxBytes: o.maxLogBytes });
    return { log, engine: new SessionEngine({ scenario: o.scenario, log, clock: o.clock }) };
  };
  const rotate = (because: "fresh" | "ended") => {
    try { return rotateStaleLog(o.dataDir, o.sessionId, now()); }
    catch (err) { throw new SessionStoreError("io", `cannot rotate the previous session log in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}${because === "ended" ? " (it holds a session that had ended)" : ""}`); }
  };
  let opened: { log: JsonlEventLog; engine: SessionEngine } | null = null;
  try {
    const done = (x: { log: JsonlEventLog; engine: SessionEngine }, rest: Pick<OpenedSession, "outcome" | "rotatedTo" | "rotatedBecause" | "resume" | "resumeNotes">): OpenedSession => ({
      ...x, lock, notes, ...rest,
      close: async () => { try { await x.log.close(); } catch { /* best effort */ } lock.release(); },
    });
    if (o.mode === "fresh") {
      const rotatedTo = rotate("fresh");
      opened = make();
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "fresh" } : { outcome: "new" });
    }
    opened = make();
    let restored;
    try { restored = await opened.engine.restore(); }
    catch (err) {
      if (err instanceof RestoreError || err instanceof LogCorruptError) throw new SessionStoreError("resume_refused", `cannot resume the session from its log: ${err.message}. The log was not changed; ${FRESH_HINT}`);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "EMLINK") throw new SessionStoreError("resume_refused", `the session log is a symbolic link and is not followed; move ${path.basename(opened.log.file)} away and retry`);
      throw new SessionStoreError("io", `cannot read the session log in ${o.dataDir}: ${code ?? (err as Error).message}`);
    }
    if (restored.kind === "empty") return done(opened, { outcome: "new" });
    if (restored.kind === "ended") {
      await opened.log.close();
      const rotatedTo = rotate("ended");
      opened = make();
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "ended" } : { outcome: "new" });
    }
    const resumeNotes = await opened.engine.markResumed(restored.info);
    return done(opened, { outcome: "resumed", resume: restored.info, resumeNotes });
  } catch (err) {
    if (opened) { try { await opened.log.close(); } catch { /* best effort */ } }
    lock.release();
    throw err;
  }
}
