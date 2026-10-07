import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { CHECKS } from "../checks.js";
import { runDemo, type RunDeps } from "../runner.js";
import type { Report } from "../report.js";
import { stampFromBody } from "./nonce.js";
// Whole-demo runs against a fake model on loopback: a generous explicit limit, no elapsed-time assertion.
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

// Private TMPDIR: this file's runs make their temp directories here, never in the shared one (AGENTS.md section 8).
const realTmp = process.env.TMPDIR;
let privateTmp = "";
beforeAll(() => { privateTmp = mkdtempSync(path.join(os.tmpdir(), "acr-live-evidence-test-")); process.env.TMPDIR = privateTmp; });
afterAll(() => { if (realTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = realTmp; rmSync(privateTmp, { recursive: true, force: true }); });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const serve = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
};
const liveEnv = (base: string) => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: base, NPC_MODEL: "m", GM_MODEL: "m", MODEL_MAX_RETRIES: "0" });
/** A model that answers the Game Master well and every AI character with nothing (so each reply is the canned fallback line). */
const silentCharacters = () => serve((req, res) => {
  let body = ""; req.on("data", (d) => { body += d; });
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (body.includes("Game Master")) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody('{"verdict": false, "reasoning": "not yet"}', body) } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
/** A model whose character calls fail with an error message that carries secret-looking text and the hidden fact. */
const leakyErrors = (secret: string, hiddenText: string) => serve((req, res) => {
  let body = ""; req.on("data", (d) => { body += d; });
  req.on("end", () => {
    if (body.includes("Game Master")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody('{"verdict": false, "reasoning": "not yet"}', body) } }] })}\n\n`); res.end("data: [DONE]\n\n"); return; }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `bad request: key ${secret} Bearer abcdefghijklmnop sk-test-0123456789abcdef and ${hiddenText}` } }));
  });
});
const run = async (argv: string[], over: Partial<RunDeps> = {}) => { const c = capture(); const r = await runDemo(deps(c, argv, over)); return { ...r, c, text: c.out.join("") + c.err.join("") }; };
const f08 = (r: Report) => r.results.find((x) => x.id === "F-08")!;

describe("mock mode (US-0023): offline, deterministic, identical checks, zero fallbacks", () => {
  it("reports 0 of 4 replies in the narration, F-08 and the JSON; --max-fallbacks 0 passes with the same 29 checks", async () => {
    for (const extra of [[], ["--max-fallbacks", "0"]]) {
      const { exitCode, report, text } = await run(["--fast", "--no-color", ...extra]);
      expect(exitCode).toBe(0);
      expect(report!.summary).toEqual({ passed: CHECKS.length, failed: 0, skipped: 0 });
      expect(report!.liveEvidence).toMatchObject({ npcReplies: 4, fallbackReplies: 0, warnings: [], alerts: [], maxFallbacks: extra.length ? 0 : null });
      expect(f08(report!).details).toContain(extra.length ? "0 canned fallback lines of 4 AI replies (limit 0)" : "; 0 canned fallback lines of 4 AI replies");
      expect(f08(report!).details).not.toContain("WARNING");
      expect(text).toContain("AI character replies so far: 0 canned fallback lines of 4 AI replies");
      expect(text).toContain("Run summary");
      expect(text).toContain("AI character replies: 4; scripted 4, canned fallback 0");
      expect(text).toContain("facilitator alerts: 0");
      expect(text).toContain("3 players joined, each with the join code of their role (codes are never shown)");
      expect(text).toMatch(/was replayed \d+ missed events/);
    }
  });
});

describe("live mode (US-0023): fallback lines and alert reasons", () => {
  it("counts the canned lines, shows the alert reason next to each reply, and only warns without --max-fallbacks (exit 0)", async () => {
    const base = await silentCharacters();
    const { exitCode, report, text } = await run(["--live", "--fast", "--no-color"], { resolveLiveEnv: () => liveEnv(base) });
    expect(report!.results.filter((r) => r.status === "failed")).toEqual([]);
    expect(exitCode).toBe(0);
    const ev = report!.liveEvidence!;
    expect(ev).toMatchObject({ npcReplies: 2, fallbackReplies: 2, maxFallbacks: null });
    expect(ev.warnings).toEqual(["2 of 2 AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)"]);
    const fb = ev.alerts.filter((a) => a.fallback);
    expect(fb).toHaveLength(2);
    expect(fb.every((a) => a.level === "warning" && a.role === "client_sponsor" && a.replySeq !== null && a.reason.length > 0)).toBe(true);
    expect(f08(report!).status).toBe("passed");
    expect(f08(report!).details).toContain("WARNING: 2 canned fallback lines of 2 AI replies (no --max-fallbacks limit given)");
    expect(text).toContain("Priya Raman (client_sponsor), canned fallback line: ");
    expect(text).toMatch(/alert \(warning\) for this reply: fell back to its canned line: /);
    expect(text).toContain("AI character replies: 2; real 0, canned fallback 2 (no --max-fallbacks limit: only a warning)");
    expect(text).toContain("facilitator alerts: 2");
  });

  it("--max-fallbacks n fails the run (exit 1, F-08) when more than n replies were canned, and passes at the limit", async () => {
    const base = await silentCharacters();
    const over = await run(["--live", "--fast", "--no-color", "--max-fallbacks", "1"], { resolveLiveEnv: () => liveEnv(base) });
    expect(over.exitCode).toBe(1);
    expect(f08(over.report!)).toMatchObject({ status: "failed" });
    expect(f08(over.report!).details).toContain("2 canned fallback lines of 2 AI replies, more than --max-fallbacks 1");
    expect(over.report!.results.filter((r) => r.status === "failed").map((r) => r.id)).toEqual(["F-08"]);
    const at = await run(["--live", "--fast", "--no-color", "--max-fallbacks", "2"], { resolveLiveEnv: () => liveEnv(base) });
    expect(at.exitCode).toBe(0);
    expect(f08(at.report!).details).toContain("2 canned fallback lines of 2 AI replies (limit 2)");
  });

  it("writes only sanitized alert text: no key, token, join code or hidden fact in the narration, the JSON or the transcript", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-live-evidence-out-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const secret = "TOPSECRETKEYVALUE0123456789";
    const hiddenText = "phased delivery after go-live if the risk";
    const base = await leakyErrors(secret, hiddenText);
    const { exitCode, report, text } = await run(["--live", "--fast", "--no-color", "--transcript", "t.md", "--json", "r.json"], { cwd: dir, resolveLiveEnv: () => ({ ...liveEnv(base), LOCAL_API_KEY: secret }) });
    expect(exitCode).toBe(0);
    expect(report!.liveEvidence!.fallbackReplies).toBe(2);
    const all = [text, JSON.stringify(report), await readFile(path.join(dir, "t.md"), "utf8"), await readFile(path.join(dir, "r.json"), "utf8")].join("\n");
    for (const bad of [secret, "abcdefghijklmnop", "sk-test-0123456789abcdef", hiddenText, base]) expect(all).not.toContain(bad);
    expect(report!.liveEvidence!.alerts.some((a) => a.fallback && a.reason.includes("[redacted]"))).toBe(true);
  });

  it("a bad --max-fallbacks value is a usage error (exit 2) before anything starts", async () => {
    for (const raw of ["-1", "x", "1.5", "1001"]) {
      const { exitCode, c } = await run(["--fast", `--max-fallbacks=${raw}`]);
      expect(exitCode).toBe(2);
      expect(c.out).toEqual([]);
      expect(c.err.join("")).toContain("error: --max-fallbacks must be a whole number from 0 to 1000");
    }
  });
});
