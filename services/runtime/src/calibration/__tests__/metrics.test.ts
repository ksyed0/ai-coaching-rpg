import { describe, expect, it } from "vitest";
import { agreement, bias, biasByExpected, computeMetrics, contrast, labelFor, notObserved, spread, stability, usability } from "../metrics.js";
import { DEFAULT_TARGETS } from "../targets.js";
import type { ContrastOutcome, Observed, SingleOutcome } from "../types.js";

const base = { criterion: "discovery", split: "tune" as const, source: "handwritten" as const, drafter: null, capped: 0, dropped: 0, evidence: [] };
const single = (id: string, expected: SingleOutcome["expected"], runs: Observed[], acceptable = [expected]): SingleOutcome =>
  ({ ...base, probeId: id, kind: "single", subject: "p", expected, acceptable, runs });
const cont = (id: string, expected: Record<string, 1 | 2 | 3 | 4>, run: Record<string, Observed>, minGap = 1): ContrastOutcome =>
  ({ ...base, probeId: id, kind: "contrast", expected, minGap, runs: [run] });

describe("agreement", () => {
  it("counts exact (acceptable) and within-one over usable runs, and excludes unusable ones", () => {
    const s = [single("a", 1, [1]), single("b", 2, [3]), single("c", 4, [2]), single("d", 3, ["failed"]), single("e", 4, [3], [3, 4])];
    expect(agreement(s)).toEqual({ n: 4, unusable: 1, exact: 2, withinOne: 3 });
  });
});
describe("bias", () => {
  it("is the signed mean of observed minus expected, overall and per expected level", () => {
    const s = [single("a", 1, [3]), single("b", 1, [2]), single("c", 4, [3]), single("d", 2, ["invalid"])];
    expect(bias(s)).toEqual({ n: 3, mean: (2 + 1 - 1) / 3 });
    expect(biasByExpected(s)[1]).toEqual({ n: 2, mean: 1.5 });
    expect(biasByExpected(s)[4]).toEqual({ n: 1, mean: -1 });
  });
  it("is null with no usable pairs", () => expect(bias([single("a", 2, ["failed"])]).mean).toBeNull());
});
describe("spread", () => {
  it("counts distinct numeric levels used", () => {
    expect(spread([single("a", 1, [3]), single("b", 4, [3]), single("c", 2, [3])])).toBe(1);
    expect(spread([single("a", 1, [1]), single("b", 4, [4]), single("c", 2, ["not_observed"])])).toBe(2);
  });
});
describe("notObserved", () => {
  it("computes precision and recall, null when undefined", () => {
    const s = [single("a", "not_observed", ["not_observed"]), single("b", 3, ["not_observed"]), single("c", "not_observed", [2])];
    expect(notObserved(s)).toEqual({ precision: 1 / 2, recall: 1 / 2 });
    expect(notObserved([single("a", 2, [2])])).toEqual({ precision: null, recall: null });
  });
});
describe("contrast", () => {
  it("scores ordering, pairwise ordering and the gap", () => {
    const c = [
      cont("good", { x: 4, y: 1 }, { x: 4, y: 1 }, 2),
      cont("flat", { x: 4, y: 1 }, { x: 3, y: 3 }, 2),
      cont("gap", { x: 4, y: 2 }, { x: 3, y: 2 }, 2),
      cont("bad", { x: 4, y: 1 }, { x: "failed", y: 1 }, 1),
    ];
    expect(contrast(c)).toMatchObject({ n: 4, usable: 3, ordered: 2, pairs: 3, pairsOrdered: 2, gapMet: 1 });
  });
});
describe("usability and stability", () => {
  it("counts unusable slots, capped scores and dropped quotes", () => {
    const s = [{ ...single("a", 2, [2, "invalid"]), capped: 1, dropped: 2 }];
    expect(usability(s)).toEqual({ slots: 2, unusable: 1, capped: 1, dropped: 2 });
  });
  it("reports mean population variance over repeated numeric runs", () => {
    expect(stability([single("a", 2, [2, 4]), single("b", 2, [3, 3])])).toBe(0.5);
    expect(stability([single("a", 2, [2])])).toBeNull();
  });
});
describe("labelFor", () => {
  const m = (over: Partial<ReturnType<typeof computeMetrics>> = {}) => ({ ...computeMetrics([single("a", 1, [1]), single("b", 4, [4]), cont("c", { x: 4, y: 1 }, { x: 4, y: 1 }, 2)]), ...over });
  it("passes a discriminating, unbiased judge", () => expect(labelFor(m(), DEFAULT_TARGETS).label).toBe("PASS"));
  it("fails on poor contrast ordering or large bias", () => {
    const bad = computeMetrics([cont("c", { x: 4, y: 1 }, { x: 3, y: 3 }, 2), single("a", 1, [3]), single("b", 2, [4])]);
    const r = labelFor(bad, DEFAULT_TARGETS);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/contrast ordering/);
  });
  it("warns when usability is below target", () => {
    const w = computeMetrics([single("a", 1, ["failed"]), single("b", 4, [4]), single("c", 2, [2]), single("d", 3, [3])]);
    expect(labelFor(w, DEFAULT_TARGETS).label).toBe("WARN");
  });
});
