import { stampFromBody } from "./nonce.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { parseDemoArgs } from "../args.js";
import { evaluateExtraMs, runDemo, type RunDeps } from "../runner.js";
import { SHOWCASE_CHECKS } from "../showcase.js";
// Whole-demo and real-process/socket tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
const PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-showcase-eval-"));
afterAll(() => rmSync(PARENT, { recursive: true, force: true }));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

let counter = 0;
const outDir = () => path.join(PARENT, `reports-${++counter}`);
const run = async (argv: string[], over: Partial<RunDeps> = {}) => {
  const c = capture();
  const r = await runDemo({
    argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test", tempParent: PARENT, cwd: PARENT,
    resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
  });
  return { ...r, stdout: c.out.join(""), stderr: c.err.join("") };
};

describe("args", () => {
  it("--evaluate and --eval-out", () => {
    expect(parseDemoArgs(["--showcase", "--evaluate", "--eval-out", "out"])).toMatchObject({ ok: true, opts: { evaluate: true, evalOut: "out" } });
    expect(parseDemoArgs(["--showcase"])).toMatchObject({ ok: true, opts: { evaluate: undefined, evalOut: undefined } });
    for (const [argv, msg] of [[["--evaluate"], "error: --evaluate needs --showcase"], [["--showcase", "--eval-out", "x"], "error: --eval-out needs --evaluate"], [["--showcase", "--evaluate", "--eval-out", ""], "error: --eval-out needs a directory path"], [["--showcase", "--evaluate", "--evaluate"], "error: --evaluate was given more than once"]] as [string[], string][]) {
      const r = parseDemoArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(msg);
    }
  });
});

