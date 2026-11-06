import type { ModerationCode } from "../review/errors.js";
import type { Level } from "../review/types.js";

export type { ModerationCode };

/** A closed result for the control service. `detail` holds subject ids only; no text from the review layer. */
export type ModResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ModerationCode; detail?: string[] };

/** What `pnpm moderate status` prints, per subject, as data. */
export type SubjectStatus = {
  id: string;
  state: "draft" | "released" | "amending" | "withdrawn";
  /** The latest released version (its event seq), or null when never released. */
  version: number | null;
  criteriaTotal: number;
  openCriteria: string[];
  summaryStale: boolean;
  tableStale: boolean;
  evaluationOk: boolean;
  /** Criteria release requires to be scored by hand (`scoreByHand`): accepting them does not unblock it. */
  scoreByHand: string[];
  selfRated: number;
  openDisputes: { seq: number; role: string; criterion: string | null }[];
};
export type ModerationStatus = {
  superseded: string | null;
  subjects: SubjectStatus[];
};

/** A criterion's level as the review holds it: 1 to 4, null (Not observed) or "invalid" (an evaluator error). */
export type CurrentDto = 1 | 2 | 3 | 4 | null | "invalid";

/** The facilitator's view of one subject, field by field from `viewReport`; every string is cleaned as `show` cleans a line. */
export type SubjectViewDto = {
  id: string;
  state: "draft" | "released" | "amending" | "withdrawn";
  criteria: {
    id: string;
    name: string;
    current: CurrentDto;
    /** "clear" is the review's name for a criterion that never needed review (the brief's list had only the other three). */
    status: "needs_review" | "accepted" | "edited" | "clear";
    rationale: string;
    evidence: { quote: string; scene?: string }[];
    flags: string[];
    /** The player's own blind self-rating; undefined when none (and always for the group). */
    selfLevel: Level | undefined;
  }[];
  summary: {
    strengths: string[];
    developments: string[];
    actions: { lo: string; text: string }[];
  };
  objectives: { id: string; label: string }[];
  comments: {
    visibility: "internal" | "feedback";
    text: string;
    criterion?: string;
  }[];
  responses: {
    seq: number;
    role: string;
    text: string;
    criterion?: string;
    dispute: boolean;
    resolution?: { outcome: string; reason: string };
  }[];
  versions: number[];
};

/** Every write: the review directory, the author (already a clean safe id, e.g. `priya-console`), the clock and the secrets to scrub. */
export type Base = {
  dir: string;
  by: string;
  now: () => number;
  secrets: string[];
};
export type ExpectLevel = "1" | "2" | "3" | "4" | "na" | "invalid";
