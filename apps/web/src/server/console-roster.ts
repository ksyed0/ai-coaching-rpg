import type { FacilitatorRosterEntry, VoiceState } from "./wire";

// One seat as the console may see it, picked field by field (the name is capped). Imports nothing but a type, so both the session API
// and the live-view copies can use it without a cycle.

const MAX_NAME_CODE_POINTS = 60;
const cap = (name: string) => [...name].slice(0, MAX_NAME_CODE_POINTS).join("");
// Kept here (not imported from stream-hub.ts) so this module stays type-only in its imports.
const VOICE_STATES: readonly string[] = ["none", "voice", "text_only", "off"] satisfies VoiceState[];
const isVoiceState = (v: unknown): v is VoiceState => typeof v === "string" && VOICE_STATES.includes(v);

export const entryOf = (e: FacilitatorRosterEntry): FacilitatorRosterEntry => ({
  roleId: e.roleId,
  ...(typeof e.name === "string" && { name: cap(e.name) }),
  joined: e.joined === true,
  consented: e.consented === true,
  connected: e.connected === true,
  // Default-deny: only the literal boolean true marks an AI seat; any other value is dropped.
  ...(e.ai === true && { ai: true as const }),
  // US-0071 (K6): the seat's voice state only when it is one of the four, and speaking only as the literal true (a text-only session's
  // entry has neither key: the runtime sends them only with voice on).
  ...(isVoiceState(e.voice) && { voice: e.voice }),
  ...(e.speaking === true && { speaking: true as const }),
});
