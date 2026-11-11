import { randomBytes } from "node:crypto";
import { closeSync, constants as fc, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { isFileSafeId } from "@acr/events";
import { SessionLock, SessionLockError, assertInside } from "@acr/runtime/files";
import type { SetTimer } from "../supervisor.js";
import type { AuditLog } from "./audit-log.js";

/**
 * US-0073 (A2a Task 9a, spec section 6): the audio retention sweep. It DELETES recorded speech, so every step is conservative:
 *
 * - Candidates are only `readdir(audioDir)` entries named exactly 32 lower-case hex that `lstat` shows to be real directories of this user.
 *   `<id>.deleting-<rand>` real directories are deletions a previous run began (renamed and audited) and are finished silently. Anything
 *   else (files, links, other names, other users' folders, the `.store.lock` and `.audio-audit.*` files) is never touched or followed.
 * - The store lock is the only proof of a live worker (the sweep never reads `VOICE_ENABLED`): taken without waiting; refused -> skipped.
 * - Clock: `ended.json`'s `endedAtMs`; else the largest index segment `endMs` + 24 h; else the newest file time. Later than now counts as
 *   now. Expired when the age is at least `retentionDays` days.
 * - Expired: count the WAVs, rename to `<id>.deleting-<rand>`, THEN audit once, then remove without following links, then `release()` the
 *   lock (which unlinks the lock file only while it is still ours; the sweep never unlinks a lock path itself).
 * - Kept (not expired) but locked by us (no worker is live): a WAV with no `kind:"segment"` index line in ITS OWN role folder is an orphan
 *   (a crash between the WAV and its index line) and is removed under the lock; a failed removal logs a fixed sentence, the next run retries.
 * - The audio directory must be a real directory of this user with no group or other write bit (judged through an O_NOFOLLOW descriptor),
 *   or nothing is swept; every directory is listed only after its identity is verified through a descriptor (`listVerifiedDir`).
 * - Logs fixed sentences only: never a path, an identity or any content.
 */
export const SWEEP_REMOVE_FAILED = "audio sweep could not remove a folder";
export const SWEEP_RENAME_FAILED = "audio sweep could not move a folder aside";
export const SWEEP_FOLDER_FAILED = "audio sweep could not check a folder";
export const SWEEP_DIR_UNSAFE = "audio sweep skipped: the audio directory is not a private directory of this user";
export const SWEEP_BAD_SETTINGS = "audio sweep skipped: invalid retention or clock";
export const SWEEP_LOCK_FAILED = "audio sweep could not take a store lock";

const DAY_MS = 86_400_000;
/** With no ended marker, expiry starts this long after the last recorded segment (spec section 6). */
export const NO_MARKER_GRACE_MS = DAY_MS;
const LIVE_NAME = /^[0-9a-f]{32}$/;
const LEFTOVER_NAME = /^[0-9a-f]{32}\.deleting-[a-z0-9]+$/;
/** A segment WAV name: `<file-safe id>.wav` (the id rule lives in `@acr/events`). Returns the id, or null. */
export function segmentIdOf(name: string): string | null {
  if (!name.endsWith(".wav")) return null;
  const id = name.slice(0, -4);
  return isFileSafeId(id) ? id : null;
}
const MAX_MARKER_BYTES = 4_096;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
/** The layout is two levels deep; a deeper tree is still removed, but the walk stops descending somewhere sane. */
const MAX_DEPTH = 32;

export type StoreLockAcquirer = (dir: string, id: string) => { release(): void } | null;

export type SweepOptions = {
  audioDir: string;
  retentionDays: number;
  now: () => number;
  audit: Pick<AuditLog, "append">;
  acquireLock: StoreLockAcquirer;
  log: (m: string) => void;
};

/** The production store-lock acquirer: `SessionLock.acquire(dir, id, { suffix: "store" })`, never waiting; null when refused or on error. */
export function makeAcquireLock(log?: (m: string) => void): StoreLockAcquirer {
  return (dir, id) => {
    try { return SessionLock.acquire(dir, id, { suffix: "store" }); } catch (err) {
      if (!(err instanceof SessionLockError && err.code === "locked")) { try { log?.(SWEEP_LOCK_FAILED); } catch { /* reporting only */ } }
      return null;
    }
  };
}

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);
const isOwnRealDir = (st: Stats): boolean => {
  const uid = ownUid();
  return !st.isSymbolicLink() && st.isDirectory() && (uid === null || st.uid === uid);
};
const lstatOrNull = (p: string): Stats | null => { try { return lstatSync(p); } catch { return null; } };
const sameIdent = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;
/** `p` is still the real directory of this user that `expected` described (same device and inode). */
const stillDir = (p: string, expected: Stats): boolean => { const st = lstatOrNull(p); return st !== null && isOwnRealDir(st) && sameIdent(st, expected); };

