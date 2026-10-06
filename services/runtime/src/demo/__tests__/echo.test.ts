import { describe, expect, it } from "vitest";
import { ECHO_THRESHOLD, findEchoes, similarity, tokenSet, type EchoLine } from "../echo.js";

describe("tokenSet and similarity", () => {
  it("lower-cases, strips punctuation and drops stop words and single characters, but keeps polarity words", () => {
    expect([...tokenSet("The 45k is STILL, an extra hit to the budget!")].sort()).toEqual(["45k", "budget", "extra", "hit"]);
    expect(tokenSet("I will not approve it, no. Yes!").has("not")).toBe(true);
    expect(tokenSet("no yes").size).toBe(2);
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
  const AI = (seq: number, role: string, text: string, sceneId: string | null = "s1", fallback?: true): EchoLine => ({ seq, sceneId, role, text, ai: true, ...(fallback ? { fallback } : {}) });
  const P = (seq: number, text = "a player line", sceneId: string | null = "s1"): EchoLine => ({ seq, sceneId, role: "delivery_lead", text, ai: false });
  const A = "The budget is the problem, forty five thousand extra on the programme.";
  const B = "Forty five thousand extra on the programme: the budget is the problem.";

  it("flags two different characters near-duplicating each other for the same player line, with roles, seqs and similarity, and counts the eligible pair", () => {
    expect(findEchoes([P(1), AI(2, "client_sponsor", A), AI(3, "cfo", B)])).toEqual({
      pairs: [{ sceneId: "s1", first: { seq: 2, role: "client_sponsor" }, second: { seq: 3, role: "cfo" }, similarity: 1 }], eligible: 1,
    });
  });
  it("does not compare the same role with itself, replies to different player lines, other scenes or fallback lines", () => {
    expect(findEchoes([P(1), AI(2, "a", A), AI(3, "a", B)])).toEqual({ pairs: [], eligible: 0 });
    expect(findEchoes([P(1), AI(2, "a", A), P(3), AI(4, "b", B)])).toEqual({ pairs: [], eligible: 0 });
    expect(findEchoes([AI(2, "a", A, "s1"), AI(3, "b", B, "s2")])).toEqual({ pairs: [], eligible: 0 });
    expect(findEchoes([AI(2, "a", "Say that again please, I lost you.", "s1", true), AI(3, "b", "Say that again please, I lost you.", "s1", true)])).toEqual({ pairs: [], eligible: 0 });
  });
  it("is not fooled by opposite polarity or short replies", () => {
    expect(findEchoes([AI(1, "a", "I will approve it"), AI(2, "b", "I will not approve it")])).toMatchObject({ pairs: [], eligible: 1 });
    const longYes = "We will approve the fixed price change request on Friday, signed by the CFO.";
    const longNo = "We will not approve the fixed price change request on Friday, signed by the CFO.";
    expect(similarity(longYes, longNo)).toBeGreaterThanOrEqual(ECHO_THRESHOLD);
    expect(findEchoes([AI(1, "a", longYes), AI(2, "b", longNo)])).toMatchObject({ pairs: [], eligible: 1 });
    expect(findEchoes([AI(1, "a", "Fixed price, thanks."), AI(2, "b", "Fixed price, thanks.")])).toMatchObject({ pairs: [], eligible: 1 }); // identical but under 4 content tokens
  });
  it("a silent turn leaves no reply to compare, so it reduces the eligible pairs", () => {
    expect(findEchoes([P(1), AI(2, "a", A), AI(3, "b", B), P(4), AI(5, "a", A)]).eligible).toBe(1);
  });
  it("honours the threshold and an empty input", () => {
    expect(findEchoes([])).toEqual({ pairs: [], eligible: 0 });
    const lines = [AI(1, "a", "alpha beta gamma delta zeta"), AI(2, "b", "alpha beta gamma delta epsilon")]; // 4 of 6
    expect(findEchoes(lines).pairs).toHaveLength(1);
    expect(findEchoes(lines, 0.7).pairs).toEqual([]);
  });
});
