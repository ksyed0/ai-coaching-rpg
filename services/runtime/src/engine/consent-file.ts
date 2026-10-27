import { ConsentRecordError, ConsentStore, type ConsentNotice } from "./consent.js";
import type { Bind } from "./credentials.js";
import { assertSessionId } from "./log-files.js";
import { readSecureJson, removeSecureFile, SecureFileError, sweepSecureTemps, writeSecureJson, type SyncCheck } from "./secure-json-file.js";

/** US-0053: `<id>.consent.json`, who agreed to which notice version. Mode 0600, written by atomic rename. */
export const consentFileName = (sessionId: string): string => { assertSessionId(sessionId); return `${sessionId}.consent.json`; };
export const MAX_CONSENT_FILE_BYTES = 16 * 1024;

/** The session's consent store, or null when there is no file. Entries under another notice version are dropped. */
export function readConsentFile(dir: string, bind: Bind, notice: ConsentNotice): ConsentStore | null {
  let json: unknown;
  try { json = readSecureJson(dir, consentFileName(bind.sessionId), { maxBytes: MAX_CONSENT_FILE_BYTES }); }
  catch (err) { if (err instanceof SecureFileError) throw new ConsentRecordError(`the consent file is unusable (${err.kind})`); throw err; }
  return json === null ? null : ConsentStore.fromRecord(json, notice, bind);
}

export function writeConsentFile(dir: string, bind: Bind, consent: ConsentStore, beforeCommit?: SyncCheck): void {
  writeSecureJson(dir, consentFileName(bind.sessionId), consent.toRecord(bind), beforeCommit, "consent file");
}

export function removeConsentFile(dir: string, sessionId: string): void { removeSecureFile(dir, consentFileName(sessionId)); }
export function sweepConsentTemps(dir: string, sessionId: string): number { return sweepSecureTemps(dir, consentFileName(sessionId)); }
