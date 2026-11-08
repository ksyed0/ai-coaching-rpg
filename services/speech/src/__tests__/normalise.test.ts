import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, normalise } from "../normalise.js";

/** The specification (owner decision 2026-11-08: conservative, the cleaner never rewrites a word). */
const TABLE: [string, string][] = [
  // whitespace
  ["  We can ship in May.  ", "We can ship in May."],
  ["We  can\tship\nin   May.", "We can ship in May."],
  ["We can ship.", "We can ship."],
  ["We can ship.", "We can ship."],
  ["", ""],
  ["   ", ""],
  // control, bidi and zero-width characters are removed (not turned into spaces)
  ["We\u0007 can ship.", "We can ship."],
  ["ship​ment", "shipment"],
  ["﻿Hello", "Hello"],
  ["pay ‮evil‬ now", "pay evil now"],
  ["a⁦b⁩c", "abc"],
  ["soft­ware", "software"],
  // a duplicated currency word after a currency amount
  ["It costs $11,000 dollars.", "It costs $11,000."],
  ["It costs $11,000 Dollars.", "It costs $11,000."],
  ["only $1 dollar", "only $1"],
  ["£250 pounds a day", "£250 a day"],
  ["€3.50 euros each", "€3.50 each"],
  ["€1 euro", "€1"],
  ["$5 dollars dollars", "$5"],
  // explicit non-rules: everything else stays exactly as the model wrote it
  ["forty-two thousand", "forty-two thousand"],
  ["nine thirty", "nine thirty"],
  ["ten percent", "ten percent"],
  ["one of them", "one of them"],
  ["a hundred ways", "a hundred ways"],
  ["11,000 dollars", "11,000 dollars"],
  ["$5 million dollars", "$5 million dollars"],
  ["£250 dollars", "£250 dollars"],
  ["$20 dollarsigns", "$20 dollarsigns"],
  ["Thank you.", "Thank you."],
  ["We'll ship at 9:30 — 10% faster!", "We'll ship at 9:30 — 10% faster!"],
  ["Ça va? 你好 👋🏽", "Ça va? 你好 👋🏽"],
];

describe("normalise (US-0070, spec 7.3): the conservative transcript cleaner", () => {
  it.each(TABLE)("%j becomes %j", (raw, want) => {
    expect(normalise(raw)).toBe(want);
  });

  it("has at least 20 cases and is idempotent over every one", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(20);
    for (const [raw] of TABLE) expect(normalise(normalise(raw)), raw).toBe(normalise(raw));
  });

  it("leaves no control, format (bidi, zero-width) or line-break character", () => {
    const hostile = "a\u0000b\u001fc\u007fd\u0085e؜f‎g‏h⁠i‪j⁧k\r\nl";
    const out = normalise(hostile);
    expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(out).toBe("abcdefghijk l"); // only the line break became a space
  });

  it(`cuts at ${2000} code units on a code-point boundary`, () => {
    expect(MAX_LINE_CHARS).toBe(2000);
    const long = "a".repeat(2500);
    expect(normalise(long)).toHaveLength(2000);
    // A surrogate pair straddling the cut is dropped whole, never split.
    const straddle = "a".repeat(1999) + "😀" + "b";
    const out = normalise(straddle);
    expect(out).toBe("a".repeat(1999));
    expect(normalise(out)).toBe(out);
    const fits = "a".repeat(1998) + "😀";
    expect(normalise(fits)).toBe(fits);
  });

  it("a cut that ends on a space is trimmed", () => {
    expect(normalise("a".repeat(1999) + " bcd")).toBe("a".repeat(1999));
  });
});
