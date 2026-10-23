export const REVIEW_SCHEMA = "acr.review/1";
export const VIEW_SCHEMA = "acr.view/1";
export const POLICY_VERSION = 1;
export const GROUP = "group";
export const ZERO_HASH = "0".repeat(64);
export const REVIEW_FILE = "review.jsonl";
export const LIMITS = {
  reason: 500,
  text: 1500,
  item: 400,
  events: 10_000,
  logBytes: 16 * 1024 * 1024,
} as const;

/** A criterion level: 1 to 4, or null for Not observed. */
export type Level = 1 | 2 | 3 | 4 | null;
/** What a criterion currently holds: a level, Not observed, or an evaluator error. */
export type CurrentLevel = Level | "invalid";
export type Actor =
  | { kind: "facilitator"; by: string }
  | { kind: "participant"; role: string; attestedBy: string }
  | { kind: "system" };
export type Visibility = "internal" | "feedback";
export type Outcome = "upheld" | "amended" | "declined";
export type Summary = {
  strengths: string[];
  development_points: string[];
  next_actions: { lo: string; action: string }[];
};

export type Body =
  | {
      type: "review.opened";
      schema: typeof REVIEW_SCHEMA;
      policyVersion: number;
      legacy: boolean;
      session: { id: string; logSha256: string | null; startedAt: string };
      scenario: { id: string; sha256: string | null };
      rubricHash: string | null;
      files: Record<string, string>;
      codes: Record<string, unknown> | null;
    }
  | {
      type: "score.edited";
      subject: string;
      criterion: string;
      from: CurrentLevel;
      to: Level;
      reason: string;
    }
  | {
      type: "rationale.edited";
      subject: string;
      criterion: string;
      fromHash: string;
      text: string;
      reason: string;
    }
  | {
      type: "summary.edited";
      subject: string;
      summary: Summary;
      reason: string;
    }
  | { type: "summary.accepted"; subject: string }
  | { type: "score.accepted"; subject: string; criterion: string }
  | {
      type: "comment.added";
      subject: string;
      criterion?: string;
      text: string;
      visibility: Visibility;
    }
  | { type: "report.released"; subjects: string[] }
  | { type: "report.amended"; subject: string; reason: string; basedOn: number }
  | { type: "report.withdrawn"; subject: string; reason: string }
  | {
      type: "report.exported";
      subject: string;
      version: number;
      principal: string;
      destination: string;
    }
  | {
      type: "self.rated";
      role: string;
      criterion: string;
      level: Level;
      note?: string;
    }
  | {
      type: "response.added";
      role: string;
      criterion?: string;
      text: string;
      dispute?: boolean;
    }
  | {
      type: "dispute.resolved";
      response: number;
      outcome: Outcome;
      reason: string;
    }
  | { type: "review.superseded"; by: string };

/** A body plus who did it, before the log assigns seq, ts and prev. `carriedFrom` marks moderation copied from a superseded review. */
export type Entry = { actor: Actor; body: Body; carriedFrom?: string };
export type ReviewEvent = {
  seq: number;
  ts: number;
  prev: string;
  actor: Actor;
  carriedFrom?: string;
} & Body;
export type EventType = Body["type"];