describe("pnpm demo --showcase --evaluate (mock mode)", () => {
  it("adds check S-16, writes a report per player and the group, narrates a summary and lists the files in the --json report", async () => {
    const out = outDir(); const json = path.join(PARENT, "r.json");
    const { exitCode, report, stdout } = await run(["--showcase", "--fast", "--no-color", "--evaluate", "--eval-out", out, "--json", json]);
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.results.map((r) => r.id)).toEqual([...SHOWCASE_CHECKS.map((c) => c.id), "S-16"]);
    const dir = path.join(out, "demo");
    expect(readdirSync(dir).sort()).toEqual(["account_manager.json", "account_manager.md", "delivery_lead.json", "delivery_lead.md", "group.json", "group.md", "index.md", "method.md", "tech_lead.json", "tech_lead.md"]);
    expect(stdout).toContain("EVALUATION: feedback reports for the session");
    expect(stdout).toMatch(/scripted offline evaluator/);
    expect(stdout).toMatch(/delivery_lead: LO1 .*; LO2 .*; LO3 .*; LO4/);
    expect(stdout).toMatch(/model calls: 5/);
    expect(stdout).toMatch(/S-16 3 of 3 players evaluated; 4 reports \(3 players and the group\) in 10 files/);
    expect(report!.evaluation).toMatchObject({ modelCalls: 5, group: { status: "ok" }, failures: [], participants: [{ role: "account_manager", status: "ok" }, { role: "delivery_lead", status: "ok" }, { role: "tech_lead", status: "ok" }] });
    expect(report!.evaluation!.files).toContain("index.md");
    const written = JSON.parse(readFileSync(json, "utf8"));
    expect(written.evaluation.files).toHaveLength(10);
    // the mock run is deterministic: a second run gives the same scores
    const second = outDir();
    await run(["--showcase", "--fast", "--no-color", "--evaluate", "--eval-out", second]);
    for (const f of ["delivery_lead.json", "group.json", "index.md"]) expect(readFileSync(path.join(second, "demo", f), "utf8")).toBe(readFileSync(path.join(dir, f), "utf8"));
    // the scripted evaluator exercised the verification and the re-ask
    const dl = JSON.parse(readFileSync(path.join(dir, "delivery_lead.json"), "utf8"));
    expect(dl.criteria.some((c: { dropped_quotes: number }) => c.dropped_quotes > 0)).toBe(true);
    expect(dl.criteria[0].flags.join(" ")).toMatch(/capped from 4 to 2/);
  });

  it("S-16 reads the files back from disk: a quote edited in <role>.json after writing makes S-16 fail with 'quote is not verbatim'", async () => {
    const r = await run(["--showcase", "--fast", "--no-color", "--evaluate", "--eval-out", outDir()], {
      afterReportsWritten: async (dir) => {
        const file = path.join(dir, "account_manager.json");
        const j = JSON.parse(readFileSync(file, "utf8"));
        const c = j.criteria.find((x: { evidence: unknown[] }) => x.evidence.length > 0);
        c.evidence[0].quote = `${c.evidence[0].quote} and something nobody said`;
        await writeFile(file, JSON.stringify(j));
      },
    });
    expect(r.exitCode).toBe(1);
    const s16 = r.report!.results.find((x) => x.id === "S-16")!;
    expect(s16.status).toBe("failed");
    expect(s16.details).toMatch(/quote is not verbatim/);
    expect(r.report!.results.filter((x) => x.status === "failed").map((x) => x.id)).toEqual(["S-16"]);
  });

  it("without --evaluate the run is exactly S-01 to S-14, writes no reports and has no evaluation section", async () => {
    const { report } = await run(["--showcase", "--fast", "--no-color"]);
    expect(report!.results.map((r) => r.id)).toEqual(SHOWCASE_CHECKS.map((c) => c.id));
    expect(report!.evaluation).toBeUndefined();
    expect(existsSync(path.join(PARENT, "data"))).toBe(false);
  });

  it("the transcript Markdown keeps its dialogue and does not mention the evaluation", async () => {
    const a = path.join(PARENT, "ta.md"); const b = path.join(PARENT, "tb.md");
    await run(["--showcase", "--fast", "--no-color", "--transcript", a]);
    await run(["--showcase", "--fast", "--no-color", "--evaluate", "--eval-out", outDir(), "--transcript", b]);
    const body = (t: string) => t.slice(t.indexOf("## Legend"), t.indexOf("## Checks"));
    const ta = await readFile(a, "utf8"); const tb = await readFile(b, "utf8");
    expect(body(tb)).toBe(body(ta));
    expect(tb).not.toMatch(/EVALUATION/);
    expect(tb).toMatch(/\| S-16 \| passed \|/);
  });

  it("a scenario whose rubrics are invalid is refused up front", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-eval-variant-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await cp(path.join(REPO_ROOT, "scenarios", "friday-escalation-extended"), dir, { recursive: true });
    await rm(path.join(dir, "rubrics", "group_collaboration_v1.yaml"));
    const r = await run(["--showcase", "--evaluate", "--scenario", dir, "--eval-out", outDir()]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--showcase cannot use that scenario: the rubrics are invalid: .*group_collaboration_v1/);
    expect(r.stdout).toBe("");
  });

  it("never reads the live environment in a mock run", async () => {
    expect((await run(["--showcase", "--fast", "--evaluate", "--eval-out", outDir()], { resolveLiveEnv: () => { throw new Error("no"); } })).exitCode).toBe(0);
  });
});

