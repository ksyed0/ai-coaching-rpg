import path from "node:path";
import { isValidSessionId } from "@acr/events";
import type { Scenario } from "@acr/script";
import type { Clock } from "./clock.js";
import { JsonlEventLog, LogCorruptError } from "./event-log.js";
import { DEFAULT_LOCK_STALE_MS, MAX_LOCK_STALE_MS, MIN_LOCK_STALE_MS, SessionLock, SessionLockError, ensurePrivateDir, finishInterruptedRotation, rotateStaleLog, type LockOptions } from "./log-files.js";
import { RestoreError, SessionEngine, type ResumeInfo, type ResumeNotes } from "./session-engine.js";
import { JoinCodeRecordError, JoinCodes } from "./join-codes.js";
import { codesFileName, readJoinCodesFile, removeJoinCodesFile, sweepJoinCodesTemps, writeJoinCodesFile } from "./join-code-file.js";
import { scenarioHash } from "./scenario-hash.js";
import { ConsentRecordError, ConsentStore, type ConsentNotice } from "./consent.js";
import { CredentialRecordError, PlayerCredentials } from "./credentials.js";
import { credentialsFileName, readCredentialsFile, removeCredentialsFile, sweepCredentialsTemps, writeCredentialsFile } from "./credentials-file.js";
import { consentFileName, readConsentFile, removeConsentFile, sweepConsentTemps, writeConsentFile } from "./consent-file.js";
import type { Seats } from "./seats.js";

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
   * US-0053 (with `consentNotice`): the seated players' credentials and their consent, kept from an earlier start only when the join
   * codes were kept too. `persist()` writes both files under the session lock and throws when the lock was lost.
   */
  seats?: Seats;
  /**
   * US-0033 (review I-1): withdraws codes that THIS start issued and nobody has seen yet (call it when the start fails before they were
   * shown, then close). Removes the codes file only while this process holds the lock; codes kept from an earlier start are never
   * removed. Never throws; false when the file could not be removed (the next start must then be told). Seat files this start created
   * are removed too (best effort: empty ones are harmless, the next start replaces them).
   */
  discardIssuedCodes(): boolean;
  /**
   * US-0058: replaces the codes file with `c` (hashes only) under the session lock. Throws SessionStoreError "lock" when the lock was
   * lost and "io" when the write failed, each with a fixed message (no path and no value from the file); the old file stays then.
   */
  writeJoinCodes(c: JoinCodes): void;
  /** Closes the log handle and releases the lock. Never throws. */
  close(): Promise<void>;
};

