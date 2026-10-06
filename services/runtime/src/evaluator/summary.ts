import type { EvaluationResult } from "./evaluate.js";
import { loScoreText } from "./report-model.js";

/** A short summary of one evaluation for the terminal: per participant the learning-objective results, then the team. Text is scrubbed by the caller. */
export function summaryLines(result: EvaluationResult): string[] {
  const lines: string[] = [];
  const objs = (os: { id: string; score: number | null; label: string }[]) => os.map((o) => `${o.id} ${loScoreText(o.score, o.label)}`).join("; ");
  for (const p of result.participants) lines.push(p.status === "ok" ? `${p.roleId}: ${objs(p.objectives)}` : `${p.roleId}: ${p.reason}`);
  const team = result.group.criteria.map((c) => `${c.name} ${c.score === null ? "N/O" : c.score}`).join("; ");
  lines.push(result.group.status === "ok" ? `team: ${team}` : `team: ${result.group.reason}`);
  lines.push(`model calls: ${result.modelCalls}`);
  return lines;
}
