import { randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, fstatSync, readdirSync, fsyncSync, futimesSync, fchmodSync, linkSync, mkdirSync, openSync, readSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isValidSessionId } from "@acr/events";

/**
 * A session id becomes file names (`<id>.jsonl`, `<id>.lock`, `<id>.codes.json`, rotated `<id>.<time>.jsonl`) and is placed in a regular
 * expression: every function here that takes one refuses an invalid id first (US-0020), whoever the caller is.
 */
export function assertSessionId(sessionId: string): void {
  if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(String(sessionId).slice(0, 40))}`);
}

/** Both paths must stay inside `dir`: defense in depth on top of the session id check. */
export function assertInside(dir: string, file: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to touch a path outside the data dir`);
}

/**
 * Creates the data directory owner-only (0700) and removes group and other permissions from an existing one (it holds session
 * logs). Never adds a permission, so a read-only directory stays read-only. Returns a warning when read bits could not be removed;
 * THROWS (code EUNSAFE) when the directory stays writable by group or others.
 */
export function ensurePrivateDir(dir: string): string | null {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(dir, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)); }
  catch (err) { return `could not check the data directory's permissions (${(err as NodeJS.ErrnoException).code ?? "error"})`; }
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory()) throw Object.assign(new Error("the data directory is not a directory"), { code: "ENOTDIR" });
    if ((st.mode & 0o077) === 0) return null;
    try { fchmodSync(fd, st.mode & 0o700); return null; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      // Writable by others: anyone could forge what a resumed session contains, or swap the lock. Refuse rather than run on it.
      if ((st.mode & 0o022) !== 0) throw Object.assign(new Error(`the data directory (data/sessions; in Docker ./data/sessions on the host) is writable by other users and could not be made private (${code}): chown it to the server's user (or chmod 700 it as its owner)`), { code: "EUNSAFE" });
      return `the data directory is readable by other users and its permissions could not be tightened (${code})`;
    }
  } finally { closeSync(fd); }
}

