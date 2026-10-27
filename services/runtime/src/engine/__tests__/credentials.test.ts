import { describe, expect, it } from "vitest";
import { CredentialRecordError, PlayerCredentials } from "../credentials.js";

const BIND = { sessionId: "s", scenarioSha256: "c".repeat(64) };

describe("PlayerCredentials (US-0053)", () => {
  it("test_issue_returns_a_32_hex_credential_and_verify_accepts_only_that_one", () => {
    const c = PlayerCredentials.create(BIND);
    const plain = c.issue("a", "Ada");
    expect(plain).toMatch(/^[0-9a-f]{32}$/);
    expect(c.verify("a", plain)).toBe(true);
    expect(c.verify("a", plain.replace(/.$/, plain.endsWith("0") ? "1" : "0"))).toBe(false);
    expect(c.verify("b", plain)).toBe(false);
  });

  it("test_verify_is_false_for_an_unissued_role_an_ai_role_empty_and_over_long_input", () => {
    const c = PlayerCredentials.create(BIND);
    const plain = c.issue("a", "Ada");
    expect(c.verify("ai-1", plain)).toBe(false);
    expect(c.verify("__proto__", plain)).toBe(false);
    expect(c.verify("a", "")).toBe(false);
    expect(c.verify("a", undefined)).toBe(false);
    expect(c.verify("a", plain + "0".repeat(40))).toBe(false);
    expect(() => c.verify("a", "x".repeat(100_000))).not.toThrow();
  });

  it("test_revoke_makes_verify_false_and_keeps_other_roles", () => {
    const c = PlayerCredentials.create(BIND);
    const a = c.issue("a", "Ada"); const b = c.issue("b", "Bo");
    expect(c.revoke("a")).toBe(true);
    expect(c.revoke("a")).toBe(false);
    expect(c.verify("a", a)).toBe(false);
    expect(c.has("a")).toBe(false);
    expect(c.verify("b", b)).toBe(true);
  });

  it("test_revokeAll_empties_every_role", () => {
    const c = PlayerCredentials.create(BIND);
    const a = c.issue("a", "Ada"); c.issue("b", "Bo");
    expect(c.revokeAll().sort()).toEqual(["a", "b"]);
    expect(c.verify("a", a)).toBe(false);
    expect(c.names()).toEqual({});
  });

  it("test_toRecord_holds_no_plain_credential", () => {
    const c = PlayerCredentials.create(BIND);
    const plain = c.issue("a", "Ada");
    expect(JSON.stringify(c.toRecord())).not.toContain(plain);
    expect(c.toRecord().roles.a!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("test_fromRecord_round_trips_and_keeps_verification", () => {
    const c = PlayerCredentials.create(BIND);
    const plain = c.issue("a", "Ada");
    const again = PlayerCredentials.fromRecord(JSON.parse(JSON.stringify(c.toRecord())));
    expect(again.verify("a", plain)).toBe(true);
    expect(again.matches(BIND)).toBe(true);
    expect(again.matches({ ...BIND, sessionId: "t" })).toBe(false);
  });

  it("test_fromRecord_refuses_an_extra_key_a_bad_salt_a_bad_hash_and_a_wrong_version", () => {
    const c = PlayerCredentials.create(BIND);
    c.issue("a", "Ada");
    const good = c.toRecord();
    const bad: unknown[] = [
      { ...good, extra: 1 }, { ...good, salt: "zz" }, { ...good, v: 2 }, { ...good, logIdentity: "nope" },
      { ...good, roles: { a: { hash: "not-hex", name: "Ada" } } },
      { ...good, roles: { a: { ...good.roles.a, extra: 1 } } },
      JSON.parse(`{"v":1,"sessionId":"s","scenarioSha256":"${"c".repeat(64)}","logIdentity":"${"a".repeat(32)}","salt":"${"b".repeat(32)}","roles":{"__proto__":{"hash":"${"d".repeat(64)}","name":"A"}}}`), // a real own key
      null, [],
    ];
    for (const r of bad) {
      let msg = "";
      try { PlayerCredentials.fromRecord(r); } catch (e) { expect(e).toBeInstanceOf(CredentialRecordError); msg = (e as Error).message; }
      expect(msg).not.toBe("");
      expect(msg).not.toContain("Ada");
    }
  });

  it("test_logIdentity_is_stable_across_toRecord_and_fromRecord", () => {
    const c = PlayerCredentials.create(BIND);
    expect(c.logIdentity).toMatch(/^[0-9a-f]{32}$/);
    expect(PlayerCredentials.fromRecord(c.toRecord()).logIdentity).toBe(c.logIdentity);
    expect(PlayerCredentials.create(BIND).logIdentity).not.toBe(c.logIdentity);
  });

  it("test_names_returns_the_cleaned_name_per_issued_role", () => {
    const c = PlayerCredentials.create(BIND);
    c.issue("a", "Ada"); c.issue("b", "Bo");
    expect(c.names()).toEqual({ a: "Ada", b: "Bo" });
    expect(c.nameOf("a")).toBe("Ada");
    expect(c.nameOf("z")).toBeUndefined();
  });

  it("test_issue_refuses_a_reserved_role", () => {
    expect(() => PlayerCredentials.create(BIND).issue("__proto__", "Ada")).toThrow();
  });
});
