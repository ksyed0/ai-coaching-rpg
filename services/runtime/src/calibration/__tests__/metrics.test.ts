import { describe, expect, it } from "vitest";
import { agreement, bias, biasByExpected, computeMetrics, contrast, isUsable, labelFor, notObserved, splitMetrics, spread, stability, usability } from "../metrics.js";
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
    expect(contrast(c)).toEqual({ n: 4, usable: 3, ordered: 2, pairs: 3, pairsOrdered: 2, gapMet: 1, meanGap: 4 / 3, meanRequired: 2 });
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

const numbers = (v: unknown): number[] => (typeof v === "number" ? [v] : v !== null && typeof v === "object" ? Object.values(v).flatMap(numbers) : []);
const perfect = () => [single("p1", 1, [1]), single("p2", 2, [2]), single("p3", 3, [3]), single("p4", 4, [4]), cont("c1", { x: 4, y: 1 }, { x: 4, y: 1 }, 2), cont("c2", { x: 3, y: 2 }, { x: 3, y: 2 }, 1)];

describe("isUsable", () => {
  it("accepts only levels 1-4 and not_observed", () => {
    for (const o of [1, 2, 3, 4, "not_observed"] as const) expect(isUsable(o)).toBe(true);
    for (const o of ["invalid", "failed", 0, 5, "other"]) expect(isUsable(o as Observed)).toBe(false);
  });
});

describe("metric edge cases", () => {
  it("excludes unusable runs from not-observed precision and recall", () => {
    const s = [single("a", "not_observed", ["not_observed"]), single("b", "not_observed", ["failed"]), single("c", 2, ["invalid"])];
    expect(notObserved(s)).toEqual({ precision: 1, recall: 1 });
  });
  it("treats a contrast probe with a not_observed player as unusable and keeps every number finite", () => {
    const c = [cont("a", { x: 4, y: 1 }, { x: 3, y: "not_observed" }, 2)];
    expect(contrast(c)).toEqual({ n: 1, usable: 0, ordered: 0, pairs: 0, pairsOrdered: 0, gapMet: 0, meanGap: null, meanRequired: null });
    const all = numbers(computeMetrics([single("s", 2, [2]), ...c]));
    expect(all.length).toBeGreaterThan(5);
    for (const n of all) expect(Number.isFinite(n)).toBe(true);
    expect(JSON.stringify(computeMetrics(c))).not.toMatch(/NaN/);
  });
  it("counts the gap as met when it equals minGap exactly", () => {
    expect(contrast([cont("a", { x: 4, y: 1 }, { x: 3, y: 1 }, 2)]).gapMet).toBe(1);
    expect(contrast([cont("a", { x: 4, y: 1 }, { x: 2, y: 1 }, 2)]).gapMet).toBe(0);
  });
  it("counts levels used by contrast players in spread", () => {
    expect(spread([single("a", 2, [3])], [cont("c", { x: 4, y: 1 }, { x: 4, y: 1 })])).toBe(3);
  });
  it("counts contrast slots in usability", () => {
    expect(usability([cont("c", { x: 4, y: 1 }, { x: 1, y: "failed" })])).toEqual({ slots: 2, unusable: 1, capped: 0, dropped: 0 });
  });
  it("counts a single probe with no runs as one unusable slot, consistently with agreement", () => {
    const s = [single("a", 2, [])];
    expect(usability(s)).toEqual({ slots: 1, unusable: 1, capped: 0, dropped: 0 });
    expect(agreement(s).unusable).toBe(1);
  });
  it("reports the number of distinct numeric expected levels", () => {
    expect(computeMetrics(perfect()).expectedLevels).toBe(4);
    expect(computeMetrics([single("a", "not_observed", ["not_observed"]), single("b", 2, [2])]).expectedLevels).toBe(1);
    expect(computeMetrics([]).expectedLevels).toBe(0);
  });
});

describe("splitMetrics", () => {
  const withMeta = (o: SingleOutcome, over: Partial<SingleOutcome>): SingleOutcome => ({ ...o, ...over });
  const os = [
    withMeta(single("a", 2, [2]), { split: "tune", source: "handwritten", drafter: null }),
    withMeta(single("b", 3, [3]), { split: "holdout", source: "drafted", drafter: "m1" }),
    withMeta(single("c", 1, [1]), { split: "holdout", source: "drafted", drafter: "m1" }),
  ];
  it("groups by split, source and drafter", () => {
    expect(Object.keys(splitMetrics(os, "split")).sort()).toEqual(["holdout", "tune"]);
    expect(splitMetrics(os, "split").holdout!.probes).toBe(2);
    expect(splitMetrics(os, "source").drafted!.probes).toBe(2);
    expect(splitMetrics(os, "source").handwritten!.probes).toBe(1);
  });
  it("groups a null drafter under (none)", () => {
    const r = splitMetrics(os, "drafter");
    expect(Object.keys(r).sort()).toEqual(["(none)", "m1"]);
    expect(r["(none)"]!.probes).toBe(1);
    expect(r.m1!.probes).toBe(2);
  });
  it("does not pollute or collide for a drafter named like a prototype key", () => {
    const names = ["__proto__", "constructor", "toString"];
    const r = splitMetrics(names.map((d, i) => withMeta(single(`p${i}`, 2, [2]), { drafter: d })), "drafter");
    expect(Object.getPrototypeOf(r)).toBeNull();
    expect(Object.keys(r).sort()).toEqual([...names].sort());
    for (const n of names) expect(r[n]!.probes).toBe(1);
    expect(({} as Record<string, unknown>).probes).toBeUndefined();
  });
});