export class SessionStoreError extends Error {
  constructor(readonly code: "lock" | "resume_refused" | "io" | "join_codes" | "seats", message: string) { super(message); this.name = "SessionStoreError"; }
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
 * 5. With `managed` (US-0058, set by the control service): an empty log keeps matching codes and seats, and an ended log is refused, never rotated.
 */
export async function openSession(o: {
  scenario: Scenario; sessionId: string; dataDir: string; clock: Clock; mode: StartMode; now?: () => Date; lock?: LockOptions; maxLogBytes?: number;
  /** US-0033: manage the player roles' join codes (the server and the demo's resume room). Off by default. */
  joinCodes?: boolean;
  /** US-0053: the consent notice players agree to; with it, the session's credentials and consent files are managed. Off by default. */
  consentNotice?: ConsentNotice;
  /**
   * US-0058: a runtime forked by the control service (CONTROL_MANAGED=1). An EMPTY log keeps the codes, credentials and consent on
   * disk when they fit this session and scenario (a lobby survives a control-service restart), and an ENDED log is refused with
   * `resume_refused` and never moved aside (the review needs it). Off by default: the terminal start is unchanged.
   */
  managed?: boolean;
}): Promise<OpenedSession> {
  // US-0020: the id becomes file names, so it is refused before ANY file system action (not after the directory and the lock exist).
  if (!isValidSessionId(o.sessionId)) throw new Error(`invalid session id: ${JSON.stringify(String(o.sessionId).slice(0, 40))}`);
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
  // US-0053: the same for the credentials and consent files.
  if (o.consentNotice) {
    try { sweepCredentialsTemps(o.dataDir, o.sessionId); sweepConsentTemps(o.dataDir, o.sessionId); }
    catch (err) { lock.release(); throw new SessionStoreError("io", `cannot remove a stale seat temp file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`); }
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
  /**
   * The SYNCHRONOUS lock check for the codes file (review I-A): `lock.assertHeld()` is async and must never be used in a void callback,
   * where its rejection would be ignored (and left unhandled). Throws when the lock was lost, removed or replaced.
   */
  const holdLockNow = (): undefined => {
    if (lock.lost || !lock.verify()) throw new SessionLockError("lost", "the session lock was removed or taken over by another process");
    return undefined;
  };
  const playerRoles = Object.values(o.scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
  const bind = { sessionId: o.sessionId, scenarioSha256: scenarioHash(o.scenario), roleIds: playerRoles };
  /** The lock check before deleting a seat file: once the lock was lost, the files may be the new holder's live ones. */
  const holdLockForRemoval = () => {
    try { holdLockNow(); }
    catch { throw new SessionStoreError("lock", "cannot open the session: the session lock was lost (removed or taken over by another process); nothing was removed"); }
  };
  /** US-0053: removes the credentials and consent files (a missing file is fine). */
  const removeSeats = () => {
    if (!o.consentNotice) return;
    holdLockForRemoval();
    try { removeCredentialsFile(o.dataDir, o.sessionId); removeConsentFile(o.dataDir, o.sessionId); }
    catch (err) { throw new SessionStoreError("io", `cannot remove the previous seat files in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
  };
  /**
   * US-0053: reads both seat files for a resume BEFORE anything is changed, so an unusable file refuses the start untouched. The
   * consent file is read only beside credentials bound to this session (otherwise both are replaced unread).
   */
  const readSeats = (): { credentials: PlayerCredentials | null; consent: ConsentStore | null } | undefined => {
    if (!o.consentNotice) return undefined;
    try {
      const credentials = readCredentialsFile(o.dataDir, o.sessionId);
      const consent = credentials?.matches(bind) ? readConsentFile(o.dataDir, bind, o.consentNotice) : null;
      return { credentials, consent };
    } catch (err) {
      if (err instanceof CredentialRecordError || err instanceof ConsentRecordError) throw new SessionStoreError("seats", `cannot use the seat files: ${err.message}. Nothing was changed; to seat everyone again by join code, move ${credentialsFileName(o.sessionId)} and ${consentFileName(o.sessionId)} aside and start again`);
      throw new SessionStoreError("io", `cannot read the seat files in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? "error"}`); // fixed text: never a message that could quote the file
    }
  };
  /** Set when this start wrote new seat files (discardIssuedCodes removes those, never kept ones). */
  let seatsCreated = false;
  /** Set once this start wrote new join codes: a later failure of the open withdraws them (nobody has seen them). */
  let codesIssued = false;
  /**
   * US-0053: keeps the seats read from disk when the codes were kept and the credentials fit this session, or writes new empty ones.
   * `logIdentity` (a resumed log's own) keeps the pseudonyms of a running session stable when its credentials file was lost.
   */
  const settleSeats = (codesKept: boolean, found: ReturnType<typeof readSeats>, logIdentity?: string): Seats | undefined => {
    const notice = o.consentNotice;
    if (!notice) return undefined;
    let credentials: PlayerCredentials; let consent: ConsentStore;
    // A log that records an identity the credentials do not carry belongs to other seats (a restored or swapped file): they are not used.
    const identityKept = !logIdentity || found?.credentials?.logIdentity === logIdentity;
    if (codesKept && found?.credentials?.matches(bind) && identityKept) {
      credentials = found.credentials;
      consent = found.consent ?? new ConsentStore(notice); // entries under another notice version were dropped on read
      if (!found.consent) {
        try { writeConsentFile(o.dataDir, bind, consent, holdLockNow); }
        catch (err) { throw new SessionStoreError("io", `cannot write the consent file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
      }
    } else {
      if (codesKept && found) notes.push(found.credentials
        ? found.credentials.matches(bind)
          ? "warning: the web seats were reset: the credentials on file belong to another copy of this session log, so players join again with their join code"
          : "warning: the credentials on file were issued for other scenario files: players join again with their join code"
        : "warning: no credentials file from before the restart was found: players join again with their join code");
      credentials = PlayerCredentials.create(bind, logIdentity);
      consent = new ConsentStore(notice);
      // The old consent goes first: a crash after the credentials write then leaves no consent file (replaced next start), never
      // stale consent (possibly bound elsewhere, which would refuse every later start) beside new credentials.
      holdLockForRemoval();
      try { removeConsentFile(o.dataDir, o.sessionId); }
      catch (err) { throw new SessionStoreError("io", `cannot remove the previous consent file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
      try { writeCredentialsFile(o.dataDir, o.sessionId, credentials, holdLockNow); writeConsentFile(o.dataDir, bind, consent, holdLockNow); }
      catch (err) { throw new SessionStoreError("io", `cannot write the seat files in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
      seatsCreated = true;
    }
    const seats: Seats = {
      credentials, consent,
      // Throws (SessionLockError) when the lock was lost: the files may be another server's now.
      persist: () => { writeCredentialsFile(o.dataDir, o.sessionId, seats.credentials, holdLockNow); writeConsentFile(o.dataDir, bind, seats.consent, holdLockNow); },
    };
    return seats;
  };
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
    // US-0053: seats held under the old codes go before the new codes are durable, so a crash in between can never keep them.
    removeSeats();
    const { codes, plain } = JoinCodes.issue(playerRoles, bind);
    try { writeJoinCodesFile(o.dataDir, o.sessionId, codes, holdLockNow); }
    catch (err) { throw new SessionStoreError("io", `cannot write the join codes file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
    codesIssued = true;
    return { codes, issued: plain };
  };
  const rotate = (because: "fresh" | "ended") => {
    // The old codes go first: a crash between the two steps must never let the old session's codes open the new one.
    if (o.joinCodes) {
      try { removeJoinCodesFile(o.dataDir, o.sessionId); }
      catch (err) { throw new SessionStoreError("io", `cannot remove the previous join codes file in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
    }
    removeSeats(); // US-0053: likewise the old seats
    try { return rotateStaleLog(o.dataDir, o.sessionId, now()); }
    catch (err) { throw new SessionStoreError("io", `cannot rotate the previous session log in ${o.dataDir}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}${because === "ended" ? " (it holds a session that had ended)" : ""}`); }
  };
  let opened: { log: JsonlEventLog; engine: SessionEngine } | null = null;
  try {
    const done = (x: { log: JsonlEventLog; engine: SessionEngine }, rest: Pick<OpenedSession, "outcome" | "rotatedTo" | "rotatedBecause" | "resume" | "resumeNotes" | "joinCodes" | "seats">): OpenedSession => ({
      ...x, lock, notes, ...rest,
      writeJoinCodes: (c) => {
        try { writeJoinCodesFile(o.dataDir, o.sessionId, c, holdLockNow); }
        catch (err) {
          if (err instanceof SessionLockError) throw new SessionStoreError("lock", "cannot write the join codes file: the session lock was lost");
          throw new SessionStoreError("io", "cannot write the join codes file");
        }
      },
      discardIssuedCodes: () => {
        if (!rest.joinCodes?.issued && !seatsCreated) return true;
        try { holdLockNow(); } catch { return false; } // lost: the files may be another server's now, never touch them
        if (seatsCreated) { try { removeCredentialsFile(o.dataDir, o.sessionId); removeConsentFile(o.dataDir, o.sessionId); } catch { /* best effort, see above */ } }
        if (!rest.joinCodes?.issued) return true;
        try { removeJoinCodesFile(o.dataDir, o.sessionId); return true; } catch { return false; }
      },
      close: async () => { try { await x.log.close(); } catch { /* best effort */ } lock.release(); },
    });
    if (o.mode === "fresh") {
      const rotatedTo = rotate("fresh");
      opened = make();
      const joinCodes = settleCodes(false, false);
      const seats = settleSeats(false, undefined);
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "fresh", joinCodes, seats } : { outcome: "new", joinCodes, seats });
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
    if (restored.kind === "empty" && o.managed) {
      // Order matters: seats are read BEFORE settleCodes, which removes them when the codes on file do not fit (and issues new
      // ones); `!issued` then drops `found` exactly in that case, so no credential outlives the codes it was issued under.
      const found = readSeats();
      const joinCodes = settleCodes(true, false);
      return done(opened, { outcome: "new", joinCodes, seats: settleSeats(!joinCodes?.issued, found) });
    }
    if (restored.kind === "empty") { const joinCodes = settleCodes(false, false); return done(opened, { outcome: "new", joinCodes, seats: settleSeats(false, undefined) }); }
    if (restored.kind === "ended" && o.managed) throw new SessionStoreError("resume_refused", "the session has ended");
    if (restored.kind === "ended") {
      await opened.log.close();
      const rotatedTo = rotate("ended");
      opened = make();
      const joinCodes = settleCodes(false, false);
      const seats = settleSeats(false, undefined);
      return done(opened, rotatedTo ? { outcome: "rotated", rotatedTo, rotatedBecause: "ended", joinCodes, seats } : { outcome: "new", joinCodes, seats });
    }
    // Both read before anything is written or appended: a refused codes or seat file leaves everything untouched.
    const found = readSeats();
    const joinCodes = settleCodes(true, true);
    // The log's own identity (logs written before US-0053 carry none: then a new one) survives a lost credentials file.
    const seats = settleSeats(!joinCodes?.issued, found, restored.info.logIdentity);
    const resumeNotes = await opened.engine.markResumed(restored.info);
    return done(opened, { outcome: "resumed", resume: restored.info, resumeNotes, joinCodes, seats });
  } catch (err) {
    if (opened) { try { await opened.log.close(); } catch { /* best effort */ } }
    // Codes written by this failed open were never shown: keep them and the next start would hold codes nobody has (the
    // discardIssuedCodes invariant). Only while the lock is held; a lost lock means the file may be another server's.
    if (codesIssued) { try { holdLockNow(); removeJoinCodesFile(o.dataDir, o.sessionId); } catch { /* lost or unremovable: nothing more to do */ } }
    lock.release();
    throw err;
  }
}
