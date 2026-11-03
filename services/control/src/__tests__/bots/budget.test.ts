import { describe, expect, it } from "vitest";
import { SessionBudget } from "../../bots/budget.js";

describe("SessionBudget", () => {
  it("take() is true 60 times then false", () => {
    const b = new SessionBudget(60);
    for (let i = 0; i < 60; i++) expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.used).toBe(60);
    expect(b.exhausted).toBe(true);
  });
  it("seeded with used 58 it allows 2", () => {
    const b = new SessionBudget(60, 58);
    expect(b.exhausted).toBe(false);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.used).toBe(60);
  });
  it("clamps a seed to [0, limit] and never exceeds the limit", () => {
    expect(new SessionBudget(5, 99).used).toBe(5);
    expect(new SessionBudget(5, 99).take()).toBe(false);
    expect(new SessionBudget(5, -3).used).toBe(0);
    expect(new SessionBudget(5, Number.NaN).used).toBe(0);
    const z = new SessionBudget(0);
    expect(z.take()).toBe(false);
    expect(z.used).toBe(0);
    expect(z.exhausted).toBe(true);
  });
  it("budgetAlerted starts false and is a plain flag", () => {
    const b = new SessionBudget(1);
    expect(b.budgetAlerted).toBe(false);
    b.budgetAlerted = true;
    expect(b.budgetAlerted).toBe(true);
  });
});
