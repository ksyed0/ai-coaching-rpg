import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = path.resolve(runtimeDir, "../..");
const tsx = path.join(runtimeDir, "node_modules", ".bin", "tsx");
const priv: string[] = [];
afterEach(async () => { for (const d of priv.splice(0)) await rm(d, { recursive: true, force: true }); });
// A private TMPDIR per child: its temp-dir leaks (and nothing else's) are visible, and parallel test files cannot interfere.
const privateTmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acrx-")); priv.push(d); return d; };
const demoDirs = (tmp: string) => readdirSync(tmp).filter((d) => d.startsWith("acr-demo-")); // (tsx keeps its own cache dir there)
const env = (tmp: string) => ({ ...process.env, TMPDIR: tmp, NO_COLOR: "1" });

describe("the real process", () => {
  it("writes ONLY the JSON report to stdout with --json - (narration on stderr), exit 0", async () => {
    const tmp = await privateTmp();
    const r = spawnSync(tsx, ["src/demo/run.ts", "--fast", "--json", "-"], { cwd: runtimeDir, env: env(tmp), encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as { summary: { failed: number; passed: number }; mode: string }; // fails if anything but JSON reached stdout
    expect(report).toMatchObject({ mode: "mock", summary: { failed: 0, passed: 29 } });
    expect(r.stderr).toContain("ACT 1");
    expect(demoDirs(tmp)).toEqual([]);
  });

  const pnpmOk = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!pnpmOk)("`pnpm -s demo --fast --json -` from the repo root also gives pure JSON on stdout (no pnpm banners)", async () => {
    const tmp = await privateTmp();
    const r = spawnSync("pnpm", ["-s", "demo", "--fast", "--json", "-"], { cwd: repoRoot, env: env(tmp), encoding: "utf8", timeout: 90_000 });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { summary: { failed: number } }).summary.failed).toBe(0);
    expect(r.stderr).toContain("ACT 1");
  });

  it.skipIf(!pnpmOk)("`pnpm demo --fast --json demo-report.json` lands the file in the directory pnpm was run from", async () => {
    const tmp = await privateTmp();
    const file = path.join(repoRoot, "demo-report.json");
    const had = existsSync(file);
    const r = spawnSync("pnpm", ["demo", "--fast", "--json", "demo-report.json"], { cwd: repoRoot, env: env(tmp), encoding: "utf8", timeout: 90_000 });
    try {
      expect(r.status).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(path.join(runtimeDir, "demo-report.json"))).toBe(false);
    } finally { if (!had) await rm(file, { force: true }); }
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s mid-run cleans up (no temp dir left), reports the interruption and exits %i", async (signal, code) => {
    const tmp = await privateTmp();
    const child = spawn(tsx, ["src/demo/run.ts", "--speed", "1"], { cwd: runtimeDir, env: env(tmp), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const started = new Promise<void>((resolve) => child.stdout.on("data", (d) => { out += d; if (out.includes("ACT 2")) resolve(); }));
    child.stderr.resume();
    const exited = new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
    await started;
    expect(demoDirs(tmp).length).toBe(1); // the run really had a temp dir
    child.kill(signal);
    expect(await exited).toBe(code);
    expect(out).toContain("INTERRUPTED");
    expect(demoDirs(tmp)).toEqual([]);
  }, 60_000);
});
