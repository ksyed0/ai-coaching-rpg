import { describe, expect, it } from "vitest";
import type { Transcript } from "@acr/adapters";
import { GATE_AVG_LOGPROB, GATE_MIN_RMS_DBFS, GATE_NO_SPEECH_PROB, GATE_SHORT_MS, gate } from "../noise-gate.js";

const t = (text: string, extra: Partial<Transcript> = {}): Transcript => ({ text, durationMs: 120, ...extra });
const seg = (speechMs = 1200, meanDbfs = -25) => ({ speechMs, meanDbfs });
const good = { noSpeechProb: 0.05, avgLogprob: -0.2 };

describe("noise gate (US-0070, spec 7.2): signal tests, never a phrase list", () => {
  it("uses the constants of the overview (whisper-server's own thresholds)", () => {
    expect([GATE_MIN_RMS_DBFS, GATE_NO_SPEECH_PROB, GATE_AVG_LOGPROB, GATE_SHORT_MS]).toEqual([-50, 0.6, -1.0, 400]);
  });

  it("blank text is empty", () => {
    for (const text of ["", "   ", "\n\t "]) expect(gate(seg(), t(text, good))).toEqual({ keep: false, reason: "empty" });
  });

  it("energy below -50 dBFS is low_energy (and blank text wins over it)", () => {
    expect(gate(seg(1200, -50.1), t("We can ship in May.", good))).toEqual({ keep: false, reason: "low_energy" });
    expect(gate(seg(1200, -50), t("We can ship in May.", good))).toEqual({ keep: true });
    expect(gate(seg(1200, Number.NEGATIVE_INFINITY), t("", good))).toEqual({ keep: false, reason: "empty" });
  });

  it("a no-speech score above 0.6 is no_speech", () => {
    expect(gate(seg(), t("We can ship in May.", { ...good, noSpeechProb: 0.61 }))).toEqual({ keep: false, reason: "no_speech" });
    expect(gate(seg(), t("We can ship in May.", { ...good, noSpeechProb: 0.6 }))).toEqual({ keep: true });
  });

  it("an average log-probability below -1.0 is low_confidence", () => {
    expect(gate(seg(), t("We can ship in May.", { ...good, avgLogprob: -1.01 }))).toEqual({ keep: false, reason: "low_confidence" });
    expect(gate(seg(), t("We can ship in May.", { ...good, avgLogprob: -1.0 }))).toEqual({ keep: true });
  });

  it("a very short segment is dropped when its scores are only borderline", () => {
    expect(gate(seg(380), t("Yes.", { noSpeechProb: 0.31, avgLogprob: -0.2 }))).toEqual({ keep: false, reason: "no_speech" });
    expect(gate(seg(380), t("Yes.", { noSpeechProb: 0.05, avgLogprob: -0.71 }))).toEqual({ keep: false, reason: "low_confidence" });
    // The same borderline scores on a segment of 400 ms or more are kept.
    expect(gate(seg(400), t("Yes.", { noSpeechProb: 0.31, avgLogprob: -0.71 }))).toEqual({ keep: true });
  });

  it('"Thank you." with good scores is kept (no blocklist)', () => {
    for (const text of ["Thank you.", "Thanks for watching!", "you", "Bye."]) expect(gate(seg(), t(text, good)), text).toEqual({ keep: true });
  });

  it("a short segment with good scores is kept", () => {
    expect(gate(seg(320), t("No.", good))).toEqual({ keep: true });
  });

  it("absent scores: only empty and energy apply", () => {
    expect(gate(seg(320), t("Thank you."))).toEqual({ keep: true });
    expect(gate(seg(320), t(""))).toEqual({ keep: false, reason: "empty" });
    expect(gate(seg(320, -60), t("Thank you."))).toEqual({ keep: false, reason: "low_energy" });
    // One score present, the other absent: only the present one is judged.
    expect(gate(seg(), t("Thank you.", { noSpeechProb: 0.9 }))).toEqual({ keep: false, reason: "no_speech" });
    expect(gate(seg(), t("Thank you.", { avgLogprob: -0.1 }))).toEqual({ keep: true });
  });

  it("a non-finite score counts as absent", () => {
    expect(gate(seg(), t("Thank you.", { noSpeechProb: Number.NaN, avgLogprob: Number.NEGATIVE_INFINITY }))).toEqual({ keep: true });
  });
});
