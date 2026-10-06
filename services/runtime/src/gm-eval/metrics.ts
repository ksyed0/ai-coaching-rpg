import type { GmCase } from "./cases.js";

/** One run of one case against a Game Master. `verdict`: usable verdict (null: none); `reason`: why there was none. */
export type RunResult = { caseId: string; verdict: boolean | null; attempts: number; latencyMs: number; via?: string; reason?: string };

export type CaseSummary = { id: string; label: boolean; runs: number; trueCount: number; falseCount: number; noVerdict: number };
export type EvalMetrics = {
  runs: number;
  /** Runs that ended in a usable verdict / all runs. */
  parseRate: number;
  /** Usable verdicts that equal the label / usable verdicts (null with none). */
  agreement: number | null;
  /** Of the runs answered true, how many were labelled true (null with none answered true). */
  precision: number | null;
  /** Of the runs on cases labelled true, how many were answered true (an unusable run is a miss). */
  recall: number | null;
  /** Positive cases: runs answered true, and the runs there were (the "scenes ended" figure when each positive case is a scene). */
  positiveHits: number; positiveRuns: number;
  /** Negative controls answered true (a false exit) and the runs there were. */
  falseExits: number; negativeRuns: number;
  /** Average attempts per run (2 means every run needed the re-ask). */
  meanAttempts: number;
  latencyMs: { median: number; max: number } | null;
  noVerdictByReason: Record<string, number>;
  viaCounts: Record<string, number>;
  perCase: CaseSummary[];
};

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);
const median = (v: number[]): number | null => {
  if (v.length === 0) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Pure: the figures of a set of runs against labelled cases. Runs for an unknown case id are ignored. */
export function summarize(cases: GmCase[], results: RunResult[]): EvalMetrics {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rs = results.filter((r) => byId.has(r.caseId));
  const usable = rs.filter((r) => r.verdict !== null);
  const label = (r: RunResult) => byId.get(r.caseId)!.label;
  const answeredTrue = usable.filter((r) => r.verdict === true);
  const positives = rs.filter(label);
  const negatives = rs.filter((r) => !label(r));
  const noVerdictByReason: Record<string, number> = {};
  for (const r of rs) if (r.verdict === null) noVerdictByReason[r.reason ?? "unknown"] = (noVerdictByReason[r.reason ?? "unknown"] ?? 0) + 1;
  const viaCounts: Record<string, number> = {};
  for (const r of usable) viaCounts[r.via ?? "unknown"] = (viaCounts[r.via ?? "unknown"] ?? 0) + 1;
  const lat = median(rs.map((r) => r.latencyMs));
  return {
    runs: rs.length,
    parseRate: rs.length === 0 ? 0 : usable.length / rs.length,
    agreement: ratio(usable.filter((r) => r.verdict === label(r)).length, usable.length),
    precision: ratio(answeredTrue.filter(label).length, answeredTrue.length),
    recall: ratio(positives.filter((r) => r.verdict === true).length, positives.length),
    positiveHits: positives.filter((r) => r.verdict === true).length, positiveRuns: positives.length,
    falseExits: negatives.filter((r) => r.verdict === true).length, negativeRuns: negatives.length,
    meanAttempts: rs.length === 0 ? 0 : rs.reduce((a, r) => a + r.attempts, 0) / rs.length,
    latencyMs: lat === null ? null : { median: Math.round(lat), max: Math.max(...rs.map((r) => r.latencyMs)) },
    noVerdictByReason, viaCounts,
    perCase: cases.map((c) => {
      const mine = rs.filter((r) => r.caseId === c.id);
      return { id: c.id, label: c.label, runs: mine.length, trueCount: mine.filter((r) => r.verdict === true).length, falseCount: mine.filter((r) => r.verdict === false).length, noVerdict: mine.filter((r) => r.verdict === null).length };
    }),
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);

/** The plain-text report of the metrics. */
export function formatMetrics(m: EvalMetrics): string[] {
  const out = [
    `runs ${m.runs}; usable verdict ${pct(m.parseRate)}; agreement with the labels ${pct(m.agreement)}; precision ${pct(m.precision)}; recall ${pct(m.recall)}`,
    `positive cases answered true: ${m.positiveHits} of ${m.positiveRuns} runs; false exits on negative controls: ${m.falseExits} of ${m.negativeRuns} runs`,
    `mean attempts ${m.meanAttempts.toFixed(2)} (2 = every run needed the re-ask); latency ${m.latencyMs ? `median ${m.latencyMs.median} ms, max ${m.latencyMs.max} ms` : "n/a"}`,
    `read via: ${Object.entries(m.viaCounts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; no usable verdict by reason: ${Object.entries(m.noVerdictByReason).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
  ];
  for (const c of m.perCase) out.push(`  ${c.label ? "met    " : "not met"} ${c.id}: true ${c.trueCount}, false ${c.falseCount}, no verdict ${c.noVerdict} of ${c.runs}${c.runs > 0 && (c.label ? c.trueCount < c.runs : c.trueCount > 0) ? "  <-- disagrees" : ""}`);
  return out;
}
