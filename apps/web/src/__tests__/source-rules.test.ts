import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Rules the review asked for that are about the source, not one behaviour: checked over every file so a new component cannot slip past.
const SRC = join(__dirname, "..");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}
const all = files(SRC);
const isTest = (p: string) => p.includes(`${"__tests__"}`) || /\.test\.tsx?$/.test(p);
const source = all.filter((p) => /\.(ts|tsx|css)$/.test(p) && !isTest(p));
const clientSide = source.filter((p) => /[\\/](components|lib|app)[\\/]/.test(p));
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(SRC, p);

describe("source rules", () => {
  it("no source file uses dangerouslySetInnerHTML", () => {
    const hits = all.filter((p) => !isTest(p) && /\.(ts|tsx|js|jsx)$/.test(p) && read(p).includes("dangerouslySetInnerHTML")).map(rel);
    expect(hits).toEqual([]);
    expect(source.length).toBeGreaterThan(20); // the scan really saw the tree
  });

  it("no component sets an inline style (the CSP allows styles only from files and nonced tags)", () => {
    const hits = clientSide.filter((p) => p.endsWith(".tsx") && /\bstyle\s*=\s*\{|\bstyle:\s*\{|setAttribute\(\s*["']style|\.style\./.test(read(p))).map(rel);
    expect(hits).toEqual([]);
  });

  it("the browser code never touches the cookie (it is HttpOnly) or storage", () => {
    const hits = clientSide.filter((p) => /document\.cookie|localStorage|sessionStorage/.test(read(p))).map(rel);
    expect(hits).toEqual([]);
  });

  it("pages, components and styles load no third-party resource", () => {
    const hits = clientSide.filter((p) => /https?:\/\/|@import\s+url|url\(\s*["']?\/\//.test(read(p))).map(rel);
    expect(hits).toEqual([]);
  });

  it("the client modules are marked for the browser and import no server module", () => {
    const comps = source.filter((p) => /[\\/]components[\\/].+\.tsx$/.test(p));
    expect(comps.length).toBeGreaterThanOrEqual(10);
    for (const p of [...comps, ...source.filter((q) => /[\\/]lib[\\/].+\.tsx?$/.test(q))]) {
      expect(read(p), rel(p)).not.toMatch(/from\s+["'][^"']*server\//);
      expect(read(p), rel(p)).not.toMatch(/from\s+["']node:/);
    }
    for (const name of ["JoinForm", "SessionScreen", "SayBox", "ConsentPanel", "SceneStatus"]) {
      expect(read(join(SRC, "components", `${name}.tsx`)).startsWith(`"use client";`), name).toBe(true);
    }
  });

  it("the tokens define light and dark themes, a visible focus ring and a 16 px gutter", () => {
    const css = read(join(SRC, "lib", "tokens.css"));
    expect(css).toMatch(/:root\s*\{[^}]*--bg:/);
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\]/);
    const app = read(join(SRC, "lib", "app.css"));
    expect(app).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(css).toMatch(/--gutter:\s*16px/);
    expect(app).toMatch(/\.page\s*\{[^}]*padding:\s*0 var\(--gutter\)/);
    expect(app).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe("pages", () => {
  it("/join and the session page are noindex", async () => {
    const join = await import("../app/join/page");
    const session = await import("../app/session/[id]/page");
    for (const m of [join.metadata, session.metadata]) expect(m.robots).toEqual({ index: false, follow: false });
  });
});
