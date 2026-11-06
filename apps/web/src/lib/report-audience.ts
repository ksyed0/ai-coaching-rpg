import { roleLabel } from "./names";

// Who sees a released report, in words, for the release, amend and withdraw dialogs (AC-0338). A hand-written mirror of the runtime's
// visibility policy, version 1 (services/runtime/src/review/policy.ts, POLICY): the web app never imports the runtime, and
// src/lib/__tests__/report-audience.test.ts pins this file against POLICY. Only the audiences that can be resolved to a person today
// (the facilitator and the participant) are listed: the policy's other audiences (line manager, L&D, HR, sponsor) are inert until
// identities exist, and are never promised here.

/** The visibility policy version this wording mirrors. */
export const AUDIENCE_POLICY_VERSION = 1;

/** A personal report (a role) or the group report (the index is a view of the group). */
export type SubjectKind = "personal" | "group";
export type ResolvableAudience = "participant" | "facilitator";

/** The resolvable audience kinds per subject kind, as in POLICY.personal and POLICY.group. */
export const AUDIENCE_KINDS: Readonly<Record<SubjectKind, readonly ResolvableAudience[]>> = Object.freeze({
  personal: Object.freeze(["participant", "facilitator"] as const),
  group: Object.freeze(["participant", "facilitator"] as const),
});

export const subjectKind = (id: string): SubjectKind => (id === "group" || id === "index" ? "group" : "personal");

const WORDS: Record<SubjectKind, Record<ResolvableAudience, (label: string) => string>> = {
  // a participant sees only their own personal report
  personal: { participant: (label) => `${label} (the participant this report is about)`, facilitator: () => "The facilitator" },
  // every participant sees the group report with their peers' individual results removed (redactGroupForParticipant)
  group: { participant: () => "Every participant, with the other participants' individual results removed", facilitator: () => "The facilitator" },
};

/** Who sees this subject once it is released, one line per audience. */
export function audienceOf(id: string): string[] {
  const kind = subjectKind(id);
  return AUDIENCE_KINDS[kind].map((a) => WORDS[kind][a](roleLabel(id)));
}
