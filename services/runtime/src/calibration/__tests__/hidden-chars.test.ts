import { describe, expect, it } from "vitest";
import { loadScenario } from "@acr/script";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HIDDEN_RANGES, hasHiddenChar, isHiddenChar, stripHidden } from "../hidden-chars.js";
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
    scan(0x1f000, 0x1faff); // emoji and their modifiers stay visible
    scan(0xdffff, 0xe0fff);
    expect(mismatches).toEqual([]);
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
});
