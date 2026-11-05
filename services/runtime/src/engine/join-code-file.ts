import { JoinCodeRecordError, JoinCodes } from "./join-codes.js";
import { assertSessionId } from "./log-files.js";
import { readSecureJson, removeSecureFile, SecureFileError, sweepSecureTemps, writeSecureJson, type SyncCheck } from "./secure-json-file.js";

/**
 * US-0033: the session's join codes file, `<id>.codes.json` next to its log. It holds the salted SHA-256 of each player role's code
 * (never a code), so a restarted server keeps accepting the codes that were handed out. Written only at startup, by the process that
 * holds the session lock, before any client can connect: write a new file (O_EXCL, O_NOFOLLOW, 0600), fsync, rename over the old one,
 * fsync the directory. Read through one descriptor that was opened without following links and judged by fstat.
 */
export const codesFileName = (sessionId: string): string => { assertSessionId(sessionId); return `${sessionId}.codes.json`; };
export const MAX_CODES_FILE_BYTES = 64 * 1024;

export type { SyncCheck };

const REFUSALS: Record<SecureFileError["kind"], string> = {
  symlink: "the join codes file is a symbolic link and is not followed",
  not_file: "the join codes file is not a regular file",
  links: "the join codes file has other hard links",
  owner: "the join codes file belongs to another user",
  size: "the join codes file is too large",
  json: "the join codes file is not valid JSON",
};

/** The session's codes, or null when there is no codes file. Throws JoinCodeRecordError (no values quoted) for anything unusable. */
export function readJoinCodesFile(dir: string, sessionId: string): JoinCodes | null {
  let json: unknown;
  try { json = readSecureJson(dir, codesFileName(sessionId), { maxBytes: MAX_CODES_FILE_BYTES }); }
  catch (err) { if (err instanceof SecureFileError) throw new JoinCodeRecordError(REFUSALS[err.kind]); throw err; }
  return json === null ? null : JoinCodes.fromRecord(json);
}

/**
 * Replaces the codes file with `codes` (hashes only). `beforeCommit` runs right before the rename (the session store checks there,
 * synchronously, that it still holds the session lock); a throw leaves the old file in place. Never leaves a temp file behind on failure.
 */
export function writeJoinCodesFile(dir: string, sessionId: string, codes: JoinCodes, beforeCommit?: SyncCheck): void {
  writeSecureJson(dir, codesFileName(sessionId), codes.toRecord(), beforeCommit, "join codes file");
}

/** Removes the codes file (a session that starts over gets new codes). A missing file is fine. */
export function removeJoinCodesFile(dir: string, sessionId: string): void {
  removeSecureFile(dir, codesFileName(sessionId));
}

/**
 * Removes `<id>.codes.json.<12 hex>.tmp` regular files a crash left behind while writing (review M-5); anything else is skipped. Call only while holding the session
 * lock: no other process can be writing one then. Matches exactly the names writeJoinCodesFile makes; unlink never follows a link.
 * Returns how many were removed. A missing directory is fine.
 */
export function sweepJoinCodesTemps(dir: string, sessionId: string): number {
  return sweepSecureTemps(dir, codesFileName(sessionId)); // codesFileName asserts the id first: a hostile id is refused even when the directory is missing
}
