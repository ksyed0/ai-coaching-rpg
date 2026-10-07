import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { parseDemoArgs } from "../args.js";
import { CHECKS, CHECK_IDS, RESUME_CHECKS, SECURITY_CHECKS } from "../checks.js";
import { runDemo, type RunDeps } from "../runner.js";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const deps = (c: Captured, argv: string[], over: Partial<RunDeps> = {}): RunDeps => ({
  argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test",
  resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
});
/** A whole demo run takes about a second; a loaded CI runner can be many times slower, so these runs get a generous limit. */
const RUN_TIMEOUT_MS = 60_000;
// Private TMPDIR: runner.test.ts counts acr-demo-* directories in the shared temp dir while it runs in parallel (see security-room.test.ts).
const realTmp = process.env.TMPDIR;
let privateTmp = "";
beforeAll(() => { privateTmp = mkdtempSync(path.join(os.tmpdir(), "acr-resume-room-")); process.env.TMPDIR = privateTmp; });
afterAll(() => { if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp; rmSync(privateTmp, { recursive: true, force: true }); });

describe("--resume option", () => {
  it("is off by default and leaves the default options exactly as they were", () => {
    const r = parseDemoArgs(["--fast"]);
    expect(r.ok && "resume" in r.opts).toBe(false);
    expect(parseDemoArgs(["--fast", "--resume"])).toMatchObject({ ok: true, opts: { resume: true } });
    expect(parseDemoArgs(["--resume", "--resume"])).toMatchObject({ ok: false, error: expect.stringContaining("more than once") });
  });
  it("is refused with --url and with --showcase", () => {
    expect(parseDemoArgs(["--resume", "--url", "ws://127.0.0.1:1"])).toMatchObject({ ok: false, error: expect.stringContaining("--resume cannot be combined with --url") });
    expect(parseDemoArgs(["--resume", "--showcase"])).toMatchObject({ ok: false, error: expect.stringContaining("--resume belongs to the default run") });
  });
});

describe("the resume checks are opt-in and leave the default catalogue alone", () => {
  it("F-34 to F-43 are separate from the 29 default checks and from the security room", () => {
    expect(CHECKS.length).toBe(29);
    expect(RESUME_CHECKS.map((c) => c.id)).toEqual(["F-34", "F-35", "F-36", "F-37", "F-38", "F-39", "F-40", "F-41", "F-42", "F-43"]);
    expect(CHECK_IDS).not.toContain("F-34");
    expect(RESUME_CHECKS.every((c) => c.kind === "inproc")).toBe(true);
    expect(SECURITY_CHECKS.some((c) => RESUME_CHECKS.some((r) => r.id === c.id))).toBe(false);
  });
});

describe("pnpm demo --resume", () => {
  it("passes all 39 checks in mock mode, offline and deterministically, and leaves no socket behind", async () => {
    const tcp = () => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap").length;
    const t0 = tcp();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color", "--resume"]));
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.results.map((r) => r.id)).toEqual([...CHECK_IDS, ...RESUME_CHECKS.map((r) => r.id)]);
    expect(report!.summary).toEqual({ passed: 39, failed: 0, skipped: 0 });
    const out = c.out.join("");
    expect(out).toContain("ACT 6c");
    expect(out).not.toMatch(/acr-resume-room-|acr-demo-/); // no temp path in the narration
    expect(c.err).toEqual([]);
    expect(tcp()).toBe(t0);
  }, RUN_TIMEOUT_MS);

  it("runs together with --security: 42 checks", async () => {
    const { exitCode, report } = await runDemo(deps(capture(), ["--fast", "--no-color", "--security", "--resume"]));
    expect(exitCode).toBe(0);
    expect(report!.summary).toEqual({ passed: 42, failed: 0, skipped: 0 });
  }, RUN_TIMEOUT_MS);

  it("a failing resume check fails the run; a bypassed one is a failure, never a quiet skip", async () => {
    const failed = await runDemo(deps(capture(), ["--fast", "--no-color", "--resume"], { forceFail: ["F-36"] }));
    expect(failed.exitCode).toBe(1);
    expect(failed.report!.results.find((r) => r.id === "F-36")?.status).toBe("failed");
    const bypassed = await runDemo(deps(capture(), ["--fast", "--no-color", "--resume"], { bypass: ["F-40"] }));
    expect(bypassed.exitCode).toBe(1);
    expect(bypassed.report!.results.find((r) => r.id === "F-40")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
  }, RUN_TIMEOUT_MS);

  it("the default run does not open the resume room", async () => {
    const c = capture();
    const { report } = await runDemo(deps(c, ["--fast", "--no-color"]));
    expect(c.out.join("")).not.toContain("ACT 6c");
    expect(report!.summary.passed).toBe(29);
  }, RUN_TIMEOUT_MS);
});
