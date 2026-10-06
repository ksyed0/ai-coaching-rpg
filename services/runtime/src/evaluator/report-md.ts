import { mdEscape, safeMd } from "../demo/transcript-md.js";
import { DRAFT_BANNER, VISIBILITY_LINE, methodMarkdown } from "./method.js";
import { loScoreText, scoreText, type GroupReport, type JsonCriterion, type ParticipantReport } from "./report-model.js";

const cap = (s: string) => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A validated id, or an escaped fragment: report text never carries an unchecked identifier. */
const id = (v: string, sec: string[]): string => (SAFE_ID.test(v) ? `\`${v}\`` : safeMd(v, 64, sec));

function header(title: string, r: ParticipantReport | GroupReport, sec: string[], extra: [string, string][]): string[] {
  const cell = (t: string) => safeMd(t, 200, sec);
  const out = [`# ${title}`, "", `> ${DRAFT_BANNER}`, "", VISIBILITY_LINE, "", "| Field | Value |", "| --- | --- |",
    `| Scenario | ${cell(r.scenario.title)} (${id(r.scenario.id, sec)}, version ${cell(r.scenario.version)}) |`,
    `| Session | ${id(r.session.id, sec)} |`, `| Date | ${cell(r.session.date)} |`];
  for (const [k, v] of extra) out.push(`| ${k} | ${v} |`);
  out.push(`| Evaluator | ${cell(r.evaluator.provider)}${r.evaluator.model ? `, model ${safeMd(r.evaluator.model, 100, sec)}` : ""} |`, `| Model calls | ${r.evaluator.model_calls} |`, "");
  for (const n of r.notes) out.push(`Note: ${safeMd(n, 600, sec)}`, "");
  return out;
}

function criteriaTable(cs: JsonCriterion[], sec: string[]): string[] {
  const out = ["| Criterion | Level | Confidence | Rationale |", "| --- | --- | --- | --- |"];
  for (const c of cs) {
    const flags = c.flags.length ? ` (${c.flags.map((f) => safeMd(f, 160, sec)).join("; ")})` : "";
    out.push(`| ${safeMd(c.name, 120, sec)} (${id(c.id, sec)}) | ${scoreText(c.score, c.level_label)} | ${c.confidence ? cap(c.confidence) : "-"} | ${safeMd(c.rationale, 600, sec) || "-"}${flags} |`);
  }
  return out;
}

function evidenceSection(cs: JsonCriterion[], sec: string[], showRole: boolean): string[] {
  const out = ["## Evidence", "", "Every quote below was checked by the program against the recorded session; times are measured from the start of the session.", ""];
  for (const c of cs) {
    out.push(`### ${safeMd(c.name, 120, sec)} (${id(c.id, sec)})`, "");
    if (c.evidence.length === 0) out.push("No verified quote.", "");
    else {
      for (const e of c.evidence) out.push(`- Scene ${e.scene}, ${e.time} (line #${e.seq}${showRole ? `, ${id(e.role, sec)}` : ""}): "${safeMd(e.quote, 320, sec)}"`);
      out.push("");
    }
  }
  return out;
}

function objectivesTable(los: ParticipantReport["learning_objectives"], sec: string[]): string[] {
  const out = ["| Learning objective | Statement | Score | Criteria used |", "| --- | --- | --- | --- |"];
  for (const o of los) out.push(`| ${id(o.id, sec)} | ${safeMd(o.statement, 300, sec)} | ${loScoreText(o.score, o.label)} | ${o.criteria.map((c) => id(c, sec)).join(", ")} (${o.observed.length} of ${o.criteria.length} observed) |`);
  return out;
}

const bullets = (items: string[], sec: string[], empty: string): string[] => (items.length ? [...items.map((i) => `- ${safeMd(i, 400, sec)}`), ""] : [empty, ""]);

/** The participant's report as Markdown. Pure; every model- or participant-written string goes through safeMd. */
export function renderParticipantMarkdown(r: ParticipantReport, secrets: string[] = []): string {
  const sec = secrets;
  const out = header(`Feedback report: ${r.participant.role}`, r, sec, [["Participant role", id(r.participant.role, sec)], ["Lines spoken", String(r.participant.utterances)]]);
  out.push("## Summary", "");
  if (r.evaluation.status !== "ok") out.push(`${safeMd(r.evaluation.reason ?? r.evaluation.status, 400, sec)}`, "");
  else {
    out.push("### Strengths", "", ...bullets(r.summary.strengths, sec, "None were drafted."));
    out.push("### Development points", "", ...bullets(r.summary.development_points, sec, "None were drafted."));
    out.push("### Next actions", "");
    if (r.summary.next_actions.length === 0) out.push("None were drafted.", "");
    else out.push(...r.summary.next_actions.map((a) => `- (${id(a.lo, sec)}) ${safeMd(a.action, 400, sec)}`), "");
  }
  out.push("## Learning objectives", "", ...objectivesTable(r.learning_objectives, sec), "");
  out.push("## Criteria", "", ...criteriaTable(r.criteria, sec), "");
  out.push(...evidenceSection(r.criteria, sec, false));
  out.push(...methodMarkdown(2));
  return `${out.join("\n")}\n`;
}

/** The group report as Markdown. */
export function renderGroupMarkdown(r: GroupReport, secrets: string[] = []): string {
  const sec = secrets;
  const out = header("Group report", r, sec, [["Players", r.lo_coverage.players.map((p) => id(p, sec)).join(", ")]]);
  out.push("## Group criteria", "");
  if (r.evaluation.status !== "ok") out.push(`${safeMd(r.evaluation.reason ?? r.evaluation.status, 400, sec)}`, "");
  out.push(...criteriaTable(r.criteria, sec), "");
  out.push("## Learning-objective coverage across the team", "");
  const players = r.lo_coverage.players;
  out.push(`| Learning objective | ${players.map((p) => id(p, sec)).join(" | ")} | Team (group criteria) |`, `| --- | ${players.map(() => "---").join(" | ")} | --- |`);
  for (const o of r.lo_coverage.objectives) {
    out.push(`| ${id(o.id, sec)}: ${safeMd(o.statement, 160, sec)} | ${players.map((p) => loScoreText(o.by_role[p]!.score, o.by_role[p]!.label)).join(" | ")} | ${loScoreText(o.team.score, o.team.label)} |`);
  }
  out.push("");
  out.push("## Talking points for the facilitator", "");
  if (r.talking_points.from_scenario) out.push("From the scenario author:", "", `- ${safeMd(r.talking_points.from_scenario, 800, sec)}`, "");
  out.push("Drafted from this session:", "", ...bullets(r.talking_points.from_evaluator, sec, "None were drafted."));
  out.push("## Notable moments", "");
  if (r.notable_moments.length === 0) out.push("None with a verified quote.", "");
  else for (const m of r.notable_moments) out.push(`- Scene ${m.scene}, ${m.time} (line #${m.seq}, ${id(m.role, sec)}): "${safeMd(m.quote, 320, sec)}"${m.note ? ` - ${safeMd(m.note, 300, sec)}` : ""}`);
  if (r.notable_moments.length) out.push("");
  out.push(...evidenceSection(r.criteria, sec, true));
  out.push(...methodMarkdown(2));
  return `${out.join("\n")}\n`;
}

export function renderMethodMarkdown(): string {
  return `${["# How scores are produced", "", DRAFT_BANNER, "", VISIBILITY_LINE, "", ...methodMarkdown(2)].join("\n")}\n`;
}

export { mdEscape };
