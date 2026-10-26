import { INVALID_LABEL, levelLabel } from "../evaluator/aggregate.js";
import type { LoResult } from "../evaluator/aggregate.js";
import {
  FACILITATOR_ONLY_LINE,
  IN_REVIEW_BANNER,
  releasedBanner,
} from "../evaluator/method.js";
import {
  renderGroupMarkdown,
  renderParticipantMarkdown,
} from "../evaluator/report-md.js";
import type {
  GroupReport,
  JsonCriterion,
  JsonObjective,
  Moderation,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { type CriterionView, type SubjectView, type View } from "./fold.js";
import { VIEW_SCHEMA } from "./types.js";

export const TABLE_STALE_NOTE =
  "Per-role table out of date: a player was released or withdrawn after this group report was released; amend and re-release the group to refresh it.";
export type RenderAudience =
  { audience: "facilitator" } | { audience: "released"; line: string };
const AI_PREFIX =
  "AI draft calibration (not the calibration of the final scores): ";

const jsonLo = (o: LoResult): JsonObjective => ({
  id: o.id,
  statement: o.statement,
  score: o.score,
  label: o.label,
  criteria: o.criteria,
  observed: o.observed,
  incomplete: o.incomplete,
});

/**
 * Per-criterion review state ("open", "accepted", ...) is shown only to the facilitator audience. A released view carries just the
 * "Facilitator-adjusted" disclosure: the release gate (Task 9) guarantees there are no open items in a released subject.
 */
function criterion(
  c: JsonCriterion,
  v: CriterionView,
  facilitator: boolean,
): JsonCriterion {
  const adjusted = v.edits.length > 0;
  const last = v.edits.at(-1);
  const moderation: Moderation = {
    adjusted,
    ai_score: c.score,
    ai_label: c.level_label,
    ai_invalid: c.invalid,
    reason: last?.reason ?? null,
    by: last?.by ?? v.rationaleEdits.at(-1)?.by ?? null,
    rationale_edited: v.rationaleEdits.length > 0,
    accepted: v.status === "accepted",
    ...(facilitator
      ? { state: v.status === "needs_review" ? ("open" as const) : v.status }
      : {}),
  };
  const cur = v.current;
  const invalid = cur === "invalid";
  const level = cur === "invalid" ? null : cur;
  return {
    ...c,
    score: level,
    level_label: invalid ? INVALID_LABEL : levelLabel(level),
    invalid,
    rationale: v.rationale,
    moderation,
  };
}

/** Facilitators who changed or accepted something: comment authors are not reviewers of the scores. */
function reviewerNames(sv: SubjectView): string[] {
  return [
    ...new Set([
      ...sv.criteria.flatMap((c) => [
        ...c.edits.map((e) => e.by),
        ...c.rationaleEdits.map((e) => e.by),
        ...(c.acceptedBy ? [c.acceptedBy] : []),
      ]),
      ...sv.summaryBy,
    ]),
  ];
}

/** The draft report with the review applied. Pure; the draft object is not modified. Banner and visibility line follow the audience. */
export function viewReport(
  draft: ParticipantReport | GroupReport,
  view: View,
  subject: string,
  a: RenderAudience,
): ParticipantReport | GroupReport {
  const sv = view.subjects.get(subject) as SubjectView;
  const names = reviewerNames(sv);
  const edited = sv.criteria.filter((c) => c.edits.length > 0).length;
  const base = {
    ...structuredClone(draft),
    schema: VIEW_SCHEMA,
    status: "moderated" as const,
    draft_notice:
      a.audience === "facilitator"
        ? IN_REVIEW_BANNER
        : releasedBanner(sv.versions.at(-1) ?? 0, names),
    visibility: a.audience === "facilitator" ? FACILITATOR_ONLY_LINE : a.line,
    criteria: draft.criteria.map((c) =>
      criterion(
        c,
        sv.criteria.find((x) => x.id === c.id)!,
        a.audience === "facilitator",
      ),
    ),
  };
  base.evaluator = {
    ...base.evaluator,
    calibration_line: `${AI_PREFIX}${base.evaluator.calibration_line}`,
  };
  base.notes = [
    ...base.notes,
    `Scores were moderated by a facilitator${names.length ? ` (${names.join(", ")})` : ""}; ${edited} of ${sv.criteria.length} criteria were changed.`,
  ];
  if (a.audience === "facilitator" && sv.tableStale)
    base.notes.push(TABLE_STALE_NOTE);
  // A "released" audience (US-0043) must be fed a view whose comments are already frozen at the release (see snapshotReport):
  // this function trusts sv.comments and would otherwise show comments made after the release to participants.
  const comments = sv.comments
    .filter((c) => a.audience === "facilitator" || c.visibility === "feedback")
    .map((c) => ({
      ...(c.criterion ? { criterion: c.criterion } : {}),
      text: c.text,
      by: c.by,
      visibility: c.visibility,
    }));
  if (draft.kind === "participant") {
    const r = base as ParticipantReport;
    if (a.audience === "facilitator" && sv.summary)
      r.summary_state = { edited: sv.summaryEdited, stale: sv.summaryStale };
    r.learning_objectives = sv.objectives.map(jsonLo);
    if (sv.summary) r.summary = structuredClone(sv.summary);
    if (comments.length) r.comments = comments;
    return r;
  }
  const g = base as GroupReport;
  if (g.learning_objectives.length)
    g.learning_objectives = sv.objectives.map(jsonLo);
  const roles = [...view.subjects.values()].filter(
    (s) => s.kind === "participant",
  );
  g.lo_coverage = {
    players: roles.map((r) => r.id),
    objectives: draft.lo_coverage.objectives.map((o) => {
      const pick = (x: LoResult | undefined) => ({
        score: x?.score ?? null,
        label: x?.label ?? "Not observed",
        incomplete: x?.incomplete ?? false,
      });
      return {
        id: o.id,
        statement: o.statement,
        by_role: Object.fromEntries(
          roles.map((r) => [
            r.id,
            pick(r.objectives.find((x) => x.id === o.id)),
          ]),
        ),
        team: pick(sv.objectives.find((x) => x.id === o.id)),
      };
    }),
  };
  if (comments.length) g.comments = comments;
  return g;
}

export function renderSubjectMarkdown(
  report: ParticipantReport | GroupReport,
  secrets: string[],
): string {
  return report.kind === "participant"
    ? renderParticipantMarkdown(report, secrets)
    : renderGroupMarkdown(report, secrets);
}

/**
 * The facilitator-audience report of a subject's last RELEASED snapshot (criteria, summary, objectives and, for the group, the frozen
 * table), not its live draft state: an export during an amendment still carries what was released. Pure. Needs a released snapshot.
 */
export function snapshotReport(
  draft: ParticipantReport | GroupReport,
  view: View,
  subject: string,
): ParticipantReport | GroupReport {
  const sv = view.subjects.get(subject) as SubjectView;
  const snap = sv.snapshot;
  if (!snap) throw new Error("snapshotReport needs a released subject");
  const frozen: SubjectView = {
    ...sv,
    criteria: snap.criteria,
    summary: snap.summary,
    summaryEdited: snap.summaryEdited,
    summaryStale: false,
    objectives: snap.objectives,
    // frozen at release: the log is append-only, so a comment made before the release has a smaller seq
    comments: sv.comments.filter((c) => c.seq < snap.version),
  };
  const subjects = new Map(view.subjects).set(subject, frozen);
  const r = viewReport(draft, { ...view, subjects }, subject, {
    audience: "facilitator",
  });
  r.draft_notice = releasedBanner(snap.version, reviewerNames(frozen));
  if (r.kind === "group" && snap.table) {
    const players = Object.keys(snap.table.objectives[0]?.byRole ?? {});
    const pick = (x: LoResult | null) => ({
      score: x?.score ?? null,
      label: x?.label ?? "Not observed",
      incomplete: x?.incomplete ?? false,
    });
    r.lo_coverage = {
      players,
      objectives: snap.table.objectives.map((o) => ({
        id: o.id,
        statement: o.statement,
        by_role: Object.fromEntries(
          players.map((p) => [p, pick(o.byRole[p] ?? null)]),
        ),
        team: pick(o.team),
      })),
    };
  }
  return r;
}
