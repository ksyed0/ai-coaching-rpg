import { describe, expect, it } from "vitest";
import { JOIN_CODE_ALPHABET, JoinCodeRecordError, JoinCodes, MAX_JOIN_CODE_INPUT_CHARS, formatJoinCode, newJoinCode, normalizeJoinCode } from "../join-codes.js";

const ROLES = ["delivery_lead", "tech_lead", "account_manager"];
const BIND = { sessionId: "local", scenarioSha256: "a".repeat(64) };

describe("join code format (US-0033)", () => {
  it("test_newJoinCode_shape_twelve_unambiguous_symbols_in_three_groups", () => {
    for (let i = 0; i < 200; i++) {
      const c = newJoinCode();
      expect(c).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
      for (const ch of c.replace(/-/g, "")) expect(JOIN_CODE_ALPHABET).toContain(ch);
      expect(c).not.toMatch(/[ILOU]/);
    }
  });

  it("test_newJoinCode_randomness_uses_the_injected_source_for_every_symbol", () => {
    let n = 0;
    const c = newJoinCode(() => n++ % JOIN_CODE_ALPHABET.length);
    expect(c).toBe("0123-4567-89AB");
    expect(n).toBe(12);
  });

  it("test_normalizeJoinCode_case_spaces_and_hyphens_are_ignored", () => {
    expect(normalizeJoinCode(" abcd-efgh jkmn ")).toBe("ABCDEFGHJKMN");
    expect(normalizeJoinCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
    expect(formatJoinCode("abcdefghjkmn")).toBe("ABCD-EFGH-JKMN");
  });
});

describe("JoinCodes (US-0033)", () => {
  it("test_issue_one_distinct_code_per_player_role_and_each_verifies_only_for_its_role", () => {
    const { codes, plain } = JoinCodes.issue(ROLES, BIND);
    expect(Object.keys(plain).sort()).toEqual([...ROLES].sort());
    expect(new Set(Object.values(plain)).size).toBe(3);
    for (const r of ROLES) {
      expect(codes.verify(r, plain[r])).toBe(true);
      expect(codes.verify(r, plain[r]!.toLowerCase().replace(/-/g, " "))).toBe(true); // typed loosely
      for (const other of ROLES.filter((x) => x !== r)) expect(codes.verify(other, plain[r])).toBe(false);
    }
  });

  it("test_verify_missing_empty_wrong_or_overlong_code_is_refused", () => {
    const { codes, plain } = JoinCodes.issue(ROLES, BIND);
    const good = plain.delivery_lead!;
    for (const bad of [undefined, "", "   ", good.slice(0, -1), `${good}X`, "0000-0000-0000", "x".repeat(MAX_JOIN_CODE_INPUT_CHARS + 1), `${good}${" ".repeat(MAX_JOIN_CODE_INPUT_CHARS)}`]) {
      expect(codes.verify("delivery_lead", bad)).toBe(false);
    }
  });

  it("test_verify_unknown_npc_prototype_or_facilitator_role_is_refused_like_a_wrong_code", () => {
    const { codes, plain } = JoinCodes.issue(ROLES, BIND);
    for (const role of ["no_such_role", "client_sponsor", "facilitator", "__proto__", "constructor", "toString", ""]) {
      expect(codes.verify(role, plain.delivery_lead)).toBe(false);
    }
  });

  it("test_record_holds_only_hashes_and_round_trips", () => {
    const { codes, plain } = JoinCodes.issue(ROLES, BIND);
    const rec = codes.toRecord();
    const text = JSON.stringify(rec);
    for (const c of Object.values(plain)) {
      expect(text).not.toContain(c);
      expect(text).not.toContain(normalizeJoinCode(c));
    }
    expect(rec.sessionId).toBe("local");
    expect(rec.scenarioSha256).toBe(BIND.scenarioSha256);
    expect(Object.keys(rec.roles).sort()).toEqual([...ROLES].sort());
    for (const h of Object.values(rec.roles)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    const back = JoinCodes.fromRecord(JSON.parse(text));
    for (const r of ROLES) expect(back.verify(r, plain[r])).toBe(true);
    expect(back.matches({ ...BIND, roleIds: ROLES })).toBe(true);
    expect(back.matches({ ...BIND, roleIds: ROLES.slice(0, 2) })).toBe(false);
    expect(back.matches({ ...BIND, scenarioSha256: "b".repeat(64), roleIds: ROLES })).toBe(false);
    expect(back.matches({ ...BIND, sessionId: "other", roleIds: ROLES })).toBe(false);
  });

  it("test_two_issues_differ_in_salt_and_codes", () => {
    const a = JoinCodes.issue(ROLES, BIND); const b = JoinCodes.issue(ROLES, BIND);
    expect(a.codes.toRecord().salt).not.toBe(b.codes.toRecord().salt);
    expect(b.codes.verify("delivery_lead", a.plain.delivery_lead)).toBe(false);
  });

  it("test_fromRecord_malformed_input_is_refused_without_echoing_it", () => {
    const { codes } = JoinCodes.issue(ROLES, BIND);
    const good = codes.toRecord();
    const bads: unknown[] = [
      null, [], "x", { ...good, v: 2 }, { ...good, salt: "zz" }, { ...good, sessionId: 5 }, { ...good, scenarioSha256: "nope" },
      { ...good, roles: [] }, { ...good, roles: { delivery_lead: "SECRET-LOOKING-VALUE" } }, { ...good, roles: {} },
      { ...good, roles: JSON.parse('{"__proto__": "' + "a".repeat(64) + '"}') }, { ...good, extra: 1 },
    ];
    for (const bad of bads) {
      let err: unknown;
      try { JoinCodes.fromRecord(bad); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(JoinCodeRecordError);
      expect((err as Error).message).not.toContain("SECRET-LOOKING-VALUE");
    }
  });

  it("test_issue_refuses_an_empty_role_list_or_a_reserved_role", () => {
    expect(() => JoinCodes.issue([], BIND)).toThrow(/at least one player role/);
    expect(() => JoinCodes.issue(["facilitator"], BIND)).toThrow(/reserved/);
  });
});
