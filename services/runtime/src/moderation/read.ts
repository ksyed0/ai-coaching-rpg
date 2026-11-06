/**
 * Moderation reads (EPIC-0002, slice 2c-3): the facts `pnpm moderate status` prints and the facilitator's view of one subject that
 * `show` renders, as data. No lock is taken. Errors are the review layer's own (see `toModResult`).
 */
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { cleanLine } from "../review/cli-util.js";
import { ReviewRefusedError } from "../review/errors.js";
import type { SubjectView } from "../review/fold.js";
import { scoreByHand } from "../review/gate.js";
import { loadReview, type Loaded } from "../review/store.js";
import { viewReport } from "../review/view.js";
import type {
  CurrentDto,
  ModerationStatus,
  SubjectStatus,
  SubjectViewDto,
} from "./types.js";

function subjectStatus(sv: SubjectView): SubjectStatus {
  return {
    id: sv.id,
    state: sv.state,
    version: sv.versions.at(-1) ?? null,
    criteriaTotal: sv.criteria.length,
    openCriteria: sv.criteria
      .filter((c) => c.status === "needs_review")
      .map((c) => c.id),
    summaryStale: sv.summaryStale,
    tableStale: sv.tableStale,
    evaluationOk: sv.evaluationOk,
    scoreByHand: scoreByHand(sv),
    selfRated: sv.criteria.filter((c) => c.self).length,
    openDisputes: sv.responses
      .filter((r) => r.dispute && !r.resolution)
      .map((r) => ({
        seq: r.seq,
        role: r.role,
        criterion: r.criterion ?? null,
      })),
  };
}

/** Per subject, what is open: the facts of `pnpm moderate status`. Named apart from `reviewStatus` of `@acr/runtime/reports`. */
export async function moderationStatus(dir: string): Promise<ModerationStatus> {
  const l = await loadReview(dir);
  return {
    superseded: l.view.superseded,
    subjects: [...l.view.subjects.values()].map(subjectStatus),
  };
}

/** The facilitator-audience report of one subject, as `show` renders it. Refused (`unknown_subject`) for a subject the review lacks. */
export async function facilitatorReport(
  dir: string,
  subject: string,
): Promise<{
  loaded: Loaded;
  sv: SubjectView;
  report: ParticipantReport | GroupReport;
}> {
  const loaded = await loadReview(dir);
  const sv = subject ? loaded.view.subjects.get(subject) : undefined;
  if (!subject || !sv)
    throw new ReviewRefusedError(
      "unknown subject; run status to list them",
      "unknown_subject",
    );
  const draft = loaded.drafts.subjects.get(subject)!.raw as unknown as
    ParticipantReport | GroupReport;
  return {
    loaded,
    sv,
    report: viewReport(draft, loaded.view, subject, {
      audience: "facilitator",
    }),
  };
}

const STATUS = {
  open: "needs_review",
  accepted: "accepted",
  edited: "edited",
  clear: "clear",
} as const;

/**
 * The facilitator's view of one subject, field by field: only the fields of `SubjectViewDto`, every string through `cleanLine`
 * (hidden and control characters out, secrets and machine paths redacted), as `show` cleans each rendered line. No author names.
 */
export async function subjectView(
  dir: string,
  subject: string,
  secrets: string[],
): Promise<SubjectViewDto> {
  const { sv, report } = await facilitatorReport(dir, subject);
  const t = (s: string): string => cleanLine(String(s), secrets);
  const self = report.kind === "participant" ? report.self : undefined;
  const summary =
    report.kind === "participant"
      ? report.summary
      : { strengths: [], development_points: [], next_actions: [] };
  return {
    id: sv.id,
    state: sv.state,
    criteria: report.criteria.map((c) => {
      const current: CurrentDto = c.invalid
        ? "invalid"
        : (c.score as 1 | 2 | 3 | 4 | null);
      const lvl = self?.[c.id]?.level;
      return {
        id: t(c.id),
        name: t(c.name),
        current,
        status: STATUS[c.moderation?.state ?? "open"],
        rationale: t(c.rationale),
        evidence: c.evidence.map((e) => ({
          quote: t(e.quote),
          ...(typeof e.scene_title === "string"
            ? { scene: t(e.scene_title) }
            : {}),
        })),
        flags: c.flags.map(t),
        selfLevel:
          lvl === undefined ? undefined : (lvl as 1 | 2 | 3 | 4 | null),
      };
    }),
    summary: {
      strengths: summary.strengths.map(t),
      developments: summary.development_points.map(t),
      actions: summary.next_actions.map((a) => ({
        lo: t(a.lo),
        text: t(a.action),
      })),
    },
    objectives: report.learning_objectives.map((o) => ({
      id: t(o.id),
      label: t(o.statement),
    })),
    comments: (report.comments ?? []).map((c) => ({
      visibility: c.visibility,
      text: t(c.text),
      ...(c.criterion !== undefined ? { criterion: t(c.criterion) } : {}),
    })),
    // seq and role are the live view's (the rendered report has neither); the facilitator audience reads the same list
    responses: sv.responses.map((r) => ({
      seq: r.seq,
      role: t(r.role),
      text: t(r.text),
      ...(r.criterion !== undefined ? { criterion: t(r.criterion) } : {}),
      dispute: r.dispute,
      ...(r.resolution
        ? {
            resolution: {
              outcome: r.resolution.outcome,
              reason: t(r.resolution.reason),
            },
          }
        : {}),
    })),
    versions: [...sv.versions],
  };
}
