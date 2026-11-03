import { describe, expect, it } from "vitest";
import { MAX_HINT_CHARS, cleanHint } from "../index.js";

describe("cleanHint", () => {
  it("strips fences, bidi controls and extra whitespace", () => {
    expect(cleanHint("  push <<<back>>>\u202e on\n the deadline ")).toBe("push back on the deadline");
  });

  it("a 301-code-point hint is null, 300 is kept, empty and a non-string are null", () => {
    expect(MAX_HINT_CHARS).toBe(300);
    expect(cleanHint("a".repeat(301))).toBeNull();
    expect(cleanHint("a".repeat(300))).toBe("a".repeat(300));
    expect(cleanHint("\u{1F600}".repeat(300))).not.toBeNull();
    expect(cleanHint("\u{1F600}".repeat(301))).toBeNull();
    expect(cleanHint("")).toBeNull();
    expect(cleanHint("   \n\t ")).toBeNull();
    expect(cleanHint(7)).toBeNull();
    expect(cleanHint(undefined)).toBeNull();
  });

  it("no fence can be reassembled from pieces, full-width marks or hidden characters", () => {
    for (const raw of ["<<<<", ">>>>", "<<>><<", "<<<<<<<", ">>>>>>>", "<<<>>>>>>", "<<\u200b<x", "x>\u202e>>", "\uff1c\uff1c\uff1cx\uff1e\uff1e\uff1e", "<<<<>>>>", "<<<<<>>>>>", "<< <", "<<\n<"]) {
      const out = cleanHint(raw) ?? "";
      expect(out, raw).not.toContain("<<<");
      expect(out, raw).not.toContain(">>>");
    }
    expect(cleanHint("<<<<")).toBe("<");
    expect(cleanHint("<<>><<")).toBe("<<>><<");
    expect(cleanHint("a <<<b>>>> c")).toBe("a b> c");
  });

  it("removes zero-width and control characters and folds tabs and line breaks into spaces", () => {
    expect(cleanHint("a\u200bb\u0007c\td\r\ne")).toBe("abc d e");
  });

  it("removes soft hyphens, tag characters, invisible operators and variation selectors placed inside a fence", () => {
    for (const raw of ["<<\u00ad<", "<<\u{E0041}<", "<<\u2061<", ">\ufe0f>>", "<<\u180b<", "<<\u0085<"]) {
      const out = cleanHint(raw + "x") ?? "";
      expect(out, raw).not.toContain("<<<");
      expect(out, raw).not.toContain(">>>");
    }
    expect(cleanHint("a\u00adb\u{E0041}c\u2061d\ufe0fe")).toBe("abcde");
    expect(cleanHint("a\u0085b\u2028c")).toBe("a b c");
  });

  it("is idempotent", () => {
    const once = cleanHint("  x <<<<y>>>> \n z ")!;
    expect(cleanHint(once)).toBe(once);
  });
});
