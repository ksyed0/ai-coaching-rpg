import type { VoiceRefusal } from "../protocol.js";
import type { IndexEntry } from "./index-file.js";

/** How a held segment ended (US-0073 A2a): the runtime's answer, a worker-side no-text outcome, or no answer in time. */
export type SegmentOutcome =
  | { kind: "accepted" }
  | { kind: "refused"; code: VoiceRefusal }
  | { kind: "no_text"; status: "empty" | "stt_failed" }
  | { kind: "timeout" };

export type Decision = { keep: true; status: IndexEntry["status"] } | { keep: false };

/**
 * The refusals whose audio is kept (review C2): timing refusals, where consent was shown. An ALLOWLIST: every other code, including
 * `failed` (control's own timeout and a runtime exit), `ended`, `not_started`, the consent and seat class, and any code added later, is dropped.
 */
const KEPT_REFUSALS: ReadonlySet<string> = new Set<VoiceRefusal>(["paused", "not_in_scene"]);

/** Decides whether a segment's audio may reach the disk, and its index status. Anything unrecognised is `keep: false`. */
export function decide(outcome: SegmentOutcome): Decision {
  switch (outcome.kind) {
    case "accepted": return { keep: true, status: "transcribed" };
    case "no_text": return outcome.status === "empty" || outcome.status === "stt_failed" ? { keep: true, status: outcome.status } : { keep: false };
    case "refused": return typeof outcome.code === "string" && KEPT_REFUSALS.has(outcome.code) ? { keep: true, status: `refused:${outcome.code}` } : { keep: false };
    default: return { keep: false }; // "timeout" and anything unknown
  }
}
