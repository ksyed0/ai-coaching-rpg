import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChildMessageSchema as RuntimeChild, ParentMessageSchema as RuntimeParent,
  type ChildMessage as RuntimeChildMessage, type ParentMessage as RuntimeParentMessage,
} from "../../../runtime/src/host/parent-channel.js";
import { ChildMessageSchema, ParentMessageSchema, type ChildMessage, type ParentMessage } from "../protocol.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

describe("protocol copy", () => {
  it("has the same types as the runtime's", () => {
    expectTypeOf<Equal<ParentMessage, RuntimeParentMessage>>().toEqualTypeOf<true>();
    expectTypeOf<Equal<ChildMessage, RuntimeChildMessage>>().toEqualTypeOf<true>();
  });

  const valid: unknown[] = [
    { type: "codes", codes: [{ roleId: "cfo", code: "abc-123" }] },
    { type: "codes", codes: [] },
    { type: "ready", port: 4000, status: "new", modelLabel: "local" },
    { type: "ready", port: 65535, status: "resumed", modelLabel: "m", logIdentity: "id" },
    { type: "ended" },
    { type: "reissued", requestId: "r1", code: "c" },
    { type: "reissue_failed", requestId: "r-1", reason: "no" },
  ];
  const invalid: unknown[] = [
    null, "x", [], {}, { type: "codes" }, { type: "codes", codes: [{ roleId: "cfo", code: "" }] }, { type: "codes", codes: [{ roleId: "Bad Id", code: "c" }] },
    { type: "ready", port: 0, status: "new", modelLabel: "m" }, { type: "ready", port: 70000, status: "new", modelLabel: "m" },
    { type: "ready", port: 1.5, status: "new", modelLabel: "m" }, { type: "ready", port: 1, status: "bogus", modelLabel: "m" },
    { type: "ready", port: 1, status: "new", modelLabel: "" }, { type: "ended", extra: 1 }, { type: "reissued", requestId: "../x", code: "c" },
    { type: "reissue_failed", requestId: "r", reason: "x".repeat(201) }, { type: "nope" },
  ];
  it("accepts and rejects the same child messages as the runtime", () => {
    for (const m of valid) { expect(RuntimeChild.safeParse(m).success).toBe(true); expect(ChildMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success, JSON.stringify(m)).toBe(RuntimeChild.safeParse(m).success);
    for (const m of invalid) expect(ChildMessageSchema.safeParse(m).success).toBe(false);
  });

  it("accepts and rejects the same parent messages as the runtime", () => {
    const ok: unknown[] = [{ type: "reissue", requestId: "r1", roleId: "cfo" }, { type: "reissue", requestId: "r1", roleId: "cfo", by: "Sam" }];
    const bad: unknown[] = [{ type: "reissue", requestId: "r1" }, { type: "reissue", requestId: "r1", roleId: "facilitator" }, { type: "reissue", requestId: "r 1", roleId: "cfo" },
      { type: "reissue", requestId: "r1", roleId: "cfo", by: "x".repeat(201) }, { type: "reissue", requestId: "r1", roleId: "cfo", z: 1 }, { type: "other" }, null];
    for (const m of ok) { expect(RuntimeParent.safeParse(m).success).toBe(true); expect(ParentMessageSchema.safeParse(m).success).toBe(true); }
    for (const m of bad) { expect(RuntimeParent.safeParse(m).success).toBe(false); expect(ParentMessageSchema.safeParse(m).success).toBe(false); }
  });
});
