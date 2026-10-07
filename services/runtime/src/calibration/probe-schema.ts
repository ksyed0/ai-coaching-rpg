import { z } from "zod";
import { isFileSafeId, isScenarioId } from "@acr/events";

export type Level = 1 | 2 | 3 | 4;
export type Expected = Level | "not_observed";

export const LevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const ExpectedSchema = z.union([LevelSchema, z.literal("not_observed")]);

const FileId = z.string().refine(isFileSafeId, "must be 1 to 64 characters of lower-case letters, digits, '_' or '-'");
const RoleId = z.string().max(64).refine(isScenarioId, "must be a scenario id");

export const LineSchema = z.object({ scene: RoleId, role: RoleId, text: z.string().min(1).max(2000) }).strict();

const common = {
  id: FileId,
  criterion: FileId,
  source: z.enum(["handwritten", "drafted", "excerpt"]),
  drafter: z.string().min(1).max(200).nullable().default(null),
  approved_by: z.string().min(1).max(120).nullable().default(null),
  approved_at: z.string().min(1).max(40).nullable().default(null),
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
  if (p.kind === "single" && p.acceptable !== undefined && !p.acceptable.includes(p.expected)) {
    ctx.addIssue({ code: "custom", message: "acceptable must include expected" });
  }
  if (p.kind === "contrast") {
    const levels = Object.values(p.players);
    if (levels.length < 2 || new Set(levels).size < 2) {
      ctx.addIssue({ code: "custom", message: "a contrast probe needs at least two players with at least two distinct expected levels" });
    }
  }
});

export type SingleProbe = z.infer<typeof SingleProbeSchema>;
export type ContrastProbe = z.infer<typeof ContrastProbeSchema>;
export type Probe = SingleProbe | ContrastProbe;

/** Roles whose scores the probe checks. */
export function scoredRoles(p: Probe): string[] {
  return p.kind === "single" ? [p.subject] : Object.keys(p.players);
}
