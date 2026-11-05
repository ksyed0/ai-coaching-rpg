import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
// Whole-demo and real-process/socket tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const repoRoot = path.resolve(runtimeDir, "../..");
const tsx = path.join(runtimeDir, "node_modules", ".bin", "tsx");
const priv: string[] = [];
afterEach(async () => { for (const d of priv.splice(0)) await rm(d, { recursive: true, force: true }); });
// A private TMPDIR per child: its temp-dir leaks (and nothing else's) are visible, and parallel test files cannot interfere.
const privateTmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), "acrx-")); priv.push(d); return d; };
const demoDirs = (tmp: string) => readdirSync(tmp).filter((d) => d.startsWith("acr-demo-")); // (tsx keeps its own cache dir there)
const env = (tmp: string) => ({ ...process.env, TMPDIR: tmp, NO_COLOR: "1" });

/** Spawns detached (its own process group), so the whole tree (tsx wrapper AND the node grandchild) can be killed. */
const spawnGroup = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): ChildProcess =>
  spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
const killGroup = (child: ChildProcess): void => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
};
/** Resolves with the output once `marker` appears; rejects at once (exit code only, no output dump) if the child exits or fails to start first. */
export function waitForMarker(child: ChildProcess, marker: string, sink: { out: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d) => { sink.out += d; if (sink.out.includes(marker)) resolve(); });
    child.once("exit", (code, sig) => { if (!sink.out.includes(marker)) reject(new Error(`the process exited early (code ${code}, signal ${sig})`)); });
    child.once("error", (e) => reject(new Error(`the process could not start: ${e.message}`)));
  });
}

describe("the real process", () => {
  it("writes ONLY the JSON report to stdout with --json - (narration on stderr), exit 0", async () => {
    const tmp = await privateTmp();
    const r = spawnSync(tsx, ["src/demo/run.ts", "--fast", "--json", "-"], { cwd: runtimeDir, env: env(tmp), encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as { summary: { failed: number; passed: number }; mode: string }; // fails if anything but JSON reached stdout
    expect(report).toMatchObject({ mode: "mock", summary: { failed: 0, passed: 29 } });
    expect(r.stderr).toContain("ACT 1");
    expect(demoDirs(tmp)).toEqual([]);
  }, 90_000); // a real process (tsx or pnpm start-up): its own spawn timeout bounds it, not vitest's 5 s default

  const pnpmOk = spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(!pnpmOk)("`pnpm -s demo --fast --json -` from the repo root also gives pure JSON on stdout (no pnpm banners)", async () => {
    const tmp = await privateTmp();
    const r = spawnSync("pnpm", ["-s", "demo", "--fast", "--json", "-"], { cwd: repoRoot, env: env(tmp), encoding: "utf8", timeout: 90_000 });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as { summary: { failed: number } }).summary.failed).toBe(0);
    expect(r.stderr).toContain("ACT 1");
  }, 90_000); // a real process (tsx or pnpm start-up): its own spawn timeout bounds it, not vitest's 5 s default

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
  }, 90_000); // a real process (tsx or pnpm start-up): its own spawn timeout bounds it, not vitest's 5 s default

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("%s mid-run cleans up (no temp dir left), reports the interruption and exits %i", async (signal, code) => {
    const tmp = await privateTmp();
    const child = spawnGroup(tsx, ["src/demo/run.ts", "--speed", "1"], { cwd: runtimeDir, env: env(tmp) });
    try {
      const sink = { out: "" };
      const exited = new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
      child.stderr!.resume();
      await waitForMarker(child, "ACT 2", sink);
      expect(demoDirs(tmp).length).toBe(1); // the run really had a temp dir
      child.kill(signal);
      expect(await exited).toBe(code);
      expect(sink.out).toContain("INTERRUPTED");
      expect(demoDirs(tmp)).toEqual([]);
    } finally { killGroup(child); }
  }, 60_000);

  it("waitForMarker fails at once, with the exit code only, when the child exits before the marker", async () => {
    const child = spawnGroup(process.execPath, ["-e", "console.log('some output'); process.exit(7)"], {});
    try {
      const sink = { out: "" };
      await expect(waitForMarker(child, "ACT 2", sink)).rejects.toThrow("the process exited early (code 7, signal null)");
    } finally { killGroup(child); }
  });
  it("waitForMarker resolves when the marker appears", async () => {
    const child = spawnGroup(process.execPath, ["-e", "console.log('hello ACT 2'); setTimeout(()=>{}, 50)"], {});
    try { await waitForMarker(child, "ACT 2", { out: "" }); } finally { killGroup(child); }
  });
});
