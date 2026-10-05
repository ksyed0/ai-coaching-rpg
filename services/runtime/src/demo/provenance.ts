import type { SessionEvent } from "@acr/events";

const FALLBACK_ALERT = /^NPC [^:]+: (.*); used fallback line$/;

/** The reason inside a fallback alert ("no first token within timeout"), or null when the alert is not one. */
export function fallbackReason(message: string): string | null {
  return FALLBACK_ALERT.exec(message)?.[1] ?? null;
}

/** Where a line of text came from: authored in advance, produced by a live model, a canned stand-in, or technical logging. */
export type Provenance = "scripted" | "generated" | "fallback" | "system";
export const TAGS: Record<Provenance, string> = { scripted: "[SCRIPTED]", generated: "[GENERATED]", fallback: "[FALLBACK]", system: "[SYSTEM]" };
/** Whose models answered: the scripted mock providers, or a real (live) provider. */
export type ProviderKind = "mock" | "live";

/**
 * THE rule for "was this AI reply a canned fallback line?": the text is the character's fallback line AND the engine logged the
 * fallback alert immediately before it (this is exactly what the NPC agent's fallback path emits).
 */
export function isFallbackReply(fallbackLine: string, utterance: { text: string }, previous: SessionEvent | undefined): boolean {
  return utterance.text === fallbackLine && previous?.type === "facilitator.alert" && fallbackReason(previous.message) !== null;
}

/** Provenance of an AI character's reply. A fallback is scripted text standing in for a missing reply: never "generated". */
export function classifyNpcReply(provider: ProviderKind, fallback: boolean): Provenance {
  if (fallback) return "fallback";
  return provider === "live" ? "generated" : "scripted";
}

/** Provenance of a Game Master decision (its reasoning is model output in a live run, a scripted string in a mock run). */
export function classifyGmDecision(provider: ProviderKind): Provenance { return provider === "live" ? "generated" : "scripted"; }
