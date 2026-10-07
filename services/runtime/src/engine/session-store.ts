import path from "node:path";
import type { Scenario } from "@acr/script";
import type { Clock } from "./clock.js";
import { JsonlEventLog, LogCorruptError } from "./event-log.js";
import { DEFAULT_LOCK_STALE_MS, MAX_LOCK_STALE_MS, MIN_LOCK_STALE_MS, SessionLock, SessionLockError, ensurePrivateDir, finishInterruptedRotation, rotateStaleLog, type LockOptions } from "./log-files.js";
import { RestoreError, SessionEngine, type ResumeInfo, type ResumeNotes } from "./session-engine.js";
import { JoinCodeRecordError, JoinCodes } from "./join-codes.js";
import { codesFileName, readJoinCodesFile, removeJoinCodesFile, sweepJoinCodesTemps, writeJoinCodesFile } from "./join-code-file.js";
import { scenarioHash } from "./scenario-hash.js";

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
  /**
   * US-0033 (with `joinCodes: true`): the verifier for the player roles' join codes, and `issued`, the plain codes when they were
   * issued by THIS start (show them to the operator once, then drop them), or null when the codes handed out earlier still apply.
   */
  joinCodes?: { codes: JoinCodes; issued: Record<string, string> | null };
  /**
   * US-0033 (review I-1): withdraws codes that THIS start issued and nobody has seen yet (call it when the start fails before they were
   * shown, then close). Removes the codes file only while this process holds the lock; codes kept from an earlier start are never
   * removed. Never throws; false when the file could not be removed (the next start must then be told).
   */
  discardIssuedCodes(): boolean;
  /** Closes the log handle and releases the lock. Never throws. */
  close(): Promise<void>;
};

export class SessionStoreError extends Error {
  constructor(readonly code: "lock" | "resume_refused" | "io" | "join_codes", message: string) { super(message); this.name = "SessionStoreError"; }
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
 * 4. With `joinCodes` (US-0033): only a RESUMED session keeps the codes in `<id>.codes.json` (when they were issued for this session,
 *    scenario and set of player roles; new ones otherwise). Every other start (fresh, after an ended session, and on a missing or empty
 *    log, where nothing has happened yet) issues and shows new codes, so codes nobody saw can never be kept silently. Only hashes are written, under the lock, before any client can
 *    connect. A codes file that cannot be read is refused like a corrupt log: nothing is changed and the start fails.
 */
export async function openSession(o: {
  scenario: Scenario; sessionId: string; dataDir: string; clock: Clock; mode: StartMode; now?: () => Date; lock?: LockOptions; maxLogBytes?: number;
  /** US-0033: manage the player roles' join codes (the server and the demo's resume room). Off by default. */
  joinCodes?: boolean;
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
  // US-0033 (review M-5): a crash while writing the codes file leaves `<id>.codes.json.<hex>.tmp`; this process holds the lock, so remove them.
  if (o.joinCodes) {
    try { sweepJoinCodesTemps(o.dataDir, o.sessionId); }
    catch (err) { lock.release(); throw new SessionStoreError("io", `cannot remove a stale join codes temp file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`); }
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
  const playerRoles = Object.values(o.scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
  const bind = { sessionId: o.sessionId, scenarioSha256: scenarioHash(o.scenario), roleIds: playerRoles };
  /** Decides the session's join codes: keep the ones on disk (`keep`) when they fit this session, or issue and persist new ones. */
  const settleCodes = (keep: boolean, warnIfNew: boolean): OpenedSession["joinCodes"] => {
    if (!o.joinCodes) return undefined;
    if (keep) {
      let existing: JoinCodes | null;
      try { existing = readJoinCodesFile(o.dataDir, o.sessionId); }
      catch (err) {
        if (err instanceof JoinCodeRecordError) throw new SessionStoreError("join_codes", `cannot use the join codes file: ${err.message}. Nothing was changed; to issue new codes (the old ones stop working), move ${codesFileName(o.sessionId)} aside and start again`);
        throw new SessionStoreError("io", `cannot read the join codes file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
      }
      if (existing && existing.matches(bind)) return { codes: existing, issued: null };
      if (warnIfNew) notes.push(existing
        ? "warning: the join codes on file were issued for other scenario files or roles: new join codes were issued, and the old ones no longer work"
        : "warning: no join codes from before the restart were found: new join codes were issued, and any old ones no longer work; hand out the new codes");
    }
    if (playerRoles.length === 0) return undefined; // nothing to protect
    const { codes, plain } = JoinCodes.issue(playerRoles, bind);
    try { writeJoinCodesFile(o.dataDir, o.sessionId, codes, () => lock.assertHeld()); }
    catch (err) { throw new SessionStoreError("io", `cannot write the join codes file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
    return { codes, issued: plain };
  };
  const rotate = (because: "fresh" | "ended") => {
    // The old codes go first: a crash between the two steps must never let the old session's codes open the new one.
    if (o.joinCodes) {
      try { removeJoinCodesFile(o.dataDir, o.sessionId); }
      catch (err) { throw new SessionStoreError("io", `cannot remove the previous join codes file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
    }
    try { return rotateStaleLog(o.dataDir, o.sessionId, now()); }
    catch (err) { throw new SessionStoreError("io", `cannot rotate the previous session log in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}${because === "ended" ? " (it holds a session that had ended)" : ""}`); }
  };
  let opened: { log: JsonlEventLog; engine: SessionEngine } | null = null;
  try {
    const done = (x: { log: JsonlEventLog; engine: SessionEngine }, rest: Pick<OpenedSession, "outcome" | "rotatedTo" | "rotatedBecause" | "resume" | "resumeNotes" | "joinCodes">): OpenedSession => ({
      ...x, lock, notes, ...rest,
      discardIssuedCodes: () => {
        if (!rest.joinCodes?.issued) return true;
        try { lock.assertHeld(); removeJoinCodesFile(o.dataDir, o.sessionId); return true; } catch { return false; }
      },
      close: async () => { try { await x.log.close(); } catch { /* best effort */ } lock.release(); },
    });
    if (o.mode === "fresh") {
      const rotatedTo = rotate("fresh");
      opened = make();
      const joinCodes = settleCodes(false, false);
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "fresh", joinCodes } : { outcome: "new", joinCodes });
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
    // Nothing has happened in this session yet (review I-1, M-1): codes from an earlier start, possibly never shown, are not kept.
    if (restored.kind === "empty") return done(opened, { outcome: "new", joinCodes: settleCodes(false, false) });
    if (restored.kind === "ended") {
      await opened.log.close();
      const rotatedTo = rotate("ended");
      opened = make();
      const joinCodes = settleCodes(false, false);
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "ended", joinCodes } : { outcome: "new", joinCodes });
    }
    const joinCodes = settleCodes(true, true); // before anything is appended: a refused codes file leaves the log untouched
    const resumeNotes = await opened.engine.markResumed(restored.info);
    return done(opened, { outcome: "resumed", resume: restored.info, resumeNotes, joinCodes });
  } catch (err) {
    if (opened) { try { await opened.log.close(); } catch { /* best effort */ } }
    lock.release();
    throw err;
  }
}
