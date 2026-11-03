import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLAYERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.dirname(PLAYERS);
const PACKAGES = new Set(["@acr/adapters", "@acr/events", "@acr/script"]);

/** Every module specifier in a source text: `from "x"`, a side-effect `import "x"` and `import("x")`. */
export function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of source.matchAll(re)) found.push(m[1]!);
  }
  return found;
}

/** Why a specifier, imported from a file in players/, is not allowed (undefined when it is). */
export function violation(spec: string): string | undefined {
  if (spec.startsWith("node:") || PACKAGES.has(spec)) return undefined;
  if (spec.startsWith(".")) {
    const target = path.resolve(PLAYERS, spec);
    const rel = path.relative(SRC, target).split(path.sep).join("/");
    if (rel === "players" || rel.startsWith("players/")) return undefined;
    if (rel.startsWith("agents/")) return undefined;
    if (rel === "evaluator/config.js") return undefined;
    return `${spec} (resolves to ${rel})`;
  }
  return spec;
}

const files = readdirSync(PLAYERS).filter((f) => f.endsWith(".ts"));

describe("players/ import boundary", () => {
  it("finds the module sources", () => { expect(files).toEqual(expect.arrayContaining(["index.ts", "generator.ts", "prompt.ts", "clean.ts", "provider.ts"])); });

  it("every players/*.ts import is ./, ../agents/, ../evaluator/config.js, @acr/adapters, @acr/events, @acr/script or node:", () => {
    const bad = files.flatMap((f) => specifiers(readFileSync(path.join(PLAYERS, f), "utf8")).map(violation).filter((v): v is string => v !== undefined).map((v) => `${f}: ${v}`));
    expect(bad).toEqual([]);
  });

  it("players/ never imports demo/showcase-script", () => {
    const bad = files.filter((f) => specifiers(readFileSync(path.join(PLAYERS, f), "utf8")).some((s) => /showcase-script/.test(s)));
    expect(bad).toEqual([]);
  });

  it("the checker reports a planted import in every syntax", () => {
    const planted = ['import "../host/x.js";', 'import { a } from "../host/y.js";', 'const z = await import("../host/z.js");', 'export * from "../demo/w.js";', 'import "../agents/ok.js";', 'import "lodash";'].join("\n");
    const bad = specifiers(planted).map(violation).filter((v): v is string => v !== undefined);
    expect(bad).toHaveLength(5);
    for (const needle of ["host/x.js", "host/y.js", "host/z.js", "demo/w.js", "lodash"]) expect(bad.some((b) => b.includes(needle))).toBe(true);
    expect(violation("../agents/ok.js")).toBeUndefined();
    expect(violation("../evaluator/config.js")).toBeUndefined();
    expect(violation("../evaluator/other.js")).toBeDefined();
  });
});
