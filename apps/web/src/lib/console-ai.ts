import { postJson, type ApiResult } from "./api";
import { failureText, parseCodes, type CodeEntry } from "./console-api";

// US-0060: the console's calls for AI players. The BFF answers a refusal with its own sentence in the error envelope and the client
// shows that sentence; `AI_ERRORS` holds the same words for the case where the message did not arrive (too long, or not a string).

/** The BFF's words for each refusal of a role switch, keyed by the error code (the same strings as the BFF's own copy). */
export const AI_ERRORS: Readonly<Record<string, string>> = {
  ai_role: "This role is played by an AI player. Switch it back to human first.",
  ai_notice: "This server's consent notice does not mention AI players. AI players need notice v2 or later.",
  ai_started: "Roles can no longer be changed: the session has started.",
  ai_no_human: "At least one role must stay human.",
  ai_too_many: "At most 8 roles can be AI players.",
  ai_invalid: "The request could not be read.",
  ai_roles_unconfirmed: "The change may or may not have been made. Check the roster, then switch the role again.",
};

/** A failed role switch as one sentence: the BFF's own message for a known AI code, else our copy of it, else the generic text. */
export function aiErrorText(r: Extract<ApiResult, { ok: false }>): string {
  if (!Object.hasOwn(AI_ERRORS, r.code)) return failureText(r);
  return r.message !== "" ? r.message : AI_ERRORS[r.code]!;
}

/** POST .../ai-roles with the WHOLE wanted AI set (never only the toggled role). */
export function setAiRoles(sessionId: string, roles: string[], fetchImpl?: typeof fetch): Promise<ApiResult> {
  return postJson(`/api/v1/console/sessions/${encodeURIComponent(sessionId)}/ai-roles`, { roles }, fetchImpl);
}

/** The answer's AI set and the human roles' codes; anything malformed reads as nothing. */
export function parseAiAnswer(d: unknown): { roles: string[]; codes: CodeEntry[] } {
  const o = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
  return {
    roles: Array.isArray(o.roles) ? o.roles.filter((r): r is string => typeof r === "string") : [],
    codes: parseCodes(o.codes),
  };
}
