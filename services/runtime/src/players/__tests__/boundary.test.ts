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

  it("the transitive closure of players/ stays out of host/, engine/, cli/ and demo/ and uses only allowed packages", () => {
    const { files: closure, externals } = closureOf(files.map((f) => path.join(PLAYERS, f)), (f) => readFileSync(f, "utf8"));
    expect(closure.length).toBeGreaterThan(files.length);
    const rel = closure.map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(rel.filter((r) => /^(host|engine|cli|demo)\//.test(r))).toEqual([]);
    expect(externals.filter((e) => !externalOk(e))).toEqual([]);
  });

  it("the closure walker follows relative imports and reports a planted forbidden file and package", () => {
    const fake: Record<string, string> = {
      [path.join(SRC, "players/a.ts")]: 'import "../agents/b.js"; import "node:fs";',
      [path.join(SRC, "agents/b.ts")]: 'import { x } from "../host/c.js"; import "lodash"; import "@acr/events";',
      [path.join(SRC, "host/c.ts")]: "export const x = 1;",
    };
    const r = closureOf([path.join(SRC, "players/a.ts")], (f) => fake[f] ?? "");
    const rel = r.files.map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(rel).toEqual(["players/a.ts", "agents/b.ts", "host/c.ts"]);
    expect(r.externals.filter((e) => !externalOk(e))).toEqual(["lodash"]);
  });
});

function externalOk(spec: string): boolean { return spec.startsWith("node:") || PACKAGES.has(spec); }

/** Every file reachable through relative imports from `start` (inside services/runtime/src), and every non-relative specifier met on the way. */
function closureOf(start: string[], read: (file: string) => string): { files: string[]; externals: string[] } {
  const seen = new Set<string>(); const externals = new Set<string>(); const queue = [...start];
  while (queue.length) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of specifiers(read(f))) {
      if (!spec.startsWith(".")) { externals.add(spec); continue; }
      queue.push(path.resolve(path.dirname(f), spec).replace(/\.js$/, ".ts"));
    }
  }
  return { files: [...seen], externals: [...externals] };
}
