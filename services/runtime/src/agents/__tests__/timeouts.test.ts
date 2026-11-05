import { describe, expect, it } from "vitest";
import {
  gmDeadlineMs, MIN_GM_DEADLINE_MS, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseNpcTimeouts, parseTimeoutEnv,
} from "../timeouts.js";

const NAME = "NPC_FIRST_TOKEN_TIMEOUT_MS";

describe("timeout defaults", () => {
  it("are 10 s first token, 20 s reply, within 500..600000", () => {
    expect([DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]).toEqual([10_000, 20_000, 500, 600_000]);
  });
});

describe("parseTimeoutEnv", () => {
  it.each([
    ["1500", 1500], ["500", 500], ["600000", 600_000], ["  2500  ", 2500], ["\t7000\n", 7000], ["0010000", 10_000],
  ])("accepts %j as %i", (raw, value) => {
    expect(parseTimeoutEnv(NAME, raw, 10_000)).toEqual({ ok: true, value });
  });

  it.each([[undefined], [""], ["   "], ["\t\n"]])("falls back to the default for %j", (raw) => {
    expect(parseTimeoutEnv(NAME, raw, 12_345)).toEqual({ ok: true, value: 12_345 });
  });

  it.each([["1e3"], ["10s"], ["0x10"], ["-1000"], ["+1000"], ["1000.5"], ["1,000"], ["1 000"], ["abc"], ["NaN"], ["Infinity"], ["0"], ["-0"], ["١٠٠٠"]])(
    "rejects %j as not a base-10 positive integer", (raw) => {
      const r = parseTimeoutEnv(NAME, raw, 10_000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(NAME);
    },
  );

  it.each([["499"], ["600001"], ["1"], ["99999999999999999999"]])("rejects %j as out of range and states the range", (raw) => {
    const r = parseTimeoutEnv(NAME, raw, 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain(NAME); expect(r.error).toContain("500"); expect(r.error).toContain("600000"); }
  });

  it("truncates and escapes an offending value in the message", () => {
    const r = parseTimeoutEnv(NAME, "x".repeat(500) + "\u001b[31m\nSECRET", 10_000);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.length).toBeLessThan(250); expect(r.error).not.toContain("SECRET"); expect(r.error).not.toContain("\u001b"); expect(r.error).not.toContain("\n"); }
  });
});

describe("parseNpcTimeouts", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseNpcTimeouts({})).toEqual({ ok: true, firstTokenTimeoutMs: 10_000, replyTimeoutMs: 20_000 });
  });
  it("reads both variables", () => {
    expect(parseNpcTimeouts({ NPC_FIRST_TOKEN_TIMEOUT_MS: "3000", NPC_REPLY_TIMEOUT_MS: "9000" })).toEqual({ ok: true, firstTokenTimeoutMs: 3000, replyTimeoutMs: 9000 });
  });
  it("accepts reply equal to first token", () => {
    expect(parseNpcTimeouts({ NPC_FIRST_TOKEN_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "5000" }).ok).toBe(true);
  });
  it("rejects reply below first token and names both variables", () => {
    const r = parseNpcTimeouts({ NPC_FIRST_TOKEN_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "4999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toMatch(/NPC_REPLY_TIMEOUT_MS.*NPC_FIRST_TOKEN_TIMEOUT_MS/);
  });
  it("checks the default reply against a raised first token (first token 30000 > default reply 20000)", () => {
    const r = parseNpcTimeouts({ NPC_FIRST_TOKEN_TIMEOUT_MS: "30000" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain("NPC_REPLY_TIMEOUT_MS");
  });
  it("a lowered reply with the default first token (10000) is rejected too", () => {
    expect(parseNpcTimeouts({ NPC_REPLY_TIMEOUT_MS: "9999" }).ok).toBe(false);
  });
  it("reports both individual errors at once", () => {
    const r = parseNpcTimeouts({ NPC_FIRST_TOKEN_TIMEOUT_MS: "1e3", NPC_REPLY_TIMEOUT_MS: "0x10" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors).toHaveLength(2); expect(r.errors[0]).toContain("NPC_FIRST_TOKEN_TIMEOUT_MS"); expect(r.errors[1]).toContain("NPC_REPLY_TIMEOUT_MS"); }
  });
});

describe("gmDeadlineMs", () => {
  it("is max(reply timeout, 60 s): one computation for the Game Master call and the showcase bounds", () => {
    expect(MIN_GM_DEADLINE_MS).toBe(60_000);
    expect(gmDeadlineMs(20_000)).toBe(60_000);
    expect(gmDeadlineMs(60_000)).toBe(60_000);
    expect(gmDeadlineMs(180_000)).toBe(180_000);
  });
});
