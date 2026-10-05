import type { SessionEvent } from "@acr/events";

const ALERT_ANY = /^NPC [^:]+: (.*); used fallback line$/s;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The reason inside a fallback alert ("no first token within timeout"), or null when the alert is not one (for `roleId`, when given). */
export function fallbackReason(message: string, roleId?: string): string | null {
  const re = roleId === undefined ? ALERT_ANY : new RegExp(`^NPC ${escapeRe(roleId)}: (.*); used fallback line$`, "s");
  return re.exec(message)?.[1] ?? null;
}

/** Where a line of text came from. */
export type Provenance = "scripted" | "generated" | "fallback" | "unverified" | "system";
/** The one table of tags (the transcript legend and the narration read it). */
export const TAGS: Record<Provenance, string> = {
  scripted: "[SCRIPTED]", generated: "[GENERATED]", fallback: "[FALLBACK]", unverified: "[UNVERIFIED]", system: "[SYSTEM]",
};
/**
 * Whose models answered the AI characters and the Game Master. `mock`: the scripted providers the runner itself started
 * (also the side room). `live`: the real provider the runner itself configured. `remote`: a server reached with `--url`, whose
 * provider the runner cannot know (with or without `--live`).
 */
export type ProviderKind = "mock" | "live" | "remote";

/**
 * THE rule for "was this AI reply a canned fallback line?". The NPC agent's fallback path marks its utterance with
 * `fallback: true`, so the marker is the rule. `legacy` (only for a remote server that may predate the marker) adds an older
 * inference: the text is the character's fallback line AND the engine logged THIS character's fallback alert immediately
 * before it. Without `legacy` a model that says the fallback text itself is never mistaken for a fallback.
 */
export function isFallbackReply(
  npc: { id: string; fallback_line: string }, utterance: { text: string; fallback?: true }, previous: SessionEvent | undefined, o: { legacy: boolean },
): boolean {
  if (utterance.fallback === true) return true;
  return o.legacy && utterance.text === npc.fallback_line && previous?.type === "facilitator.alert" && fallbackReason(previous.message, npc.id) !== null;
}

/** Provenance of an AI character's reply. A fallback is scripted text standing in for a missing reply: never "generated". */
export function classifyNpcReply(provider: ProviderKind, fallback: boolean): Provenance {
  if (fallback) return "fallback";
  return provider === "live" ? "generated" : provider === "remote" ? "unverified" : "scripted";
}

/** Provenance of a Game Master decision (its reasoning is model output live, a scripted string in a mock run, unknown remotely). */
export function classifyGmDecision(provider: ProviderKind): Provenance {
  return provider === "live" ? "generated" : provider === "remote" ? "unverified" : "scripted";
}
