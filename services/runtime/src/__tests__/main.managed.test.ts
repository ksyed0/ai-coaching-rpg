import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, type Runtime } from "../main.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "../../../../packages/script/src/__tests__/fixtures/minimal");
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });
let tmp = "";
const runtimes: Runtime[] = [];
afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop(); if (tmp) await rm(tmp, { recursive: true, force: true }); tmp = ""; });

const SECRET_TOKEN = "dotenv-token-0123456789abcdef";
async function boot(extra: Record<string, string>, o: { logDir?: string } = {}) {
  const logs: string[] = []; const shown: Record<string, string>[] = [];
  const r = await bootstrap({
    env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: "m1", MODEL_PROVIDER: "mock", ...extra },
    root: tmp, ...o, tickMs: 60_000, log: (m) => logs.push(m), warn: (m) => logs.push(m),
    showJoinCodes: (list) => { shown.push(Object.fromEntries(list.map((c) => [c.roleId, c.code]))); },
  });
  if (r.ok) runtimes.push(r.runtime);
  return { r, logs, shown };
}
/** The names in `d`, sorted; a missing directory reads as empty (one readdir, no exists-then-read). */
const files = (d: string) => readdir(d).then((n) => n.sort(), (err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return []; throw err; });

describe("bootstrap managed mode (US-0058)", () => {
  it("bootstrap with CONTROL_MANAGED=1 ignores a <root>/.env that sets SESSION_START=fresh and FACILITATOR_TOKEN", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-mmain-"));
    const data = path.join(tmp, "sessions");
    await writeFile(path.join(tmp, ".env"), `SESSION_START=fresh\nFACILITATOR_TOKEN=${SECRET_TOKEN}\n`);
    const first = await boot({ CONTROL_MANAGED: "1", SESSION_DATA_DIR: data });
    if (!first.r.ok) throw new Error(first.r.errors.join("; "));
    expect(first.shown).toHaveLength(1);
    expect(first.logs.join("\n")).not.toContain("facilitator token required"); // the .env token was not picked up
    const codesFile = path.join(data, "m1.codes.json");
    const codesBefore = await readFile(codesFile, "utf8");
    await first.r.runtime.stop(); runtimes.pop();
    // The restart finds the same lobby: SESSION_START=fresh in the .env did not move anything aside or re-issue codes.
    const second = await boot({ CONTROL_MANAGED: "1", SESSION_DATA_DIR: data });
    if (!second.r.ok) throw new Error(second.r.errors.join("; "));
    expect(second.shown).toHaveLength(0);
    expect(await readFile(codesFile, "utf8")).toBe(codesBefore);
    expect((await files(data)).filter((n) => n.includes("jsonl"))).toEqual([]);
  });

  it("NO_DOTENV=1 alone skips the .env merge", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-mmain-"));
    await writeFile(path.join(tmp, ".env"), `FACILITATOR_TOKEN=${SECRET_TOKEN}\n`);
    const withFile = await boot({}, { logDir: path.join(tmp, "a") });
    if (!withFile.r.ok) throw new Error(withFile.r.errors.join("; "));
    expect(withFile.logs.join("\n")).toContain("facilitator token required"); // control: the file IS read normally
    await withFile.r.runtime.stop(); runtimes.pop();
    const without = await boot({ NO_DOTENV: "1" }, { logDir: path.join(tmp, "b") });
    if (!without.r.ok) throw new Error(without.r.errors.join("; "));
    expect(without.logs.join("\n")).not.toContain("facilitator token required");
    expect(without.logs.join("\n")).toContain("OPEN"); // the open-server warning: no token from anywhere
  });

  it("bootstrap with SESSION_DATA_DIR writes the log, lock and codes there and nothing under <root>/data", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-mmain-"));
    const data = path.join(tmp, "elsewhere", "sessions");
    await mkdir(path.dirname(data), { recursive: true });
    const { r } = await boot({ SESSION_DATA_DIR: data });
    if (!r.ok) throw new Error(r.errors.join("; "));
    const names = await files(data);
    expect(names).toEqual(expect.arrayContaining(["m1.lock", "m1.codes.json"]));
    expect(existsSync(path.join(tmp, "data"))).toBe(false);
    // the log appears with the first event
    const started = await r.runtime.host.engine.start({ host: "p" }).then(() => true);
    expect(started).toBe(true);
    expect(await files(data)).toContain("m1.jsonl");
    expect(existsSync(path.join(tmp, "data"))).toBe(false);
  });

  it("a relative SESSION_DATA_DIR is refused and the value is not echoed", async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "acr-mmain-"));
    const { r } = await boot({ SESSION_DATA_DIR: "rel/secret-dir-name" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(/SESSION_DATA_DIR/);
    expect(r.errors.join("\n")).not.toContain("secret-dir-name");
    expect(existsSync(path.join(tmp, "rel"))).toBe(false);
    expect(existsSync(path.join(tmp, "data"))).toBe(false);
  });
});
