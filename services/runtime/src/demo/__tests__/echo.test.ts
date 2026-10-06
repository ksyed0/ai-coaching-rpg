import { describe, expect, it } from "vitest";
import { ECHO_THRESHOLD, findEchoes, similarity, tokenSet } from "../echo.js";

describe("tokenSet and similarity", () => {
  it("lower-cases, strips punctuation and drops stop words and single characters", () => {
    expect([...tokenSet("The 45k is STILL, an extra hit to the budget!")].sort()).toEqual(["45k", "budget", "extra", "hit"]);
  });
  it("is 1 for identical meaningful words, 0 for disjoint ones and 0 when either side is empty", () => {
    expect(similarity("Forty-five thousand!", "forty five THOUSAND")).toBe(1);
    expect(similarity("fixed price contract", "weekend hiking trip")).toBe(0);
    expect(similarity("the and of", "budget")).toBe(0);
    expect(similarity("", "")).toBe(0);
  });
  it("is symmetric and between 0 and 1", () => {
    const a = "extra hit budget forty five thousand"; const b = "unplanned expense budget forty five thousand start";
    expect(similarity(a, b)).toBe(similarity(b, a));
    expect(similarity(a, b)).toBeGreaterThan(0); expect(similarity(a, b)).toBeLessThan(1);
  });
  it("catches the observed Priya and Helena echo and not a ruling", () => {
    const priya = "Forty-five thousand is still an extra hit to the budget for us.";
    expect(similarity(priya, "Forty-five thousand is a start, but it's still an unplanned extra hit to the budget.")).toBeGreaterThanOrEqual(ECHO_THRESHOLD);
    expect(similarity(priya, "Fixed price, 45k, delivered by the 14th; every day late costs you 2k. Agreed or not?")).toBeLessThan(ECHO_THRESHOLD);
  });
});

describe("findEchoes", () => {
  const L = (seq: number, role: string, text: string, sceneId: string | null = "s1", fallback?: true) => ({ seq, sceneId, role, text, ...(fallback ? { fallback } : {}) });
  it("flags consecutive near-duplicates in a scene with their roles, seqs and rounded similarity", () => {
    const r = findEchoes([L(3, "client_sponsor", "The budget is the problem, forty five thousand extra."), L(4, "cfo", "Forty five thousand extra, the budget is the problem.")]);
    expect(r).toEqual([{ sceneId: "s1", first: { seq: 3, role: "client_sponsor" }, second: { seq: 4, role: "cfo" }, similarity: 1 }]);
  });
  it("does not compare across scenes, non-adjacent replies, or fallback lines", () => {
    expect(findEchoes([L(1, "a", "same words here"), L(2, "b", "same words here", "s2")])).toEqual([]);
    expect(findEchoes([L(1, "a", "same words here"), L(2, "b", "something entirely different"), L(3, "a", "same words here")])).toEqual([]);
    expect(findEchoes([L(1, "a", "Say that again please.", "s1", true), L(2, "b", "Say that again please.", "s1", true)])).toEqual([]);
  });
  it("honours the threshold and an empty input", () => {
    expect(findEchoes([])).toEqual([]);
    const lines = [L(1, "a", "alpha beta gamma delta"), L(2, "b", "alpha beta gamma epsilon")]; // 3 of 5
    expect(findEchoes(lines)).toHaveLength(1);
    expect(findEchoes(lines, 0.7)).toEqual([]);
  });
});
