import { describe, expect, it } from "vitest";
import { isValidSessionId } from "@acr/events";
import { acceptableOf, ProbeSchema, type SingleProbe } from "../probe-schema.js";
import { EXPECTED_HIDDEN } from "./expected-hidden.js";

const line = (role: string, text: string) => ({ scene: "s2_client_call", role, text });
const base = {
  id: "disc-l1", criterion: "discovery", source: "handwritten", split: "tune",
  transcript: [line("client_sponsor", "Can you confirm by Friday?"), line("delivery_lead", "Yes, done.")],
};

const messages = (input: unknown): string => {
  const r = ProbeSchema.safeParse(input);
  return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
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
  it("requires approval on an excerpt probe (a human assigned the level) and keeps its drafter null", () => {
    const ex = { ...base, source: "excerpt", kind: "single", subject: "delivery_lead", expected: 2 };
    const approved = { approved_by: "kamal", approved_at: "2026-10-08T00:00:00Z" };
    expect(ProbeSchema.safeParse({ ...ex, ...approved }).success).toBe(true);
    expect(messages(ex)).toMatch(/excerpt.*approved_by.*approved_at/);
    expect(messages({ ...ex, approved_by: "kamal" })).toMatch(/excerpt.*approved_by.*approved_at/);
    expect(messages({ ...ex, approved_at: "2026-10-08T00:00:00Z" })).toMatch(/excerpt.*approved_by.*approved_at/);
    expect(messages({ ...ex, ...approved, drafter: "m" })).toMatch(/excerpt.*drafter/);
    // handwritten probes are unaffected
    expect(ProbeSchema.safeParse({ ...base, kind: "single", subject: "delivery_lead", expected: 2 }).success).toBe(true);
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
    // the id's character message states the id's own cap (58); the criterion keeps 64
    const badId = messages({ ...single, id: "Bad Id" });
    expect(badId).toMatch(/1 to 58 characters/);
    expect(badId).not.toMatch(/64/);
    expect(messages({ ...single, criterion: "Bad Criterion" })).toMatch(/1 to 64 characters/);
    // the criterion is not capped by this rule
    expect(ProbeSchema.safeParse({ ...single, criterion: tooLong }).success).toBe(true);
  });
  describe("approved_at", () => {
    const draft = { ...base, source: "drafted", kind: "single", subject: "delivery_lead", expected: 2, drafter: "m", approved_by: "kamal" };
    const excerpt = { ...base, source: "excerpt", kind: "single", subject: "delivery_lead", expected: 2, approved_by: "kamal" };
    it.each(["2026-10-08T00:00:00Z", new Date("2026-10-08T12:34:56.789Z").toISOString(), "2026-10-08T00:00:00+02:00"])("accepts the ISO-8601 datetime %s on a drafted and an excerpt probe", (at) => {
      expect(ProbeSchema.safeParse({ ...draft, approved_at: at }).success).toBe(true);
      expect(ProbeSchema.safeParse({ ...excerpt, approved_at: at }).success).toBe(true);
    });
    it.each(["yesterday", "2026-10-08", "2026-13-40T00:00:00Z", "2026-10-08 00:00:00", "tomorrow at noon"])("rejects %j on a drafted and an excerpt probe", (at) => {
      expect(ProbeSchema.safeParse({ ...draft, approved_at: at }).success).toBe(false);
      expect(ProbeSchema.safeParse({ ...excerpt, approved_at: at }).success).toBe(false);
    });
    it("lets a handwritten probe keep null", () => {
      expect(ProbeSchema.safeParse({ ...base, kind: "single", subject: "delivery_lead", expected: 2, approved_at: null }).success).toBe(true);
    });
  });
});

const inExpected = (c: number) => EXPECTED_HIDDEN.some(([a, b]) => c >= a && c <= b);
const hex = (c: number) => c.toString(16).padStart(4, "0");
const ch = (c: number) => String.fromCodePoint(c);

describe("transcript text: hidden and bidirectional control characters (Trojan Source, ASCII smuggling)", () => {
  const withText = (text: string) => ({ ...base, kind: "single", subject: "delivery_lead", expected: 1, transcript: [line("client_sponsor", "Hello."), line("delivery_lead", text)] });
  it.each(EXPECTED_HIDDEN.flatMap(([a, b]) => [a, b]).map((c) => [hex(c)]))("refuses U+%s, naming the line (1-based)", (h) => {
    const r = ProbeSchema.safeParse(withText(`Fine ${ch(parseInt(h, 16))}by me.`));
    expect(r.success).toBe(false);
    const issue = r.error!.issues.find((i) => i.message === "transcript line 2 contains hidden or bidirectional control characters")!;
    expect(issue.path).toEqual(["transcript", 1, "text"]);
  });
  const neighbours = [...new Set(EXPECTED_HIDDEN.flatMap(([a, b]) => [a - 1, b + 1]))].filter((c) => c >= 0 && !inExpected(c));
  it.each(neighbours.map((c) => [hex(c)]))("accepts the neighbour U+%s just outside a refused range", (h) => {
    expect(messages(withText(`Fine ${ch(parseInt(h, 16))}by me.`))).toBe("");
  });
  it("accepts ordinary text: accents, Cyrillic, Arabic, Hebrew, Devanagari, CJK, emoji with modifiers and FE0F, curly quotes, em dash, NBSP, U+202F, U+205F", () => {
    for (const t of ["“Yes,” she said — it’s fine.", "é ñ ü ß Café São Paulo", "Привет, команда", "مرحبا بكم", "שלום לכולם", "नमस्ते टीम", "我们周五之前确认。", "Great 👍🏽 ❤️ 🚀", "a\u00a0b\u202fc\u205fd\u2000e\u200af", "tab\tand\nnewline"]) {
      expect(messages(withText(t)), t).toBe("");
    }
  });
  it("refuses zero-width joiners and non-joiners (so ZWJ emoji families are not supported)", () => {
    expect(messages(withText("family 👨\u200d👩\u200d👧"))).toContain("transcript line 2 contains hidden");
    expect(messages(withText("می\u200cخواهم"))).toContain("transcript line 2 contains hidden");
  });
  it("refuses the same characters in drafter and approved_by", () => {
    const ok = { ...base, kind: "single", subject: "delivery_lead", expected: 1, source: "drafted", drafter: "qwen3-30b", approved_by: "Kamal", approved_at: "2026-10-07T09:00:00Z" };
    expect(messages(ok)).toBe("");
    for (const c of [0x202e, 0x200b, 0xe0041, 0x00ad, 0x0007]) {
      expect(messages({ ...ok, drafter: `qwen${ch(c)}3` }), hex(c)).toContain("must not contain hidden or bidirectional control characters");
      expect(messages({ ...ok, approved_by: `Ka${ch(c)}mal` }), hex(c)).toContain("must not contain hidden or bidirectional control characters");
    }
    expect(messages({ ...ok, approved_by: "José Ñúñez 李" })).toBe("");
  });
});
