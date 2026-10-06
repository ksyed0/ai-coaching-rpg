import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { RubricSchema, validateRubrics, type Rubric } from "./rubric.js";

/** A rubric file is a few KiB; refuse anything absurd before parsing it (YAML aliases can expand). */
export const MAX_RUBRIC_BYTES = 256 * 1024;
/** Aliases are legitimate for repeated phrases but never need to be numerous. */
export const MAX_RUBRIC_ALIASES = 10;
const SAFE_ID = /^[a-z0-9_-]{1,64}$/;

export type LoadedRubrics = { rubrics: Rubric[]; errors: string[]; warnings: string[] };

/**
 * Resolves the scenario's `rubrics:` ids from `<dir>/rubrics/<id>.yaml`, validates each file and the set. Never throws for a content
 * problem: every problem is one line in `errors` (nothing is returned half-valid: a rubric with a problem is left out). An empty or
 * absent `rubrics:` is "no rubrics" with a warning.
 */
export async function loadRubrics(dir: string, scenario: { meta: { rubrics: string[]; learning_objectives: { id: string; rubric_criteria: string[] }[] } }): Promise<LoadedRubrics> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = scenario.meta.rubrics ?? [];
  if (ids.length === 0) return { rubrics: [], errors, warnings: ["the scenario names no rubrics, so there is nothing to score against"] };
  const rubrics: Rubric[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!SAFE_ID.test(id)) { errors.push(`rubric id '${id.slice(0, 40)}' is not a safe name (1 to 64 lowercase letters, digits, _ or -)`); continue; }
    if (seen.has(id)) { errors.push(`rubric '${id}' is listed more than once`); continue; }
    seen.add(id);
    const file = `rubrics/${id}.yaml`;
    const full = path.join(dir, "rubrics", `${id}.yaml`);
    let text: string;
    try {
      const size = (await stat(full)).size;
      if (size > MAX_RUBRIC_BYTES) { errors.push(`${file}: the file is larger than ${MAX_RUBRIC_BYTES / 1024} KiB`); continue; }
      text = await readFile(full, "utf8");
    } catch { errors.push(`${file}: the file cannot be read (the scenario names rubric '${id}')`); continue; }
    if (Buffer.byteLength(text, "utf8") > MAX_RUBRIC_BYTES) { errors.push(`${file}: the file is larger than ${MAX_RUBRIC_BYTES / 1024} KiB`); continue; }
    let raw: unknown;
    try { raw = parse(text, { maxAliasCount: MAX_RUBRIC_ALIASES }); }
    catch (err) { errors.push(`${file}: not valid YAML: ${(err as Error).message.split("\n")[0]}`); continue; }
    let rubric: Rubric;
    try { rubric = RubricSchema.parse(raw); }
    catch (err) {
      if (err instanceof ZodError) { const first = err.issues[0]!; errors.push(`${file}: ${first.path.join(".") || "(root)"} ${first.message}`); continue; }
      throw err;
    }
    if (rubric.id !== id) { errors.push(`${file}: the file's id '${rubric.id}' does not match the name '${id}' the scenario uses`); continue; }
    rubrics.push(rubric);
  }
  // When a rubric could not be loaded its criteria are unknown, so a learning-objective complaint would only add noise.
  const failedLoad = errors.length > 0;
  const check = validateRubrics(rubrics, failedLoad ? [] : scenario.meta.learning_objectives);
  errors.push(...check.errors);
  warnings.push(...check.warnings);
  return { rubrics, errors, warnings };
}
