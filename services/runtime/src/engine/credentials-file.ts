import { CredentialRecordError, PlayerCredentials } from "./credentials.js";
import { assertSessionId } from "./log-files.js";
import { readSecureJson, removeSecureFile, SecureFileError, sweepSecureTemps, writeSecureJson, type SyncCheck } from "./secure-json-file.js";

/** US-0053: `<id>.credentials.json`, the salted hashes, names and log identity of the seated players. Mode 0600, written by atomic rename. */
export const credentialsFileName = (sessionId: string): string => { assertSessionId(sessionId); return `${sessionId}.credentials.json`; };
export const MAX_CREDENTIALS_FILE_BYTES = 64 * 1024;

/** The session's credentials, or null when there is no file. Throws CredentialRecordError (no values quoted) for anything unusable. */
export function readCredentialsFile(dir: string, sessionId: string): PlayerCredentials | null {
  let json: unknown;
  try { json = readSecureJson(dir, credentialsFileName(sessionId), { maxBytes: MAX_CREDENTIALS_FILE_BYTES }); }
  catch (err) { if (err instanceof SecureFileError) throw new CredentialRecordError(`the credentials file is unusable (${err.kind})`); throw err; }
  return json === null ? null : PlayerCredentials.fromRecord(json);
}

/** Replaces the credentials file; `beforeCommit` is the synchronous session-lock check (see writeSecureJson). */
export function writeCredentialsFile(dir: string, sessionId: string, credentials: PlayerCredentials, beforeCommit?: SyncCheck): void {
  writeSecureJson(dir, credentialsFileName(sessionId), credentials.toRecord(), beforeCommit, "credentials file");
}

export function removeCredentialsFile(dir: string, sessionId: string): void { removeSecureFile(dir, credentialsFileName(sessionId)); }
export function sweepCredentialsTemps(dir: string, sessionId: string): number { return sweepSecureTemps(dir, credentialsFileName(sessionId)); }
