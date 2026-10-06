import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import { VISIBILITY_LINE } from "./method.js";
import { buildTranscript } from "./transcript.js";

export type VerifyResult = { problems: string[]; reports: number; quotes: number; scores: number };

const inRange = (n: unknown): boolean => n === null || (typeof n === "number" && n >= 1 && n <= 4);

/**
 * Checks the report files THEMSELVES, read back from disk (not the in-memory result): every player has a Markdown and a JSON report,
 * every quoted piece of evidence is a verbatim piece of an utterance in the recorded session (by that player for a personal report, by
 * any player for the group), the method section and the visibility line are present, and every score is 1 to 4 or Not observed.
 */
export async function verifyReportFiles(dir: string, events: SessionEvent[], scenario: Scenario): Promise<VerifyResult> {
  const t = buildTranscript(events, scenario);
  const problems: string[] = [];
  let reports = 0; let quotes = 0; let scores = 0;
  const players = Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
  const read = async (name: string): Promise<string | null> => { try { return await readFile(path.join(dir, name), "utf8"); } catch { problems.push(`${name} is missing`); return null; } };
  for (const name of [...players, "group"]) {
    const md = await read(`${name}.md`);
    const raw = await read(`${name}.json`);
    if (md === null || raw === null) continue;
    reports++;
    if (!md.includes("## How this was scored")) problems.push(`${name}.md has no method section`);
    if (!md.includes(VISIBILITY_LINE)) problems.push(`${name}.md has no visibility line`);
    let json: { schema?: string; criteria?: { id: string; score: number | null; evidence: { seq: number; quote: string; role: string }[] }[]; learning_objectives?: { id: string; score: number | null }[]; method?: { sections?: unknown[] }; visibility?: string };
    try { json = JSON.parse(raw); } catch { problems.push(`${name}.json is not valid JSON`); continue; }
    if (json.schema !== "acr.report/1") problems.push(`${name}.json has schema ${JSON.stringify(json.schema)}`);
    if (!json.method?.sections?.length) problems.push(`${name}.json has no method`);
    if (json.visibility !== VISIBILITY_LINE) problems.push(`${name}.json has no visibility line`);
    for (const c of json.criteria ?? []) {
      scores++;
      if (!inRange(c.score) || (c.score !== null && !Number.isInteger(c.score))) problems.push(`${name}: criterion ${c.id} has the score ${String(c.score)}`);
      for (const e of c.evidence) {
        quotes++;
        const u = t.utterances.get(e.seq);
        if (!u) problems.push(`${name}: ${c.id} quotes line #${e.seq}, which is not an utterance in the session`);
        else if (!u.norm.includes(e.quote)) problems.push(`${name}: ${c.id} quote is not verbatim in line #${e.seq}`);
        else if (name !== "group" && u.roleId !== name) problems.push(`${name}: ${c.id} quotes line #${e.seq}, spoken by ${u.roleId}`);
        else if (name === "group" && u.speaker !== "player") problems.push(`group: ${c.id} quotes line #${e.seq}, which is not a player's`);
      }
      if (c.score !== null && c.evidence.length === 0 && c.score >= 3) problems.push(`${name}: criterion ${c.id} has a score of ${c.score} and no evidence`);
    }
    for (const lo of json.learning_objectives ?? []) if (!inRange(lo.score)) problems.push(`${name}: ${lo.id} has the score ${String(lo.score)}`);
  }
  for (const n of ["index.md", "method.md"]) await read(n);
  return { problems, reports, quotes, scores };
}
