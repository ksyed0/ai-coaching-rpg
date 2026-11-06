// Pairs the evaluator's level with the participant's own rating, per criterion, from the structured released report.
// The input is untrusted JSON: anything off yields fewer rows (or none), never an error.

export type ComparisonRow = { criterion: string; evaluator: string; yours: string; note?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function comparisonRows(own: unknown): ComparisonRow[] {
  if (!isObj(own) || !Array.isArray(own.criteria)) return [];
  const self = isObj(own.self) ? own.self : {};
  const rows: ComparisonRow[] = [];
  for (const c of own.criteria) {
    if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string") continue;
    const mine = Object.hasOwn(self, c.id) ? self[c.id] : undefined;
    const label = isObj(mine) && typeof mine.label === "string" && mine.label !== "" ? mine.label : "Not rated";
    const note = isObj(mine) && typeof mine.note === "string" && mine.note !== "" ? mine.note : undefined;
    rows.push({
      criterion: c.name,
      evaluator: typeof c.level_label === "string" ? c.level_label : "",
      yours: label,
      ...(note !== undefined ? { note } : {}),
    });
  }
  return rows;
}
