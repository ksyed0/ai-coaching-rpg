import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidSessionId } from "../engine/event-log.js";
import { safeMd } from "../demo/transcript-md.js";
import { EvaluatorInputError, type EvaluationResult } from "./evaluate.js";
import { DRAFT_BANNER, VISIBILITY_LINE } from "./method.js";
import { buildMethod } from "./method.js";
import { id, renderGroupMarkdown, renderMethodMarkdown, renderParticipantMarkdown } from "./report-md.js";
import { DEMO_NOTE, buildGroupReport, buildParticipantReport, loScoreText, type EvaluatorInfo, type GroupReport, type ParticipantReport } from "./report-model.js";

const SAFE_ROLE = /^[a-z0-9_-]{1,64}$/;
/** File names the reports use themselves; a role with one of these ids would overwrite them. */
export const RESERVED_NAMES = new Set(["group", "index", "method"]);

export function checkRoleId(roleId: string): string {
  if (!SAFE_ROLE.test(roleId)) throw new EvaluatorInputError(`role id ${JSON.stringify(roleId.slice(0, 40))} is not a safe file name (use 1 to 64 lowercase letters, digits, _ or -)`);
  if (RESERVED_NAMES.has(roleId)) throw new EvaluatorInputError(`role id '${roleId}' is reserved for the report files (group, index, method)`);
  return roleId;
}

export type RenderedReports = { files: Map<string, string>; participants: ParticipantReport[]; group: GroupReport };

/** Renders every report file in memory: `<role>.md` and `.json`, `group.md` and `.json`, `index.md` and `method.md`. Pure. Role ids are validated first. */
export function renderReports(result: EvaluationResult, evaluator: EvaluatorInfo, secrets: string[] = []): RenderedReports {
  for (const p of result.participants) checkRoleId(p.roleId);
  const ctx = { result, evaluator, secrets };
  const files = new Map<string, string>();
  const participants = result.participants.map((p) => buildParticipantReport(ctx, p));
  for (const r of participants) {
    files.set(`${r.participant.role}.md`, renderParticipantMarkdown(r, secrets));
    files.set(`${r.participant.role}.json`, `${JSON.stringify(r, null, 2)}\n`);
  }
  const group = buildGroupReport(ctx);
  files.set("group.md", renderGroupMarkdown(group, secrets));
  files.set("group.json", `${JSON.stringify(group, null, 2)}\n`);
  files.set("method.md", renderMethodMarkdown(buildMethod({ players: result.participants.length })));
  files.set("index.md", renderIndex(result, participants, group, secrets, evaluator));
  return { files, participants, group };
}

function renderIndex(result: EvaluationResult, participants: ParticipantReport[], group: GroupReport, secrets: string[], evaluator: EvaluatorInfo): string {
  const sec = secrets;
  const roles = participants.map((p) => p.participant.role);
  const out = [`# Feedback reports: ${safeMd(result.scenario.title, 200, sec)}`, "", `> ${DRAFT_BANNER}`, "", VISIBILITY_LINE, "",
    `Session \`${result.sessionId}\`, ${safeMd(result.startedAtIso, 40, sec)}. Model calls: ${result.modelCalls}.`, "", ...(evaluator.scripted ? [DEMO_NOTE, ""] : []), "## Reports", ""];
  for (const r of roles) out.push(`- [${r}](${r}.md) ([JSON](${r}.json))`);
  out.push("- [Group report](group.md) ([JSON](group.json))", "- [How scores are produced](method.md)", "", "## Learning-objective results for everyone", "");
  const team = group.lo_coverage.objectives.some((o) => o.team.score !== null);
  out.push(`| Learning objective | ${roles.map((r) => `\`${r}\``).join(" | ")}${team ? " | Team" : ""} |`, `| --- | ${roles.map(() => "---").join(" | ")}${team ? " | ---" : ""} |`);
  for (const o of group.lo_coverage.objectives) {
    out.push(`| ${id(o.id, sec)}: ${safeMd(o.statement, 160, sec)} | ${roles.map((r) => loScoreText(o.by_role[r]!.score, o.by_role[r]!.label, o.by_role[r]!.incomplete)).join(" | ")}${team ? ` | ${loScoreText(o.team.score, o.team.label, o.team.incomplete)}` : ""} |`);
  }
  out.push("", "There is no overall grade: the picture is the list of learning-objective results. Not observed (N/O) means there was no evidence either way.", "");
  const bad = [...participants.filter((p) => p.evaluation.status !== "ok").map((p) => `${p.participant.role}: ${p.evaluation.reason ?? p.evaluation.status}`), ...(group.evaluation.status !== "ok" ? [`group: ${group.evaluation.reason ?? group.evaluation.status}`] : [])];
  if (bad.length) out.push("## Not evaluated", "", ...bad.map((b) => `- ${safeMd(b, 400, sec)}`), "");
  return `${out.join("\n")}\n`;
}

/** Writing the report files failed (disk, permissions); the partial directory was removed. */
export class ReportWriteError extends Error {
  constructor(message: string) { super(message); this.name = "ReportWriteError"; }
}

export type WrittenReports = { dir: string; files: string[]; participants: ParticipantReport[]; group: GroupReport };

/** Creates a file that must not exist yet (flag `wx`): a second write to the same path fails with EEXIST and never overwrites. */
export async function writeExclusive(file: string, text: string, write: typeof writeFile = writeFile): Promise<void> {
  await write(file, text, { encoding: "utf8", flag: "wx", mode: 0o644 });
}

/**
 * Writes the reports into a FRESH directory `<out>/<session-id>` (or `<session-id>-2`, `-3`... when that exists), every file created
 * exclusively (never overwritten), nothing outside it. If a write fails midway the partial directory is removed and the error says so.
 * Returns the directory and the absolute file paths.
 */
export async function writeReports(result: EvaluationResult, o: { outDir: string; evaluator: EvaluatorInfo; secrets?: string[]; /** Test hook: replaces fs.writeFile. */ write?: typeof writeFile }): Promise<WrittenReports> {
  if (!isValidSessionId(result.sessionId)) throw new EvaluatorInputError(`session id ${JSON.stringify(result.sessionId.slice(0, 40))} is not a safe directory name`);
  const rendered = renderReports(result, o.evaluator, o.secrets ?? []);
  const out = path.resolve(o.outDir);
  await mkdir(out, { recursive: true });
  let dir = "";
  for (let n = 1; n <= 99; n++) {
    const candidate = path.join(out, n === 1 ? result.sessionId : `${result.sessionId}-${n}`);
    if (path.dirname(candidate) !== out) throw new EvaluatorInputError("the report directory would be outside the output directory");
    try { await mkdir(candidate); dir = candidate; break; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  if (!dir) throw new EvaluatorInputError(`too many report directories for session ${result.sessionId} in the output directory`);
  const files: string[] = [];
  try {
    for (const [name, text] of rendered.files) {
      const file = path.join(dir, name);
      if (path.dirname(file) !== dir) throw new EvaluatorInputError("a report file would be outside the report directory");
      await writeExclusive(file, text, o.write);
      files.push(file);
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof EvaluatorInputError ? "unsafe path" : "failed");
    throw new ReportWriteError(`writing the reports failed (${code}) after ${files.length} of ${rendered.files.size} files; the partial report directory was removed`);
  }
  return { dir, files, participants: rendered.participants, group: rendered.group };
}
