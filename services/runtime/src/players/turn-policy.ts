/** The timing and cap settings of one live AI player's turns (the policy class itself comes with the bot). */
export type TurnSettings = { minGapMs: number; nudgeMs: number; linesPerScene: number; settleMs: number };
export const DEFAULT_TURN_SETTINGS: TurnSettings = { minGapMs: 15_000, nudgeMs: 90_000, linesPerScene: 10, settleMs: 6_000 };
/** What made the AI player speak: a reply to a line, a nudge after a quiet spell, or the facilitator's prompt. */
export type Trigger = "reply" | "nudge" | "prompt";