/** Test seams (final review I1): run just before a directory is opened for listing, and between that open and the listing. */
export const sweepTestHooks: { beforeOpenDir?: (p: string) => void; afterOpenDir?: (p: string) => void } = {};

class DirChangedError extends Error {
  constructor() { super("a directory changed while it was being listed"); this.name = "DirChangedError"; }
}

/**
 * Lists a directory only while it is provably the one `expected` describes: opened O_DIRECTORY|O_NOFOLLOW (a link in its place fails),
 * its fstat identity compared with `expected`, the descriptor kept open across the listing (the inode cannot be reused meanwhile), and
 * the path lstat'ed again afterwards (a swap during the listing is caught). Node has no fd-relative readdir, hence the double check.
 * Throws DirChangedError (or the open error) on any mismatch; the caller then touches nothing in it.
 */
function listVerifiedDir(p: string, expected: Stats): string[] {
  sweepTestHooks.beforeOpenDir?.(p);
  const fd = openSync(p, fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || !sameIdent(st, expected)) throw new DirChangedError();
    sweepTestHooks.afterOpenDir?.(p);
    const names = readdirSync(p);
    if (!stillDir(p, expected)) throw new DirChangedError();
    return names;
  } finally { closeSync(fd); }
}

/**
 * The audio directory may be swept only when it is a real directory of this user that nobody else can write to (no group or other write
 * bit), judged through a descriptor opened without following a link. Otherwise another user could rename an entry and plant a link under
 * its name between our checks (final review I1). The worker and the audit log refuse or repair such a directory; the sweep only refuses.
 */
function rootIsPrivate(audioDir: string, st: Stats): boolean {
  if (!isOwnRealDir(st)) return false;
  let fd: number;
  try { fd = openSync(audioDir, fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW); } catch { return false; }
  try {
    const open = fstatSync(fd);
    const uid = ownUid();
    return open.isDirectory() && sameIdent(open, st) && (uid === null || open.uid === uid) && (open.mode & 0o022) === 0;
  } catch { return false; } finally { closeSync(fd); }
}

/** Reads a small regular file without following a link; null when missing, not a regular file, too large or unreadable. */
function readRegular(file: string, maxBytes: number): string | null {
  let fd: number;
  try { fd = openSync(file, fc.O_RDONLY | fc.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}

const validMs = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function markerTime(dir: string): number | null {
  const text = readRegular(path.join(dir, "ended.json"), MAX_MARKER_BYTES);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && (v as { v?: unknown }).v === 1 && validMs((v as { endedAtMs?: unknown }).endedAtMs)) return (v as { endedAtMs: number }).endedAtMs;
  } catch { /* torn or foreign: the next clock source decides */ }
  return null;
}

/** The real role directories directly inside a session folder, each with the identity it was found with. */
function roleDirs(dir: string): Array<{ p: string; st: Stats }> {
  const own = lstatOrNull(dir);
  if (own === null || !isOwnRealDir(own)) return [];
  let names: string[];
  try { names = listVerifiedDir(dir, own); } catch { return []; }
  const out: Array<{ p: string; st: Stats }> = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const st = lstatOrNull(p);
    if (st !== null && isOwnRealDir(st)) out.push({ p, st });
  }
  return out;
}

