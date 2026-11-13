// US-0071 (A1b Task 16): what the console shows about voice. The BFF sends a human seat's `voice` and `speaking` to the facilitator only,
// and only with voice on (a text-only session's roster has neither key). The client parsers keep them through `pickVoice`, so a value
// outside the four states, or a `speaking` that is not the literal true, never reaches the view. A client module: imports no server module.

export type ConsoleVoiceState = "none" | "voice" | "text_only" | "off";

export const CONSOLE_VOICE = {
  heading: "Voice",
  caption: "Each participant's voice choice. Speaking is shown as it happens and is not announced.",
  speaking: "Speaking",
  quiet: "Quiet",
  states: { voice: "Voice on", text_only: "Text only", none: "Not chosen", off: "Voice off" } satisfies Record<ConsoleVoiceState, string>,
} as const;

const STATES: readonly string[] = ["none", "voice", "text_only", "off"] satisfies ConsoleVoiceState[];
export const isConsoleVoiceState = (v: unknown): v is ConsoleVoiceState => typeof v === "string" && STATES.includes(v);

/** The voice fields of one roster entry, picked: `voice` only when it is one of the four states, `speaking` only as the literal true. */
export const pickVoice = (r: Record<string, unknown>): { voice?: ConsoleVoiceState; speaking?: true } => ({
  ...(isConsoleVoiceState(r.voice) && { voice: r.voice }),
  ...(r.speaking === true && { speaking: true as const }),
});
