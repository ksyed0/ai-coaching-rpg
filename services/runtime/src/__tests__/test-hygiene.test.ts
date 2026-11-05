import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * BUG-0006 guard. A test that asserts a measured elapsed time passes on the author's machine and fails on a loaded one (coverage alone makes
 * code several times slower). Use `expectLinear` (scaling.ts) for complexity, injected clocks for timing and a private TMPDIR for temp dirs.
 * The rules are plain line patterns; a line that is a deliberate exception can carry `// hygiene-ok: <reason>`.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SKIP_DIRS = new Set(["node_modules", ".git", "coverage", "dist", ".tmp"]);
const SELF = path.join("services", "runtime", "src", "__tests__", "test-hygiene.test.ts");

function* testFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* testFiles(path.join(dir, e.name)); }
    else if (/\.test\.(ts|tsx|js|mjs)$/.test(e.name)) yield path.join(dir, e.name);
  }
}

type Rule = { name: string; line: RegExp; unless?: RegExp };
const RULES: Rule[] = [
  // expect(<anything measured with a clock>).toBeLessThan(N) / toBeLessThanOrEqual(N)
  { name: "elapsed time compared with a bound", line: /expect\([^;]*\b(Date\.now|performance\.now|hrtime)\b[^;]*\)\s*\.toBeLessThan(OrEqual)?\(/ },
  // expect(elapsed).toBeLessThan(N) and look-alikes
  { name: "elapsed time compared with a bound", line: /expect\(\s*(elapsed\w*|duration\w*|took\w*|\w*Elapsed|\w*Duration)\s*\)\s*\.toBeLessThan(OrEqual)?\(/ },
  // listing the shared temp dir (only a file that points TMPDIR at its own directory may)
  { name: "listing the shared temp directory", line: /readdir(Sync)?\(\s*(os\.)?tmpdir\(\)/, unless: /process\.env\.TMPDIR\s*=/ },
];

describe("test hygiene (BUG-0006)", () => {
  it("no test asserts a measured elapsed time or lists the shared temp directory", () => {
    const found: string[] = [];
    let files = 0;
    for (const f of testFiles(ROOT)) {
      const rel = path.relative(ROOT, f);
      if (rel === SELF) continue;
      files++;
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (/hygiene-ok:/.test(line)) return;
        for (const r of RULES) if (r.line.test(line) && !(r.unless && r.unless.test(text))) found.push(`${rel}:${i + 1}: ${r.name}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(files).toBeGreaterThan(50); // the walk really found the test files
    expect(found).toEqual([]);
  });

  it("the rules do catch the patterns they exist for", () => {
    const hit = (s: string) => RULES.some((r) => r.line.test(s));
    expect(hit("expect(Date.now() - t0).toBeLessThan(5_000);")).toBe(true);
    expect(hit("expect(performance.now() - t).toBeLessThanOrEqual(3000)")).toBe(true);
    expect(hit("expect(elapsedMs).toBeLessThan(100);")).toBe(true);
    expect(hit("const x = readdirSync(os.tmpdir()).filter(Boolean);")).toBe(true);
    expect(hit("expect(items.length).toBeLessThan(100);")).toBe(false);
    expect(hit("expect(Math.max(...delays)).toBeLessThanOrEqual(700 / 20 + 1e-9);")).toBe(false);
  });
});
