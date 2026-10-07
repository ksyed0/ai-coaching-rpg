import { z } from "zod";
import { SAFE_ID_MAX_CHARS, SCENARIO_ID_MESSAGE, SCENARIO_ID_PATTERN } from "@acr/events";

/** The scale: four proficiency levels, no midpoint (avoids central tendency). A criterion with no evidence either way is "Not observed" (no score). */
export const LEVEL_LABELS = { 1: "Not yet demonstrated", 2: "Developing", 3: "Proficient", 4: "Advanced" } as const;
export type Level = keyof typeof LEVEL_LABELS;
export const LEVELS: readonly Level[] = [1, 2, 3, 4];

const Id = z.string().regex(SCENARIO_ID_PATTERN, SCENARIO_ID_MESSAGE).max(SAFE_ID_MAX_CHARS);
const Text = (max: number) => z.string().trim().min(1, "must not be blank").max(max);

/** The behavioural anchor of one level, written as observable behaviour; example phrases are required at levels 2 and 4. */
export const LevelAnchorSchema = z.object({ anchor: Text(800), examples: z.array(Text(300)).max(6).default([]) });

export const CriterionSchema = z.object({
  id: Id,
  name: Text(120),
  description: Text(600),
  /** Observable indicators the evaluator looks for in the transcript. */
  what_to_look_for: z.array(Text(300)).min(1).max(12),
  levels: z.object({ 1: LevelAnchorSchema, 2: LevelAnchorSchema, 3: LevelAnchorSchema, 4: LevelAnchorSchema }),
});

export const RubricSchema = z.object({
  id: Id,
  name: Text(120),
  /** `individual`: scored per player role. `group`: scored once for the whole team. */
  scope: z.enum(["individual", "group"]),
  version: z.union([z.string(), z.number()]).transform(String),
  description: z.string().max(1000).default(""),
  criteria: z.array(CriterionSchema).min(1).max(30),
});

export type LevelAnchor = z.infer<typeof LevelAnchorSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
export type Rubric = z.infer<typeof RubricSchema>;

export type RubricCheck = { errors: string[]; warnings: string[] };

/** Cross-checks a set of loaded rubrics with the scenario's learning objectives. Pure. */
export function validateRubrics(rubrics: Rubric[], objectives: { id: string; rubric_criteria: string[] }[]): RubricCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const owner = new Map<string, string>();
  for (const r of rubrics) {
    const seenHere = new Set<string>();
    for (const c of r.criteria) {
      if (seenHere.has(c.id)) errors.push(`criterion id '${c.id}' is defined more than once in ${r.id}`);
      else if (owner.has(c.id)) errors.push(`criterion id '${c.id}' is used by both ${owner.get(c.id)} and ${r.id}`);
      seenHere.add(c.id);
      if (!owner.has(c.id)) owner.set(c.id, r.id);
      for (const l of [2, 4] as const) {
        if (c.levels[l].examples.length === 0) errors.push(`${r.id}: criterion '${c.id}' level ${l} needs at least one example phrase`);
      }
    }
  }
  for (const lo of objectives) {
    for (const id of lo.rubric_criteria) {
      if (!owner.has(id)) errors.push(`learning objective ${lo.id} maps to criterion '${id}', which no loaded rubric defines`);
    }
  }
  return { errors, warnings };
}
