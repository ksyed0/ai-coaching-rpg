import { describe, expect, it } from "vitest";
import { DEFAULT_GM_MAX_TOKENS, DEFAULT_NPC_MAX_TOKENS, MAX_TOKENS_LIMIT, MIN_TOKENS_LIMIT, parseTokenBudgets } from "../token-budgets.js";

describe("token budgets", () => {
  it("defaults are NPC 600 and GM 400, range 50..4000", () => {
    expect([DEFAULT_NPC_MAX_TOKENS, DEFAULT_GM_MAX_TOKENS, MIN_TOKENS_LIMIT, MAX_TOKENS_LIMIT]).toEqual([600, 400, 50, 4000]);
  });
  it.each([[{}], [{ NPC_MAX_TOKENS: "", GM_MAX_TOKENS: "  " }]])("unset or blank gives the defaults (%j)", (env) => {
    expect(parseTokenBudgets(env)).toEqual({ ok: true, npcMaxTokens: 600, gmMaxTokens: 400 });
  });
  it("accepts trimmed whole numbers at the bounds", () => {
    expect(parseTokenBudgets({ NPC_MAX_TOKENS: " 50 ", GM_MAX_TOKENS: "4000" })).toEqual({ ok: true, npcMaxTokens: 50, gmMaxTokens: 4000 });
    expect(parseTokenBudgets({ NPC_MAX_TOKENS: "1500" })).toEqual({ ok: true, npcMaxTokens: 1500, gmMaxTokens: 400 });
  });
  it.each([["49"], ["4001"], ["0"], ["-100"], ["1e3"], ["600.5"], ["600 tokens"], ["0x200"], ["abc"], ["+600"]])("rejects %j naming the variable and the range", (raw) => {
    for (const name of ["NPC_MAX_TOKENS", "GM_MAX_TOKENS"]) {
      const r = parseTokenBudgets({ [name]: raw });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.errors).toHaveLength(1); expect(r.errors[0]).toContain(name); expect(r.errors[0]).toMatch(/50 to 4000/); }
    }
  });
  it("reports both errors when both are bad, and quotes untrusted text safely", () => {
    const r = parseTokenBudgets({ NPC_MAX_TOKENS: "x\u0007y", GM_MAX_TOKENS: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors).toHaveLength(2); expect(r.errors.join("")).not.toContain("\u0007"); }
  });
});