describe("pnpm demo --showcase --live --evaluate (a fake OpenAI-compatible server on loopback)", () => {
  const ALL_IDS = ["discovery", "listening", "negotiation", "commercial_judgement", "stakeholder_management", "team_alignment", "role_clarity", "shared_understanding", "decision_quality", "role_clarity_group", "escalation_discipline"];
  const evalJson = JSON.stringify({ criteria: ALL_IDS.map((id) => ({ id, score: null, rationale: "nothing observed" })), strengths: ["You took part."], talking_points: ["Discuss the price."] });
  const start = async (evaluatorReply: string) => {
    const seen = { eval: 0, bodies: [] as string[] };
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const isEval = body.includes("learning-and-development assessor");
        const isGm = body.includes("Game Master");
        if (isEval) { seen.eval++; seen.bodies.push(body); }
        const text = isEval ? evaluatorReply : isGm ? '{"verdict": false, "reasoning": "not yet"}' : "I hear you, tell me more.";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody(text, body) } }] })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return { port: (server.address() as { port: number }).port, seen };
  };
  const env = (port: number, extra: NodeJS.ProcessEnv = {}) => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m", LOCAL_API_KEY: "live-eval-secret-key-0123456789", ...extra });

  it("sends the transcript to the model provider (with a notice), makes one call per evaluable player plus one for the group and passes S-16", async () => {
    const { port, seen } = await start(evalJson);
    const out = outDir();
    const r = await run(["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color", "--evaluate", "--eval-out", out], { resolveLiveEnv: () => env(port, { EVAL_MODEL: "judge-1" }) });
    expect(r.report!.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(seen.eval).toBe(2); // --max-lines 1: only the delivery lead speaks enough to be evaluated, plus the group
    expect(r.stdout).toMatch(/NOTICE: --evaluate sends the whole session transcript .* to the configured model provider/);
    expect(r.stdout).toMatch(/The evaluator sends the session transcript to the configured model provider/);
    expect(seen.bodies.every((b) => b.includes('"model":"judge-1"'))).toBe(true);
    expect(seen.bodies[0]).toContain("<<<TRANSCRIPT ");
    expect(readdirSync(path.join(out, "demo"))).toHaveLength(10);
    const md = readFileSync(path.join(out, "demo", "delivery_lead.md"), "utf8");
    expect(md).toMatch(/Evaluator \| local OpenAI-compatible server \(custom endpoint: yes\), model judge-1/);
    const everything = r.stdout + r.stderr + JSON.stringify(r.report) + md;
    expect(everything).not.toContain("live-eval-secret-key-0123456789");
    expect(everything).not.toContain(String(port));
  });

  it("an evaluator that never returns usable JSON fails S-16 (no participant could be evaluated) and reports each failure", async () => {
    const { port } = await start("I will not give JSON");
    const r = await run(["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color", "--evaluate", "--eval-out", outDir()], { resolveLiveEnv: () => env(port) });
    expect(r.exitCode).toBe(1);
    expect(r.report!.results.find((x) => x.id === "S-16")).toMatchObject({ status: "failed", details: expect.stringMatching(/no participant could be evaluated/) });
    expect(r.report!.evaluation!.failures.length).toBe(2);
    expect(r.report!.evaluation!.participants.map((p) => p.status)).toEqual(["insufficient_evidence", "failed", "insufficient_evidence"]);
  });

  it("invalid evaluator settings are refused before anything starts, naming the variable", async () => {
    const r = await run(["--showcase", "--live", "--fast", "--evaluate", "--eval-out", outDir()], { resolveLiveEnv: () => env(1, { EVAL_MAX_TOKENS: "5" }) });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/EVAL_MAX_TOKENS/);
    expect(r.stdout).toBe("");
  });
});

describe("the live --evaluate watchdog", () => {
  it("grows by EVAL_TIMEOUT_MS x (players + 1) x 2, for a default and for an explicit --watchdog", async () => {
    expect(evaluateExtraMs(180_000, 3)).toBe(1_440_000); // 24 minutes
    const server = http.createServer((req, res) => {
      let body = ""; req.on("data", (d) => { body += d; });
      req.on("end", () => {
        const text = body.includes("learning-and-development assessor") ? JSON.stringify({ criteria: [{ id: "discovery", score: null }, { id: "shared_understanding", score: null }] }) : body.includes("Game Master") ? '{"verdict": false, "reasoning": "x"}' : "ok then";
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: stampFromBody(text, body) } }] })}\n\n`); res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const port = (server.address() as { port: number }).port;
    const env = { MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://127.0.0.1:${port}/v1`, NPC_MODEL: "m", GM_MODEL: "m" };
    const base = ["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color", "--evaluate"];
    const a = await run([...base, "--eval-out", outDir()], { resolveLiveEnv: () => env });
    expect(a.report!.showcase!.watchdogMinutes).toBe(30 + 24);
    const b = await run([...base, "--watchdog", "5", "--eval-out", outDir()], { resolveLiveEnv: () => env });
    expect(b.report!.showcase!.watchdogMinutes).toBe(5 + 24);
    const c = await run(["--showcase", "--live", "--max-lines", "1", "--fast", "--no-color"], { resolveLiveEnv: () => env });
    expect(c.report!.showcase!.watchdogMinutes).toBe(30); // without --evaluate nothing changes
  });
});
