import { describe, expect, it } from "vitest";
import { ProbeSchema } from "../probe-schema.js";

const line = (role: string, text: string) => ({ scene: "s2_client_call", role, text });
const base = {
  id: "disc-l1", criterion: "discovery", source: "handwritten", split: "tune",
  transcript: [line("client_sponsor", "Can you confirm by Friday?"), line("delivery_lead", "Yes, done.")],
};

describe("ProbeSchema", () => {
  it("accepts a single probe and defaults acceptable/drafter/approval", () => {
    const p = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 1 });
    expect(p.kind).toBe("single");
    expect(p.drafter).toBeNull();
    expect(p.approved_by).toBeNull();
  });
  it("accepts a contrast probe with two distinct expected levels", () => {
    const p = ProbeSchema.parse({ ...base, kind: "contrast", players: { delivery_lead: 4, account_manager: 1 }, min_gap: 2 });
    expect(p.kind).toBe("contrast");
  });
  it("rejects a contrast probe whose players share one level", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "contrast", players: { delivery_lead: 3, account_manager: 3 }, min_gap: 1 })).toThrow();
  });
  it("requires drafter, approver and time on a drafted probe", () => {
    const draft = { ...base, source: "drafted", kind: "single", subject: "delivery_lead", expected: 2 };
    expect(() => ProbeSchema.parse(draft)).toThrow();
    expect(() => ProbeSchema.parse({ ...draft, drafter: "m", approved_by: "kamal", approved_at: "2026-10-08T00:00:00Z" })).not.toThrow();
  });
  it("requires acceptable to include expected", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 4, acceptable: [2, 3] })).toThrow();
  });
  it("rejects unknown keys, a bad id, and a one-line transcript", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 1, extra: 1 })).toThrow();
    expect(() => ProbeSchema.parse({ ...base, id: "../x", kind: "single", subject: "delivery_lead", expected: 1 })).toThrow();
    expect(() => ProbeSchema.parse({ ...base, transcript: [line("delivery_lead", "x")], kind: "single", subject: "delivery_lead", expected: 1 })).toThrow();
  });
  it("accepts not_observed as an expected value", () => {
    expect(ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: "not_observed" }).kind).toBe("single");
  });
});
