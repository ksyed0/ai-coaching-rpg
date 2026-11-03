import { AiRolesRecordError, AiRoleSet } from "./ai-roles.js";
import type { Bind } from "./credentials.js";
import { assertSessionId } from "./log-files.js";
import { readSecureJson, removeSecureFile, SecureFileError, sweepSecureTemps, writeSecureJson, type SyncCheck } from "./secure-json-file.js";

/** US-0060: `<id>.ai-roles.json`, the lobby's AI roles. Mode 0600, written by atomic rename. */
export const aiRolesFileName = (sessionId: string): string => { assertSessionId(sessionId); return `${sessionId}.ai-roles.json`; };
export const MAX_AI_ROLES_FILE_BYTES = 16 * 1024;

/** The lobby's AI roles, or null when there is no file. Throws AiRolesRecordError (no values quoted) for anything unusable. */
export function readAiRolesFile(dir: string, bind: Bind & { roleIds: string[] }): AiRoleSet | null {
  let json: unknown;
  try { json = readSecureJson(dir, aiRolesFileName(bind.sessionId), { maxBytes: MAX_AI_ROLES_FILE_BYTES }); }
  catch (err) { if (err instanceof SecureFileError) throw new AiRolesRecordError(`the AI-role file is unusable (${err.kind})`); throw err; }
  return json === null ? null : AiRoleSet.fromRecord(json, bind);
}

export function writeAiRolesFile(dir: string, bind: Bind, set: AiRoleSet, beforeCommit?: SyncCheck): void {
  writeSecureJson(dir, aiRolesFileName(bind.sessionId), set.toRecord(bind), beforeCommit, "AI-role file");
}

export function removeAiRolesFile(dir: string, sessionId: string): void { removeSecureFile(dir, aiRolesFileName(sessionId)); }
export function sweepAiRolesTemps(dir: string, sessionId: string): number { return sweepSecureTemps(dir, aiRolesFileName(sessionId)); }
