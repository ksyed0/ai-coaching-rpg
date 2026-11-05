import { describe, expect, it } from "vitest";
import { AI_ROLES_RECORD_VERSION, AiRolesRecordError, AiRoleSet } from "../ai-roles.js";

const BIND = { sessionId: "s", scenarioSha256: "a".repeat(64), roleIds: ["account_manager", "delivery_lead", "tech_lead"] };
const good = (over: Record<string, unknown> = {}) => ({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: ["tech_lead"], ...over });

describe("AiRoleSet (US-0060)", () => {
  it("is empty by default and reports membership", () => {
    const s = AiRoleSet.empty();
    expect(s.list()).toEqual([]);
    expect(s.has("tech_lead")).toBe(false);
    s.replace(["tech_lead"], BIND.roleIds);
    expect(s.has("tech_lead")).toBe(true);
    expect(AI_ROLES_RECORD_VERSION).toBe(2);
    expect(s.includeInGroup).toBe(true);
  });

  it("fromRecord refuses another session, another scenario hash, v 2, an extra key, a role outside the bind, a duplicate and a non-array, and no message contains the value \"SECRET-ROLE-X\"", () => {
    const SECRET = "SECRET-ROLE-X";
    const cases: unknown[] = [
      good({ sessionId: SECRET }), good({ scenarioSha256: "b".repeat(64) }), good({ v: 2 }), good({ extra: SECRET }),
      good({ roles: [SECRET] }), good({ roles: ["tech_lead", "tech_lead"] }), good({ roles: SECRET }), good({ roles: [5] }),
      good({ scenarioSha256: SECRET }), good({ roles: ["account_manager", "delivery_lead", "tech_lead", SECRET] }),
      null, [], SECRET, { v: 1 },
    ];
    for (const raw of cases) {
      let thrown: unknown;
      try { AiRoleSet.fromRecord(raw, BIND); } catch (e) { thrown = e; }
      expect(thrown, JSON.stringify(raw)).toBeInstanceOf(AiRolesRecordError);
      expect((thrown as Error).message).not.toContain(SECRET);
    }
  });

  it("toRecord then fromRecord keeps the roles in bind order", () => {
    const rec = good({ roles: ["tech_lead", "account_manager"] }); // out of order on disk
    const s = AiRoleSet.fromRecord(rec, BIND);
    expect(s.list()).toEqual(["account_manager", "tech_lead"]);
    const out = s.toRecord(BIND);
    expect(out).toEqual({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: ["account_manager", "tech_lead"] });
    expect(AiRoleSet.fromRecord(JSON.parse(JSON.stringify(out)), BIND).list()).toEqual(["account_manager", "tech_lead"]);
  });

  it("list returns a copy and replace copies its input", () => {
    const s = AiRoleSet.empty(); const input = ["tech_lead"];
    s.replace(input, BIND.roleIds); input.push("x"); s.list().push("y");
    expect(s.list()).toEqual(["tech_lead"]);
  });

  it("replace keeps only distinct player roles of the bind, in bind order", () => {
    const s = AiRoleSet.empty();
    s.replace(["tech_lead", "ghost", "account_manager", "tech_lead", "__proto__", "client_sponsor"], BIND.roleIds);
    expect(s.list()).toEqual(["account_manager", "tech_lead"]);
    s.replace(["nobody"], BIND.roleIds);
    expect(s.list()).toEqual([]);
    s.replace(["delivery_lead", 5 as unknown as string, null as unknown as string], BIND.roleIds);
    expect(s.list()).toEqual(["delivery_lead"]);
  });

  it("a v1 record reads with includeInGroup true", () => {
    expect(AiRoleSet.fromRecord(good(), BIND).includeInGroup).toBe(true);
  });

  it("a set with the option on writes a v1 record byte-identical to 3b's", () => {
    const s = AiRoleSet.fromRecord(good({ roles: ["tech_lead", "account_manager"] }), BIND);
    s.setIncludeInGroup(false); s.setIncludeInGroup(true);
    expect(JSON.stringify(s.toRecord(BIND))).toBe(
      '{"v":1,"sessionId":"s","scenarioSha256":"' + "a".repeat(64) + '","roles":["account_manager","tech_lead"]}');
  });

  it("a set with the option off writes v2 with includeInGroup false and reads back off", () => {
    const s = AiRoleSet.empty(); s.replace(["tech_lead"], BIND.roleIds); s.setIncludeInGroup(false);
    const out = s.toRecord(BIND);
    expect(out).toEqual({ v: 2, sessionId: "s", scenarioSha256: "a".repeat(64), roles: ["tech_lead"], includeInGroup: false });
    const back = AiRoleSet.fromRecord(JSON.parse(JSON.stringify(out)), BIND);
    expect(back.includeInGroup).toBe(false);
    expect(back.list()).toEqual(["tech_lead"]);
  });

  it("a v2 record with includeInGroup \"false\", true, null, a missing includeInGroup or an extra key is refused without quoting it", () => {
    const SECRET = "SECRET-OPTION-X";
    const v2 = (over: Record<string, unknown> = {}) => good({ v: 2, includeInGroup: false, ...over });
    const missing = v2(); delete (missing as Record<string, unknown>).includeInGroup;
    const cases: unknown[] = [v2({ includeInGroup: "false" }), v2({ includeInGroup: true }), v2({ includeInGroup: null }), v2({ includeInGroup: SECRET }), v2({ includeInGroup: 0 }),
      missing, v2({ extra: SECRET }), good({ includeInGroup: false }), good({ v: 3, includeInGroup: false }), v2({ v: 1 })];
    for (const raw of cases) {
      let thrown: unknown;
      try { AiRoleSet.fromRecord(raw, BIND); } catch (e) { thrown = e; }
      expect(thrown, JSON.stringify(raw)).toBeInstanceOf(AiRolesRecordError);
      expect((thrown as Error).message).not.toContain(SECRET);
    }
    let t: unknown;
    try { AiRoleSet.fromRecord(v2({ includeInGroup: "false" }), BIND); } catch (e) { t = e; }
    expect((t as Error).message).toBe("the AI-role file has an invalid group-score option");
  });
});
