import type { Transcript } from "@acr/adapters";

/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.2): the phantom-text gate. Whisper can invent text from silence or noise; a segment is dropped on
 * a SIGNAL test only, never on its words ("Thank you." is a common real line, so there is no phrase list). The scores are used only when
 * the server reported them as finite numbers (whisper-server's verbose_json; F1 of the overview is unconfirmed until the live check), so
 * without them only blank text and energy apply.
 */
export const GATE_MIN_RMS_DBFS = -50;
/** whisper-server's own `--no-speech-thold` default. */
export const GATE_NO_SPEECH_PROB = 0.6;
/** whisper-server's own `--logprob-thold` default. */
export const GATE_AVG_LOGPROB = -1.0;
/** Below this much speech a segment is "very short" and judged by the stricter scores below. */
export const GATE_SHORT_MS = 400;
const SHORT_NO_SPEECH_PROB = 0.3;
const SHORT_AVG_LOGPROB = -0.7;

export type GateReason = "empty" | "low_energy" | "no_speech" | "low_confidence";
export type GateResult = { keep: true } | { keep: false; reason: GateReason };

const finite = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Rules in order: blank text, energy, no-speech score, confidence, then the very-short rule. */
export function gate(seg: { speechMs: number; meanDbfs: number }, t: Transcript): GateResult {
  if (t.text.trim() === "") return { keep: false, reason: "empty" };
  if (!(seg.meanDbfs >= GATE_MIN_RMS_DBFS)) return { keep: false, reason: "low_energy" };
  const noSpeech = finite(t.noSpeechProb) ? t.noSpeechProb : undefined;
  const logprob = finite(t.avgLogprob) ? t.avgLogprob : undefined;
  if (noSpeech !== undefined && noSpeech > GATE_NO_SPEECH_PROB) return { keep: false, reason: "no_speech" };
  if (logprob !== undefined && logprob < GATE_AVG_LOGPROB) return { keep: false, reason: "low_confidence" };
  if (seg.speechMs < GATE_SHORT_MS) {
    if (noSpeech !== undefined && noSpeech > SHORT_NO_SPEECH_PROB) return { keep: false, reason: "no_speech" };
    if (logprob !== undefined && logprob < SHORT_AVG_LOGPROB) return { keep: false, reason: "low_confidence" };
  }
  return { keep: true };
}