function lastSegmentEnd(dir: string): number | null {
  let best: number | null = null;
  for (const { p: role } of roleDirs(dir)) {
    const text = readRegular(path.join(role, "index.jsonl"), MAX_INDEX_BYTES);
    if (text === null) continue;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; } // a torn last line
      if (!v || typeof v !== "object" || (v as { kind?: unknown }).kind !== "segment") continue;
      const end = (v as { endMs?: unknown }).endMs;
      if (validMs(end) && (best === null || end > best)) best = end;
    }
  }
  return best;
}

/** Walks the tree without following links (lstat only), calling `visit` for every non-directory entry. */
function walkFiles(dir: string, visit: (p: string, st: Stats) => void, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    const st = lstatOrNull(p);
    if (st === null) continue;
    if (st.isDirectory() && !st.isSymbolicLink()) walkFiles(p, visit, depth + 1);
    else visit(p, st);
  }
}

function newestFileTime(dir: string, own: Stats): number {
  let best: number | null = null;
  walkFiles(dir, (_p, st) => { if (best === null || st.mtimeMs > best) best = st.mtimeMs; });
  return best ?? own.mtimeMs; // an empty folder: its own time
}

/** The time expiry counts from (spec section 6), never later than now. */
function expiryClock(dir: string, own: Stats, now: number): number {
  const marker = markerTime(dir);
  let clock: number;
  if (marker !== null) clock = marker;
  else {
    const last = lastSegmentEnd(dir);
    clock = last !== null ? last + NO_MARKER_GRACE_MS : newestFileTime(dir, own);
  }
  return Math.min(clock, now);
}

function countSegments(dir: string): number {
  let n = 0;
  walkFiles(dir, (p, st) => { if (st.isFile() && p.endsWith(".wav")) n++; });
  return n;
}

/**
 * Removes a tree WITHOUT following links: every entry is `lstat`ed; a link (to anything) is unlinked as a link, a directory is listed only
 * through `listVerifiedDir`, checked again (same device and inode, still a real directory of this user) before each child is touched and
 * before it is rmdir'ed. Every path is asserted inside `audioDir`. Throws on the first failure or mismatch (a later run retries).
 */
function removeTree(audioDir: string, p: string, depth = 0): void {
  assertInside(audioDir, p);
  const st = lstatSync(p);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    if (!isOwnRealDir(st)) throw new DirChangedError(); // another user's folder is never emptied
    if (depth > MAX_DEPTH) throw new Error("tree too deep");
    for (const n of listVerifiedDir(p, st)) {
      if (!stillDir(p, st)) throw new DirChangedError();
      removeTree(audioDir, path.join(p, n), depth + 1);
    }
    if (!stillDir(p, st)) throw new DirChangedError();
    rmdirSync(p);
  } else {
    unlinkSync(p);
  }
}

/** The segment ids a role's index names (`kind:"segment"` lines; torn or foreign lines ignored); null when the index cannot be trusted. */
function indexedSegments(role: string): Set<string> | null {
  const file = path.join(role, "index.jsonl");
  const ids = new Set<string>();
  try { lstatSync(file); } catch (e) {
    // Only ENOENT means "no index at all" (every WAV in the folder is an orphan); EIO, EACCES, ENOMEM and the rest mean "cannot tell".
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? ids : null;
  }
  const text = readRegular(file, MAX_INDEX_BYTES);
  if (text === null) return null; // present but unreadable, a link or oversized: remove nothing on a guess
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && (v as { kind?: unknown }).kind === "segment" && typeof (v as { segment?: unknown }).segment === "string") ids.add((v as { segment: string }).segment);
    } catch { /* a torn line */ }
  }
  return ids;
}

/** Removes the orphan WAVs of a kept session folder (the store lock is held by the caller). Returns how many were removed. */
function removeOrphans(o: SweepOptions, dir: string): number {
  let removed = 0;
  for (const { p: role, st: roleSt } of roleDirs(dir)) {
    const indexed = indexedSegments(role);
    if (indexed === null) continue;
    let names: string[];
    try { names = listVerifiedDir(role, roleSt); } catch { safeLog(o, SWEEP_FOLDER_FAILED); continue; }
    for (const n of names) {
      const segId = segmentIdOf(n);
      if (segId === null || indexed.has(segId)) continue;
      const p = path.join(role, n);
      try {
        assertInside(o.audioDir, p);
        if (!stillDir(role, roleSt)) { safeLog(o, SWEEP_FOLDER_FAILED); break; } // the role folder was swapped: touch nothing in it
        const st = lstatSync(p);
        if (!st.isFile()) continue; // a link or folder named like a WAV is never followed or removed
        unlinkSync(p);
        removed++;
      } catch { safeLog(o, SWEEP_REMOVE_FAILED); }
    }
  }
  return removed;
}

