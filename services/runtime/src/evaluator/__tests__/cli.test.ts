import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChatRequest } from "@acr/adapters";
import { EVALUATE_USAGE, findScenarioDir, runEvaluate, secretValues } from "../cli.js";
import { summaryLines } from "../summary.js";
import { build } from "./fixtures.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SAYS: [string, string][] = [
  ["delivery_lead", "Okay, Priya's email is in. First reactions on the request from the client?"], ["tech_lead", "My worry is the ingestion layer. Anything we add now competes with go-live."],
  ["account_manager", "I would rather not say no outright. The renewal is in play, so a refusal lands badly."], ["delivery_lead", "So what if we offer a phased module after go-live, scoped and priced?"],
  ["tech_lead", "I can live with that. The phased version is roughly half the work."], ["account_manager", "Agreed. Position: phase two after go-live, priced as a change request."],
];
function logText(): string {
  const evs = build([
    [0, { type: "session.started", scenarioId: "esc-scope-creep-01", version: "1.2", roles: {} }],
    [1, { type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead", "tech_lead", "account_manager"] }],
    ...SAYS.map(([r, t], i) => [10 + i * 20, { type: "utterance", roleId: r, text: t, channel: "text" }] as [number, never]),
    [200, { type: "scene.exited", sceneId: "s1_huddle", reason: "gm_detects" }],
    [201, { type: "session.ended", reason: "script_complete" }],
  ] as never, "cli-sess");
  return evs.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let dir: string;
let log: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cli-")); log = path.join(dir, "cli-sess.jsonl"); await writeFile(log, logText()); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function io() {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } };
}
const run = (argv: string[], env: NodeJS.ProcessEnv = {}, extra: Partial<Parameters<typeof runEvaluate>[0]> = {}) => {
  const o = io();
  return runEvaluate({ argv, stdout: o.stdout, stderr: o.stderr, env, repoRoot: REPO, cwd: dir, ...extra }).then((r) => ({ ...r, out: o.out.join(""), err: o.err.join("") }));
};

describe("usage", () => {
  it("--help prints the usage and exits 0", async () => {
    const r = await run(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(EVALUATE_USAGE);
    expect(EVALUATE_USAGE).toMatch(/exit codes: 0 .* 1 .* 2/);
  });
  it.each([[[]], [["a.jsonl", "b.jsonl"]], [["x.jsonl", "--bogus"]], [["x.jsonl", "--json", "out.json"]], [["x.jsonl", "--out", ""]], [["x.jsonl", "--scenario"]]])("%j is a usage error (exit 2)", async (argv) => {
    const r = await run(argv as string[]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toMatch(/error:/);
  });
  it("a missing or invalid log is an input error (2) that does not echo the path", async () => {
    const r = await run([path.join(dir, "nope.jsonl")]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain("cannot read the session log (ENOENT)");
    expect(r.err).not.toContain(dir);
    await writeFile(path.join(dir, "bad.jsonl"), "not json\nstill not\n");
    expect((await run([path.join(dir, "bad.jsonl")])).err).toMatch(/malformed event at line 1/);
  });
  it("an unknown scenario id asks for --scenario; a bad --scenario dir or rubrics are input errors", async () => {
    const text = (await readFile(log, "utf8")).replaceAll("esc-scope-creep-01", "no-such-scenario");
    const other = path.join(dir, "other.jsonl"); await writeFile(other, text);
    const r = await run([other]);
    expect(r.exitCode).toBe(2);
    expect(r.err).toMatch(/no scenario with id "no-such-scenario".*--scenario/);
    expect((await run([log, "--scenario", path.join(dir, "missing")])).err).toMatch(/cannot load the scenario/);
    const copy = path.join(dir, "sc"); await cp(path.join(REPO, "scenarios/friday-escalation"), copy, { recursive: true });
    await rm(path.join(copy, "rubrics", "group_collaboration_v1.yaml"));
    const bad = await run([log, "--scenario", copy]);
    expect(bad.exitCode).toBe(2);
    expect(bad.err).toMatch(/the rubrics are invalid: .*group_collaboration_v1\.yaml/);
  });
  it("invalid evaluator settings or an unusable provider are input errors naming variables, never values", async () => {
    expect((await run([log], { EVAL_MAX_TOKENS: "5" })).err).toMatch(/EVAL_MAX_TOKENS/);
    const r = await run([log], { MODEL_PROVIDER: "anthropic" });
    expect(r.exitCode).toBe(2);
    expect(r.err).toMatch(/ANTHROPIC_API_KEY is empty/);
    expect((await run([log], { MODEL_PROVIDER: "nope" })).err).toMatch(/unknown MODEL_PROVIDER/);
  });
});

describe("a run with the scripted offline evaluator (MODEL_PROVIDER mock)", () => {
  it("finds the scenario by the id in the log, writes every report and exits 0", async () => {
    const out = path.join(dir, "reports");
    const r = await run([log, "--out", out]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toMatch(/NOTICE: MODEL_PROVIDER is mock: using the scripted offline evaluator/);
    expect(r.out).toMatch(/delivery_lead: LO1 .*; LO2 .*; LO3/);
    expect(r.out).toMatch(/team: Shared understanding \d/);
    expect(r.out).toMatch(/model calls: \d+/);
    expect(r.out).toMatch(/reports written to /);
    const files = await readdir(path.join(out, "cli-sess"));
    expect(files.sort()).toEqual(["account_manager.json", "account_manager.md", "delivery_lead.json", "delivery_lead.md", "group.json", "group.md", "index.md", "method.md", "tech_lead.json", "tech_lead.md"]);
    const md = await readFile(path.join(out, "cli-sess", "delivery_lead.md"), "utf8");
    expect(md).toContain("scripted offline evaluator (demo data, not a real assessment)");
    expect(md).toContain("Visibility: facilitator only until released");
  });
  it("exercises the verification (an invented quote is dropped, a 4 is capped) and the re-ask path", async () => {
    const r = await run([log, "--out", path.join(dir, "o"), "--json", "-"]);
    expect(r.exitCode).toBe(0);
    const summary = JSON.parse(r.out.slice(r.out.indexOf("{")));
    expect(summary).toMatchObject({ ok: true, session: "cli-sess", failures: [] });
    expect(summary.files).toContain("index.md");
    expect(summary.modelCalls).toBe(5); // 3 players + 1 re-ask + group
    const json = JSON.parse(await readFile(path.join(dir, "o", "cli-sess", "delivery_lead.json"), "utf8"));
    const first = json.criteria[0];
    expect(first.dropped_quotes).toBe(1);
    expect(first.score).toBe(2);
    expect(first.flags.join(" ")).toMatch(/capped from 4 to 2/);
    expect(r.err).toMatch(/evaluating delivery_lead/); // with --json - the narration is on stderr
  });
  it("a second run never overwrites the first", async () => {
    const out = path.join(dir, "o2");
    await run([log, "--out", out]); await run([log, "--out", out]);
    expect((await readdir(out)).sort()).toEqual(["cli-sess", "cli-sess-2"]);
  });
});

describe("a run against a real provider", () => {
  const reply = (req: ChatRequest) => (/role id "tech_lead"/.test(req.system) ? "never json" : JSON.stringify({ criteria: [{ id: "discovery", score: null }, { id: "shared_understanding", score: null }], talking_points: ["x"] }));
  const provider = { name: "fake", async *stream(req: ChatRequest) { yield reply(req); } };
  it("prints the consent notice with the provider label, exits 1 when a participant failed but still writes all reports", async () => {
    const out = path.join(dir, "o3");
    const r = await run([log, "--out", out], { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345" }, { provider });
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/NOTICE: this sends the session transcript .* to the configured model provider \(OpenRouter \(custom endpoint: no\)\)/);
    expect(r.err).toMatch(/evaluation failed: tech_lead: evaluation failed: the reply could not be used/);
    expect((await readdir(path.join(out, "cli-sess"))).length).toBe(10);
    expect(await readFile(path.join(out, "cli-sess", "tech_lead.md"), "utf8")).toMatch(/evaluation failed: the reply could not be used/);
    expect(r.out + r.err).not.toContain("sk-or-secret-value-12345");
  });
});

describe("helpers", () => {
  it("findScenarioDir matches by id and returns null otherwise", async () => {
    expect(await findScenarioDir(REPO, "esc-scope-creep-02")).toBe(path.join(REPO, "scenarios", "friday-escalation-extended"));
    expect(await findScenarioDir(REPO, "zzz")).toBeNull();
    expect(await findScenarioDir(path.join(dir, "nowhere"), "zzz")).toBeNull();
  });
  it("secretValues picks key-like variables of 8+ characters", () => { expect(secretValues({ A_API_KEY: "12345678", B_TOKEN: "short", C: "12345678901" })).toEqual(["12345678"]); });
  it("summaryLines lists each participant and the team", () => {
    const lines = summaryLines({
      participants: [{ roleId: "a", status: "ok", objectives: [{ id: "LO1", score: 3, label: "Proficient" }] }, { roleId: "b", status: "failed", reason: "evaluation failed: x", objectives: [] }],
      group: { status: "ok", criteria: [{ name: "Shared understanding", score: 3 }, { name: "Decision quality", score: null }] }, modelCalls: 4,
    } as never);
    expect(lines).toEqual(["a: LO1 3.0 - Proficient", "b: evaluation failed: x", "team: Shared understanding 3; Decision quality N/O", "model calls: 4"]);
  });
});

describe("the calibration stamp in a run", () => {
  const ok = { criteria: [{ id: "discovery", score: null }, { id: "shared_understanding", score: null }], talking_points: ["x"] };
  const provider = { name: "fake", async *stream() { yield JSON.stringify(ok); } };
  const ENV = { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", EVAL_MODEL: "gemma-4-31b" };
  const SUMMARY = (hash: string) => ({ schema: "acr.calibration.summary/1", scenarioId: "esc-scope-creep-01", rubricHash: hash, variant: "v1", judge: { label: "primary", model: "gemma-4-31b" }, ranAt: "2026-10-08T00:00:00.000Z",
    probes: { total: 34, tune: 14, holdout: 20 }, exact: { n: 27, of: 32 }, bias: 0.16, contrast: { ordered: 4, of: 4, probes: 4 }, usable: { n: 32, of: 32 }, label: "PASS" });
  async function storeSummary(hash: string, model = "gemma-4-31b") {
    const { summaryFile } = await import("../../calibration/report.js");
    const f = summaryFile(path.join(dir, "data/calibration"), "esc-scope-creep-01", model, "v1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(SUMMARY(hash)));
  }
  const hashOf = async () => {
    const { loadEvaluationInput } = await import("../cli.js");
    const { rubricHash } = await import("../../calibration/rubric-hash.js");
    const sdir = await findScenarioDir(REPO, "esc-scope-creep-01");
    return rubricHash((await loadEvaluationInput(sdir!)).rubrics);
  };
  it("a real run with no calibration file is stamped not calibrated and records the variant and rubric hash in the JSON", async () => {
    const out = path.join(dir, "c1");
    await run([log, "--out", out], ENV, { provider });
    const j = JSON.parse(await readFile(path.join(out, "cli-sess", "group.json"), "utf8"));
    expect(j.evaluator).toMatchObject({ model: "gemma-4-31b", variant: "v1", calibration: { state: "not_calibrated" } });
    expect(j.evaluator.rubricHash).toBe(await hashOf());
    expect(await readFile(path.join(out, "cli-sess", "index.md"), "utf8")).toMatch(/Calibration: not calibrated/);
  });
  it("a matching calibration summary stamps measured numbers in index, group and personal reports", async () => {
    await storeSummary(await hashOf());
    const out = path.join(dir, "c2");
    await run([log, "--out", out], ENV, { provider });
    for (const f of ["index.md", "group.md", "delivery_lead.md"]) expect(await readFile(path.join(out, "cli-sess", f), "utf8"), f).toMatch(/Scored by gemma-4-31b, prompt v1\. Calibration on 34 probes \(2026-10-08\): 27 of 32 exact/);
  });
  it("a summary for another rubric hash is stale, and one for another model is ignored", async () => {
    await storeSummary("0000000000000000");
    const o1 = path.join(dir, "c3");
    await run([log, "--out", o1], ENV, { provider });
    expect(await readFile(path.join(o1, "cli-sess", "index.md"), "utf8")).toMatch(/not calibrated for this rubric or prompt version/);
    const o2 = path.join(dir, "c4");
    await run([log, "--out", o2], { ...ENV, EVAL_MODEL: "other-model" }, { provider });
    expect(await readFile(path.join(o2, "cli-sess", "index.md"), "utf8")).toMatch(/Calibration: not calibrated \(/);
  });
  it("a run configured with NPC_MODEL only records and looks up that model, and prints the variant and rubric hash in every Markdown report", async () => {
    await storeSummary(await hashOf());
    const out = path.join(dir, "c7");
    await run([log, "--out", out], { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: "sk-or-secret-value-12345", NPC_MODEL: " gemma-4-31b " }, { provider });
    const g = JSON.parse(await readFile(path.join(out, "cli-sess", "group.json"), "utf8"));
    expect(g.evaluator).toMatchObject({ model: "gemma-4-31b", variant: "v1", calibration: { state: "ok" } });
    const h = await hashOf();
    for (const f of ["group.md", "delivery_lead.md"]) { const md = await readFile(path.join(out, "cli-sess", f), "utf8"); expect(md).toContain("| Prompt variant | `v1`, rubric `" + h + "` |"); expect(md).toContain("model gemma-4-31b"); }
    expect(await readFile(path.join(out, "cli-sess", "index.md"), "utf8")).toContain("Prompt variant `v1`, rubric `" + h + "`.");
  });
  it("a summary that names another model but has the same file name (slug collision) is not_calibrated", async () => {
    const { summaryFile } = await import("../../calibration/report.js");
    const { mkdir } = await import("node:fs/promises");
    const f = summaryFile(path.join(dir, "data/calibration"), "esc-scope-creep-01", "gemma-4-31b", "v1");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify({ ...SUMMARY(await hashOf()), judge: { label: "primary", model: "Gemma:4:31b" } }));
    const out = path.join(dir, "c8");
    await run([log, "--out", out], ENV, { provider });
    expect(await readFile(path.join(out, "cli-sess", "index.md"), "utf8")).toMatch(/Calibration: not calibrated \(/);
  });
  it("the scripted evaluator's header row is a deterministic constant for the same rubrics", async () => {
    const a = path.join(dir, "d1"), b = path.join(dir, "d2");
    await run([log, "--out", a]); await run([log, "--out", b]);
    const row = (t: string) => /\| Prompt variant \|[^\n]*/.exec(t)![0];
    expect(row(await readFile(path.join(a, "cli-sess", "group.md"), "utf8"))).toBe(row(await readFile(path.join(b, "cli-sess", "group.md"), "utf8")));
  });
  it("a corrupt summary never breaks a run", async () => {
    const { summaryFile } = await import("../../calibration/report.js");
    const f = summaryFile(path.join(dir, "data/calibration"), "esc-scope-creep-01", "gemma-4-31b", "v1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, "{broken");
    const out = path.join(dir, "c5");
    const r = await run([log, "--out", out], ENV, { provider });
    expect(r.exitCode).toBe(0);
    expect(await readFile(path.join(out, "cli-sess", "group.md"), "utf8")).toMatch(/Calibration: not calibrated/);
  });
  it("the scripted evaluator is never looked up: it is stamped with the constant not-calibrated line even when a summary exists", async () => {
    await storeSummary(await hashOf());
    const out = path.join(dir, "c6");
    await run([log, "--out", out], { EVAL_MODEL: "gemma-4-31b" });
    const md = await readFile(path.join(out, "cli-sess", "index.md"), "utf8");
    expect(md).toContain("Calibration: not calibrated (no calibration result for this judge, prompt variant and rubric).");
    expect(md).not.toMatch(/Scored by/);
  });
});
