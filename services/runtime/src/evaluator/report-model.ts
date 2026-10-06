import { scrubDeep } from "../demo/report.js";
import { NOT_OBSERVED, type LoResult } from "./aggregate.js";
import type { EvaluationResult, GroupEval, ParticipantEval } from "./evaluate.js";
import { DRAFT_BANNER, VISIBILITY_LINE, buildMethod, type Method } from "./method.js";
import type { CriterionResult } from "./parse.js";

export const REPORT_SCHEMA = "acr.report/1";

/** Who produced the scores: a fixed provider label (never an endpoint or key) and the model id when one was configured. */
export type EvaluatorInfo = { provider: string; model?: string };
export type ReportContext = { result: EvaluationResult; evaluator: EvaluatorInfo; secrets: string[] };

type Common = {
  schema: typeof REPORT_SCHEMA; status: "draft"; draft_notice: string; visibility: string;
  scenario: { id: string; title: string; version: string };
  session: { id: string; date: string; complete: boolean; scenes: { number: number; id: string; title: string }[] };
  evaluator: EvaluatorInfo & { model_calls: number };
  notes: string[];
  method: Method;
};

export type JsonCriterion = {
  id: string; name: string; score: number | null; level_label: string; confidence: string | null; rationale: string; flags: string[]; dropped_quotes: number;
  evidence: { seq: number; role: string; quote: string; scene: number; scene_title: string; time: string }[];
};
export type JsonObjective = { id: string; statement: string; score: number | null; label: string; criteria: string[]; observed: string[] };

export type ParticipantReport = Common & {
  kind: "participant";
  participant: { role: string; utterances: number };
  evaluation: { status: string; reason?: string };
  summary: { strengths: string[]; development_points: string[]; next_actions: { lo: string; action: string }[] };
  learning_objectives: JsonObjective[];
  criteria: JsonCriterion[];
};
export type GroupReport = Common & {
  kind: "group";
  evaluation: { status: string; reason?: string };
  criteria: JsonCriterion[];
  learning_objectives: JsonObjective[];
  lo_coverage: { players: string[]; objectives: { id: string; statement: string; by_role: Record<string, { score: number | null; label: string }>; team: { score: number | null; label: string } }[] };
  facilitator_notes: string;
  talking_points: { from_scenario: string; from_evaluator: string[] };
  notable_moments: { seq: number; role: string; quote: string; note: string; scene: number; scene_title: string; time: string }[];
};

function notesOf(r: EvaluationResult): string[] {
  const notes: string[] = [];
  if (r.trimmed) notes.push(`The transcript was trimmed before it was sent to the model: ${r.trimmed.omittedLines} line(s) omitted and ${r.trimmed.shortenedLines} line(s) cut short to fit a budget of ${r.trimmed.budgetChars} characters (${r.trimmed.fullChars} in full). Scores may be less reliable.`);
  if (!r.sessionComplete) notes.push("The session log has no session.ended event: the session may be incomplete.");
  return notes;
}

function common(ctx: ReportContext, modelCalls: number): Common {
  const r = ctx.result;
  return {
    schema: REPORT_SCHEMA, status: "draft", draft_notice: DRAFT_BANNER, visibility: VISIBILITY_LINE, scenario: r.scenario,
    session: { id: r.sessionId, date: r.startedAtIso, complete: r.sessionComplete, scenes: r.scenes.map((s, i) => ({ number: i + 1, id: s.id, title: s.title })) },
    evaluator: { ...ctx.evaluator, model_calls: modelCalls }, notes: notesOf(r), method: buildMethod(),
  };
}

export const jsonCriterion = (c: CriterionResult): JsonCriterion => ({
  id: c.id, name: c.name, score: c.score, level_label: c.label, confidence: c.confidence, rationale: c.rationale, flags: c.flags, dropped_quotes: c.droppedQuotes,
  evidence: c.evidence.map((e) => ({ seq: e.seq, role: e.roleId, quote: e.quote, scene: e.sceneNumber, scene_title: e.sceneTitle, time: e.time })),
});
const jsonObjective = (o: LoResult): JsonObjective => ({ id: o.id, statement: o.statement, score: o.score, label: o.label, criteria: o.criteria, observed: o.observed });

export function buildParticipantReport(ctx: ReportContext, p: ParticipantEval): ParticipantReport {
  const report: ParticipantReport = {
    ...common(ctx, p.modelCalls), kind: "participant", participant: { role: p.roleId, utterances: p.utterances },
    evaluation: { status: p.status, ...(p.reason ? { reason: p.reason } : {}) },
    summary: { strengths: p.strengths, development_points: p.development_points, next_actions: p.next_actions },
    learning_objectives: p.objectives.map(jsonObjective), criteria: p.criteria.map(jsonCriterion),
  };
  return scrubDeep(report, ctx.secrets);
}

export function buildGroupReport(ctx: ReportContext): GroupReport {
  const r = ctx.result; const g: GroupEval = r.group;
  const report: GroupReport = {
    ...common(ctx, g.modelCalls), kind: "group", evaluation: { status: g.status, ...(g.reason ? { reason: g.reason } : {}) },
    criteria: g.criteria.map(jsonCriterion), learning_objectives: g.objectives.map(jsonObjective),
    lo_coverage: {
      players: r.participants.map((p) => p.roleId),
      objectives: r.objectives.map((lo, i) => ({
        id: lo.id, statement: lo.statement,
        by_role: Object.fromEntries(r.participants.map((p) => [p.roleId, { score: p.objectives[i]!.score, label: p.objectives[i]!.label }])),
        team: { score: g.objectives[i]!.score, label: g.objectives[i]!.label },
      })),
    },
    facilitator_notes: r.facilitatorNotes, talking_points: { from_scenario: r.facilitatorNotes, from_evaluator: g.talking_points },
    notable_moments: g.notable_moments.map((m) => ({ seq: m.seq, role: m.roleId, quote: m.quote, note: m.note, scene: m.sceneNumber, scene_title: m.sceneTitle, time: m.time })),
  };
  return scrubDeep(report, ctx.secrets);
}

export const scoreText = (score: number | null, label: string): string => (score === null ? `N/O - ${NOT_OBSERVED}` : `${score} - ${label}`);
export const loScoreText = (score: number | null, label: string): string => (score === null ? NOT_OBSERVED : `${score.toFixed(1)} - ${label}`);
