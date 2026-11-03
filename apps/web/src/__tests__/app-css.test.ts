import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// `ul.plain` is the player's brief list (BriefPanel) and keeps its indent. The console's lists have their own class, so a later rule
// for `ul.plain` must not appear again (a second rule once removed the brief's bullets).
const css = readFileSync(join(__dirname, "..", "lib", "app.css"), "utf8");

describe("app.css", () => {
  it("has exactly one ul.plain rule, the original padding-left one", () => {
    const rules = css.match(/^ul\.plain\s*\{[^}]*\}/gm) ?? [];
    expect(rules).toEqual(["ul.plain { padding-left: 18px; }"]);
  });
  it("gives the console lists their own class", () => {
    expect(css).toMatch(/^ul\.console-list\s*\{/m);
  });
});
