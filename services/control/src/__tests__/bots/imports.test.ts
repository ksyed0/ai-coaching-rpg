import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Every module specifier in `text`: from "x", import "x", import("x"), import(`x`), require("x"). */
export function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

/** The only runtime subpaths control may import; anything else (review store, engine internals) stays out. */
const ALLOWED = ["@acr/runtime/participant", "@acr/runtime/players", "@acr/runtime/reports"];

describe("control sources and the runtime", () => {
  it("the checker sees every import form", () => {
    const fixture = ['import a from "@acr/runtime/x";', 'import "@acr/runtime/y";', 'const b = await import("@acr/runtime/z");', "const c = await import(`@acr/runtime/t`);", 'const d = require("@acr/runtime/u");', 'export { e } from "@acr/runtime/v";'].join("\n");
    expect(specifiers(fixture)).toEqual(["@acr/runtime/x", "@acr/runtime/y", "@acr/runtime/z", "@acr/runtime/t", "@acr/runtime/u", "@acr/runtime/v"]);
  });

  it("the allowed list is exactly participant, players and reports (any other @acr/runtime subpath fails the guard)", () => {
    expect(ALLOWED).toEqual(["@acr/runtime/participant", "@acr/runtime/players", "@acr/runtime/reports"]);
    for (const other of ["@acr/runtime/review", "@acr/runtime", "@acr/runtime/participant/write", "@acr/runtime/src/review/store.js"]) expect(ALLOWED).not.toContain(other);
  });

  it("no control source outside __tests__ imports @acr/runtime other than the allowed subpaths (players, reports)", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const spec of specifiers(text)) {
        if (spec.startsWith("@acr/runtime")) expect(ALLOWED, f).toContain(spec);
        expect(spec, f).not.toMatch(/runtime\/src/);
      }
    }
  });
});
