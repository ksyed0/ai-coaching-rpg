import { randomBytes } from "node:crypto";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { assertInside, fsyncDirSync } from "./log-files.js";

/**
 * Safe small-JSON-file helpers shared by the join codes, credentials and consent files (all hold hashes or tiny records, mode 0600).
 * Reads go through one descriptor opened without following links and judged by fstat; writes go to a new O_EXCL temp file, fsync,
 * rename over the old file, fsync the directory. The caller holds the session lock.
 */

/**
 * A check that must run synchronously and throw to refuse. Typed to return `undefined`, so an async function (whose rejection would
 * be ignored, and left unhandled) is a compile error; a returned promise is also refused at run time.
 */
export type SyncCheck = () => undefined;

export type SecureFileErrorKind = "symlink" | "not_file" | "links" | "owner" | "size" | "json";

/** A file that cannot be used. The message names the kind only, never any content. */
export class SecureFileError extends Error {
  constructor(readonly kind: SecureFileErrorKind) { super(`secure file refused: ${kind}`); this.name = "SecureFileError"; }
}

/** The parsed JSON of `dir/fileName`, or null when the file is absent. Throws SecureFileError for anything unusable. */
export function readSecureJson(dir: string, fileName: string, o: { maxBytes: number }): unknown | null {
  const file = path.join(dir, fileName);
  assertInside(dir, file);
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP" || code === "EMLINK") throw new SecureFileError("symlink");
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecureFileError("not_file");
    if (st.nlink > 1) throw new SecureFileError("links");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new SecureFileError("owner");
    if (st.size > o.maxBytes) throw new SecureFileError("size");
    if ((st.mode & 0o077) !== 0) { try { fchmodSync(fd, 0o600); } catch { /* best effort: it holds hashes only */ } }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    try { return JSON.parse(buf.subarray(0, off).toString("utf8")) as unknown; } catch { throw new SecureFileError("json"); }
  } finally { closeSync(fd); }
}

/**
 * Replaces `dir/fileName` with `value`. `beforeCommit` runs right before the rename (the session store checks there, synchronously,
 * that it still holds the session lock); a throw leaves the old file in place. Never leaves a temp file behind on failure.
 * `label` only words the error for an asynchronous check.
 */
export function writeSecureJson(dir: string, fileName: string, value: unknown, beforeCommit?: SyncCheck, label = "secure file"): void {
  const file = path.join(dir, fileName);
  const tmp = path.join(dir, `${fileName}.${randomBytes(6).toString("hex")}.tmp`);
  assertInside(dir, file); assertInside(dir, tmp);
  const data = Buffer.from(JSON.stringify(value) + "\n", "utf8");
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
      throw new Error(`the pre-commit check of the ${label} must be synchronous`);
    }
    renameSync(tmp, file);
  }
  catch (err) { try { unlinkSync(tmp); } catch { /* best effort */ } throw err; }
  fsyncDirSync(dir);
}

/** Removes `dir/fileName`. A missing file is fine. */
export function removeSecureFile(dir: string, fileName: string): void {
  const file = path.join(dir, fileName);
  assertInside(dir, file);
  try { unlinkSync(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  fsyncDirSync(dir);
}

/**
 * Removes `<fileName>.<12 hex>.tmp` regular files a crash left behind while writing; anything else is skipped. Call only while
 * holding the session lock. Matches exactly the names writeSecureJson makes; unlink never follows a link. Returns how many were
 * removed. A missing directory is fine.
 */
export function sweepSecureTemps(dir: string, fileName: string): number {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; throw err; }
  const prefix = `${fileName}.`;
  let n = 0;
  for (const e of entries) {
    const name = e.name;
    if (!name.startsWith(prefix) || !/^[0-9a-f]{12}\.tmp$/.test(name.slice(prefix.length))) continue;
    if (!e.isFile()) continue; // a directory (or anything else) with that name is not ours and must not stop the start
    const file = path.join(dir, name);
    assertInside(dir, file);
    // EISDIR/EPERM: it became a directory since the listing; leave it alone as well.
    try { unlinkSync(file); n++; } catch (err) { if (!["ENOENT", "EISDIR", "EPERM"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
  }
  if (n > 0) fsyncDirSync(dir);
  return n;
}
