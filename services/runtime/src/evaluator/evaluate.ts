import type { ChatRequest, ModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import type { Criterion, Rubric, Scenario } from "@acr/script";
import { collectModelReply } from "../agents/model-reply.js";
import { aggregateObjectives, type LoInput, type LoResult, type Score } from "./aggregate.js";
import type { EvalConfig } from "./config.js";
import { cleanActions, cleanList, cleanProse, extractJson, makeVerifier, normaliseCriteria, verifyAll, type Action, type CriterionResult, type Evidence } from "./parse.js";
import { buildGroupRequest, buildParticipantRequest, buildReask, newNonce } from "./prompt.js";
import { buildTranscript, renderTranscript, type Transcript, type TrimInfo } from "./transcript.js";

/** A participant who spoke fewer times than this gets "insufficient evidence" and no model call. */
export const MIN_UTTERANCES = 2;

export type EvalStatus = "ok" | "insufficient_evidence" | "failed";
export type ParticipantEval = {
  roleId: string; status: EvalStatus; /** Why: set for failed and insufficient_evidence. */ reason?: string;
  utterances: number; criteria: CriterionResult[]; objectives: LoResult[];
  strengths: string[]; development_points: string[]; next_actions: Action[]; modelCalls: number;
};
export type NotableMoment = { seq: number; roleId: string; quote: string; note: string; sceneNumber: number; sceneTitle: string; time: string };
export type GroupEval = {
  status: EvalStatus; reason?: string; criteria: CriterionResult[]; objectives: LoResult[]; talking_points: string[]; notable_moments: NotableMoment[]; modelCalls: number;
};
export type EvaluationResult = {
  sessionId: string; scenario: { id: string; title: string; version: string }; startedAtIso: string; sessionComplete: boolean;
  utterancesByRole: Record<string, number>; scenes: { id: string; title: string }[];
  trimmed: TrimInfo | null; participants: ParticipantEval[]; group: GroupEval;
  objectives: LoInput[]; facilitatorNotes: string; modelCalls: number; failures: string[];
};

export class EvaluatorInputError extends Error {
  constructor(message: string) { super(message); this.name = "EvaluatorInputError"; }
}

export type EvaluateInput = {
  events: SessionEvent[]; scenario: Scenario; rubrics: Rubric[]; provider: ModelProvider; config: EvalConfig;
  signal?: AbortSignal; /** Fixed delimiter nonce (tests); random by default. */ nonce?: string; onProgress?: (message: string) => void;
};

type Asked = { ok: true; value: Record<string, unknown>; calls: number } | { ok: false; reason: string; calls: number };

const reasonOf = (s: string): string => cleanProse(s, 300);

/**
 * One evaluator call with a single bounded re-ask: a model failure (timeout, error, abort) ends the call at once; an unusable reply
 * (not JSON, or no criterion id matched) is sent back once with the problem. `accept` returns the problem text, or null when usable.
 */
async function ask(provider: ModelProvider, req: ChatRequest, cfg: EvalConfig, signal: AbortSignal | undefined, accept: (v: Record<string, unknown>) => string | null): Promise<Asked> {
  let calls = 0;
  let current = req;
  let last = "unknown problem";
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const got = await collectModelReply(provider, current, { firstTokenTimeoutMs: cfg.firstTokenTimeoutMs, replyTimeoutMs: cfg.timeoutMs, signal });
    if (got.failure) return { ok: false, reason: reasonOf(got.failure), calls };
    const parsed = extractJson(got.text);
    const problem = parsed.ok ? accept(parsed.value) : parsed.error;
    if (parsed.ok && problem === null) return { ok: true, value: parsed.value, calls };
    last = problem ?? "unknown problem";
    current = buildReask(req, got.text, last);
  }
  return { ok: false, reason: reasonOf(`the reply could not be used after one re-ask: ${last}`), calls };
}