/** fsyncs a directory (sync) so a created, linked or removed entry survives a power cut; tolerated where unsupported. */
export function fsyncDirSync(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, fsConstants.O_RDONLY); fsyncSync(fd); }
  catch (err) { if (!["EISDIR", "EINVAL", "EPERM", "EBADF", "ENOTSUP", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
  finally { if (fd !== null) closeSync(fd); }
}

/** linkSync errors that mean "this filesystem has no hard links": fall back to a copy. */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"]);

/** Copies the open source descriptor into a NEW file (O_EXCL: an existing target is never overwritten; EEXIST is thrown). */
function copyFromFd(src: number, target: string): void {
  const out = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    for (;;) {
      const n = readSync(src, buf, 0, buf.length, pos);
      if (n === 0) break;
      let off = 0;
      while (off < n) off += writeSync(out, buf, off, n - off);
      pos += n;
    }
    fsyncSync(out);
  } catch (err) {
    closeSync(out);
    try { unlinkSync(target); } catch { /* best effort: never leave a half copy */ }
    throw err;
  }
  closeSync(out);
}

/**
 * Moves a non-empty regular `<id>.jsonl` aside (never deleted) to `<id>.<UTC timestamp>.jsonl`, with a numeric suffix on collision.
 * Used for SESSION_START=fresh and for the log of a session that had already ended. The log is opened once (O_NOFOLLOW) and judged
 * through that descriptor; the move is link + unlink (or, where hard links are unsupported, an exclusive copy from the open
 * descriptor + unlink), never a bare rename, so an existing target can never be overwritten (EEXIST -> next suffix). Missing or empty
 * files are left alone; a directory or symlink in that place is an error and is not touched.
 */
export function rotateStaleLog(dir: string, sessionId: string, now: Date): string | null {
  assertSessionId(sessionId);
  const file = path.join(dir, `${sessionId}.jsonl`);
  assertInside(dir, file);
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`${file} is not a regular file; move it away and retry`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file; move it away and retry`);
    if (st.size === 0) return null;
    const stamp = now.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
    for (let n = 0; n < 1_000; n++) {
      const target = path.join(dir, `${sessionId}.${stamp}${n === 0 ? "" : `-${n}`}.jsonl`);
      assertInside(dir, target);
      let copied = false;
      try { linkSync(file, target); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") continue;
        if (!code || !NO_HARDLINK_CODES.has(code)) throw err;
        // This filesystem cannot hard-link (some bind mounts, NFS/SMB): copy what we opened instead, still never overwriting.
        try { copyFromFd(fd, target); }
        catch (cerr) { if ((cerr as NodeJS.ErrnoException).code === "EEXIST") continue; throw cerr; }
        copied = true;
      }
      try { unlinkSync(file); }
      catch (uerr) {
        // The source is only ever removed after the target exists; if that last step fails, say so, so nobody retries blindly.
        throw new Error(`${copied ? "a copy of" : "a second hard link to"} the old log was made at ${path.basename(target)} but ${path.basename(file)} could not be removed (${(uerr as NodeJS.ErrnoException).code ?? "error"}); remove or move ${path.basename(file)} by hand and start again`);
      }
      fsyncDirSync(dir); // the new name and the removed one are durable before a new log is created
      return target;
    }
    throw new Error(`no free rotation name for ${file} after 1000 tries`);
  } finally { closeSync(fd); }
}

/**
 * A crash between rotateStaleLog's link and its unlink leaves `<id>.jsonl` with a second name `<id>.<UTC time>[-n].jsonl` (same inode,
 * nlink 2). Finishes that rotation: removes `<id>.jsonl` when one of the rotated names is the same file, so the data stays under the
 * rotated name. Returns that name, or null when there is nothing to finish (the log is then left to the normal checks).
 */
export function finishInterruptedRotation(dir: string, sessionId: string): string | null {
  assertSessionId(sessionId);
  const file = path.join(dir, `${sessionId}.jsonl`);
  assertInside(dir, file);
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch { return null; }
  let ident: Identity;
  try { const st = fstatSync(fd); if (!st.isFile() || st.nlink < 2) return null; ident = { dev: st.dev, ino: st.ino }; }
  finally { closeSync(fd); }
  const rotated = new RegExp(`^${sessionId}\\.\\d{8}T\\d{6}Z(-\\d+)?\\.jsonl$`);
  for (const name of readdirSync(dir).filter((n) => rotated.test(n))) {
    const other = path.join(dir, name);
    assertInside(dir, other);
    let ofd: number;
    try { ofd = openSync(other, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); } catch { continue; }
    try { const st = fstatSync(ofd); if (!sameFile({ dev: st.dev, ino: st.ino }, ident)) continue; } finally { closeSync(ofd); }
    unlinkSync(file);
    fsyncDirSync(dir);
    return name;
  }
  return null;
}

// ---- the single-writer lock ---------------------------------------------------------------------------------------------------

export const DEFAULT_LOCK_STALE_MS = 30_000;
export const MIN_LOCK_STALE_MS = 10_000;
/** How long a holder waits before re-checking a lock that looked missing or replaced (a takeover race puts it back within microseconds). */
export const LOCK_RECHECK_MS = 50;
export const MAX_LOCK_STALE_MS = 600_000;
/** The heartbeat refreshes the lock's mtime this often: a sixth of the stale age, at least once a second (5 s by default). */
export const heartbeatFor = (staleMs: number): number => Math.max(1_000, Math.floor(staleMs / 6));
const MAX_LOCK_INFO_BYTES = 4_096;

export type LockOptions = {
  /** A lock whose heartbeat (mtime) is older than this is stale and may be taken over (default 30 s). */
  staleMs?: number;
  /** Wall clock in ms (tests). */
  now?: () => number;
  /** Who we are (tests): the host name and process id written into the lock. */
  hostname?: string; pid?: number;
  /** Whether a process id is running on this host (tests). */
  isAlive?: (pid: number) => boolean;
  /** Called once if the lock file is found replaced or removed while held (the log then refuses further appends). */
  onLost?: () => void;
  /** The wait before re-checking a lock that looked missing (default LOCK_RECHECK_MS); tests inject it to control the order of a race. */
  recheckDelay?: () => Promise<void>;
};

export type LockErrorCode = "locked" | "not_a_file" | "contention" | "lost" | "closed";
export class SessionLockError extends Error {
  constructor(readonly code: LockErrorCode, message: string) { super(message); this.name = "SessionLockError"; }
}

/** Lock paths this process holds: a second lock on the same session inside one process is refused like one from another process. */
const HELD = new Set<string>();

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; } // EPERM: it exists, it is just not ours
}

type Identity = { dev: number; ino: number };
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;

/**
 * `<id>.lock` beside the session log: one server process per session log (US-0018).
 *
 * - Created with O_CREAT | O_EXCL | O_NOFOLLOW, mode 0600, holding `{pid, host, startedAt}`; a symlink in its place is refused.
 * - Heartbeat: the holder refreshes the file's mtime through its open descriptor every `heartbeatFor(staleMs)` ms (timer unref'd)
 *   and checks that the path still names its own file; a replaced or removed lock is "lost" and the log stops appending.
 * - Stale-lock takeover: a lock is stale when its mtime is older than `staleMs`, or when it names THIS host and a process id
 *   that no longer runs, or this very process id while this process does not hold it (a restarted container reuses pids). A stale
 *   lock is renamed aside under a random name, proven (device and inode, read through descriptors) to be the file that was judged
 *   stale, removed, and the exclusive create is retried. If another process replaced it in between, its lock is put back and the
 *   start is refused. Every judgement reads one open descriptor (fstat), never a path checked and then opened.
 * - Two containers that share a data volume must have different host names (Docker's default), since process ids of another
 *   container cannot be checked.
 */
export class SessionLock {
  readonly file: string;
  private fd: number | null;
  private readonly ident: Identity;
  private timer: NodeJS.Timeout | null = null;
  private lostFlag = false;
  private released = false;
  private readonly now: () => number;
  private readonly onLost: (() => void) | undefined;
  private readonly recheckDelay: () => Promise<void>;

  /** Test seam: runs between the rename and the identity check of a takeover (to make a two-starter race deterministic). */
  static testHooks: { afterRename?: () => void } = {};

  private constructor(file: string, fd: number, ident: Identity, now: () => number, heartbeatMs: number, onLost?: () => void, recheckDelay?: () => Promise<void>) {
    this.file = file; this.fd = fd; this.ident = ident; this.now = now; this.onLost = onLost;
    this.recheckDelay = recheckDelay ?? (() => new Promise((r) => setTimeout(r, LOCK_RECHECK_MS)));
    HELD.add(file);
    this.timer = setInterval(() => { void this.heartbeat(); }, heartbeatMs);
    this.timer.unref();
  }

  static acquire(dir: string, sessionId: string, opts: LockOptions = {}): SessionLock {
    assertSessionId(sessionId);
    const file = path.resolve(dir, `${sessionId}.lock`);
    assertInside(dir, file);
    const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
    const now = opts.now ?? Date.now;
    const host = opts.hostname ?? os.hostname();
    const pid = opts.pid ?? process.pid;
    const isAlive = opts.isAlive ?? processAlive;
    const createFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
    for (let attempt = 0; attempt < 4; attempt++) {
      let fd: number;
      try { fd = openSync(file, createFlags, 0o600); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (HELD.has(file)) throw new SessionLockError("locked", "this session log is already open in this server process");
        const verdict = SessionLock.judge(file, { staleMs, now, host, pid, isAlive });
        if (verdict === "gone") continue;
        if (verdict.stale === false) throw new SessionLockError("locked", verdict.message);
        // The judged file stays OPEN until the takeover is over: its inode cannot be freed and reused by a new lock meanwhile,
        // so the identity check in removeIfSame can never mistake another server's fresh lock for the stale one.
        try { if (!SessionLock.removeIfSame(file, verdict.ident)) throw new SessionLockError("contention", "another server process took the session lock at the same moment; nothing was changed"); }
        finally { closeSync(verdict.fd); }
        continue;
      }
      try {
        const info = Buffer.from(JSON.stringify({ pid, host, startedAt: new Date(now()).toISOString() }) + "\n");
        writeSync(fd, info, 0, info.length, 0);
        fsyncSync(fd);
        const st = fstatSync(fd);
        fsyncDirSync(path.dirname(file));
        return new SessionLock(file, fd, { dev: st.dev, ino: st.ino }, now, heartbeatFor(staleMs), opts.onLost, opts.recheckDelay);
      } catch (err) {
        try { closeSync(fd); unlinkSync(file); } catch { /* best effort: the half-made lock is stale at once (our pid, not held) */ }
        throw err;
      }
    }
    throw new SessionLockError("contention", "the session lock kept changing while it was being taken; try again");
  }

  /** Reads an existing lock through one descriptor: "gone" when it vanished, else whether it is stale. */
  private static judge(file: string, o: { staleMs: number; now: () => number; host: string; pid: number; isAlive: (pid: number) => boolean }):
    "gone" | { stale: true; ident: Identity; fd: number } | { stale: false; message: string } {
    let fd: number;
    try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "gone";
      if (code === "ELOOP" || code === "EMLINK") throw new SessionLockError("not_a_file", "the session lock is a symbolic link; remove it by hand");
      throw err;
    }
    let keep = false; // a stale verdict hands the open descriptor to the caller (it pins the inode during the takeover)
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SessionLockError("not_a_file", "the session lock is not a regular file; remove it by hand");
      if (st.nlink > 1) throw new SessionLockError("not_a_file", "the session lock has other hard links; after confirming that no server runs on this session, remove the leftover lock and its extra links");
      if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SessionLockError("not_a_file", "the session lock belongs to another user; chown it to the server's user, or remove the leftover lock after confirming that no server runs on this session");
      const buf = Buffer.alloc(MAX_LOCK_INFO_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      let info: { pid?: unknown; host?: unknown } = {};
      try { const v = JSON.parse(buf.toString("utf8", 0, n)) as unknown; if (v && typeof v === "object") info = v as typeof info; } catch { /* half-written or foreign: judged by age only */ }
      const ageMs = o.now() - st.mtimeMs;
      const sameHost = typeof info.host === "string" && info.host === o.host;
      const lockPid = typeof info.pid === "number" && Number.isSafeInteger(info.pid) && info.pid > 0 ? info.pid : null;
      const deadHere = sameHost && lockPid !== null && (lockPid === o.pid || !o.isAlive(lockPid));
      if (ageMs > o.staleMs || deadHere) { keep = true; return { stale: true, ident: { dev: st.dev, ino: st.ino }, fd }; }
      const secs = Math.max(0, Math.round(ageMs / 1000));
      return { stale: false, message: `the session log is locked by another server process (last heartbeat ${secs} s ago); stop that process, or wait: its lock counts as stale after ${Math.round(o.staleMs / 1000)} s without a heartbeat` };
    } finally { if (!keep) closeSync(fd); }
  }

  /**
   * Renames the lock aside, then unlinks that aside copy only when it is the very file that was judged stale (dev + inode); otherwise
   * links it back under the lock name (never overwriting) and removes the aside name.
   */
  private static removeIfSame(file: string, ident: Identity): boolean {
    const aside = `${file}.stale-${randomBytes(6).toString("hex")}`;
    try { renameSync(file, aside); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return true; throw err; }
    SessionLock.testHooks.afterRename?.();
    let moved: Identity | null = null;
    try {
      const fd = openSync(aside, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { const st = fstatSync(fd); moved = { dev: st.dev, ino: st.ino }; } finally { closeSync(fd); }
    } catch { moved = null; }
    if (moved && sameFile(moved, ident)) { unlinkSync(aside); return true; }
    // Someone replaced the stale lock with a live one between our check and the rename: put it back, never overwriting.
    try { linkSync(aside, file); } catch { /* a third lock appeared: leave ours aside for the holder's heartbeat to notice */ }
    try { unlinkSync(aside); } catch { /* best effort */ }
    return false;
  }

  /** True while the lock path still names the file this process created. */
  verify(): boolean {
    if (this.fd === null) return false;
    try {
      const fd = openSync(this.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try { const st = fstatSync(fd); return sameFile({ dev: st.dev, ino: st.ino }, this.ident); } finally { closeSync(fd); }
    } catch { return false; }
  }

  get lost(): boolean { return this.lostFlag; }

  /**
   * Resolves while the lock is ours; rejects with SessionLockError "lost" (after one re-check LOCK_RECHECK_MS later, since a takeover
   * race may move a live lock aside for an instant and put it back) or "closed" after release(). Checked around every log append.
   */
  async assertHeld(): Promise<void> {
    if (this.released) throw new SessionLockError("closed", "the session was closed; nothing more is written to its log");
    if (!this.lostFlag && (this.verify() || await this.recheck())) return;
    this.markLost();
    throw new SessionLockError("lost", "the session lock was removed or taken over by another process; this server stops writing the log");
  }

  private async recheck(): Promise<boolean> {
    await this.recheckDelay();
    return !this.released && this.verify();
  }

  private markLost(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    try { this.onLost?.(); } catch { /* reporting only */ }
  }

  /** Refreshes the mtime through the held descriptor, then checks the path still names our file. */
  async heartbeat(): Promise<void> {
    if (this.fd === null || this.lostFlag) return;
    try { const t = this.now() / 1000; futimesSync(this.fd, t, t); } catch { /* a failed touch is caught by verify below or by the next one */ }
    if (!this.verify() && !(await this.recheck()) && !this.released) this.markLost();
  }

  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Stops the heartbeat and removes the lock file if it is still ours. Never throws. */
  release(): void {
    this.released = true;
    this.stopTimer();
    HELD.delete(this.file);
    if (this.fd === null) return;
    const ours = this.verify();
    try { closeSync(this.fd); } catch { /* already closed */ }
    this.fd = null;
    if (ours) { try { unlinkSync(this.file); } catch { /* best effort: a leftover lock of a dead process is stale */ } }
  }

  /** Simulates a crash (tests and the demo): stops the heartbeat and forgets the lock WITHOUT removing the file. */
  abandon(): void {
    this.released = true;
    this.stopTimer();
    HELD.delete(this.file);
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* already closed */ } }
    this.fd = null;
  }
}
