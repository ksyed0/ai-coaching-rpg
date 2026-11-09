import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

// US-0071 (EPIC-0003 voice A1b, Task 7): `@livekit/rtc-node` is native and glibc-only; a file-ingest worker (the demo, CI, any host
// without LiveKit) must never load it. Only src/ingest/livekit-room-native.ts imports it, and main.ts loads that file dynamically, only
// for SPEECH_INGEST=livekit. RtcConn (livekit-room.ts) takes the library's values injected, so it loads nothing native (review finding 4).
// Each probe is a fresh Node process that records every resolved URL and dumps its CommonJS require.cache.
describe("the speech worker and @livekit/rtc-node (US-0071)", () => {
  const run = promisify(execFile);
  const pkgDir = path.resolve(SRC, "..");
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-imports-"));
    await writeFile(path.join(dir, "hooks.mjs"), [
      'import { appendFileSync } from "node:fs";',
      "export async function resolve(specifier, context, next) { const r = await next(specifier, context); appendFileSync(process.env.ACR_IMPORT_RECORD, r.url + \"\\n\"); return r; }",
    ].join("\n"));
    await writeFile(path.join(dir, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(path.join(dir, "hooks.mjs")).href)});\n`);
  }, 90_000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function loadedBy(files: string[], tag: string): Promise<string[]> {
    const record = path.join(dir, `${tag}.txt`);
    await writeFile(record, "");
    const code = [
      ...files.map((f) => `await import(${JSON.stringify(pathToFileURL(path.join(SRC, f)).href)});`),
      'const { createRequire } = await import("node:module");',
      `const require = createRequire(${JSON.stringify(pathToFileURL(path.join(pkgDir, "probe.js")).href)});`,
      "process.stdout.write(JSON.stringify(Object.keys(require.cache)));",
    ].join("\n");
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--import", pathToFileURL(path.join(dir, "register.mjs")).href, "--input-type=module", "-e", code], {
      cwd: pkgDir, timeout: 60_000, env: { ...process.env, ACR_IMPORT_RECORD: record, TMPDIR: dir },
    });
    return [...(await readFile(record, "utf8")).split("\n").filter((l) => l !== ""), ...(JSON.parse(stdout) as string[])];
  }
  const rtc = (keys: string[]) => keys.filter((u) => u.includes("@livekit/rtc-node") || u.includes("rtc-ffi-bindings") || u.includes("@livekit+rtc"));

  it("only src/ingest/livekit-room-native.ts names @livekit/rtc-node, and main.ts loads it only by a dynamic import", () => {
    const users = sources(SRC).filter((f) => specifiers(readFileSync(f, "utf8")).some((sp) => sp.startsWith("@livekit/rtc-node")));
    expect(users.map((f) => path.relative(SRC, f))).toEqual([path.join("ingest", "livekit-room-native.ts")]);
    const main = readFileSync(path.join(SRC, "main.ts"), "utf8");
    expect(main).toMatch(/await import\("\.\/ingest\/livekit-room-native\.js"\)/);
    expect(main).not.toMatch(/from "\.\/ingest\/livekit-room(-native)?\.js"/);
    expect(main).not.toMatch(/import\("\.\/ingest\/livekit-room\.js"\)/);
  });

  it("a file-ingest run never loads @livekit/rtc-node (main, the worker, both ingests and the config)", async () => {
    const keys = await loadedBy(["main.ts", "worker.ts", "config.ts", "ingest/file-ingest.ts", "ingest/livekit-ingest.ts"], "file-run");
    expect(keys.some((u) => u.includes("/src/ingest/livekit-ingest.ts"))).toBe(true); // the probe saw the modules
    expect(rtc(keys)).toEqual([]);
  }, 90_000);

  it("importing livekit-room-native.ts does load it (the probe works)", async () => {
    const keys = await loadedBy(["ingest/livekit-room-native.ts"], "room");
    expect(rtc(keys).length).toBeGreaterThan(0);
  }, 90_000);

  it("importing livekit-room.ts (RtcConn) loads nothing native: it is unit-tested and measured by coverage", async () => {
    const keys = await loadedBy(["ingest/livekit-room.ts"], "conn");
    expect(keys.some((u) => u.includes("/src/ingest/livekit-room.ts"))).toBe(true);
    expect(rtc(keys)).toEqual([]);
  }, 90_000);
});
