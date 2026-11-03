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

describe("control sources and the runtime", () => {
  it("no control source outside __tests__ imports @acr/runtime other than @acr/runtime/players", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/(?:from|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("@acr/runtime")) expect(spec, f).toBe("@acr/runtime/players");
        expect(spec, f).not.toMatch(/runtime\/src/);
      }
    }
  });
});