describe("labelFor discrimination rules", () => {
  const T = DEFAULT_TARGETS;
  const flat = (e: SingleOutcome["expected"][]) => e.map((x, i) => single(`f${i}`, x, [3]));
  it("fails a judge that always answers 3 on singles expecting 2 and 4", () => {
    const r = labelFor(computeMetrics(flat([2, 4, 2, 4, 2, 4, 2, 4, 2, 4])), T);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/flat judge: uses only 1 distinct level\(s\) but the probes expect 2/);
  });
  it("fails a flat judge over expected levels 1-4 (needs 3 distinct)", () => {
    const r = labelFor(computeMetrics(flat([1, 4, 4, 3, 2, 4])), T);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/but the probes expect 4/);
  });
  it("fails a flat judge whose contrast probes are all unusable because of not_observed", () => {
    const cs = Array.from({ length: 10 }, (_, i) => cont(`c${i}`, { x: 4, y: 1 }, { x: 3, y: "not_observed" }, 1));
    expect(labelFor(computeMetrics([...flat([2, 4, 2, 4]), ...cs]), T).label).toBe("FAIL");
  });
  it("fails 20 flat singles plus one contrast probe with a failed player", () => {
    const m = computeMetrics([...flat(Array.from({ length: 20 }, (_, i) => ([1, 2, 3, 4] as const)[i % 4]!)), cont("c", { x: 4, y: 1 }, { x: 3, y: "failed" })]);
    expect(labelFor(m, T).label).toBe("FAIL");
  });
  it("warns, never passes, on an empty set", () => {
    const r = labelFor(computeMetrics([]), T);
    expect(r.label).toBe("WARN");
    expect(r.reasons).toContain("no usable evidence");
  });
  it("still passes a perfect judge on a starter-shaped set", () => {
    expect(labelFor(computeMetrics(perfect()), T)).toEqual({ label: "PASS", reasons: [] });
  });
  it("fails a flat judge with contrast probes on both ordering and spread", () => {
    const r = labelFor(computeMetrics([single("a", 1, [3]), single("b", 4, [3]), cont("c", { x: 4, y: 1 }, { x: 3, y: 3 }, 2)]), T);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/contrast ordering/);
    expect(r.reasons.join(" ")).toMatch(/flat judge/);
  });
  it("warns that discrimination is thinly measured with 1 usable contrast probe of 4", () => {
    const cs = [cont("c1", { x: 4, y: 1 }, { x: 4, y: 1 }), ...[2, 3, 4].map((i) => cont(`c${i}`, { x: 4, y: 1 }, { x: 4, y: "failed" }))];
    const r = labelFor(computeMetrics([...perfect().slice(0, 4), ...cs]), { ...T, minUsable: 0 });
    expect(r.label).toBe("WARN");
    expect(r.reasons).toContain("discrimination thinly measured: only 1 of 4 contrast probes were usable");
  });
  it("warns, never passes, a perfect judge with no contrast probes", () => {
    const r = labelFor(computeMetrics(perfect().slice(0, 4)), T);
    expect(r.label).toBe("WARN");
    expect(r.reasons).toContain("discrimination not measured: no contrast probes");
  });
  it("fails on bias alone when contrast ordering passes", () => {
    const m = computeMetrics([single("a", 1, [3]), single("b", 4, [4]), cont("c", { x: 4, y: 1 }, { x: 4, y: 1 })]);
    const r = labelFor(m, T);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/bias/);
    expect(r.reasons.join(" ")).not.toMatch(/contrast ordering|flat judge/);
  });
  it("warns on exact agreement below target when one is set", () => {
    const m = computeMetrics([single("a", 1, [1]), single("b", 4, [4]), single("c", 2, [3]), single("d", 3, [2]), cont("e", { x: 4, y: 1 }, { x: 4, y: 1 })]);
    expect(labelFor(m, T).label).toBe("PASS");
    const r = labelFor(m, { ...T, exactAgreement: 0.9 });
    expect(r.label).toBe("WARN");
    expect(r.reasons.join(" ")).toMatch(/exact agreement 2 of 4/);
  });
});
