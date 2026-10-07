import type { Rubric, Scenario } from "@acr/script";
import type { EvalConfig } from "../evaluator/config.js";
import { evaluateSession, type ParticipantEval } from "../evaluator/evaluate.js";
import type { Judge } from "./judge.js";
import { CalibrationInputError } from "./judge.js";
import { buildProbeEvents } from "./probe-events.js";
import { printable } from "./probe-load.js";
import { acceptableOf, scoredRoles, type Probe } from "./probe-schema.js";
import type { Evidence, Observed, Outcome } from "./types.js";

export const MAX_REPEAT = 5;

export type RunOptions = {
  repeat: number; only?: string[]; allCriteria: boolean; signal?: AbortSignal; onProgress?: (m: string) => void;
  /** Called with each finished probe's outcome as soon as it is complete, so a caller keeps them even if a later probe throws. */
  onOutcome?: (o: Outcome) => void;
};

/** Reads one criterion of one participant's evaluation as an observed level; an evaluation that did not complete is "failed", not a score. */
export function observedOf(p: ParticipantEval | undefined, criterion: string): { observed: Observed; capped: boolean; dropped: number; evidence?: Evidence } {
  if (!p || p.status !== "ok") return { observed: "failed", capped: false, dropped: 0 };
  const c = p.criteria.find((x) => x.id === criterion);
  if (!c) return { observed: "failed", capped: false, dropped: 0 };
  const capped = c.flags.some((f) => f.startsWith("capped from"));
  const evidence: Evidence = { role: p.roleId, rationale: c.rationale, quotes: c.evidence.map((e) => e.quote) };
  if (c.invalid) return { observed: "invalid", capped, dropped: c.droppedQuotes, evidence };
  if (c.score === null) return { observed: "not_observed", capped, dropped: c.droppedQuotes, evidence };
  return { observed: c.score, capped, dropped: c.droppedQuotes, evidence };
}

function rubricsFor(all: Rubric[], probe: Probe, allCriteria: boolean): Rubric[] {
  const individual = all.filter((r) => r.scope === "individual");
  if (allCriteria) return individual;
  return individual
    .map((r) => ({ ...r, criteria: r.criteria.filter((c) => c.id === probe.criterion) }))
    .filter((r) => r.criteria.length > 0);
}

/** The probes `--only` names (all of them when `only` is undefined); unknown ids and an empty selection are refused. */
export function selectProbes(probes: Probe[], only: string[] | undefined): Probe[] {
  if (!only) return probes;
  const wanted = new Set(only);
  const known = new Set(probes.map((p) => p.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length) throw new CalibrationInputError(`--only names unknown probes: ${unknown.map((id) => printable(id, 64)).join(", ")}`);
  const chosen = probes.filter((p) => wanted.has(p.id));
  if (chosen.length === 0) throw new CalibrationInputError("--only selected no probes");
  return chosen;
}

/**
 * Runs every probe through the real evaluator with this judge, `repeat` times each.
 * Model calls per run = the scenario players with at least 2 lines in the probe transcript (scored or not; evaluateSession scores each of them), so a
 * probe costs that count x `repeat` calls, plus one re-ask for each unusable reply.
 * On abort the probe in flight is dropped entirely; probes completed before it are returned. An exception loses the return value, so a
 * caller that must keep partial results collects them through `onOutcome`.
 */
export async function runJudge(judge: Judge, probes: Probe[], scenario: Scenario, rubrics: Rubric[], cfg: EvalConfig, opts: RunOptions): Promise<Outcome[]> {
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1 || opts.repeat > MAX_REPEAT) {
    throw new CalibrationInputError(`--repeat must be a whole number from 1 to ${MAX_REPEAT}`);
  }
  const chosen = selectProbes(probes, opts.only);
  const out: Outcome[] = [];
  for (const probe of chosen) {
    opts.onProgress?.(`${judge.label}: ${probe.id}`);
    const base = { probeId: probe.id, criterion: probe.criterion, split: probe.split, source: probe.source, drafter: probe.drafter };
    const events = buildProbeEvents(probe, scenario);
    const used = rubricsFor(rubrics, probe, opts.allCriteria);
    const roles = scoredRoles(probe);
    const perRun: Record<string, Observed>[] = [];
    let capped = 0;
    let dropped = 0;
    const evidence: Evidence[] = [];
    for (let i = 0; i < opts.repeat; i++) {
      if (opts.signal?.aborted) return out;
      const result = await evaluateSession({ events, scenario, rubrics: used, provider: judge.provider, config: cfg, signal: opts.signal });
      // An abort turns unfinished participants into "run aborted" failures, which are not the judge failing: drop the whole probe.
      if (opts.signal?.aborted) return out;
      const run: Record<string, Observed> = {};
      for (const role of roles) {
        const o = observedOf(result.participants.find((p) => p.roleId === role), probe.criterion);
        run[role] = o.observed;
        if (o.capped) capped++;
        dropped += o.dropped;
        if (i === 0 && o.evidence) evidence.push(o.evidence);
      }
      perRun.push(run);
    }
    const outcome: Outcome = probe.kind === "single"
      ? { ...base, kind: "single", subject: probe.subject, expected: probe.expected, acceptable: acceptableOf(probe), runs: perRun.map((r) => r[probe.subject]!), capped, dropped, evidence }
      : { ...base, kind: "contrast", expected: probe.players, minGap: probe.min_gap, runs: perRun, capped, dropped, evidence };
    out.push(outcome);
    opts.onOutcome?.(outcome);
  }
  return out;
}
