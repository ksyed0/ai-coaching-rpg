import { fail } from "./envelope";
import type { LauncherReason } from "./launcher-client";

// The BFF's own words for the control service's AI refusals. A leaf module (envelope and a launcher type only), so the session API and
// the AI routes can both use it without importing each other.

/** The BFF's own words for each refusal of the control service (the launcher's text is never used). */
export const AI_COPY = {
  ai_role: { status: 409, text: "This role is played by an AI player. Switch it back to human first." },
  ai_notice: { status: 409, text: "This server's consent notice does not mention AI players. AI players need notice v2 or later." },
  ai_started: { status: 409, text: "Roles can no longer be changed: the session has started." },
  ai_no_human: { status: 409, text: "At least one role must stay human." },
  ai_too_many: { status: 409, text: "At most 8 roles can be AI players." },
} as const;
export const UNCONFIRMED = "The change may or may not have been made. Check the roster, then switch the role again.";

/** The answer for an `ai_*` launcher reason that has its own copy; null for every other reason (`ai_invalid` is a plain bad request). */
export function aiAnswer(reason: LauncherReason): Response | null {
  if (reason === "ai_invalid") return fail(400, "bad_request", "The request could not be read.");
  if (!Object.hasOwn(AI_COPY, reason)) return null;
  const c = AI_COPY[reason as keyof typeof AI_COPY];
  return fail(c.status, reason, c.text);
}
