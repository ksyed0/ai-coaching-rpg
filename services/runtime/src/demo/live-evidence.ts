import type { SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import { collectRunSummary, type AlertEvidence, type CharacterEvidence } from "../run-summary/index.js";

/**
 * US-0023: what a run of the 29-check main story can say about the AI characters' replies and the facilitator alerts, read from the
 * facilitator's complete event stream. Shown in the narration, in check F-08's evidence and in the JSON report (`liveEvidence`).
 * The counting and the sanitising live in `../run-summary` (shared with the control service); this file adds only the demo's
 * `--max-fallbacks` limit, its warning and the narration line.
 */
export type LiveEvidence = {
  npcReplies: number;
  fallbackReplies: number;
  /** The --max-fallbacks limit; null when none was given (the count is then only a warning). */
  maxFallbacks: number | null;
  byCharacter: CharacterEvidence[];
  alerts: AlertEvidence[];
  /** Problems that do not fail the run: fallback lines without a --max-fallbacks limit. */
  warnings: string[];
};

/** The run summary plus the demo's limit and warning. */
export function collectLiveEvidence(events: SessionEvent[], scenario: Scenario, o: { maxFallbacks: number | null; secrets: readonly string[]; hidden?: readonly string[]; legacy?: boolean }): LiveEvidence {
  const { npcReplies, fallbackReplies, byCharacter, alerts } = collectRunSummary(events, scenario, o);
  const warnings = fallbackReplies > 0 && o.maxFallbacks === null
    ? [`${fallbackReplies} of ${npcReplies} AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)`] : [];
  return { npcReplies, fallbackReplies, maxFallbacks: o.maxFallbacks, byCharacter, alerts, warnings };
}

/** One line for the narration and for check F-08: "4 AI replies, 1 canned fallback line". */
export function countText(ev: Pick<LiveEvidence, "npcReplies" | "fallbackReplies">): string {
  return `${ev.fallbackReplies} canned fallback line${ev.fallbackReplies === 1 ? "" : "s"} of ${ev.npcReplies} AI replies`;
}
