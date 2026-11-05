import { describe, expect, it } from "vitest";
import { JOIN_CODE_ALPHABET, JoinCodes } from "../join-codes.js";

const BIND = { sessionId: "local", scenarioSha256: "a".repeat(64) };
const ROLES = ["delivery_lead", "tech_lead", "account_manager"];

describe("JoinCodes#withRole (US-0058)", () => {
  it("withRole replaces one hash and keeps the others verifying", () => {
    const { codes, plain } = JoinCodes.issue(ROLES, BIND);
    const before = codes.toRecord();
    const next = codes.withRole("tech_lead");
    expect(next.codes).not.toBe(codes);
    expect(next.plain).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(next.plain).not.toBe(plain.tech_lead);
    const after = next.codes.toRecord();
    expect(after.salt).toBe(before.salt);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.scenarioSha256).toBe(before.scenarioSha256);
    expect(after.roles.tech_lead).not.toBe(before.roles.tech_lead);
    expect(after.roles.delivery_lead).toBe(before.roles.delivery_lead);
    expect(after.roles.account_manager).toBe(before.roles.account_manager);
    expect(next.codes.verify("tech_lead", next.plain)).toBe(true);
    expect(next.codes.verify("tech_lead", plain.tech_lead)).toBe(false);
    expect(next.codes.verify("delivery_lead", plain.delivery_lead)).toBe(true);
    expect(next.codes.verify("account_manager", plain.account_manager)).toBe(true);
    // The original instance is immutable: its old code still verifies.
    expect(codes.verify("tech_lead", plain.tech_lead)).toBe(true);
    expect(next.codes.matches({ ...BIND, roleIds: ROLES })).toBe(true);
  });

  it("withRole uses the injected random source", () => {
    const { codes } = JoinCodes.issue(ROLES, BIND);
    let n = 0;
    const r = codes.withRole("tech_lead", () => n++ % JOIN_CODE_ALPHABET.length);
    expect(r.plain).toBe("0123-4567-89AB");
  });

  it("withRole for an unknown role throws", () => {
    const { codes } = JoinCodes.issue(ROLES, BIND);
    for (const bad of ["nobody", "", "__proto__", "constructor", "toString", "facilitator"]) {
      expect(() => codes.withRole(bad), bad).toThrow();
    }
    expect(() => JoinCodes.none().withRole("tech_lead")).toThrow();
  });
});