const noScores = (criteria: Criterion[], flag: string): CriterionResult[] =>
  criteria.map((c) => ({ id: c.id, name: c.name, score: null, label: "Not observed", confidence: null, rationale: "", evidence: [], droppedQuotes: 0, flags: [flag] }));

const scoreMap = (cs: CriterionResult[]): Map<string, Score | null> => new Map(cs.map((c) => [c.id, c.score]));

function lowestLo(objs: LoResult[]): string {
  const scored = objs.filter((o) => o.score !== null).sort((a, b) => a.score! - b.score!);
  return (scored[0] ?? objs[0])?.id ?? "LO1";
}

/**
 * Scores every player role (one model call each, plus at most one re-ask) and the group (one call), from a recorded session. Never
 * throws for a model problem: a participant whose evaluation fails is reported as failed and the others still run.
 */
export async function evaluateSession(input: EvaluateInput): Promise<EvaluationResult> {
  const { scenario, rubrics, config } = input;
  const individual = rubrics.filter((r) => r.scope === "individual");
  const group = rubrics.filter((r) => r.scope === "group");
  if (individual.length === 0) throw new EvaluatorInputError("the scenario's rubrics have no individual criteria to score against");
  const t: Transcript = buildTranscript(input.events, scenario);
  const rendered = renderTranscript(t, config.transcriptChars);
  const nonce = input.nonce ?? newNonce();
  const objectives: LoInput[] = scenario.meta.learning_objectives.map((lo) => ({ id: lo.id, statement: lo.statement, rubric_criteria: lo.rubric_criteria }));
  const players = Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id);
  const base = { scenario, transcript: rendered.text, nonce, maxTokens: config.maxTokens, temperature: config.temperature, ...(config.model ? { model: config.model } : {}) };
  const failures: string[] = [];
  let modelCalls = 0;
  const criteriaOf = (rs: Rubric[]): Criterion[] => rs.flatMap((r) => r.criteria);

  const participants: ParticipantEval[] = [];
  for (const roleId of players) {
    input.onProgress?.(`evaluating ${roleId}`);
    const utterances = t.counts[roleId] ?? 0;
    const crit = criteriaOf(individual);
    const empty = (status: EvalStatus, reason: string, calls = 0): ParticipantEval => {
      const criteria = noScores(crit, status === "failed" ? "evaluation failed" : "insufficient evidence");
      return { roleId, status, reason, utterances, criteria, objectives: aggregateObjectives(objectives, scoreMap(criteria)), strengths: [], development_points: [], next_actions: [], modelCalls: calls };
    };
    if (utterances < MIN_UTTERANCES) { participants.push(empty("insufficient_evidence", `insufficient evidence: ${utterances} utterance(s), at least ${MIN_UTTERANCES} are needed`)); continue; }
    if (input.signal?.aborted) { const p = empty("failed", "run aborted"); failures.push(`${roleId}: ${p.reason}`); participants.push(p); continue; }
    const verify = makeVerifier(t, (u) => u.roleId === roleId);
    const req = buildParticipantRequest({ ...base, rubrics: individual, roleId });
    let normalised: ReturnType<typeof normaliseCriteria> | undefined;
    const asked = await ask(input.provider, req, config, input.signal, (v) => {
      normalised = normaliseCriteria(v.criteria, crit, verify);
      if (!Array.isArray(v.criteria)) return 'the JSON has no "criteria" array';
      if (normalised.recognised === 0) return `none of the criterion ids matched (use exactly: ${crit.map((c) => c.id).join(", ")})`;
      return null;
    });
    modelCalls += asked.calls;
    if (!asked.ok || !normalised) {
      const reason = asked.ok ? "no usable evaluation" : asked.reason;
      const p = empty("failed", `evaluation failed: ${reason}`, asked.calls);
      failures.push(`${roleId}: evaluation failed: ${reason}`); participants.push(p); continue;
    }
    const objs = aggregateObjectives(objectives, scoreMap(normalised.criteria));
    participants.push({
      roleId, status: "ok", utterances, criteria: normalised.criteria, objectives: objs,
      strengths: cleanList(asked.value.strengths, 3, 400), development_points: cleanList(asked.value.development_points, 3, 400),
      next_actions: cleanActions(asked.value.next_actions, objectives.map((o) => o.id), lowestLo(objs)), modelCalls: asked.calls,
    });
  }

  // ---- the group -------------------------------------------------------------------------------------------------
  input.onProgress?.("evaluating the team");
  const groupCrit = criteriaOf(group);
  const playerSpeech = players.reduce((a, r) => a + (t.counts[r] ?? 0), 0);
  const groupEmpty = (status: EvalStatus, reason: string, calls = 0): GroupEval => {
    const criteria = noScores(groupCrit, status === "failed" ? "evaluation failed" : "insufficient evidence");
    return { status, reason, criteria, objectives: aggregateObjectives(objectives, scoreMap(criteria)), talking_points: [], notable_moments: [], modelCalls: calls };
  };
  let groupEval: GroupEval;
  if (groupCrit.length === 0) groupEval = groupEmpty("insufficient_evidence", "the scenario has no group criteria");
  else if (playerSpeech < MIN_UTTERANCES) groupEval = groupEmpty("insufficient_evidence", `insufficient evidence: the team spoke ${playerSpeech} time(s)`);
  else if (input.signal?.aborted) { groupEval = groupEmpty("failed", "run aborted"); failures.push("group: run aborted"); }
  else {
    const verify = makeVerifier(t, (u) => u.speaker === "player");
    let normalised: ReturnType<typeof normaliseCriteria> | undefined;
    const asked = await ask(input.provider, buildGroupRequest({ ...base, rubrics: group, players }), config, input.signal, (v) => {
      normalised = normaliseCriteria(v.criteria, groupCrit, verify);
      if (!Array.isArray(v.criteria)) return 'the JSON has no "criteria" array';
      if (normalised.recognised === 0) return `none of the criterion ids matched (use exactly: ${groupCrit.map((c) => c.id).join(", ")})`;
      return null;
    });
    modelCalls += asked.calls;
    if (!asked.ok || !normalised) {
      const reason = asked.ok ? "no usable evaluation" : asked.reason;
      groupEval = groupEmpty("failed", `evaluation failed: ${reason}`, asked.calls);
      failures.push(`group: evaluation failed: ${reason}`);
    } else {
      const moments: NotableMoment[] = [];
      const rawMoments = Array.isArray(asked.value.notable_moments) ? asked.value.notable_moments.slice(0, 8) : [];
      for (const m of rawMoments) {
        const { verified } = verifyAll([m], verify);
        const note = cleanProse(typeof m === "object" && m !== null ? (m as Record<string, unknown>).note : "", 300);
        const e: Evidence | undefined = verified[0];
        if (e && moments.length < 4 && !moments.some((x) => x.seq === e.seq && x.quote === e.quote)) moments.push({ seq: e.seq, roleId: e.roleId, quote: e.quote, note, sceneNumber: e.sceneNumber, sceneTitle: e.sceneTitle, time: e.time });
      }
      groupEval = {
        status: "ok", criteria: normalised.criteria, objectives: aggregateObjectives(objectives, scoreMap(normalised.criteria)),
        talking_points: cleanList(asked.value.talking_points, 5, 400), notable_moments: moments, modelCalls: asked.calls,
      };
    }
  }

  return {
    sessionId: t.sessionId, scenario: { id: scenario.meta.id, title: scenario.meta.title, version: scenario.meta.version },
    startedAtIso: new Date(t.startedTs).toISOString(), sessionComplete: t.complete, utterancesByRole: t.counts, scenes: t.scenes,
    trimmed: rendered.trimmed, participants, group: groupEval, objectives, facilitatorNotes: cleanProse(scenario.meta.facilitator_notes, 800),
    modelCalls, failures,
  };
}
