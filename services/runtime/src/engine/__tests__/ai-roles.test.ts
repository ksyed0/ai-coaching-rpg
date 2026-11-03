import { describe, expect, it } from "vitest";
import { AI_ROLES_RECORD_VERSION, AiRolesRecordError, AiRoleSet } from "../ai-roles.js";

const BIND = { sessionId: "s", scenarioSha256: "a".repeat(64), roleIds: ["account_manager", "delivery_lead", "tech_lead"] };
const good = (over: Record<string, unknown> = {}) => ({ v: 1, sessionId: "s", scenarioSha256: "a".repeat(64), roles: ["tech_lead"], ...over });

describe("AiRoleSet (US-0060)", () => {
  it("is empty by default and reports membership", () => {
    const s = AiRoleSet.empty();
    expect(s.list()).toEqual([]);
    expect(s.has("tech_lead")).toBe(false);
    s.replace(["tech_lead"]);
    expect(s.has("tech_lead")).toBe(true);
    expect(AI_ROLES_RECORD_VERSION).toBe(1);
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
    s.replace(input); input.push("x"); s.list().push("y");
    expect(s.list()).toEqual(["tech_lead"]);
  });
});
