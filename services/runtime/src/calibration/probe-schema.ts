import { z } from "zod";
import { isFileSafeId, isScenarioId } from "@acr/events";

export type Level = 1 | 2 | 3 | 4;
export type Expected = Level | "not_observed";

export const LevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const ExpectedSchema = z.union([LevelSchema, z.literal("not_observed")]);

const idMessage = (max: number): string => `must be 1 to ${max} characters of lower-case letters, digits, '_' or '-'`;
const FileId = z.string().refine(isFileSafeId, idMessage(64));
/** The probe id becomes the session id probe-<id>, which is capped at 64 characters. */
export const MAX_PROBE_ID = 58;
const ProbeId = z.string().max(MAX_PROBE_ID, `must be at most ${MAX_PROBE_ID} characters (it becomes the session id probe-<id>)`).refine(isFileSafeId, idMessage(MAX_PROBE_ID));
const RoleId = z.string().max(64).refine(isScenarioId, "must be a scenario id");

/**
 * Code points a transcript line may never contain ("Trojan Source"): C0 controls except TAB and LF, DEL and the C1 controls, the Arabic
 * letter mark, zero-width characters and direction marks, the line and paragraph separators and bidi embeddings and overrides, the bidi
 * isolates and the zero-width no-break space. They would make the text an owner reviews differ from the text the judges read.
 */
export function isHiddenControl(c: number): boolean {
  return (c <= 0x08) || (c >= 0x0b && c <= 0x1f) || (c >= 0x7f && c <= 0x9f) || c === 0x061c || (c >= 0x200b && c <= 0x200f)
    || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}
export const HIDDEN_CONTROL_MESSAGE = "a transcript line contains hidden or bidirectional control characters";
export function hasHiddenControl(s: string): boolean {
  for (const ch of s) if (isHiddenControl(ch.codePointAt(0)!)) return true;
  return false;
}
const LineText = z.string().min(1).max(2000).refine((t) => !hasHiddenControl(t), HIDDEN_CONTROL_MESSAGE);

export const LineSchema = z.object({ scene: RoleId, role: RoleId, text: LineText }).strict();

const common = {
  id: ProbeId,
  criterion: FileId,
  source: z.enum(["handwritten", "drafted", "excerpt"]),
  drafter: z.string().min(1).max(200).nullable().default(null),
  approved_by: z.string().min(1).max(120).nullable().default(null),
  /** An ISO-8601 datetime (the `...Z` form of new Date().toISOString(), or with an offset); handwritten probes keep null. */
  approved_at: z.string().max(40).datetime({ offset: true }).nullable().default(null),
  split: z.enum(["tune", "holdout"]),
  transcript: z.array(LineSchema).min(2).max(80),
};

export const SingleProbeSchema = z
  .object({
    kind: z.literal("single"), ...common,
    subject: RoleId, expected: ExpectedSchema,
    acceptable: z.array(ExpectedSchema).min(1).max(5).optional(),
  })
  .strict();

export const ContrastProbeSchema = z
  .object({
    kind: z.literal("contrast"), ...common,
    players: z.record(RoleId, LevelSchema),
    min_gap: z.number().int().min(1).max(3),
  })
  .strict();

export const ProbeSchema = z.discriminatedUnion("kind", [SingleProbeSchema, ContrastProbeSchema]).superRefine((p, ctx) => {
  if (p.source === "drafted" && (p.drafter === null || p.approved_by === null || p.approved_at === null)) {
    ctx.addIssue({ code: "custom", message: "a drafted probe needs drafter, approved_by and approved_at" });
  }
  if (p.source === "excerpt") {
    if (p.approved_by === null || p.approved_at === null) ctx.addIssue({ code: "custom", message: "an excerpt probe needs approved_by and approved_at (a human assigned its level)" });
    if (p.drafter !== null) ctx.addIssue({ code: "custom", message: "an excerpt probe has no drafter (it is a real excerpt, not model-drafted)" });
  }
  if (p.kind === "single" && p.acceptable !== undefined && !p.acceptable.includes(p.expected)) {
    ctx.addIssue({ code: "custom", message: "acceptable must include expected" });
  }
  if (p.kind === "contrast") {
    const levels = Object.values(p.players);
    if (levels.length < 2 || new Set(levels).size < 2) {
      ctx.addIssue({ code: "custom", message: "a contrast probe needs at least two players with at least two distinct expected levels" });
    } else {
      const distinct = [...new Set(levels)].sort((a, b) => a - b);
      let smallest = Infinity;
      for (let i = 1; i < distinct.length; i++) smallest = Math.min(smallest, distinct[i]! - distinct[i - 1]!);
      if (p.min_gap > smallest) {
        ctx.addIssue({ code: "custom", message: `min_gap ${p.min_gap} exceeds the smallest difference between two distinct expected levels (${smallest}), so the probe could never pass` });
      }
    }
  }
});

export type SingleProbe = z.infer<typeof SingleProbeSchema>;
export type ContrastProbe = z.infer<typeof ContrastProbeSchema>;
export type Probe = SingleProbe | ContrastProbe;

/** The levels a single probe accepts; the spec defaults this to [expected]. */
export function acceptableOf(p: SingleProbe): Expected[] {
  return p.acceptable ?? [p.expected];
}

/** Roles whose scores the probe checks. */
export function scoredRoles(p: Probe): string[] {
  return p.kind === "single" ? [p.subject] : Object.keys(p.players);
}
