import { describe, expect, it } from "vitest";
import { isValidSessionId } from "@acr/events";
import { acceptableOf, ProbeSchema, type SingleProbe } from "../probe-schema.js";

const line = (role: string, text: string) => ({ scene: "s2_client_call", role, text });
const base = {
  id: "disc-l1", criterion: "discovery", source: "handwritten", split: "tune",
  transcript: [line("client_sponsor", "Can you confirm by Friday?"), line("delivery_lead", "Yes, done.")],
};

describe("ProbeSchema", () => {
  it("accepts a single probe and defaults drafter and approval to null, leaving acceptable unset", () => {
    const p = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 1 });
    expect(p.kind).toBe("single");
    expect(p.drafter).toBeNull();
    expect(p.approved_by).toBeNull();
    expect((p as SingleProbe).acceptable).toBeUndefined();
  });
  it("acceptableOf defaults to [expected] and returns an explicit list unchanged", () => {
    const omitted = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 3 }) as SingleProbe;
    expect(acceptableOf(omitted)).toEqual([3]);
    const notObserved = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: "not_observed" }) as SingleProbe;
    expect(acceptableOf(notObserved)).toEqual(["not_observed"]);
    const given = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 3, acceptable: [2, 3] }) as SingleProbe;
    expect(acceptableOf(given)).toEqual([2, 3]);
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
  const contrast = (players: Record<string, number>, min_gap: number) => ({ ...base, kind: "contrast", players, min_gap });
  const messages = (input: unknown): string => {
    const r = ProbeSchema.safeParse(input);
    return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
  };
  it("rejects a min_gap larger than the smallest difference between distinct expected levels", () => {
    expect(messages(contrast({ delivery_lead: 4, account_manager: 3 }, 3))).toMatch(/min_gap.*smallest/);
    expect(messages(contrast({ delivery_lead: 4, account_manager: 2, tech_lead: 1 }, 2))).toMatch(/min_gap.*smallest/);
  });
  it("accepts a min_gap that every distinct pair can meet", () => {
    expect(messages(contrast({ delivery_lead: 4, account_manager: 1 }, 2))).toBe("");
    expect(messages(contrast({ delivery_lead: 4, account_manager: 1 }, 3))).toBe("");
    expect(messages(contrast({ delivery_lead: 4, account_manager: 3 }, 1))).toBe("");
    expect(messages(contrast({ delivery_lead: 4, account_manager: 2, tech_lead: 1 }, 1))).toBe("");
    // equal levels do not count as a pair that must be separated
    expect(messages(contrast({ delivery_lead: 4, account_manager: 4, tech_lead: 1 }, 3))).toBe("");
  });
  it("caps the probe id at 58 characters so probe-<id> stays a valid session id", () => {
    const ok = "a".repeat(58);
    const tooLong = "a".repeat(59);
    const single = { ...base, kind: "single", subject: "delivery_lead", expected: 1 };
    expect(ProbeSchema.safeParse({ ...single, id: ok }).success).toBe(true);
    expect(isValidSessionId(`probe-${ok}`)).toBe(true);
    const r = ProbeSchema.safeParse({ ...single, id: tooLong });
    expect(r.success).toBe(false);
    expect(messages({ ...single, id: tooLong })).toMatch(/58/);
    // the criterion is not capped by this rule
    expect(ProbeSchema.safeParse({ ...single, criterion: tooLong }).success).toBe(true);
  });
});
