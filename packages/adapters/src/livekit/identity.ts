import { isReservedRoleId, isScenarioId } from "@acr/events";

/**
 * US-0071 (EPIC-0003 voice A1b, overview section 7, K3): the LiveKit identities. A seat's identity is `<roleId>.g<generation>` (the
 * generation: 8 lower-case hex, new for every create, reissue, rebind and control start); the speech worker's is `SPEECH.<8 hex>`, which
 * never parses as a seat (upper case, and its last part has no `g`). This module loads nothing from `livekit-server-sdk`: the speech
 * worker imports it as `@acr/adapters/livekit/identity`. Errors never quote the input.
 */
export const GENERATION_HEX_CHARS = 8;
export const WORKER_IDENTITY_PREFIX = "SPEECH.";

/** Exactly `length` lower-case hex characters, checked character by character (no regular expression). */
function isLowerHex(v: unknown, length: number): v is string {
  if (typeof v !== "string" || v.length !== length) return false;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

const isSeatRole = (roleId: unknown): roleId is string => typeof roleId === "string" && roleId.length > 0 && isScenarioId(roleId) && !isReservedRoleId(roleId);

/** The seat identity `<roleId>.g<generation>`. Throws RangeError (a fixed message) for a role or a generation that is not valid. */
export function participantIdentity(roleId: string, generation: string): string {
  if (!isSeatRole(roleId)) throw new RangeError("participantIdentity: invalid role id");
  if (!isLowerHex(generation, GENERATION_HEX_CHARS)) throw new RangeError("participantIdentity: invalid generation");
  return `${roleId}.g${generation}`;
}

/**
 * The role and generation of a seat identity, or null for anything else (the worker's identity, a reserved or malformed role, a bad
 * generation, extra dots). Splits on the LAST dot.
 */
export function parseParticipantIdentity(identity: string): { roleId: string; generation: string } | null {
  if (typeof identity !== "string") return null;
  const dot = identity.lastIndexOf(".");
  if (dot <= 0) return null;
  const roleId = identity.slice(0, dot);
  const rest = identity.slice(dot + 1);
  if (!isSeatRole(roleId) || rest.length !== GENERATION_HEX_CHARS + 1 || rest[0] !== "g") return null;
  const generation = rest.slice(1);
  return isLowerHex(generation, GENERATION_HEX_CHARS) ? { roleId, generation } : null;
}

/** The speech worker's identity `SPEECH.<suffix>` (8 lower-case hex). Throws RangeError for another suffix. */
export function workerIdentity(suffix: string): string {
  if (!isLowerHex(suffix, GENERATION_HEX_CHARS)) throw new RangeError("workerIdentity: invalid suffix");
  return `${WORKER_IDENTITY_PREFIX}${suffix}`;
}
