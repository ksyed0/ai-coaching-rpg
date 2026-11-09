import { describe, expect, it } from "vitest";
import { MAX_IDENTITY_CHARS, parseParticipantIdentity, participantIdentity, WORKER_IDENTITY_PREFIX, workerIdentity } from "../identity.js";

// US-0071 (EPIC-0003 voice A1b, Task 4, K3): a seat's LiveKit identity is `<roleId>.g<8 hex>`; the worker's `SPEECH.<8 hex>` never
// parses as a role. Split on the LAST dot, role checked with the repo's scenario-id rule, generation checked character by character.
describe("participant identity (US-0071)", () => {
  it("round trip for tech_lead and a-b", () => {
    for (const roleId of ["tech_lead", "a-b"]) {
      const id = participantIdentity(roleId, "0123abcd");
      expect(id).toBe(`${roleId}.g0123abcd`);
      expect(parseParticipantIdentity(id)).toEqual({ roleId, generation: "0123abcd" });
    }
  });

  it("parse refuses reserved roles, upper case, extra dots, bad generations, the worker and junk", () => {
    for (const bad of ["facilitator.g0000abcd", "__proto__.gdeadbeef", "constructor.gdeadbeef", "Tech.g12345678", "a.b.g1234567", "a.G12345678", "a.g1234567z", "a.g1234567", "a.g123456789", "a.gDEADBEEF", "SPEECH.deadbeef", "", "a", ".g12345678", "a.12345678"]) {
      expect(parseParticipantIdentity(bad), bad).toBeNull();
    }
    expect(parseParticipantIdentity(undefined as unknown as string)).toBeNull();
  });

  it("build refuses a role with a dot, a reserved role and a bad generation", () => {
    expect(() => participantIdentity("a.b", "0123abcd")).toThrow(RangeError);
    expect(() => participantIdentity("facilitator", "0123abcd")).toThrow(RangeError);
    expect(() => participantIdentity("Tech", "0123abcd")).toThrow(RangeError);
    expect(() => participantIdentity("tech_lead", "0123ABCD")).toThrow(RangeError);
    expect(() => participantIdentity("tech_lead", "0123abc")).toThrow(RangeError);
  });

  it("an identity longer than 128 characters is refused before it is split; build refuses one that long too", () => {
    expect(MAX_IDENTITY_CHARS).toBe(128);
    const at128 = `${"a".repeat(118)}.g0123abcd`;
    expect(at128).toHaveLength(128);
    expect(parseParticipantIdentity(at128)).toEqual({ roleId: "a".repeat(118), generation: "0123abcd" });
    expect(participantIdentity("a".repeat(118), "0123abcd")).toBe(at128);
    expect(parseParticipantIdentity(`a${at128}`)).toBeNull();
    expect(parseParticipantIdentity(`${"a".repeat(100_000)}.g0123abcd`)).toBeNull();
    expect(() => participantIdentity("a".repeat(119), "0123abcd")).toThrow(RangeError);
  });

  it("a RangeError never quotes the input", () => {
    try { participantIdentity("Secret.Role", "zz"); } catch (err) { expect((err as Error).message).not.toContain("Secret"); }
  });

  it("the worker identity is SPEECH. plus 8 hex and never parses as a seat", () => {
    expect(WORKER_IDENTITY_PREFIX).toBe("SPEECH.");
    expect(workerIdentity("deadbeef")).toBe("SPEECH.deadbeef");
    expect(parseParticipantIdentity(workerIdentity("deadbeef"))).toBeNull();
    expect(() => workerIdentity("DEADBEEF")).toThrow(RangeError);
    expect(() => workerIdentity("dead")).toThrow(RangeError);
  });
});
