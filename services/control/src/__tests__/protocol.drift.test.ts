import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChildMessageSchema as RuntimeChild, ParentMessageSchema as RuntimeParent,
  type ChildMessage as RuntimeChildMessage, type ParentMessage as RuntimeParentMessage,
} from "../../../runtime/src/host/parent-channel.js";
import { ChildMessageSchema, ParentMessageSchema, RoleIdSchema, type ChildMessage, type ParentMessage } from "../protocol.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe("protocol copy", () => {
  it("has the same types as the runtime's", () => {
    expectTypeOf<Equal<ParentMessage, RuntimeParentMessage>>().toEqualTypeOf<true>();
    expectTypeOf<Equal<ChildMessage, RuntimeChildMessage>>().toEqualTypeOf<true>();
  });

  it("exports the role-id schema the messages use", () => {
    expect(RoleIdSchema.safeParse("tech_lead").success).toBe(true);
    expect(RoleIdSchema.safeParse("facilitator").success).toBe(false);
  });

  const valid: unknown[] = [
    { type: "codes", codes: [{ roleId: "cfo", code: "abc-123" }] },
    { type: "codes", codes: [] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local" },
    { type: "ready", port: 65535, status: "resumed", modelLabel: "m", logIdentity: "id" },
    { type: "ended" },
    { type: "reissued", requestId: "r1", code: "c" },
    { type: "reissue_failed", requestId: "r-1", reason: "no" },
    { type: "ai_roles_set", requestId: "r1", codes: [{ roleId: "tech_lead", code: "c" }] },
    { type: "ai_roles_set", requestId: "r1", codes: [] },
    { type: "ai_roles_failed", requestId: "r-1", reason: "the AI roles could not be changed" },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRoles: ["tech_lead"] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local", aiRoles: Array.from({ length: 256 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "resumed", modelLabel: "local", aiRoles: ["tech_lead"], aiCalls: 3 },
    { type: "ready", port: 4000, status: "resumed", modelLabel: "local", aiCalls: 1_000_000 },
  ];
  const invalid: unknown[] = [
    null, "x", [], {}, { type: "codes" }, { type: "codes", codes: [{ roleId: "cfo", code: "" }] }, { type: "codes", codes: [{ roleId: "Bad Id", code: "c" }] },
    { type: "ready", port: 0, status: "new", modelLabel: "m" }, { type: "ready", port: 70000, status: "new", modelLabel: "m" },
    { type: "ready", port: 1.5, status: "new", modelLabel: "m" }, { type: "ready", port: 1, status: "bogus", modelLabel: "m" },
    { type: "ready", port: 1, status: "new", modelLabel: "" }, { type: "ended", extra: 1 }, { type: "reissued", requestId: "../x", code: "c" },
    { type: "reissue_failed", requestId: "r", reason: "x".repeat(201) }, { type: "nope" },
    { type: "ai_roles_set", requestId: "r1", codes: Array.from({ length: 257 }, (_, i) => ({ roleId: `r${i}`, code: "c" })) },
    { type: "ai_roles_set", requestId: "r1", codes: [{ roleId: "facilitator", code: "c" }] }, { type: "ai_roles_set", requestId: "r1" },
    { type: "ai_roles_failed", requestId: "r", reason: "x".repeat(201) }, { type: "ai_roles_failed", requestId: "r" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: Array.from({ length: 257 }, (_, i) => `r${i}`) },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: ["facilitator"] }, { type: "ready", port: 4000, status: "new", modelLabel: "m", aiRoles: "tech_lead" },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 0 }, { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 1_000_001 },
    { type: "ready", port: 4000, status: "new", modelLabel: "m", aiCalls: 1.5 },
  ];
  it("accepts and rejects the same child messages as the runtime", () => {
    for (const m of valid) { expect(RuntimeChild.safeParse(m).success).toBe(true); expect(ChildMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(RuntimeChild.safeParse(m).success);
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success).toBe(false);
  });

  it("accepts and rejects the same parent messages as the runtime", () => {
    const ok: unknown[] = [{ type: "reissue", requestId: "r1", roleId: "cfo" }, { type: "reissue", requestId: "r1", roleId: "cfo", by: "Sam" },
      { type: "reissue", requestId: "r1", roleId: "cfo", reason: "removed" }, { type: "reissue", requestId: "r1", roleId: "cfo", by: "Sam", reason: "removed" },
      { type: "set_ai_roles", requestId: "r1", roles: [] }, { type: "set_ai_roles", requestId: "r1", roles: ["tech_lead", "delivery_lead"] },
      { type: "set_ai_roles", requestId: "r1", roles: Array.from({ length: 256 }, (_, i) => `r${i}`) },
      { type: "bot_alert", roleId: "tech_lead", message: "skipped a turn: the model did not answer" }, { type: "bot_alert", roleId: "tech_lead", message: "x".repeat(200) }];
    const bad: unknown[] = [{ type: "reissue", requestId: "r1" }, { type: "reissue", requestId: "r1", roleId: "facilitator" }, { type: "reissue", requestId: "r 1", roleId: "cfo" },
      { type: "reissue", requestId: "r1", roleId: "cfo", by: "x".repeat(201) }, { type: "reissue", requestId: "r1", roleId: "cfo", z: 1 }, { type: "reissue", requestId: "r1", roleId: "cfo", reason: "other" }, { type: "reissue", requestId: "r1", roleId: "cfo", reason: "" }, { type: "other" }, null,
      { type: "set_ai_roles", requestId: "r1", roles: Array.from({ length: 257 }, (_, i) => `r${i}`) }, { type: "set_ai_roles", requestId: "r1", roles: "tech_lead" },
      { type: "set_ai_roles", requestId: "r1", roles: ["facilitator"] }, { type: "set_ai_roles", requestId: "r1", roles: [], by: "Kim" }, { type: "set_ai_roles", requestId: "r1", roles: [], includeInGroup: true },
      { type: "set_ai_roles", requestId: "r 1", roles: [] }, { type: "set_ai_roles", roles: [] },
      { type: "bot_alert", roleId: "tech_lead", message: "x".repeat(201) }, { type: "bot_alert", roleId: "tech_lead", message: "" }, { type: "bot_alert", roleId: "facilitator", message: "m" },
      { type: "bot_alert", roleId: "tech_lead", message: "m", extra: 1 }, { type: "bot_alert", roleId: "tech_lead", message: "m", requestId: "r1" }, { type: "bot_alert", message: "m" }];
    for (const m of ok) { expect(RuntimeParent.safeParse(m).success).toBe(true); expect(ParentMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of bad) { expect(RuntimeParent.safeParse(m).success).toBe(false); expect(ParentMessageSchema.safeParse(m).success).toBe(false); }
  });
});
