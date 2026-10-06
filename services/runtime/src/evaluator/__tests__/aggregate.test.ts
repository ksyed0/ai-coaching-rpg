import { describe, expect, it } from "vitest";
import { aggregateObjectives, confidenceFromEvidence, deriveConfidence, levelLabel, loLabel, loScore, parseConfidence, round1, type Score } from "../aggregate.js";

/** A small deterministic generator, so the property-style tests are reproducible. */
function rng(seed: number): () => number { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

describe("labels", () => {
  it("labels a score by the thresholds 1.5, 2.5 and 3.5", () => {
    expect([1, 1.4, 1.5, 2.4, 2.5, 3.4, 3.5, 4].map(loLabel)).toEqual([
      "Not yet demonstrated", "Not yet demonstrated", "Developing", "Developing", "Proficient", "Proficient", "Advanced", "Advanced"]);
    expect(loLabel(null)).toBe("Not observed");
    expect(levelLabel(3)).toBe("Proficient");
    expect(levelLabel(null)).toBe("Not observed");
  });
  it("rounds to one decimal", () => { expect(round1(2.45)).toBe(2.5); expect(round1(2.449)).toBe(2.4); expect(round1(3)).toBe(3); });
});

describe("loScore", () => {
  it("is the mean of the observed scores, rounded to one decimal; null when none observed", () => {
    expect(loScore([2, 3])).toBe(2.5);
    expect(loScore([1, 2, 2])).toBe(1.7);
    expect(loScore([null, 4])).toBe(4);
    expect(loScore([null, null])).toBeNull();
    expect(loScore([])).toBeNull();
  });
  it("property: always between the min and max observed score, ignores null, is order independent", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const xs = Array.from({ length: 1 + Math.floor(r() * 7) }, () => pick<Score | null>(r, [1, 2, 3, 4, null]));
      const seen = xs.filter((x): x is Score => x !== null);
      const got = loScore(xs);
      if (seen.length === 0) { expect(got).toBeNull(); continue; }
      expect(got).toBeGreaterThanOrEqual(Math.min(...seen) - 0.05);
      expect(got).toBeLessThanOrEqual(Math.max(...seen) + 0.05);
      expect(loScore([...xs].reverse())).toBe(got);
      expect(loScore([...xs, null])).toBe(got);
    }
  });
  it("property: the label is monotonic in the score", () => {
    const order = ["Not yet demonstrated", "Developing", "Proficient", "Advanced"];
    let last = 0;
    for (let x = 1; x <= 4.0001; x += 0.1) { const i = order.indexOf(loLabel(round1(x))); expect(i).toBeGreaterThanOrEqual(last); last = i; }
    expect(last).toBe(3);
  });
});

describe("confidence", () => {
  it("counts the verified quotes", () => {
    expect([0, 1, 2, 3, 9].map(confidenceFromEvidence)).toEqual(["low", "low", "medium", "high", "high"]);
  });
  it("the model can lower the confidence but never raise it; a capped score is Low", () => {
    expect(deriveConfidence(3, "high")).toBe("high");
    expect(deriveConfidence(3, "low")).toBe("low");
    expect(deriveConfidence(3, null)).toBe("medium");
    expect(deriveConfidence(1, "high")).toBe("low");
    expect(deriveConfidence(2, "high")).toBe("medium");
    expect(deriveConfidence(5, "high", true)).toBe("low");
  });
  it("property: never above the evidence level or the stated level, and monotonic in the quote count", () => {
    const rank = { low: 0, medium: 1, high: 2 } as const;
    for (const stated of ["high", "medium", "low", null] as const) {
      let last = -1;
      for (let n = 0; n < 8; n++) {
        const c = deriveConfidence(n, stated);
        expect(rank[c]).toBeLessThanOrEqual(rank[confidenceFromEvidence(n)]);
        if (stated) expect(rank[c]).toBeLessThanOrEqual(rank[stated]);
        expect(rank[c]).toBeGreaterThanOrEqual(last);
        last = rank[c];
      }
    }
  });
  it("parses a stated confidence tolerantly", () => {
    expect(parseConfidence(" HIGH ")).toBe("high");
    expect(parseConfidence("certain")).toBeNull();
    expect(parseConfidence(3)).toBeNull();
  });
});

describe("aggregateObjectives", () => {
  const los = [{ id: "LO1", statement: "s1", rubric_criteria: ["a", "b"] }, { id: "LO2", statement: "s2", rubric_criteria: ["c", "d"] }, { id: "LO3", statement: "s3", rubric_criteria: ["zzz"] }];
  it("returns one result per objective (no overall grade) using only the observed criteria", () => {
    const res = aggregateObjectives(los, new Map<string, Score | null>([["a", 3], ["b", null], ["c", 2], ["d", 3]]));
    expect(res).toHaveLength(3);
    expect(res[0]).toMatchObject({ id: "LO1", score: 3, label: "Proficient", observed: ["a"] });
    expect(res[1]).toMatchObject({ id: "LO2", score: 2.5, label: "Proficient", observed: ["c", "d"] });
    expect(res[2]).toMatchObject({ id: "LO3", score: null, label: "Not observed", observed: [] });
  });
  it("accepts a plain record too", () => {
    expect(aggregateObjectives(los, { a: 1, b: 1 })[0]).toMatchObject({ score: 1, label: "Not yet demonstrated" });
  });
});
