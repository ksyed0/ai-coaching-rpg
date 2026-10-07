import { randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, copyFileSync, fstatSync, fsyncSync, futimesSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** Both paths must stay inside `dir`: defense in depth on top of the session id check. */
export function assertInside(dir: string, file: string): void {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to touch a path outside the data dir`);
}

/**
 * Creates the data directory owner-only (0700) and removes group and other permissions from an existing one (it holds session
 * logs). Never adds a permission, so a read-only directory stays read-only. Returns a warning when the bits could not be removed.
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
    catch (err) { return `the data directory is readable by other users and its permissions could not be tightened (${(err as NodeJS.ErrnoException).code ?? "error"})`; }
  } finally { closeSync(fd); }
}

/** linkSync errors that mean "this filesystem has no hard links": fall back to a copy. */
const NO_HARDLINK_CODES = new Set(["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"]);

/**
 * Moves a non-empty regular `<id>.jsonl` aside (never deleted) to `<id>.<UTC timestamp>.jsonl`, with a numeric suffix on collision.
 * Used for SESSION_START=fresh and for the log of a session that had already ended. The move is link + unlink (or, where hard links
 * are unsupported, an exclusive copy + unlink), never a bare rename, so an existing target can never be overwritten (EEXIST -> next
 * suffix). Missing or empty files are left alone; a directory or symlink in that place is an error and is not touched.
 */
export function rotateStaleLog(dir: string, sessionId: string, now: Date): string | null {
  const file = path.join(dir, `${sessionId}.jsonl`);
  assertInside(dir, file);
  let st;
  try { st = lstatSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
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
      // This filesystem cannot hard-link (some bind mounts, NFS/SMB): copy instead, still never overwriting.
      try { copyFileSync(file, target, fsConstants.COPYFILE_EXCL); }
      catch (cerr) { if ((cerr as NodeJS.ErrnoException).code === "EEXIST") continue; throw cerr; }
      copied = true;
    }
    try { unlinkSync(file); }
    catch (uerr) {
      // The source is only ever removed after the target exists; if that last step fails, say so, so nobody retries blindly.
      throw new Error(`${copied ? "a copy of" : "a second hard link to"} the old log was made at ${path.basename(target)} but ${path.basename(file)} could not be removed (${(uerr as NodeJS.ErrnoException).code ?? "error"}); remove or move ${path.basename(file)} by hand and start again`);
    }
    return target;
  }
  throw new Error(`no free rotation name for ${file} after 1000 tries`);
}

// ---- the single-writer lock ---------------------------------------------------------------------------------------------------

export const DEFAULT_LOCK_STALE_MS = 30_000;
export const MIN_LOCK_STALE_MS = 3_000;
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
};

export type LockErrorCode = "locked" | "not_a_file" | "contention" | "lost";
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

  private constructor(file: string, fd: number, ident: Identity, now: () => number, heartbeatMs: number, onLost?: () => void) {
    this.file = file; this.fd = fd; this.ident = ident; this.now = now; this.onLost = onLost;
    HELD.add(file);
    this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
    this.timer.unref();
  }

  static acquire(dir: string, sessionId: string, opts: LockOptions = {}): SessionLock {
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
        if (!SessionLock.removeIfSame(file, verdict.ident)) throw new SessionLockError("contention", "another server process took the session lock at the same moment; nothing was changed");
        continue;
      }
      try {
        const info = Buffer.from(JSON.stringify({ pid, host, startedAt: new Date(now()).toISOString() }) + "\n");
        writeSync(fd, info, 0, info.length, 0);
        fsyncSync(fd);
        const st = fstatSync(fd);
        return new SessionLock(file, fd, { dev: st.dev, ino: st.ino }, now, heartbeatFor(staleMs), opts.onLost);
      } catch (err) {
        try { closeSync(fd); unlinkSync(file); } catch { /* best effort: the half-made lock is stale at once (our pid, not held) */ }
        throw err;
      }
    }
    throw new SessionLockError("contention", "the session lock kept changing while it was being taken; try again");
  }

  /** Reads an existing lock through one descriptor: "gone" when it vanished, else whether it is stale. */
  private static judge(file: string, o: { staleMs: number; now: () => number; host: string; pid: number; isAlive: (pid: number) => boolean }):
    "gone" | { stale: true; ident: Identity } | { stale: false; message: string } {
    let fd: number;
    try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return "gone";
      if (code === "ELOOP" || code === "EMLINK") throw new SessionLockError("not_a_file", "the session lock is a symbolic link; remove it by hand");
      throw err;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SessionLockError("not_a_file", "the session lock is not a regular file; remove it by hand");
      const buf = Buffer.alloc(MAX_LOCK_INFO_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      let info: { pid?: unknown; host?: unknown } = {};
      try { const v = JSON.parse(buf.toString("utf8", 0, n)) as unknown; if (v && typeof v === "object") info = v as typeof info; } catch { /* half-written or foreign: judged by age only */ }
      const ageMs = o.now() - st.mtimeMs;
      const sameHost = typeof info.host === "string" && info.host === o.host;
      const lockPid = typeof info.pid === "number" && Number.isSafeInteger(info.pid) && info.pid > 0 ? info.pid : null;
      const deadHere = sameHost && lockPid !== null && (lockPid === o.pid || !o.isAlive(lockPid));
      if (ageMs > o.staleMs || deadHere) return { stale: true, ident: { dev: st.dev, ino: st.ino } };
      const secs = Math.max(0, Math.round(ageMs / 1000));
      return { stale: false, message: `the session log is locked by another server process (last heartbeat ${secs} s ago); stop that process, or wait: its lock counts as stale after ${Math.round(o.staleMs / 1000)} s without a heartbeat` };
    } finally { closeSync(fd); }
  }

  /** Renames the lock aside and removes it only when it is still the file that was judged (dev + inode); otherwise restores it. */
  private static removeIfSame(file: string, ident: Identity): boolean {
    const aside = `${file}.stale-${randomBytes(6).toString("hex")}`;
    try { renameSync(file, aside); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return true; throw err; }
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

  /** Throws SessionLockError("lost") when the lock is no longer ours (checked before every log append). */
  assertHeld(): void {
    if (this.released) throw new SessionLockError("lost", "the session was closed; nothing more is written to its log");
    if (this.lostFlag || !this.verify()) {
      this.markLost();
      throw new SessionLockError("lost", "the session lock was removed or taken over by another process; this server stops writing the log");
    }
  }

  private markLost(): void {
    if (this.lostFlag) return;
    this.lostFlag = true;
    try { this.onLost?.(); } catch { /* reporting only */ }
  }

  /** Refreshes the mtime through the held descriptor, then checks the path still names our file. */
  heartbeat(): void {
    if (this.fd === null || this.lostFlag) return;
    try { const t = this.now() / 1000; futimesSync(this.fd, t, t); } catch { /* a failed touch is caught by verify below or by the next one */ }
    if (!this.verify()) this.markLost();
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
