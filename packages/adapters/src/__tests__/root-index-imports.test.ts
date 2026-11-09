import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// US-0071 (EPIC-0003 voice A1b, Task 4, R20, K12): `livekit-server-sdk` is reachable ONLY through the `@acr/adapters/livekit` subpath.
// The root index is imported by the runtime, the speech worker and the bots, so it must never load the SDK. Each probe is a fresh child
// process (nothing earlier in this test run can have loaded the SDK), with a loader hook that records every resolved URL to a file and,
// after the import, a dump of the process's CommonJS require.cache (F11).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
const run = promisify(execFile);
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let dir = "";
let hooks = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-adapters-imports-"));
  hooks = path.join(dir, "record-hooks.mjs");
  await writeFile(hooks, [
    'import { appendFileSync } from "node:fs";',
    "const out = process.env.ACR_IMPORT_RECORD;",
    "export async function resolve(specifier, context, next) {",
    "  const r = await next(specifier, context);",
    '  appendFileSync(out, r.url + "\\n");',
    "  return r;",
    "}",
  ].join("\n"));
  await writeFile(path.join(dir, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * Every URL resolved while a fresh Node process (tsx for TypeScript) imports `specifier` from the adapters package directory, and (F11)
 * the keys of that process's CommonJS `require.cache` afterwards, so a CommonJS load the ESM hook might not see is caught too. `extra`
 * runs after the import (the cache probe's own positive control).
 */
async function loadedBy(specifier: string, extra = ""): Promise<{ urls: string[]; cache: string[] }> {
  const record = path.join(dir, `${specifier.replace(/[^a-z]/gi, "-")}${extra === "" ? "" : "-extra"}.txt`);
  await writeFile(record, "");
  const code = [
    `await import(${JSON.stringify(specifier)});`,
    'const { createRequire } = await import("node:module");',
    `const require = createRequire(${JSON.stringify(pathToFileURL(path.join(pkgDir, "probe.js")).href)});`,
    extra,
    "process.stdout.write(JSON.stringify(Object.keys(require.cache)));",
  ].join("\n");
  const { stdout } = await run(process.execPath, ["--import", "tsx", "--import", pathToFileURL(path.join(dir, "register.mjs")).href, "--input-type=module", "-e", code], {
    cwd: pkgDir, timeout: 60_000, env: { ...process.env, ACR_IMPORT_RECORD: record, TMPDIR: dir },
  });
  return { urls: (await readFile(record, "utf8")).split("\n").filter((l) => l !== ""), cache: JSON.parse(stdout) as string[] };
}
const sdk = (keys: string[]) => keys.filter((u) => u.includes("livekit-server-sdk"));

describe("the adapters root index and the LiveKit SDK (US-0071)", () => {
  it("importing @acr/adapters does not load livekit-server-sdk", async () => {
    const { urls, cache } = await loadedBy("@acr/adapters");
    expect(urls.some((u) => u.includes("/packages/adapters/src/index.ts"))).toBe(true); // the probe saw the root index itself
    expect(sdk(urls)).toEqual([]);
    expect(cache.length).toBeGreaterThan(0); // the root index's CommonJS dependencies are in the cache: the cache probe ran
    expect(sdk(cache)).toEqual([]);
  });

  it("importing @acr/adapters/livekit/identity does not load livekit-server-sdk", async () => {
    const { urls, cache } = await loadedBy("@acr/adapters/livekit/identity");
    expect(urls.some((u) => u.includes("/packages/adapters/src/livekit/identity.ts"))).toBe(true);
    expect(sdk(urls)).toEqual([]);
    expect(sdk(cache)).toEqual([]);
  });

  it("importing @acr/adapters/livekit does (the probe works)", async () => {
    expect(sdk((await loadedBy("@acr/adapters/livekit")).urls).length).toBeGreaterThan(0);
  });

  it("a CommonJS require of livekit-server-sdk shows in the require.cache probe (its positive control)", async () => {
    const { cache } = await loadedBy("@acr/adapters", 'require("livekit-server-sdk");');
    expect(sdk(cache).length).toBeGreaterThan(0);
  });
});
