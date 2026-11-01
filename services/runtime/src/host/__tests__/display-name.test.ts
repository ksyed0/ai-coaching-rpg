import { describe, expect, it } from "vitest";
import { cleanFacilitatorLabel, normalizeDisplayName } from "../display-name.js";

describe("normalizeDisplayName (US-0053)", () => {
  it("accepts 60 code points and refuses 61", () => {
    expect(normalizeDisplayName("\u{1F642}".repeat(60))).toBe("\u{1F642}".repeat(60)); // 120 UTF-16 units, 60 code points
    expect(normalizeDisplayName("a".repeat(60))).toBe("a".repeat(60));
    expect(normalizeDisplayName("a".repeat(61))).toBeNull();
  });

  it("trims surrounding spaces and keeps an emoji", () => {
    expect(normalizeDisplayName("  Ana \u{1F642}  ")).toBe("Ana \u{1F642}");
  });

  it("strips a right-to-left override and zero-width characters", () => {
    expect(normalizeDisplayName("Ali‮ce")).toBe("Alice");
    expect(normalizeDisplayName("Bo​b")).toBe("Bob");
  });

  it("refuses a newline or a tab inside the name", () => {
    expect(normalizeDisplayName("Ana\nBo")).toBeNull();
    expect(normalizeDisplayName("Ana\r\nBo")).toBeNull();
    expect(normalizeDisplayName("Ana\tBo")).toBeNull();
  });

  it("refuses a name that is empty after cleaning", () => {
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("    ")).toBeNull();
    expect(normalizeDisplayName("​‌⁠")).toBeNull();
  });
});

describe("cleanFacilitatorLabel (US-0059, AC-0312)", () => {
  it("cuts at 60 code points, flattens line breaks, strips bidi and zero-width characters, and returns undefined for \"\", \"   \" and undefined", () => {
    expect(cleanFacilitatorLabel("\u{1F642}".repeat(100))).toBe("\u{1F642}".repeat(60));
    expect(cleanFacilitatorLabel("x".repeat(500))).toBe("x".repeat(60));
    expect(cleanFacilitatorLabel("a\r\nb\tc")).toBe("a b c");
    expect(cleanFacilitatorLabel("Sam\u202E")).toBe("Sam");
    expect(cleanFacilitatorLabel("Bo\u200Bb")).toBe("Bob");
    expect(cleanFacilitatorLabel("")).toBeUndefined();
    expect(cleanFacilitatorLabel("   ")).toBeUndefined();
    expect(cleanFacilitatorLabel("\u202E\u0000")).toBeUndefined();
    expect(cleanFacilitatorLabel(undefined)).toBeUndefined();
  });
});
