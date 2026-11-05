import type { Expected, Level } from "./probe-schema.js";

/** What the judge produced for one scored role in one run. "invalid" and "failed" are unusable results, never scores. */
export type Observed = 1 | 2 | 3 | 4 | "not_observed" | "invalid" | "failed";
export type Evidence = { role: string; rationale: string; quotes: string[] };

type OutcomeBase = {
  probeId: string; criterion: string; split: "tune" | "holdout"; source: "handwritten" | "drafted" | "excerpt"; drafter: string | null;
  /** Scores the evaluator lowered because no quote survived verification, summed over runs. */
  capped: number;
  /** Quotes the evaluator threw away as not verbatim, summed over runs. */
  dropped: number;
  /** Rationale and quotes from the first run, one entry per scored role. */
  evidence: Evidence[];
};
export type SingleOutcome = OutcomeBase & { kind: "single"; subject: string; expected: Expected; acceptable: Expected[]; runs: Observed[] };
export type ContrastOutcome = OutcomeBase & { kind: "contrast"; expected: Record<string, Level>; minGap: number; runs: Record<string, Observed>[] };
export type Outcome = SingleOutcome | ContrastOutcome;
