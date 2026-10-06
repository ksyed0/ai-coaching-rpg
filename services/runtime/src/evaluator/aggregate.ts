import { LEVEL_LABELS } from "@acr/script";

/** A criterion score: a whole proficiency level 1 to 4, or null for "Not observed" (no evidence either way). */
export type Score = 1 | 2 | 3 | 4;
export type Confidence = "high" | "medium" | "low";
export const NOT_OBSERVED = "Not observed";
/** A criterion whose evaluator answer was unusable even after the re-ask (an omitted criterion, or a score that is not a whole number 1 to 4). It is NOT "Not observed". */
export const INVALID = "invalid" as const;
export const INVALID_LABEL = "Invalid (evaluator error)";
export const INCOMPLETE_LABEL = "Incomplete (evaluator error)";
export type CriterionScore = Score | null | typeof INVALID;

export const LO_THRESHOLDS = { developing: 1.5, proficient: 2.5, advanced: 3.5 } as const;

export function isScore(v: unknown): v is Score { return v === 1 || v === 2 || v === 3 || v === 4; }

export function levelLabel(score: Score | null): string { return score === null ? NOT_OBSERVED : LEVEL_LABELS[score]; }

/** Rounds to one decimal, half away from zero, without binary-float surprises (2.45 is 2.5). */
export function round1(x: number): number { return Math.round((x + Number.EPSILON) * 10) / 10; }

/** The label of a learning-objective score (the ROUNDED value is labelled, so the number and the label shown always agree): below 1.5 Not yet demonstrated, below 2.5 Developing, below 3.5 Proficient, else Advanced. */
export function loLabel(score: number | null): string {
  if (score === null) return NOT_OBSERVED;
  if (score < LO_THRESHOLDS.developing) return LEVEL_LABELS[1];
  if (score < LO_THRESHOLDS.proficient) return LEVEL_LABELS[2];
  if (score < LO_THRESHOLDS.advanced) return LEVEL_LABELS[3];
  return LEVEL_LABELS[4];
}

/** The mean of the observed (non-null) scores rounded to one decimal; null when none was observed. */
export function loScore(scores: (Score | null)[]): number | null {
  const seen = scores.filter((s): s is Score => s !== null);
  if (seen.length === 0) return null;
  return round1(seen.reduce((a, b) => a + b, 0) / seen.length);
}

const ORDER: Confidence[] = ["low", "medium", "high"];
const rank = (c: Confidence): number => ORDER.indexOf(c);

/** Confidence from the evidence alone: 3 or more verified quotes High, 2 Medium, fewer Low. */
export function confidenceFromEvidence(verifiedQuotes: number): Confidence {
  return verifiedQuotes >= 3 ? "high" : verifiedQuotes === 2 ? "medium" : "low";
}

/**
 * The confidence shown: the lower of what the quotes support and what the model said (a missing or unusable statement counts as
 * Medium, so the model can lower a confidence but never raise it above the evidence). A capped score is always Low.
 */
export function deriveConfidence(verifiedQuotes: number, stated: Confidence | null | undefined, capped = false): Confidence {
  if (capped) return "low";
  const fromEvidence = confidenceFromEvidence(verifiedQuotes);
  const fromModel: Confidence = stated ?? "medium";
  return ORDER[Math.min(rank(fromEvidence), rank(fromModel))]!;
}

export function parseConfidence(v: unknown): Confidence | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return t === "high" || t === "medium" || t === "low" ? t : null;
}

export type LoInput = { id: string; statement: string; rubric_criteria: string[] };
export type LoResult = {
  id: string; statement: string; score: number | null; label: string;
  /** The mapped criteria that are in scope for this result (individual criteria for a participant, group criteria for the team). */
  criteria: string[]; observed: string[];
  /** True when at least one mapped criterion was invalid (an evaluator error): the score is a mean of the rest, not of all. */
  incomplete: boolean;
};

/**
 * Learning-objective results from criterion scores (by criterion id). Not a single overall grade: one result per objective. Only criteria
 * present in `scores` count (those in scope for the participant or the team). Invalid criteria are left out of the mean and mark the
 * objective incomplete; they are never treated as Not observed. Pure.
 */
export function aggregateObjectives(objectives: LoInput[], scores: ReadonlyMap<string, CriterionScore> | Record<string, CriterionScore>): LoResult[] {
  const get = (id: string): CriterionScore | undefined => (scores instanceof Map ? scores.get(id) : (scores as Record<string, CriterionScore>)[id]);
  return objectives.map((lo) => {
    const mapped = lo.rubric_criteria.filter((id) => get(id) !== undefined);
    const incomplete = mapped.some((id) => get(id) === INVALID);
    const observed = mapped.filter((id) => isScore(get(id)));
    const score = loScore(observed.map((id) => get(id) as Score));
    return { id: lo.id, statement: lo.statement, score, label: score === null && incomplete ? INCOMPLETE_LABEL : loLabel(score), criteria: mapped, observed, incomplete };
  });
}
