import { randomBytes } from "node:crypto";
import { closeSync, constants as fc, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
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
const WAV_NAME = /^[a-z0-9_-]{1,64}\.wav$/;
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

/** The real role directories directly inside a session folder. */
function roleDirs(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.map((n) => path.join(dir, n)).filter((p) => { const st = lstatOrNull(p); return st !== null && isOwnRealDir(st); });
}

function lastSegmentEnd(dir: string): number | null {
  let best: number | null = null;
  for (const role of roleDirs(dir)) {
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
 * Removes a tree WITHOUT following links: every entry is `lstat`ed; a link (to anything) is unlinked as a link, a directory is emptied
 * and rmdir'ed. Every path is asserted inside `audioDir`. Throws on the first failure (the caller retries in a later run).
 */
function removeTree(audioDir: string, p: string, depth = 0): void {
  assertInside(audioDir, p);
  const st = lstatSync(p);
  if (st.isDirectory() && !st.isSymbolicLink()) {
    if (depth > MAX_DEPTH) throw new Error("tree too deep");
    for (const n of readdirSync(p)) removeTree(audioDir, path.join(p, n), depth + 1);
    rmdirSync(p);
  } else {
    unlinkSync(p);
  }
}

/** The segment ids a role's index names (`kind:"segment"` lines; torn or foreign lines ignored); null when the index cannot be trusted. */
function indexedSegments(role: string): Set<string> | null {
  const file = path.join(role, "index.jsonl");
  const st = lstatOrNull(file);
  const ids = new Set<string>();
  if (st === null) return ids; // no index at all: every WAV in the folder is an orphan
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
  for (const role of roleDirs(dir)) {
    const indexed = indexedSegments(role);
    if (indexed === null) continue;
    let names: string[];
    try { names = readdirSync(role); } catch { continue; }
    for (const n of names) {
      if (!WAV_NAME.test(n) || indexed.has(n.slice(0, -4))) continue;
      const p = path.join(role, n);
      try {
        assertInside(o.audioDir, p);
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
    if (!isOwnRealDir(rootSt)) { safeLog(o, SWEEP_DIR_UNSAFE); return result; }
    let names: string[];
    try { names = readdirSync(o.audioDir); } catch { safeLog(o, SWEEP_DIR_UNSAFE); return result; }
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
 * swallowed (the sweep logs its own fixed sentences). `stop()` cancels the pending timer, is idempotent, and a run that ends after it
 * schedules nothing.
 */
export function startSweepSchedule(o: { run: () => Promise<unknown>; setTimer: SetTimer; intervalMs?: number }): { stop(): void } {
  const intervalMs = o.intervalMs ?? SWEEP_INTERVAL_MS;
  let stopped = false, running = false;
  let cancel: (() => void) | null = null;
  const tick = (): void => {
    cancel = null;
    if (stopped || running) return;
    running = true;
    let p: Promise<unknown>;
    try { p = Promise.resolve(o.run()); } catch { p = Promise.resolve(); }
    void p.catch(() => {}).then(() => {
      running = false;
      if (!stopped) cancel = o.setTimer(tick, intervalMs);
    });
  };
  tick();
  return { stop(): void { stopped = true; const c = cancel; cancel = null; try { c?.(); } catch { /* cancelling never throws out */ } } };
}

/** The control service's sweep: independent of VOICE_ENABLED and of voice hosting. `deps.audit` is the audit log the sweep appends to. */
export function startAudioSweep(
  config: { audioDir: string; audioMaxRetentionDays: number },
  deps: { audit: Pick<AuditLog, "append">; setTimer: SetTimer; log: (m: string) => void; now?: () => number; acquireLock?: StoreLockAcquirer; intervalMs?: number },
): { stop(): void } {
  return startSweepSchedule({
    setTimer: deps.setTimer,
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    run: () => sweepAudio({
      audioDir: config.audioDir, retentionDays: config.audioMaxRetentionDays, now: deps.now ?? Date.now, audit: deps.audit,
      acquireLock: deps.acquireLock ?? makeAcquireLock(deps.log), log: deps.log,
    }),
  });
}
