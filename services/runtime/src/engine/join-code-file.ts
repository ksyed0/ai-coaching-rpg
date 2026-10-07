import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { JoinCodeRecordError, JoinCodes } from "./join-codes.js";
import { assertInside, assertSessionId, fsyncDirSync } from "./log-files.js";

/**
 * US-0033: the session's join codes file, `<id>.codes.json` next to its log. It holds the salted SHA-256 of each player role's code
 * (never a code), so a restarted server keeps accepting the codes that were handed out. Written only at startup, by the process that
 * holds the session lock, before any client can connect: write a new file (O_EXCL, O_NOFOLLOW, 0600), fsync, rename over the old one,
 * fsync the directory. Read through one descriptor that was opened without following links and judged by fstat.
 */
export const codesFileName = (sessionId: string): string => { assertSessionId(sessionId); return `${sessionId}.codes.json`; };
export const MAX_CODES_FILE_BYTES = 64 * 1024;

/** The session's codes, or null when there is no codes file. Throws JoinCodeRecordError (no values quoted) for anything unusable. */
export function readJoinCodesFile(dir: string, sessionId: string): JoinCodes | null {
  const file = path.join(dir, codesFileName(sessionId));
  assertInside(dir, file);
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new JoinCodeRecordError("the join codes file is a symbolic link and is not followed");
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new JoinCodeRecordError("the join codes file is not a regular file");
    if (st.nlink > 1) throw new JoinCodeRecordError("the join codes file has other hard links");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new JoinCodeRecordError("the join codes file belongs to another user");
    if (st.size > MAX_CODES_FILE_BYTES) throw new JoinCodeRecordError("the join codes file is too large");
    if ((st.mode & 0o077) !== 0) { try { fchmodSync(fd, 0o600); } catch { /* best effort: it holds hashes only */ } }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    let json: unknown;
    try { json = JSON.parse(buf.subarray(0, off).toString("utf8")); } catch { throw new JoinCodeRecordError("the join codes file is not valid JSON"); }
    return JoinCodes.fromRecord(json);
  } finally { closeSync(fd); }
}

/**
 * A check that must run synchronously and throw to refuse. Typed to return `undefined`, so an async function (whose rejection would
 * be ignored, and left unhandled) is a compile error; a returned promise is also refused at run time.
 */
export type SyncCheck = () => undefined;

/**
 * Replaces the codes file with `codes` (hashes only). `beforeCommit` runs right before the rename (the session store checks there,
 * synchronously, that it still holds the session lock); a throw leaves the old file in place. Never leaves a temp file behind on failure.
 */
export function writeJoinCodesFile(dir: string, sessionId: string, codes: JoinCodes, beforeCommit?: SyncCheck): void {
  const file = path.join(dir, codesFileName(sessionId));
  const tmp = path.join(dir, `${codesFileName(sessionId)}.${randomBytes(6).toString("hex")}.tmp`);
  assertInside(dir, file); assertInside(dir, tmp);
  const data = Buffer.from(JSON.stringify(codes.toRecord()) + "\n", "utf8");
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
    closeSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  try {
    const r: unknown = beforeCommit?.();
    if (r !== undefined) {
      if (typeof (r as { then?: unknown }).then === "function") (r as Promise<unknown>).then(undefined, () => undefined); // never left unhandled
      throw new Error("the pre-commit check of the join codes file must be synchronous");
    }
    renameSync(tmp, file);
  }
  catch (err) { try { unlinkSync(tmp); } catch { /* best effort */ } throw err; }
  fsyncDirSync(dir);
}

/** Removes the codes file (a session that starts over gets new codes). A missing file is fine. */
export function removeJoinCodesFile(dir: string, sessionId: string): void {
  const file = path.join(dir, codesFileName(sessionId));
  assertInside(dir, file);
  try { unlinkSync(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  fsyncDirSync(dir);
}

/**
 * Removes `<id>.codes.json.<12 hex>.tmp` regular files a crash left behind while writing (review M-5); anything else is skipped. Call only while holding the session
 * lock: no other process can be writing one then. Matches exactly the names writeJoinCodesFile makes; unlink never follows a link.
 * Returns how many were removed. A missing directory is fine.
 */
export function sweepJoinCodesTemps(dir: string, sessionId: string): number {
  assertSessionId(sessionId); // first: a hostile id is refused even when the directory is missing
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; throw err; }
  const prefix = `${codesFileName(sessionId)}.`;
  let n = 0;
  for (const e of entries) {
    const name = e.name;
    if (!name.startsWith(prefix) || !/^[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    if (!e.isFile()) continue; // review m-2: a directory (or anything else) with that name is not ours and must not stop the start
    const file = path.join(dir, name);
    assertInside(dir, file);
    // EISDIR/EPERM: it became a directory since the listing; leave it alone as well.
    try { unlinkSync(file); n++; } catch (err) { if (!["ENOENT", "EISDIR", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
  }
  if (n > 0) fsyncDirSync(dir);
  return n;
}
