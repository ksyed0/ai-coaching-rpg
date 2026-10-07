import type { Expected, Level } from "./probe-schema.js";
import type { Targets } from "./targets.js";
import type { ContrastOutcome, Observed, Outcome, SingleOutcome } from "./types.js";

export const isUsable = (o: Observed): o is Expected => o !== "invalid" && o !== "failed";
const isLevel = (o: Observed | Expected): o is Level => typeof o === "number";
const singles = (o: Outcome[]): SingleOutcome[] => o.filter((x): x is SingleOutcome => x.kind === "single");
const contrasts = (o: Outcome[]): ContrastOutcome[] => o.filter((x): x is ContrastOutcome => x.kind === "contrast");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function agreement(ss: SingleOutcome[]): { n: number; unusable: number; exact: number; withinOne: number } {
  let n = 0, unusable = 0, exact = 0, withinOne = 0;
  for (const s of ss) {
    const o = s.runs[0];
    if (o === undefined || !isUsable(o)) { unusable++; continue; }
    n++;
    if (s.acceptable.includes(o)) exact++;
    if (o === s.expected || (isLevel(o) && isLevel(s.expected) && Math.abs(o - s.expected) <= 1)) withinOne++;
  }
  return { n, unusable, exact, withinOne };
}

function diffs(ss: SingleOutcome[]): { expected: Level; diff: number }[] {
  const out: { expected: Level; diff: number }[] = [];
  for (const s of ss) {
    const o = s.runs[0];
    if (o !== undefined && isLevel(o) && isLevel(s.expected)) out.push({ expected: s.expected, diff: o - s.expected });
  }
  return out;
}
export const bias = (ss: SingleOutcome[]): { n: number; mean: number | null } => { const d = diffs(ss); return { n: d.length, mean: mean(d.map((x) => x.diff)) }; };
export function biasByExpected(ss: SingleOutcome[]): Record<Level, { n: number; mean: number | null }> {
  const d = diffs(ss);
  const at = (l: Level) => { const xs = d.filter((x) => x.expected === l).map((x) => x.diff); return { n: xs.length, mean: mean(xs) }; };
  return { 1: at(1), 2: at(2), 3: at(3), 4: at(4) };
}

export function spread(ss: SingleOutcome[], cs: ContrastOutcome[] = []): number {
  const seen = new Set<number>();
  for (const s of ss) { const o = s.runs[0]; if (o !== undefined && isLevel(o)) seen.add(o); }
  for (const c of cs) for (const o of Object.values(c.runs[0] ?? {})) if (isLevel(o)) seen.add(o);
  return seen.size;
}

export function notObserved(ss: SingleOutcome[]): { precision: number | null; recall: number | null } {
  let tp = 0, fp = 0, fn = 0;
  for (const s of ss) {
    const o = s.runs[0];
    if (o === undefined || !isUsable(o)) continue;
    if (o === "not_observed" && s.expected === "not_observed") tp++;
    else if (o === "not_observed") fp++;
    else if (s.expected === "not_observed") fn++;
  }
  return { precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

export function contrast(cs: ContrastOutcome[]): { n: number; usable: number; ordered: number; pairs: number; pairsOrdered: number; gapMet: number; meanGap: number | null; meanRequired: number | null } {
  let usable = 0, ordered = 0, pairs = 0, pairsOrdered = 0, gapMet = 0;
  const gaps: number[] = [], required: number[] = [];
  for (const c of cs) {
    const run = c.runs[0] ?? {};
    const roles = Object.keys(c.expected);
    if (!roles.every((r) => isLevel(run[r] ?? "failed"))) continue;
    usable++;
    let all = true;
    for (const a of roles) for (const b of roles) {
      if (c.expected[a]! <= c.expected[b]!) continue;
      pairs++;
      const gap = (run[a] as number) - (run[b] as number);
      gaps.push(gap); required.push(c.minGap);
      if (gap > 0) pairsOrdered++; else all = false;
      if (gap >= c.minGap) gapMet++;
    }
    if (all) ordered++;
  }
  return { n: cs.length, usable, ordered, pairs, pairsOrdered, gapMet, meanGap: mean(gaps), meanRequired: mean(required) };
}

export function usability(os: Outcome[]): { slots: number; unusable: number; capped: number; dropped: number } {
  let slots = 0, unusable = 0, capped = 0, dropped = 0;
  for (const o of os) {
    capped += o.capped; dropped += o.dropped;
    if (o.kind === "single") for (const r of o.runs) { slots++; if (!isUsable(r)) unusable++; }
    else for (const run of o.runs) for (const r of Object.values(run)) { slots++; if (!isUsable(r)) unusable++; }
  }
  return { slots, unusable, capped, dropped };
}

export function stability(ss: SingleOutcome[]): number | null {
  const vars: number[] = [];
  for (const s of ss) {
    const xs = s.runs.filter(isLevel);
    if (s.runs.length < 2 || xs.length < 2) continue;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    vars.push(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }
  return mean(vars);
}

export function computeMetrics(os: Outcome[]) {
  const ss = singles(os), cs = contrasts(os);
  return { probes: os.length, agreement: agreement(ss), bias: bias(ss), biasByExpected: biasByExpected(ss), spread: spread(ss, cs), notObserved: notObserved(ss), contrast: contrast(cs), usability: usability(os), stability: stability(ss) };
}
export type JudgeMetrics = ReturnType<typeof computeMetrics>;

export function splitMetrics(os: Outcome[], key: "split" | "source" | "drafter"): Record<string, JudgeMetrics> {
  const groups = new Map<string, Outcome[]>();
  for (const o of os) { const k = String(o[key] ?? "none"); groups.set(k, [...(groups.get(k) ?? []), o]); }
  return Object.fromEntries([...groups].map(([k, v]) => [k, computeMetrics(v)]));
}

export function labelFor(m: JudgeMetrics, t: Targets): { label: "PASS" | "WARN" | "FAIL"; reasons: string[] } {
  const fail: string[] = [], warn: string[] = [];
  if (m.contrast.usable > 0 && m.contrast.ordered / m.contrast.usable < t.contrastOrdering) {
    fail.push(`contrast ordering ${m.contrast.ordered} of ${m.contrast.usable} is below ${Math.round(t.contrastOrdering * 100)}%`);
  }
  if (m.bias.mean !== null && Math.abs(m.bias.mean) > t.maxAbsBias) fail.push(`bias ${m.bias.mean.toFixed(2)} levels exceeds ${t.maxAbsBias}`);
  if (m.usability.slots > 0 && 1 - m.usability.unusable / m.usability.slots < t.minUsable) warn.push(`only ${m.usability.slots - m.usability.unusable} of ${m.usability.slots} answers were usable`);
  if (t.exactAgreement !== null && m.agreement.n > 0 && m.agreement.exact / m.agreement.n < t.exactAgreement) warn.push(`exact agreement ${m.agreement.exact} of ${m.agreement.n} is below ${Math.round(t.exactAgreement * 100)}%`);
  return fail.length ? { label: "FAIL", reasons: [...fail, ...warn] } : warn.length ? { label: "WARN", reasons: warn } : { label: "PASS", reasons: [] };
}
