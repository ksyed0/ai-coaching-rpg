import { describe, expect, it } from "vitest";
import { codeSecrets, parseJoinCodesEnv } from "../ctx.js";

describe("pnpm demo --url: JOIN_CODES (US-0033)", () => {
  it("test_parseJoinCodesEnv_reads_role_code_pairs_and_an_empty_value_as_none", () => {
    expect(parseJoinCodesEnv(undefined)).toEqual({ ok: true, codes: {} });
    expect(parseJoinCodesEnv("  ")).toEqual({ ok: true, codes: {} });
    expect(parseJoinCodesEnv(" delivery_lead=ABCD-EFGH-JKMN, tech_lead = 0000-1111-2222 ,")).toEqual({ ok: true, codes: { delivery_lead: "ABCD-EFGH-JKMN", tech_lead: "0000-1111-2222" } });
  });
  it.each(["delivery_lead", "=ABCD-EFGH-JKMN", "delivery_lead=SHORT", "bad role=ABCD-EFGH-JKMN", "a=ABCD-EFGH-JKMN,a=0000-1111-2222"])("test_parseJoinCodesEnv_refuses_%j_without_quoting_it", (raw) => {
    const r = parseJoinCodesEnv(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("JOIN_CODES"); expect(r.error).not.toContain("ABCD"); expect(r.error).not.toContain("SHORT"); }
  });
  it("test_codeSecrets_lists_the_shown_and_the_compared_form", () => {
    expect(codeSecrets({ a: "ABCD-EFGH-JKMN" })).toEqual(["ABCD-EFGH-JKMN", "ABCDEFGHJKMN"]);
  });
});
