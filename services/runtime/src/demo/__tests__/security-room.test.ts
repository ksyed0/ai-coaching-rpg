import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO_ROOT, bootstrap } from "../../main.js";
import { parseDemoArgs } from "../args.js";
import { CHECKS, CHECK_IDS, SECURITY_CHECKS } from "../checks.js";
import { makeTempRoot, newSecurityToken } from "../harness.js";
import { runDemo, type RunDeps } from "../runner.js";
// Whole-demo and real-process/socket tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const deps = (c: Captured, argv: string[], over: Partial<RunDeps> = {}): RunDeps => ({
  argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test",
  resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
});
// This file's runs make their own acr-demo-* temp dirs; keep them out of the shared temp dir so that runner.test.ts, which counts
// those directories while it runs in parallel, never sees them. Each test file has its own worker process, so this stays local.
const realTmp = process.env.TMPDIR;
let privateTmp = "";
beforeAll(() => { privateTmp = mkdtempSync(path.join(os.tmpdir(), "acr-security-room-")); process.env.TMPDIR = privateTmp; });
afterAll(() => { if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp; rmSync(privateTmp, { recursive: true, force: true }); });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

describe("--security option", () => {
  it("is off by default and leaves the default options exactly as they were", () => {
    const r = parseDemoArgs(["--fast"]);
    expect(r.ok && "security" in r.opts).toBe(false);
    expect(parseDemoArgs(["--fast", "--security"])).toMatchObject({ ok: true, opts: { security: true } });
  });
  it("is refused with --url and with --showcase", () => {
    expect(parseDemoArgs(["--security", "--url", "ws://127.0.0.1:1"])).toMatchObject({ ok: false, error: expect.stringContaining("--security cannot be combined with --url") });
    expect(parseDemoArgs(["--security", "--showcase"])).toMatchObject({ ok: false, error: expect.stringContaining("--security belongs to the default run") });
  });
});

describe("the security checks are opt-in and leave the default catalogue alone", () => {
  it("F-31 to F-33 are separate from the 29 default checks", () => {
    expect(CHECKS.length).toBe(29);
    expect(SECURITY_CHECKS.map((c) => c.id)).toEqual(["F-31", "F-32", "F-33"]);
    expect(CHECK_IDS).not.toContain("F-31");
    expect(SECURITY_CHECKS.every((c) => c.kind === "inproc")).toBe(true);
  });
});

describe("pnpm demo --security", () => {
  it("passes all 32 checks in mock mode, deterministically, and the room token appears nowhere in the output or report", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color", "--security"]));
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.results.map((r) => r.id)).toEqual([...CHECK_IDS, "F-31", "F-32", "F-33"]);
    expect(report!.summary).toEqual({ passed: 32, failed: 0, skipped: 0 });
    const all = c.out.join("") + JSON.stringify(report);
    expect(all).not.toMatch(/\b[0-9a-f]{48}\b/); // the room token is a fresh 48 hex character string
    expect(all).toContain("ACT 6b");
    expect(c.err).toEqual([]);
  });

  it("a failing security check fails the run and hides nothing", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color", "--security"], { forceFail: ["F-32"] }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-32")?.status).toBe("failed");
    expect(report!.results.find((r) => r.id === "F-31")?.status).toBe("passed");
  });

  it("a bypassed security check is a failure, never a quiet skip", async () => {
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--fast", "--no-color", "--security"], { bypass: ["F-33"] }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-33")).toMatchObject({ status: "failed", details: expect.stringContaining("did not run") });
  });

  it("the default run does not start the security room", async () => {
    const c = capture();
    const { report } = await runDemo(deps(c, ["--fast", "--no-color"]));
    expect(c.out.join("")).not.toContain("ACT 6b");
    expect(report!.summary.passed).toBe(29);
  });

  it("leaves no socket behind (the security room itself makes no temp files)", async () => {
    const tcp = () => process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap" || r === "TCPSocketWrap").length;
    const t0 = tcp();
    await runDemo(deps(capture(), ["--fast", "--no-color", "--security"]));
    expect(tcp()).toBe(t0);
  });
});

describe("the room token", () => {
  it("is fresh and long enough on every call", () => {
    const a = newSecurityToken(); const b = newSecurityToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe("--url against a token-protected server", () => {
  const TOKEN = "url-mode-token-0123456789abcdef";
  let codesEnv = ""; // US-0033: the target's join codes, as JOIN_CODES
  const start = async () => {
    const tmp = await makeTempRoot(REPO_ROOT);
    cleanups.push(() => tmp.cleanup());
    const boot = await bootstrap({ env: { RUNTIME_PORT: "0", SESSION_ID: "smoke", MODEL_PROVIDER: "mock", FACILITATOR_TOKEN: TOKEN }, root: tmp.root, logDir: tmp.dataDir, log: () => {}, warn: () => {}, tickMs: 60_000, showJoinCodes: (c) => { codesEnv = c.map((x) => `${x.roleId}=${x.code}`).join(","); } });
    if (!boot.ok) throw new Error(boot.errors.join("; "));
    cleanups.push(() => boot.runtime.stop());
    return boot.runtime.port;
  };

  it("passes the external checks with FACILITATOR_TOKEN in the environment, and never prints the token", async () => {
    const port = await start();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${port}`, "--session", "smoke", "--fast", "--no-color"], { env: { PATH: "/usr/bin", FACILITATOR_TOKEN: TOKEN, JOIN_CODES: codesEnv } }));
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(c.out.join("") + c.err.join("") + JSON.stringify(report)).not.toContain(TOKEN);
    expect(c.out.join("")).toContain("FACILITATOR_TOKEN");
  });

  it("without the token the facilitator is refused (F-01 fails) and the output says nothing about the token", async () => {
    const port = await start();
    const c = capture();
    const { exitCode, report } = await runDemo(deps(c, ["--url", `ws://127.0.0.1:${port}`, "--session", "smoke", "--fast", "--no-color"], { watchdogMs: 20_000 }));
    expect(exitCode).toBe(1);
    expect(report!.results.find((r) => r.id === "F-01")).toMatchObject({ status: "failed", details: expect.stringContaining("unauthorized") });
    expect(c.out.join("")).not.toContain(TOKEN);
  });

  it("an invalid FACILITATOR_TOKEN in the environment is a usage error that does not show it", async () => {
    const c = capture();
    const { exitCode } = await runDemo(deps(c, ["--url", "ws://127.0.0.1:9", "--fast"], { env: { PATH: "/usr/bin", FACILITATOR_TOKEN: "short-secret" } }));
    expect(exitCode).toBe(2);
    expect(c.err.join("")).toContain("FACILITATOR_TOKEN");
    expect(c.err.join("") + c.out.join("")).not.toContain("short-secret");
  });
});
