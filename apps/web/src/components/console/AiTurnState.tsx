"use client";

import { ACTIVITY_EXPIRY_MS, type ActivityEntry } from "../../lib/activity";

// US-0082: an AI player's turn state in the facilitator's AI players panel: Thinking, Waiting (for the conversation), or how its last turn
// ended without a line. An AI player's failed turn is SKIPPED (never a canned line), so the words say "turn skipped". Text, never colour alone.

export const AI_TURN_LABELS = {
  thinking: "Thinking…",
  waiting: "Waiting",
  timed_out: "Timed out (turn skipped)",
  failed: "No usable reply (turn skipped)",
} as const;

/** The label for a role's latest report (none yet, or a stale "thinking", reads Waiting). */
export function aiTurnLabel(entry: ActivityEntry | undefined, now: number): string {
  if (entry === undefined) return AI_TURN_LABELS.waiting;
  if (entry.state === "thinking") return now - entry.at < ACTIVITY_EXPIRY_MS ? AI_TURN_LABELS.thinking : AI_TURN_LABELS.waiting;
  return entry.outcome !== undefined ? AI_TURN_LABELS[entry.outcome] : AI_TURN_LABELS.waiting;
}

export function AiTurnState({ entry, now = Date.now }: { entry: ActivityEntry | undefined; now?: () => number }) {
  const text = aiTurnLabel(entry, now());
  const warn = entry?.state === "idle" && entry.outcome !== undefined;
  return <span className={warn ? "pill warn" : "pill mut"} aria-label={`Turn: ${text}`}>{text}</span>;
}
