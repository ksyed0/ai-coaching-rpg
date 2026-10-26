import type { LoResult } from "../evaluator/aggregate.js";
import { safeMd } from "../demo/transcript-md.js";
import { id } from "../evaluator/report-md.js";
import { loScoreText } from "../evaluator/report-model.js";
import type { GroupReport } from "../evaluator/report-model.js";
import type { SubjectView } from "./fold.js";
import type { Loaded } from "./store.js";
import { GROUP } from "./types.js";

export type IndexAudience =
  { audience: "facilitator" } | { audience: "participant"; role: string };

/** A subject a participant may be shown: released, or amending with a released snapshot (they keep seeing the last release). */
const shown = (sv: SubjectView | undefined): sv is SubjectView =>
  sv !== undefined &&
  (sv.state === "released" || sv.state === "amending") &&
  sv.snapshot !== null;

const stateText = (sv: SubjectView): string => {
  const v = sv.versions.at(-1);
  return sv.state === "released"
    ? `released (version ${v})`
    : sv.state === "amending"
      ? `amending (last released version ${v ?? "none"})`
      : sv.state;
};

const openItems = (sv: SubjectView): number =>
  sv.criteria.filter((c) => c.status === "needs_review").length +
  (sv.summaryStale ? 1 : 0);

const cell = (x: LoResult | null | undefined): string =>
  loScoreText(
    x?.score ?? null,
    x?.label ?? "Not observed",
    x?.incomplete ?? false,
  );

/**
 * The review index as Markdown. Pure. The facilitator sees every subject with its state and the live per-role table; a participant
 * sees only what the audience policy lets them read: their own report and the group report, each only once released, and a
 * learning-objective table with their own column and the team column. Peers' names, links and results never appear.
 */
export function renderReviewIndex(
  l: Loaded,
  a: IndexAudience,
  secrets: string[],
): string {
  const sec = secrets;
  const groupDraft = l.drafts.subjects.get(GROUP)?.raw as unknown as
    GroupReport | undefined;
  const subjects = l.view.subjects;
  const out = [
    `# Feedback reports: ${safeMd(groupDraft?.scenario.title ?? "", 200, sec)}`,
    "",
    a.audience === "facilitator"
      ? "Visibility: facilitator only"
      : "Visibility: you and the facilitator",
    "",
    `Session ${id(groupDraft?.session.id ?? l.view.opened.session.id, sec)}, ${safeMd(groupDraft?.session.date ?? "", 40, sec)}.`,
    "",
  ];
  if (a.audience === "facilitator") {
    out.push(
      "## Subjects",
      "",
      "| Subject | State | Open items |",
      "| --- | --- | --- |",
    );
    for (const sv of subjects.values())
      out.push(`| ${id(sv.id, sec)} | ${stateText(sv)} | ${openItems(sv)} |`);
    out.push("");
    const roles = [...subjects.values()].filter(
      (s) => s.kind === "participant",
    );
    const g = subjects.get(GROUP);
    const los = groupDraft?.lo_coverage.objectives ?? [];
    out.push(
      "## Learning-objective results (working copy)",
      "",
      `| Learning objective | ${roles.map((r) => id(r.id, sec)).join(" | ")} | Team |`,
      `| --- | ${roles.map(() => "---").join(" | ")} | --- |`,
    );
    for (const o of los)
      out.push(
        `| ${id(o.id, sec)}: ${safeMd(o.statement, 160, sec)} | ${roles
          .map((r) => cell(r.objectives.find((x) => x.id === o.id)))
          .join(
            " | ",
          )} | ${cell((g?.objectives ?? []).find((x) => x.id === o.id))} |`,
      );
    out.push("");
    return `${out.join("\n")}\n`;
  }
  const me = subjects.get(a.role);
  const grp = subjects.get(GROUP);
  out.push("## Reports", "");
  if (shown(me) && me.kind === "participant")
    out.push(`- [${a.role}](${a.role}.md)`);
  if (shown(grp)) out.push("- [Group report](group.md)");
  out.push("");
  if (shown(grp) && grp.snapshot?.table) {
    const own = shown(me) && me.kind === "participant" ? me : undefined;
    out.push(
      "## Learning-objective results",
      "",
      `| Learning objective | ${own ? `${id(a.role, sec)} | ` : ""}Team |`,
      `| --- | ${own ? "--- | " : ""}--- |`,
    );
    for (const o of grp.snapshot.table.objectives)
      out.push(
        `| ${id(o.id, sec)}: ${safeMd(o.statement, 160, sec)} | ${
          own
            ? `${cell(own.snapshot?.objectives.find((x) => x.id === o.id))} | `
            : ""
        }${cell(o.team)} |`,
      );
    out.push(
      "",
      "There is no overall grade: the picture is the list of learning-objective results. Not observed (N/O) means there was no evidence either way.",
      "",
    );
  }
  return `${out.join("\n")}\n`;
}
