import { describe, expect, it } from "vitest";
import { cleanBy, cleanText, parseLevel } from "../text.js";
import { ReviewUsageError } from "../errors.js";

describe("cleanText", () => {
  it("strips hidden characters and scrubs secrets before returning", () => {
    const out = cleanText(
      "ok\u202Etext \u200Bwith sk-secret-value-123",
      100,
      "--reason",
      ["sk-secret-value-123"],
    );
    expect(out).toBe("oktext with [redacted]");
  });
  it("refuses empty (after stripping) and over-long text, naming the option", () => {
    expect(() => cleanText("\u200B  ", 10, "--reason", [])).toThrow(
      /--reason must not be empty/,
    );
    expect(() => cleanText("x".repeat(11), 10, "--reason", [])).toThrow(
      /--reason is longer than 10 characters/,
    );
    expect(() => cleanText("x".repeat(100_000), 500, "--reason", [])).toThrow(
      ReviewUsageError,
    );
  });
  it("counts characters, not UTF-16 units", () => {
    expect(cleanText("😀".repeat(5), 5, "--reason", [])).toBe("😀".repeat(5));
  });
});
describe("cleanBy", () => {
  it("accepts ids and refuses everything else", () => {
    expect(cleanBy("Kamal")).toBe("Kamal");
    for (const bad of [
      "",
      "a b",
      "../x",
      "x".repeat(65),
      "a\u202Eb",
      undefined,
      3,
    ])
      expect(() => cleanBy(bad)).toThrow(/--by/);
  });
});
describe("parseLevel", () => {
  it("maps 1 to 4 and na", () => {
    expect([parseLevel("1"), parseLevel("4"), parseLevel("na")]).toEqual([
      1,
      4,
      null,
    ]);
    for (const bad of ["0", "5", "2.5", "", "N/A", undefined])
      expect(() => parseLevel(bad)).toThrow(/--level/);
  });
});

describe("cleanText length after scrubbing", () => {
  it("rejects text that a scrub lengthens past the limit", async () => {
    const { cleanText } = await import("../text.js");
    expect(() => cleanText("abc", 10, "--text", ["abc"])).not.toThrow();
    // a secret replaced by a longer marker
    const out = cleanText("abc", 100, "--text", ["abc"]);
    expect(() => cleanText("abc", out.length - 1, "--text", ["abc"])).toThrow(
      /longer than/,
    );
  });
});