/** Finishes a deletion: removes the renamed folder, logging the fixed sentence on failure. True when it is gone. */
function finishRemoval(o: SweepOptions, aside: string): boolean {
  try { removeTree(o.audioDir, aside); return true; } catch {
    safeLog(o, SWEEP_REMOVE_FAILED);
    return false;
  }
}

function safeLog(o: SweepOptions, m: string): void { try { o.log(m); } catch { /* logging never breaks the sweep */ } }

/** `<id>.deleting-<16 hex>` next to the folder, one that does not exist yet. */
function asideName(audioDir: string, id: string): string {
  for (let i = 0; i < 8; i++) {
    const p = path.join(audioDir, `${id}.deleting-${randomBytes(8).toString("hex")}`);
    if (lstatOrNull(p) === null) return p;
  }
  throw new Error("no free aside name");
}

async function sweepOne(o: SweepOptions, id: string, now: number, maxAgeMs: number): Promise<{ r: "kept" | "deleted" | "skipped"; orphans: number }> {
  const dir = path.join(o.audioDir, id);
  assertInside(o.audioDir, dir);
  const lock = o.acquireLock(o.audioDir, id);
  if (lock === null) return { r: "skipped", orphans: 0 };
  try {
    // Judged again under the lock: the folder must still be the real directory of this user that readdir listed.
    const own = lstatOrNull(dir);
    if (own === null || !isOwnRealDir(own)) return { r: "skipped", orphans: 0 };
    const clock = expiryClock(dir, own, now);
    if (now - clock < maxAgeMs) return { r: "kept", orphans: removeOrphans(o, dir) };
    const segments = countSegments(dir);
    const aside = asideName(o.audioDir, id);
    assertInside(o.audioDir, aside);
    try { renameSync(dir, aside); } catch { safeLog(o, SWEEP_RENAME_FAILED); return { r: "skipped", orphans: 0 }; }
    const moved = lstatOrNull(aside);
    if (moved === null || !isOwnRealDir(moved) || moved.ino !== own.ino || moved.dev !== own.dev) {
      // Something else was swapped in between the check and the rename: put it back untouched and audit nothing.
      try { renameSync(aside, dir); } catch { /* leave it: a link or foreign entry under a .deleting- name is never followed or removed */ }
      safeLog(o, SWEEP_FOLDER_FAILED);
      return { r: "skipped", orphans: 0 };
    }
    // The audit line comes after the rename and exactly once: a crash from here on leaves a .deleting-* folder, finished silently later.
    await o.audit.append(id, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments });
    finishRemoval(o, aside);
    return { r: "deleted", orphans: 0 };
  } finally {
    try { lock.release(); } catch { /* release never throws; a leftover lock of ours goes stale */ }
  }
}

/**
 * One retention pass over `audioDir`. Never rejects; resolves with how many sessions were deleted (renamed and audited in this run) and
 * how many orphan WAVs were removed from kept folders and how many sessions were skipped (lock refused, folder unsafe or a step failed). Finished leftovers from an earlier run count as neither.
 */
