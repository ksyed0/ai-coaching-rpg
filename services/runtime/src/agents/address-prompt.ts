import { roleWords, splitLeadingAddress, type AddressCandidate } from "@acr/events";

/**
 * US-0082: "@Role" addressing in the AI prompts and replies, shared by the AI characters and the live AI players. A model may direct its
 * line at one person by starting it with "@<role id>"; the runtime only ever records an addressee it validated itself (a role of the
 * speaker's current scene), so a model can never invent one.
 */

/** The rule sentence both prompts carry (pinned by a test). */
export const ADDRESS_RULE = "To direct your line at one person in particular, begin it with @ followed by their role id exactly as it is shown in [brackets]; everyone still hears it. Do this only when you need that one person to answer. This is the only place a role id may appear.";

/** A line as a prompt sees it: who said it, what, and (US-0082) who it was addressed to. */
export type AddressedLine = { roleId: string; text: string; to?: string };

/** How a role is named in a prompt: its name when it has one (an AI character), else its id as words ("tech lead"). */
export const labelFrom = (names: Readonly<Record<string, string>>) => (roleId: string): string =>
  Object.hasOwn(names, roleId) && names[roleId]!.trim() !== "" ? names[roleId]!.replace(/\s+/g, " ").trim().slice(0, 80) : roleWords(roleId);

/**
 * The "## Who the last line was for" section, or [] when the latest line was not addressed. Bounded: one sentence. `labelOf` names a role
 * (never a participant's typed name: prompts identify people by role).
 */
export function addressSection(lines: readonly AddressedLine[], selfId: string, labelOf: (roleId: string) => string): string[] {
  const last = lines.at(-1);
  if (!last || typeof last.to !== "string" || last.to === "") return [];
  if (last.roleId === selfId) return [];
  const by = labelOf(last.roleId);
  const sentence = last.to === selfId
    ? `The last line was addressed to you (by ${by}): answer it first, directly.`
    : `The last line was addressed to ${labelOf(last.to)} (by ${by}): let them answer; speak only if you have something only you can add.`;
  return ["", "## Who the last line was for", sentence];
}

/** The other roles of a scene as addressees of `selfId`'s reply, each named by its id, its id as words and its name when it has one. */
export function addressCandidates(participants: readonly string[], selfId: string, names: Readonly<Record<string, string>> = {}): AddressCandidate[] {
  return participants.filter((id) => id !== selfId).map((id) => ({ id, labels: Object.hasOwn(names, id) ? [names[id]!] : [] }));
}

/** A reply's leading "@role" (one of `candidates` only), stripped into `to`; the reply as it was when there is none. */
export function addressOfReply(text: string, candidates: readonly AddressCandidate[]): { text: string; to?: string } {
  const r = splitLeadingAddress(text, candidates);
  return r ? { text: r.text, to: r.to } : { text };
}
