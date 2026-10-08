import { describe, expect, it } from "vitest";
import { loadScenario } from "@acr/script";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldForComparison, HIDDEN_RANGES, hasHiddenChar, isHiddenChar, stripHidden } from "../hidden-chars.js";
import { hiddenFactRoles, printable } from "../probe-load.js";
import { EXPECTED_HIDDEN } from "./expected-hidden.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const inExpected = (c: number) => EXPECTED_HIDDEN.some(([a, b]) => c >= a && c <= b);

describe("the one hidden-character table", () => {
  it("is exactly the R25 table", () => {
    expect(HIDDEN_RANGES.map(([a, b]) => [a, b])).toEqual(EXPECTED_HIDDEN);
  });
  it("agrees with the expected table for every BMP code point and the astral tag and variation-selector planes", () => {
    const mismatches: number[] = [];
    const scan = (from: number, to: number) => { for (let c = from; c <= to; c++) if (isHiddenChar(c) !== inExpected(c)) mismatches.push(c); };
    scan(0x0000, 0xffff);
    scan(0x10000, 0x1faff); // the supplementary planes up to the emoji, incl. the hieroglyph, shorthand and musical format controls
    scan(0xdffff, 0xe1000);
    expect(mismatches).toEqual([]);
  });
  it("allows the supplementary variation selectors U+E0100-E01EF in text (R27) but refuses their neighbours", () => {
    for (const c of [0xe0100, 0xe01ef]) expect(isHiddenChar(c), c.toString(16)).toBe(false);
    for (const c of [0xe00ff, 0xe01f0, 0xe0fff]) expect(isHiddenChar(c), c.toString(16)).toBe(true);
    expect(isHiddenChar(0xe1000)).toBe(false);
  });
  it("keeps visible spaces and emoji presentation selectors", () => {
    for (const c of [0x0020, 0x00a0, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000, 0xfe0e, 0xfe0f, 0x1f3fd]) expect(isHiddenChar(c), c.toString(16)).toBe(false);
  });
  it("hasHiddenChar and stripHidden see astral tag characters", () => {
    const smuggled = "a\u{E0041}\u{E0042}b​";
    expect(hasHiddenChar(smuggled)).toBe(true);
    expect(stripHidden(smuggled)).toBe("ab");
    expect(hasHiddenChar("ab 👍🏽 ❤️")).toBe(false);
  });
});

describe("printable uses the same table (plus tab and newline, for one-line messages)", () => {
  it("replaces tag characters, soft hyphens, word joiners and variation selectors, and keeps visible text", () => {
    const out = printable("a\u{E0041}b­c⁠d︀e\t\n❤️ é");
    expect(out).toBe("a·b·c·d·e··❤️ é");
    expect([...out].some((c) => isHiddenChar(c.codePointAt(0)!))).toBe(false);
  });
});

describe("the hidden-fact check strips invisible characters before comparing", () => {
  it("catches a hidden fact smuggled with tag characters, zero-width spaces and soft hyphens, naming only the role", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios", "friday-escalation"));
    const fact = "Would accept a phased delivery after go-live if the risk is explained well";
    const smuggle = (t: string) => [...t].map((c, k) => (k % 3 === 0 ? `${c}\u{E0020}` : k % 3 === 1 ? `${c}​` : `${c}­`)).join("");
    expect(hiddenFactRoles([`Honestly? ${smuggle(fact)}.`], scenario)).toEqual(["client_sponsor"]);
    expect(hiddenFactRoles(["We would accept a phased plan."], scenario)).toEqual([]);
  });
  const FACT = "Would accept a phased delivery after go-live if the risk is explained well";
  const between = (t: string, sep: string) => [...t].join(sep);
  it("strips variation selectors (FE00-FE0F, E0100-E01EF) before comparing, though FE0E/FE0F and E0100-E01EF are allowed in text", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios", "friday-escalation"));
    for (const sep of ["\ufe0f", "\ufe0e", "\ufe00", "\u{E0100}", "\u{E01EF}"]) {
      expect(hiddenFactRoles([`So: ${between(FACT, sep)}.`], scenario), sep.codePointAt(0)!.toString(16)).toEqual(["client_sponsor"]);
    }
  });
  it("folds compatibility forms (NFKC) before comparing: a fullwidth copy of a fact is caught", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios", "friday-escalation"));
    const fullwidth = [...FACT].map((c) => (c >= "!" && c <= "~" ? String.fromCodePoint(c.codePointAt(0)! - 0x21 + 0xff01) : c === " " ? "\u3000" : c)).join("");
    expect(fullwidth).not.toContain("Would");
    expect(hiddenFactRoles([fullwidth], scenario)).toEqual(["client_sponsor"]);
    // a look-alike copy (Cyrillic а, е, о for a, e, o) is NOT caught: a known limit, documented
    const lookalike = FACT.replace(/a/g, "\u0430").replace(/e/g, "\u0435").replace(/o/g, "\u043e");
    expect(hiddenFactRoles([lookalike], scenario)).toEqual([]);
  });
  it("strips hidden characters BEFORE NFKC (R28): one between a base letter and its combining mark cannot block composition", async () => {
    const loaded = await loadScenario(path.join(REPO, "scenarios", "friday-escalation"));
    const sponsor = loaded.roles["client_sponsor"]!;
    const withAccent = { ...loaded, roles: { ...loaded.roles, client_sponsor: { ...sponsor, hidden: ["We could meet at the café near the office tomorrow"] } } } as typeof loaded;
    for (const sep of ["​", "\u{E0020}", "­", "⁠", "︀", "\u{E0100}"]) {
      const line = `Fine. We could meet at the cafe${sep}́ near the office tomorrow.`;
      expect(hiddenFactRoles([line], withAccent), sep.codePointAt(0)!.toString(16)).toEqual(["client_sponsor"]);
    }
    // the plain decomposed spelling (no hidden character) is caught too, and an unrelated line is not
    expect(hiddenFactRoles(["We could meet at the café near the office tomorrow"], withAccent)).toEqual(["client_sponsor"]);
    expect(hiddenFactRoles(["We could meet at the office tomorrow"], withAccent)).toEqual([]);
  });
});

describe("foldForComparison", () => {
  it("removes hidden characters and variation selectors, composes what they separated, and folds compatibility forms", () => {
    expect(foldForComparison("cafe​́")).toBe("café");
    expect(foldForComparison("cafe\u{E0041}́ Ａ️")).toBe("café A");
    expect(foldForComparison("é")).toBe("é");
  });
  // Why the second strip (after NFKC) is kept although no current input reaches it: on this Node's Unicode data, NFKC never turns a
  // non-hidden code point into a hidden one, so the strip after NFKC is behaviourally invisible today. It stays as a guard against a future
  // Unicode version; this test fails if that ever changes, and then the second strip is what keeps the fact check sound.
  it("NFKC of no visible code point yields a hidden character or variation selector (the second strip is a guard, not dead logic)", () => {
    const folded = (c: number) => isHiddenChar(c) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef);
    const offenders: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if ((c >= 0xd800 && c <= 0xdfff) || folded(c)) continue;
      const n = String.fromCodePoint(c).normalize("NFKC");
      if (n.length === 1 && n.codePointAt(0) === c) continue;
      for (const ch of n) if (folded(ch.codePointAt(0)!)) offenders.push(c.toString(16));
    }
    expect(offenders).toEqual([]);
  });
});
