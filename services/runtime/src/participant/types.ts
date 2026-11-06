import type { Level } from "../review/types.js";

/** The generic level scale (`buildMethod().scale`): the same for every criterion, never the evaluator's label for a score. */
export type Scale = { level: number; label: string; meaning: string }[];

/**
 * The blind self-assessment form. `closed` is a released or amending report, or a draft closed by `selfClosed`;
 * `withdrawn` is separate so control can read it as `not_released`. No result carries a path, an id or a message.
 */
export type FormResult =
  | {
      kind: "form";
      criteria: { id: string; name: string }[];
      scale: Scale;
      existing: Record<string, { level: Level; note?: string }>;
    }
  | {
      kind: "closed" | "withdrawn" | "old_schema" | "none" | "unavailable";
    };

export type ProgressRow = { role: string; rated: number; total: number };
export type ProgressResult =
  { kind: "ok"; rows: ProgressRow[] } | { kind: "none" | "unavailable" };
