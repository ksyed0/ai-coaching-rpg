import { describe, expect, it } from "vitest";
import type { GmCase } from "../cases.js";
import { formatMetrics, summarize, type RunResult } from "../metrics.js";

const mk = (id: string, label: boolean): GmCase => ({ id, scene: { id: "s", title: "t", goal: "g" }, condition: "c", dialogue: [{ role: "a", text: "x" }], label, source: "test" });
const cases = [mk("p1", true), mk("p2", true), mk("n1", false), mk("n2", false)];
const r = (caseId: string, verdict: boolean | null, extra: Partial<RunResult> = {}): RunResult => ({ caseId, verdict, attempts: 1, latencyMs: 100, via: verdict === null ? undefined : "strict", ...extra });

describe("summarize", () => {
  it("computes parse rate, agreement, precision, recall, hits and false exits", () => {
    const m = summarize(cases, [r("p1", true), r("p2", false), r("n1", true), r("n2", false), r("p1", null, { reason: "no_json", attempts: 2 }), r("zzz", true)]);
    expect(m.runs).toBe(5); // the unknown case is ignored
    expect(m.parseRate).toBeCloseTo(4 / 5);
    expect(m.agreement).toBeCloseTo(2 / 4); // p1 true ok, n2 false ok; p2 false wrong, n1 true wrong
    expect(m.precision).toBeCloseTo(1 / 2); // answered true: p1 (met), n1 (not met)
    expect(m.recall).toBeCloseTo(1 / 3); // 3 runs on met cases, 1 answered true (the unusable one is a miss)
    expect([m.positiveHits, m.positiveRuns, m.falseExits, m.negativeRuns]).toEqual([1, 3, 1, 2]);
    expect(m.meanAttempts).toBeCloseTo(6 / 5);
    expect(m.noVerdictByReason).toEqual({ no_json: 1 });
    expect(m.viaCounts).toEqual({ strict: 4 });
    expect(m.latencyMs).toEqual({ median: 100, max: 100 });
    expect(m.perCase.find((c) => c.id === "p1")).toEqual({ id: "p1", label: true, runs: 2, trueCount: 1, falseCount: 0, noVerdict: 1 });
  });
  it("gives null ratios rather than NaN when nothing could be measured", () => {
    const m = summarize(cases, []);
    expect([m.runs, m.parseRate, m.agreement, m.precision, m.recall, m.latencyMs, m.meanAttempts]).toEqual([0, 0, null, null, null, null, 0]);
    expect(formatMetrics(m).join("\n")).toContain("n/a");
  });
  it("marks a case that disagrees with its label in the report", () => {
    const text = formatMetrics(summarize(cases, [r("p1", false), r("n1", true), r("n2", false)])).join("\n");
    expect(text).toMatch(/met\s+p1: .*<-- disagrees/);
    expect(text).toMatch(/not met n1: .*<-- disagrees/);
    expect(text).not.toMatch(/n2: .*disagrees/);
  });
});
