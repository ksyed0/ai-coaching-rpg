import { describe, expect, it } from "vitest";
import { ModelProviderError } from "@acr/adapters";
import { describeModelFailure } from "../model-failure.js";

describe("describeModelFailure", () => {
  it("keeps the classified wording", () => {
    expect(describeModelFailure(new ModelProviderError("busy", { kind: "overloaded", transient: true, attempts: 3 }))).toBe("model error after 3 attempts (overloaded): busy");
  });
  it("names an exhausted reasoning budget as the cause of the empty reply", () => {
    const e = new ModelProviderError("raise NPC_MAX_TOKENS", { kind: "reasoning_budget", transient: true, attempts: 1 });
    expect(describeModelFailure(e)).toBe("empty reply: reasoning budget exhausted after 1 attempt (reasoning_budget): raise NPC_MAX_TOKENS");
    expect(describeModelFailure(e, ' for "c"')).toContain('for "c"');
  });
  it("wraps a plain error", () => { expect(describeModelFailure(new Error("x"))).toBe("model error: x"); });
});
