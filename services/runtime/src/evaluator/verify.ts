import { stat } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "@acr/events";
import { readTextCapped, type Scenario } from "@acr/script";
import { isFileSafeId } from "@acr/events";
import { aiOptionOf, aiRolesOf } from "./ai-players.js";
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
  const aiFound = aiRolesOf(events, scenario);
  const option = aiOptionOf(events);
  if (aiFound === "invalid") problems.push("the log's session.started.aiRoles is not a list of distinct player roles");
  if (option === "invalid") problems.push("the log's session.started.includeInGroup is not true or false");
  if (aiFound === "invalid" || option === "invalid") return { problems, reports, quotes, scores };
  const aiRoles = aiFound;
  const players = Object.values(scenario.roles).filter((r) => r.type === "player" && !aiRoles.includes(r.id)).map((r) => r.id);
  const aiCounts = aiRoles.length > 0 && option === true;
  /** A group quote or notable moment of a line: npc lines are never team evidence; an AI player's only when the option is on, and then only with the label. */
  const groupLine = (what: string, seq: number, ai: boolean | undefined): void => {
    const u = t.utterances.get(seq);
    if (!u) return;
    if (u.speaker === "npc") problems.push(`group: ${what} quotes line #${seq}, which is not a player's`);
    else if (u.speaker === "ai_player") {
      if (!aiCounts) problems.push(`group: ${what} quotes AI player line #${seq} although AI players were not included in group scores`);
      else if (ai !== true) problems.push(`group: ${what} quotes AI player line #${seq} without the AI label`);
    }
  };
  const read = async (name: string): Promise<string | null> => { try { return await readTextCapped(path.join(dir, name), 8 * 1024 * 1024); } catch { problems.push(`${name} is missing`); return null; } };
  for (const name of [...players, "group"]) {
    const md = await read(`${name}.md`);
    const raw = await read(`${name}.json`);
    if (md === null || raw === null) continue;
    reports++;
    if (!md.includes("## How this was scored")) problems.push(`${name}.md has no method section`);
    if (!md.includes(VISIBILITY_LINE)) problems.push(`${name}.md has no visibility line`);
    let json: { schema?: string; criteria?: { id: string; score: number | null; evidence: { seq: number; quote: string; role: string; ai?: boolean }[] }[]; learning_objectives?: { id: string; score: number | null }[]; notable_moments?: { seq: number; ai?: boolean }[]; method?: { sections?: unknown[] }; visibility?: string };
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
        else if (name === "group") groupLine(c.id, e.seq, e.ai);
      }
      if (c.score !== null && c.evidence.length === 0 && c.score >= 3) problems.push(`${name}: criterion ${c.id} has a score of ${c.score} and no evidence`);
    }
    if (name === "group") for (const m of json.notable_moments ?? []) groupLine("notable moment", m.seq, m.ai);
    for (const lo of json.learning_objectives ?? []) if (!inRange(lo.score)) problems.push(`${name}: ${lo.id} has the score ${String(lo.score)}`);
  }
  for (const r of aiRoles) {
    if (!isFileSafeId(r)) continue;
    for (const ext of ["md", "json"]) if (await stat(path.join(dir, `${r}.${ext}`)).then(() => true, () => false)) problems.push(`${r}.${ext} exists for an AI player`);
  }
  for (const n of ["index.md", "method.md"]) await read(n);
  return { problems, reports, quotes, scores };
}
