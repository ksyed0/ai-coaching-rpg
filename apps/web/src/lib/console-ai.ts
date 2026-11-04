import { getJson, postJson, type ApiResult } from "./api";
import { failureText, parseCodes, parseReadiness, type CodeEntry, type RosterEntry } from "./console-api";

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
  // The prompt route: its own refusals, then the command copy it shares with the other console commands.
  ai_busy: "The AI player is already answering. Wait a moment, then try again.",
  ai_budget: "The AI players have used this session's model budget. They stay silent.",
  ai_absent: "The AI player is not connected right now.",
  ai_expired: "The prompt took too long to confirm. Try again.",
  ai_run_failed: "The prompt was recorded, but the AI player could not start. Try again.",
  paused: "The session is paused. Resume it before you prompt an AI player.",
  not_in_scene: "That AI player is not in the current scene.",
  stale_scene: "The scene changed. Review the live view and try again.",
  not_started: "The session has not started yet.",
  starting: "The session is still starting. Try again in a moment.",
  ended: "The session has ended.",
  rate_limited: "Too many actions at once. Wait a moment and try again.",
  command_failed: "The session could not take that action. Check the live view, then try again.",
  command_unconfirmed: "The session did not confirm the action. Check the live view before you try again.",
  no_channel: "The live view is not connected. Wait until it is live again, then try again.",
  command_pending: "Another action is still being confirmed. Wait a moment, then try again.",
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

/** A ONE-SHOT roster read (not a poll): the entry for each role, or null when the read failed or the answer was not a roster. */
export async function readRoster(sessionId: string, fetchImpl?: typeof fetch): Promise<RosterEntry[] | null> {
  const r = await getJson(`/api/v1/console/sessions/${encodeURIComponent(sessionId)}/readiness`, fetchImpl);
  if (!r.ok) return null;
  return parseReadiness(r.data)?.roster ?? null;
}

export const HINT_MAX = 300;

/** POST .../ai-roles/:roleId/prompt { channel, hint? }: the hint goes only here (never into a transcript line) and is left out when empty. */
export function promptAi(sessionId: string, roleId: string, channel: string, hint: string, fetchImpl?: typeof fetch): Promise<ApiResult> {
  return postJson(
    `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/ai-roles/${encodeURIComponent(roleId)}/prompt`,
    hint === "" ? { channel } : { channel, hint },
    fetchImpl,
  );
}

export type IntentView = {
  ts: number;
  trigger: "reply" | "nudge" | "prompt";
  outcome: "spoken" | "skipped" | "dropped";
  reason?: "model_failed" | "timeout" | "unusable" | "budget";
  hint?: string;
};
const TRIGGERS: readonly string[] = ["reply", "nudge", "prompt"];
const OUTCOMES: readonly string[] = ["spoken", "skipped", "dropped"];

export const INTENT_TRIGGERS: Record<IntentView["trigger"], string> = { reply: "reply", nudge: "quiet-time nudge", prompt: "prompt" };
export const INTENT_REASONS: Record<NonNullable<IntentView["reason"]>, string> = {
  model_failed: "the model did not answer",
  timeout: "the model took too long",
  unusable: "the reply was empty or unusable",
  budget: "the model budget is used up",
};

/** An outcome as words: "spoke", "dropped: the moment had passed", "skipped: <reason>". */
export function intentOutcome(e: IntentView): string {
  if (e.outcome === "spoken") return "spoke";
  if (e.outcome === "dropped") return "dropped: the moment had passed";
  return e.reason !== undefined ? `skipped: ${INTENT_REASONS[e.reason]}` : "skipped";
}

/** POST .../ai-roles/:roleId/intents {}: the AI player's recent turns, only entries with known words. */
export async function fetchIntents(sessionId: string, roleId: string, fetchImpl?: typeof fetch): Promise<{ ok: true; entries: IntentView[] } | { ok: false; message: string }> {
  const r = await postJson(`/api/v1/console/sessions/${encodeURIComponent(sessionId)}/ai-roles/${encodeURIComponent(roleId)}/intents`, {}, fetchImpl);
  if (!r.ok) return { ok: false, message: aiErrorText(r) };
  const raw = (typeof r.data === "object" && r.data !== null ? (r.data as { entries?: unknown }).entries : undefined) ?? [];
  const entries: IntentView[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    if (typeof x !== "object" || x === null) continue;
    const o = x as Record<string, unknown>;
    // A time the page can format: finite and inside the Date range (an out-of-range value would make toISOString throw).
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || Number.isNaN(new Date(o.ts).getTime())) continue;
    if (typeof o.trigger !== "string" || !TRIGGERS.includes(o.trigger)) continue;
    if (typeof o.outcome !== "string" || !OUTCOMES.includes(o.outcome)) continue;
    const reason = typeof o.reason === "string" && Object.hasOwn(INTENT_REASONS, o.reason) ? (o.reason as NonNullable<IntentView["reason"]>) : undefined;
    entries.push({
      ts: o.ts,
      trigger: o.trigger as IntentView["trigger"],
      outcome: o.outcome as IntentView["outcome"],
      ...(reason !== undefined && { reason }),
      ...(typeof o.hint === "string" && o.hint !== "" && { hint: o.hint }),
    });
  }
  return { ok: true, entries };
}
