import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The web app never reaches into the runtime package (reports and the review store are served by control); checked over every source file.
const SRC = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
}

/** Every module specifier in `text`: from "x", import "x", import("x"), import(`x`), require("x"). */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

/** Whether a specifier reaches the runtime: the package by name (any subpath) or a relative path into its source. */
const reachesRuntime = (spec: string): boolean => spec.startsWith("@acr/runtime") || /runtime\/src/.test(spec);

/** The specifiers in `text` that reach the runtime. */
const violations = (text: string): string[] => specifiers(text).filter(reachesRuntime);

describe("web sources and the runtime", () => {
  it("the checker sees every import form", () => {
    const fixture = ['import a from "@acr/runtime/x";', 'import "@acr/runtime/y";', 'const b = await import("@acr/runtime/z");', "const c = await import(`@acr/runtime/t`);", 'const d = require("@acr/runtime/u");', 'export { e } from "@acr/runtime/v";'].join("\n");
    expect(specifiers(fixture)).toEqual(["@acr/runtime/x", "@acr/runtime/y", "@acr/runtime/z", "@acr/runtime/t", "@acr/runtime/u", "@acr/runtime/v"]);
    expect(violations(fixture)).toHaveLength(6);
  });

  it("the predicate reports a bad specifier and passes clean ones", () => {
    expect(violations('import a from "@acr/runtime/reports";')).toEqual(["@acr/runtime/reports"]);
    expect(violations('import a from "../../../services/runtime/src/reports";')).toEqual(["../../../services/runtime/src/reports"]);
    expect(violations('const a = await import("../runtime/src/x");')).toEqual(["../runtime/src/x"]);
    expect(violations('import a from "@acr/events"; import b from "./runtime-lookup"; import c from "node:fs";')).toEqual([]);
  });

  it("no web source outside __tests__ imports @acr/runtime or reaches into runtime/src in any form", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(20);
    const hits = files.filter((f) => violations(readFileSync(f, "utf8")).length > 0);
    expect(hits).toEqual([]);
  });
});