export async function sweepAudio(o: SweepOptions): Promise<{ deleted: number; skipped: number; orphans: number }> {
  const result = { deleted: 0, skipped: 0, orphans: 0 };
  try {
    const now = o.now();
    if (!validMs(now) || typeof o.retentionDays !== "number" || !Number.isFinite(o.retentionDays) || o.retentionDays < 1) {
      safeLog(o, SWEEP_BAD_SETTINGS);
      return result;
    }
    const maxAgeMs = o.retentionDays * DAY_MS;
    const rootSt = lstatOrNull(o.audioDir);
    if (rootSt === null) return result; // nothing recorded yet
    if (!rootIsPrivate(o.audioDir, rootSt)) { safeLog(o, SWEEP_DIR_UNSAFE); return result; }
    let names: string[];
    try { names = listVerifiedDir(o.audioDir, rootSt); } catch { safeLog(o, SWEEP_DIR_UNSAFE); return result; }
    for (const name of names.sort()) {
      const live = LIVE_NAME.test(name);
      if (!live && !LEFTOVER_NAME.test(name)) continue;
      const p = path.join(o.audioDir, name);
      try {
        assertInside(o.audioDir, p);
        const st = lstatOrNull(p);
        if (st === null || !isOwnRealDir(st)) continue; // files, links and other users' entries are left strictly alone
        if (!live) { finishRemoval(o, p); continue; }
        const r = await sweepOne(o, name, now, maxAgeMs);
        result.orphans += r.orphans;
        if (r.r === "deleted") result.deleted++;
        else if (r.r === "skipped") result.skipped++;
      } catch {
        safeLog(o, SWEEP_FOLDER_FAILED);
        if (live) result.skipped++;
      }
    }
  } catch {
    safeLog(o, SWEEP_FOLDER_FAILED);
  }
  return result;
}

export const SWEEP_INTERVAL_MS = 3_600_000;

/**
 * Runs `run` once now (not awaited), then `intervalMs` after each run COMPLETES. Single-flight: runs never overlap, and a rejection is
 * swallowed (the sweep logs its own fixed sentences). `stop()` cancels the pending timer at once, is idempotent, schedules nothing more,
 * and returns a promise that resolves when no run is in flight (so a shutdown can let a deletion finish its audit line).
 */
export function startSweepSchedule(o: { run: () => Promise<unknown>; setTimer: SetTimer; intervalMs?: number }): { stop(): Promise<void> } {
  const intervalMs = o.intervalMs ?? SWEEP_INTERVAL_MS;
  let stopped = false;
  let inflight: Promise<void> | null = null;
  let cancel: (() => void) | null = null;
  const tick = (): void => {
    cancel = null;
    if (stopped || inflight) return;
    let p: Promise<unknown>;
    try { p = Promise.resolve(o.run()); } catch { p = Promise.resolve(); }
    const me: Promise<void> = p.catch(() => {}).then(() => {
      inflight = null;
      if (!stopped) { try { cancel = o.setTimer(tick, intervalMs); } catch { /* no timer: no further runs */ } }
    });
    inflight = me;
  };
  tick();
  return {
    stop(): Promise<void> {
      stopped = true;
      const c = cancel; cancel = null;
      try { c?.(); } catch { /* cancelling never throws out */ }
      return inflight ?? Promise.resolve();
    },
  };
}

export const SWEEP_STOP_WAIT_MS = 5_000;

/** `stop()` then wait for the in-flight run, but never longer than `waitMs` (a hung run must not hold the shutdown). Never rejects. */
export function stopWithin(sched: { stop(): Promise<void> }, setTimer: SetTimer, waitMs = SWEEP_STOP_WAIT_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let cancel: (() => void) | null = null;
    const done = (): void => { try { cancel?.(); } catch { /* ignore */ } resolve(); };
    try { cancel = setTimer(done, waitMs); } catch { /* no bound available: rely on the run */ }
    sched.stop().then(done, done);
  });
}

/** The control service's sweep: independent of VOICE_ENABLED and of voice hosting. `deps.audit` is the audit log the sweep appends to. */
export function startAudioSweep(
  config: { audioDir: string; audioMaxRetentionDays: number },
  deps: { audit: Pick<AuditLog, "append">; setTimer: SetTimer; log: (m: string) => void; now?: () => number; acquireLock?: StoreLockAcquirer; intervalMs?: number },
): { stop(): Promise<void> } {
  return startSweepSchedule({
    setTimer: deps.setTimer,
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    run: () => sweepAudio({
      audioDir: config.audioDir, retentionDays: config.audioMaxRetentionDays, now: deps.now ?? Date.now, audit: deps.audit,
      acquireLock: deps.acquireLock ?? makeAcquireLock(deps.log), log: deps.log,
    }),
  });
}
