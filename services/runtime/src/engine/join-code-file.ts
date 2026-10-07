import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { JoinCodeRecordError, JoinCodes } from "./join-codes.js";
import { assertInside, fsyncDirSync } from "./log-files.js";

/**
 * US-0033: the session's join codes file, `<id>.codes.json` next to its log. It holds the salted SHA-256 of each player role's code
 * (never a code), so a restarted server keeps accepting the codes that were handed out. Written only at startup, by the process that
 * holds the session lock, before any client can connect: write a new file (O_EXCL, O_NOFOLLOW, 0600), fsync, rename over the old one,
 * fsync the directory. Read through one descriptor that was opened without following links and judged by fstat.
 */
export const codesFileName = (sessionId: string): string => `${sessionId}.codes.json`;
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
 * Replaces the codes file with `codes` (hashes only). `beforeCommit` runs right before the rename (the session store checks that it
 * still holds the session lock there). Never leaves a temp file behind on failure.
 */
export function writeJoinCodesFile(dir: string, sessionId: string, codes: JoinCodes, beforeCommit?: () => void): void {
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
  try { beforeCommit?.(); renameSync(tmp, file); }
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
