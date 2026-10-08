import type { Expected } from "./probe-schema.js";
import type { Evidence, Observed, Outcome } from "./types.js";

/** `expected` is the probe's expected level for the role and `acceptable` its wider acceptable set (a single probe only, when wider than [expected]); both come from the outcomes, never from a judge. */
export type Disagreement = { probeId: string; role: string; a: Observed; b: Observed; aEvidence?: Evidence; bEvidence?: Evidence; expected?: Expected; acceptable?: Expected[] };
/** `bothUnusable` counts the entries both judges ran but neither answered usably (invalid or failed, in any mix): not pairs, not disagreements. */
export type Comparison = { pairs: number; meanAbsDiff: number | null; withinOne: number; bothUnusable: number; disagreements: Disagreement[] };
type Entry = { probeId: string; role: string; observed: Observed; evidence?: Evidence; expected?: Expected; acceptable?: Expected[] };

const unusable = (o: Observed): boolean => o === "invalid" || o === "failed";

/**
 * One entry per scored (probe, role). Keyed in a Map by a JSON pair so ids and roles of any spelling are safe. A duplicate probe id and
 * role inside one array would be last-wins; it cannot occur because the loader refuses duplicate probe ids.
 */
function entries(os: Outcome[]): Map<string, Entry> {
  const m = new Map<string, Entry>();
  const add = (probeId: string, role: string, observed: Observed, evidence: Evidence | undefined, expected: Expected | undefined, acceptable?: Expected[]): void => {
    const e: Entry = { probeId, role, observed };
    if (evidence) e.evidence = evidence;
    if (expected !== undefined) e.expected = expected;
    if (expected !== undefined && acceptable && (acceptable.length !== 1 || acceptable[0] !== expected)) e.acceptable = [...acceptable];
    m.set(JSON.stringify([probeId, role]), e);
  };
  for (const o of os) {
    if (o.kind === "single") {
      add(o.probeId, o.subject, o.runs[0] ?? "failed", o.evidence.find((e) => e.role === o.subject), o.expected, o.acceptable);
    } else {
      const run = o.runs[0];
      for (const role of Object.keys(o.expected)) {
        // own-property check: a role named like an inherited member must not read the prototype
        const observed = run && Object.hasOwn(run, role) ? run[role] : undefined;
        add(o.probeId, role, observed ?? "failed", o.evidence.find((e) => e.role === role), o.expected[role]);
      }
    }
  }
  return m;
}

/**
 * Blind by construction: this consumes only the two finished outcome arrays. It never receives a judge or a
 * provider, so neither judge can see the other's answers before it has finished. Only entries both judges
 * ran are compared. A numeric pair needs a level from both; a level against not_observed, invalid or failed
 * is still a disagreement but not a pair. Evidence is carried through untouched (it may hold untrusted text).
 */
export function compareJudges(a: Outcome[], b: Outcome[]): Comparison {
  const ea = entries(a), eb = entries(b);
  const diffs: number[] = [];
  const disagreements: Disagreement[] = [];
  let bothUnusable = 0;
  for (const [key, x] of ea) {
    const y = eb.get(key);
    if (!y) continue;
    if (typeof x.observed === "number" && typeof y.observed === "number") diffs.push(Math.abs(x.observed - y.observed));
    if (unusable(x.observed) && unusable(y.observed)) { bothUnusable++; continue; }
    if (x.observed === y.observed) continue;
    const d: Disagreement = { probeId: x.probeId, role: x.role, a: x.observed, b: y.observed };
    if (x.evidence) d.aEvidence = x.evidence;
    if (y.evidence) d.bEvidence = y.evidence;
    if (x.expected !== undefined) d.expected = x.expected;
    if (x.acceptable) d.acceptable = x.acceptable;
    disagreements.push(d);
  }
  disagreements.sort((p, q) => (p.probeId < q.probeId ? -1 : p.probeId > q.probeId ? 1 : p.role < q.role ? -1 : p.role > q.role ? 1 : 0));
  const mean = diffs.length ? diffs.reduce((p, c) => p + c, 0) / diffs.length : null;
  return { pairs: diffs.length, meanAbsDiff: mean, withinOne: diffs.filter((d) => d <= 1).length, bothUnusable, disagreements };
}
