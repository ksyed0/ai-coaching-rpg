import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Every module specifier in `text` (a copy of control's `specifiers`, `services/control/src/__tests__/bots/imports.test.ts`). */
function specifiers(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
}

describe("speech sources and the other services", () => {
  it("the checker sees every import form", () => {
    const fixture = ['import a from "x1";', 'import "x2";', 'const b = await import("x3");', "const c = await import(`x4`);", 'const d = require("x5");', 'export { e } from "x6";'].join("\n");
    expect(specifiers(fixture)).toEqual(["x1", "x2", "x3", "x4", "x5", "x6"]);
  });

  it("no speech source imports the runtime or the control service", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      for (const spec of specifiers(readFileSync(f, "utf8"))) {
        expect(spec, f).not.toMatch(/^@acr\/(runtime|control)(\/|$)/);
        expect(spec, f).not.toMatch(/(^|\/)(runtime|control)(\/|$)/);
      }
    }
  });

  it("protocol.ts imports only zod and @acr/events (control loads it, so nothing native may come with it)", () => {
    const text = readFileSync(path.join(SRC, "protocol.ts"), "utf8");
    expect([...new Set(specifiers(text))].sort()).toEqual(["@acr/events", "zod"]);
  });
});
