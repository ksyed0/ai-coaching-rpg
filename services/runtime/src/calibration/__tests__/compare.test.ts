import { describe, expect, it } from "vitest";
import { compareJudges } from "../compare.js";
import type { ContrastOutcome, Observed, SingleOutcome } from "../types.js";

const base = { criterion: "discovery", split: "tune" as const, source: "handwritten" as const, drafter: null, capped: 0, dropped: 0 };
const ev = (role: string, r: string) => [{ role, rationale: r, quotes: ["q"] }];
const single = (id: string, run: SingleOutcome["runs"][number], r = "r", subject = "p"): SingleOutcome =>
  ({ ...base, probeId: id, kind: "single", subject, expected: 3, acceptable: [3], runs: [run], evidence: ev(subject, r) });
const contrast = (id: string, run: Record<string, Observed>, roles = ["x", "y"]): ContrastOutcome => ({
  ...base, probeId: id, kind: "contrast", expected: Object.fromEntries(roles.map((r) => [r, 4 as const])), minGap: 1, runs: [run],
  evidence: roles.flatMap((r) => ev(r, `r${r}`)),
});

describe("compareJudges", () => {
  it("pairs by probe and role, reports mean absolute difference, within-one and the disagreements with both rationales", () => {
    const a = [single("x", 3, "A says"), single("y", 1), single("z", "failed")];
    const b = [single("x", 4, "B says"), single("y", 1), single("z", 2)];
    const r = compareJudges(a, b);
    expect(r.pairs).toBe(2);
    expect(r.meanAbsDiff).toBe(0.5);
    expect(r.withinOne).toBe(2);
    expect(r.disagreements.map((d) => d.probeId).sort()).toEqual(["x", "z"]);
    const x = r.disagreements.find((d) => d.probeId === "x")!;
    expect(x.aEvidence?.rationale).toBe("A says"); expect(x.bEvidence?.rationale).toBe("B says");
  });

  it("includes every player of a contrast probe and ignores probes only one judge ran", () => {
    const r = compareJudges([contrast("c", { x: 4, y: 1 }), single("only-a", 2)], [contrast("c", { x: 3, y: 1 })]);
    expect(r.pairs).toBe(2);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]!.role).toBe("x");
  });

  it("lists only the disagreeing player of a contrast probe and finds its evidence by role", () => {
    const r = compareJudges([contrast("c", { x: 4, y: 2 })], [contrast("c", { x: 4, y: 4 })]);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({ probeId: "c", role: "y", a: 2, b: 4 });
    expect(r.disagreements[0]!.aEvidence?.rationale).toBe("ry");
    expect(r.withinOne).toBe(1);
  });

  it.each([
    ["invalid", 3], ["failed", 2], [3, "invalid"], ["not_observed", 2], [2, "not_observed"],
  ] as const)("counts %s versus %s as a disagreement but not as a numeric pair", (x, y) => {
    const r = compareJudges([single("p1", x), single("p2", 2)], [single("p1", y), single("p2", 2)]);
    expect(r.pairs).toBe(1);
    expect(r.meanAbsDiff).toBe(0);
    expect(r.withinOne).toBe(1);
    expect(r.disagreements.map((d) => d.probeId)).toEqual(["p1"]);
  });

  it("does not list an entry both judges left unusable or both called not observed", () => {
    const r = compareJudges(
      [single("a", "failed"), single("b", "invalid"), single("c", "not_observed")],
      [single("a", "failed"), single("b", "failed"), single("c", "not_observed")],
    );
    expect(r.pairs).toBe(0);
    expect(r.disagreements).toEqual([]);
  });

  it("returns a null mean (not NaN) when nothing is numerically paired, and stays JSON-serialisable", () => {
    const r = compareJudges([single("p", "failed")], [single("p", 2)]);
    expect(r.meanAbsDiff).toBeNull();
    const round = JSON.parse(JSON.stringify(r)) as typeof r;
    expect(round.meanAbsDiff).toBeNull();
    expect(round.pairs).toBe(0);
    expect(compareJudges([], []).meanAbsDiff).toBeNull();
  });

  it("is safe against prototype-like probe ids and role names", () => {
    const a = [single("__proto__", 1, "r", "constructor"), contrast("toString", { x: 4 }, ["x", "constructor"])];
    const b = [single("__proto__", 3, "r", "constructor"), contrast("toString", { x: 4 }, ["x", "constructor"])];
    const r = compareJudges(a, b);
    // the contrast "constructor" role is absent from both runs: unusable, never the inherited function
    expect(r.pairs).toBe(2);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({ probeId: "__proto__", role: "constructor", a: 1, b: 3 });
    expect(Object.getPrototypeOf(r.disagreements[0])).toBe(Object.prototype);
  });

  it("reads a contrast role missing from one judge's run as failed, never the inherited member, even when the other judge gave a level", () => {
    const a = [contrast("c", { x: 4 }, ["x", "constructor"])];
    const b = [contrast("c", { x: 4, constructor: 2 as const }, ["x", "constructor"])];
    const r = compareJudges(a, b);
    expect(r.pairs).toBe(1);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]).toMatchObject({ probeId: "c", role: "constructor", a: "failed", b: 2 });
  });

  it("does not pair entries whose probe id and role only collide when joined with a separator", () => {
    const r = compareJudges([single("a/b", 1, "r", "c")], [single("a", 4, "r", "b/c")]);
    expect(r.pairs).toBe(0);
    expect(r.disagreements).toEqual([]);
    expect(r.bothUnusable).toBe(0);
  });

  it("counts the entries both judges left unusable, in any mix of invalid and failed", () => {
    const r = compareJudges(
      [single("a", "failed"), single("b", "invalid"), single("c", "invalid"), single("d", "failed"), single("e", "not_observed"), single("f", 2)],
      [single("a", "failed"), single("b", "failed"), single("c", "invalid"), single("d", 3), single("e", "not_observed"), single("f", 2)],
    );
    expect(r.bothUnusable).toBe(3);
    expect(r.disagreements.map((d) => d.probeId)).toEqual(["d"]);
    expect(compareJudges([], []).bothUnusable).toBe(0);
  });

  it("orders disagreements by probe id then role, whatever order the judges produced them", () => {
    const a = [contrast("b", { x: 1, y: 1 }), single("c", 1), contrast("a", { x: 1, y: 1 })];
    const b = [single("c", 4), contrast("a", { x: 4, y: 4 }), contrast("b", { x: 4, y: 4 })];
    const r = compareJudges(a, b);
    expect(r.disagreements.map((d) => `${d.probeId}/${d.role}`)).toEqual(["a/x", "a/y", "b/x", "b/y", "c/p"]);
  });

  it("carries evidence through unchanged and omits evidence a judge did not give", () => {
    const noEv = { ...single("p", 1), evidence: [] };
    const r = compareJudges([noEv], [single("p", 4, "B says")]);
    expect(r.disagreements[0]!.aEvidence).toBeUndefined();
    expect(r.disagreements[0]!.bEvidence).toEqual({ role: "p", rationale: "B says", quotes: ["q"] });
  });

  it("carries the probe's expected level for the role, from the outcomes: a single's expected (and a wider acceptable set), a contrast player's level", () => {
    const wide = { ...single("w", 1, "r"), expected: 3 as const, acceptable: [3 as const, 4 as const] };
    const wideB = { ...wide, runs: [2 as const] };
    const r = compareJudges([single("s", 1), wide, contrast("c", { x: 4, y: 1 })], [single("s", 2), wideB, contrast("c", { x: 4, y: 2 })]);
    const by = (id: string) => r.disagreements.find((d) => d.probeId === id)!;
    expect(by("s")).toMatchObject({ expected: 3 });
    expect(by("s")).not.toHaveProperty("acceptable");
    expect(by("w")).toMatchObject({ expected: 3, acceptable: [3, 4] });
    expect(by("c")).toMatchObject({ role: "y", expected: 4 });
  });
  it("leaves the field out of the disagreement (not undefined) when the outcomes do not say", () => {
    const noExpected = { ...single("s", 1), expected: undefined } as unknown as SingleOutcome;
    const r = compareJudges([noExpected], [single("s", 2)]);
    expect(Object.keys(r.disagreements[0]!)).not.toContain("expected");
    expect(JSON.stringify(r.disagreements[0])).not.toContain("undefined");
  });
});
