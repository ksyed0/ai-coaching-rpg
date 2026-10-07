import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { describeModelProvider, selectModelProvider, type ModelProvider } from "@acr/adapters";
import { initialState } from "@acr/events";
import { loadScenario, validateScenario, type Scene } from "@acr/script";
import { buildGmRequest } from "../agents/gm-prompt.js";
import { parseGmReply } from "../agents/gm-parse.js";
import { newGmNonce, runGmEvaluation } from "../agents/gm-evaluate.js";
import { parseGmConfig } from "../agents/gm-config.js";
import { parseNpcTimeouts } from "../agents/timeouts.js";
import { parseTokenBudgets } from "../agents/token-budgets.js";
import { parseTemperatures } from "../agents/temperatures.js";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import { scrubText } from "../demo/report.js";
import { loadShowcaseScript } from "../demo/showcase-script.js";
import { CaseFileError, buildShowcaseCases, loadCases, type GmCase } from "./cases.js";
import { formatMetrics, summarize, type RunResult } from "./metrics.js";
import { replayTrace } from "./replay.js";

export const GM_EVAL_USAGE = [
  "usage: pnpm gm-eval [--cases <dir|file>] [--corpus <file>] [--trace <file>] [--scenario <dir>] [--build <dir>] [--live [--runs <n>]] [--json <path|->] [--help]",
  "  Offline (the default; no model call, safe in CI): checks the labelled cases (valid, one negative control per scene, in step with the showcase script),",
  "  runs the parser over the corpus of raw replies, and with --trace replays a captured run through the CURRENT parser.",
  "  --cases <dir|file>  labelled cases: JSON files {cases: [{id, scene, condition, dialogue, label, source}]} (default tests/gm-cases)",
  "  --corpus <file>     raw replies with the expected parse (default tests/gm-cases/parser-corpus.json)",
  "  --trace <file>      a Game Master trace from `pnpm demo --showcase --gm-trace <file>` (or GM_TRACE_FILE): re-parse every raw reply offline and report parse rate by reason and drift",
  "  --scenario <dir>    the scenario whose showcase script the cases come from (default scenarios/friday-escalation-extended)",
  "  --build <dir>       (re)write <dir>/showcase.json from the showcase script (full scene = met, cut before the agreement = not met), then exit",
  "  --live              ALSO ask the configured model provider (GM_MODEL) to judge every case --runs times (default 3) with the production prompt, re-ask and",
  "                      timeout, and report parse rate, agreement with the labels, precision, recall, false exits on negative controls, attempts and latency.",
  "                      Sends the case dialogues to the provider and may cost money. Run by hand, never in CI.",
  "  --runs <n>          --live only: runs per case, 1 to 20",
  "  --json <path|->     also write the figures as JSON (- = stdout; the text then goes to stderr; run `pnpm -s gm-eval ...`)",
  "exit codes: 0 all checks passed, 1 a check failed (invalid or stale cases, a parser corpus mismatch, or every --live model call failed), 2 usage or input error",
].join("\n");

export type Out = { write(chunk: string): unknown };
export type GmEvalDeps = {
  argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; repoRoot: string; cwd?: string;
  /** Test hook: this provider judges the cases in --live (instead of the configured one). */
  provider?: ModelProvider;
};

const DEFAULT_CASES = "tests/gm-cases";
const DEFAULT_CORPUS = "tests/gm-cases/parser-corpus.json";
const DEFAULT_SCENARIO = "scenarios/friday-escalation-extended";
const hasControl = (v: string) => new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(v);

/** The parser corpus: raw replies as real models write them, each with the parse the tolerant parser must give. */
export type CorpusEntry = { id: string; raw: string; /** The nonce the reply was asked to carry (omit to read every shape, as the offline rules do). */ nonce?: string; expect: { ok: true; verdict: boolean; via?: "strict" | "tolerant" } | { ok: false; reason: string } };

export async function loadCorpus(file: string): Promise<CorpusEntry[]> {
  let data: unknown;
  try { data = JSON.parse(await readFile(file, "utf8")); } catch { throw new CaseFileError(`cannot read the parser corpus ${path.basename(file)} (missing or not valid JSON)`); }
  const list = (data as { replies?: unknown })?.replies;
  if (!Array.isArray(list)) throw new CaseFileError(`${path.basename(file)}: replies must be an array`);
  return list.map((e, i) => {
    const r = e as Partial<CorpusEntry>;
    if (!r || typeof r.id !== "string" || typeof r.raw !== "string" || !r.expect || typeof r.expect.ok !== "boolean") throw new CaseFileError(`${path.basename(file)} reply ${i + 1}: needs id, raw and expect`);
    return r as CorpusEntry;
  });
}

/** Minimal scene and state for the production prompt builder, from a case. */
export function requestFor(c: GmCase, o: { maxTokens?: number; temperature?: number; nonce?: string | null; /** US-0019: GM_TRANSCRIPT_WINDOW (the production default when absent). */ window?: number } = {}) {
  const scene = { id: c.scene.id, title: c.scene.title, goal: c.scene.goal } as unknown as Scene;
  const state = { ...initialState(), transcript: c.dialogue.map((d, i) => ({ seq: i + 1, ts: 0, sceneId: c.scene.id, roleId: d.role, text: d.text, channel: "text" as const })) };
  return buildGmRequest({ scene, condition: c.condition, state, ...o, nonce: o.nonce ?? null });
}

export async function runGmEval(deps: GmEvalDeps): Promise<{ exitCode: number }> {
  let values: { cases?: string; corpus?: string; trace?: string; scenario?: string; build?: string; live?: boolean; runs?: string; json?: string; help?: boolean };
  try {
    ({ values } = parseArgs({ args: deps.argv, allowPositionals: false, strict: true, options: {
      cases: { type: "string" }, corpus: { type: "string" }, trace: { type: "string" }, scenario: { type: "string" }, build: { type: "string" },
      live: { type: "boolean" }, runs: { type: "string" }, json: { type: "string" }, help: { type: "boolean" },
    } }));
  } catch (e) { deps.stderr.write(`error: ${(e as Error).message.split("\n")[0]}\n${GM_EVAL_USAGE}\n`); return { exitCode: 2 }; }
  if (values.help) { deps.stdout.write(`${GM_EVAL_USAGE}\n`); return { exitCode: 0 }; }
  const usage = (m: string) => { deps.stderr.write(`${m}\n${GM_EVAL_USAGE}\n`); return { exitCode: 2 }; };
  for (const f of ["cases", "corpus", "trace", "scenario", "build", "json"] as const) {
    const v = values[f];
    if (v !== undefined && (v === "" || hasControl(v))) return usage(`error: --${f} needs a path`);
  }
  if (values.runs !== undefined && !values.live) return usage("error: --runs needs --live");
  let runs = 3;
  if (values.runs !== undefined) {
    if (!/^[0-9]+$/.test(values.runs) || Number(values.runs) < 1 || Number(values.runs) > 20) return usage("error: --runs must be a whole number from 1 to 20");
    runs = Number(values.runs);
  }
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
  const resolve = (p: string | undefined, fallback: string) => (p === undefined ? path.resolve(deps.repoRoot, fallback) : path.resolve(base, p));
  const toErr = values.json === "-";
  const say = (m: string) => (toErr ? deps.stderr : deps.stdout).write(`${scrubText(m)}\n`);
  const problems: string[] = [];
  const figures: Record<string, unknown> = {};

  // The scenario and its showcase script (the source of the shipped cases).
  const scenarioDir = resolve(values.scenario, DEFAULT_SCENARIO);
  let built: GmCase[];
  try {
    const scenario = await loadScenario(scenarioDir);
    const { errors } = validateScenario(scenario);
    if (errors.length) throw new Error(`the scenario is invalid: ${errors.join("; ")}`);
    built = buildShowcaseCases(scenario, await loadShowcaseScript(scenarioDir, scenario, { mode: "live" }));
  } catch (e) { deps.stderr.write(`error: ${scrubText(e instanceof Error ? e.message : String(e))}\n`); return { exitCode: 2 }; }

  if (values.build !== undefined) {
    const dir = path.resolve(base, values.build);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "showcase.json");
    await writeFile(file, `${JSON.stringify({ version: 1, description: "Labelled Game Master cases built from the extended showcase script: each scene in full (condition met) and a negative control cut before the agreement (not met). Rebuild with `pnpm gm-eval --build tests/gm-cases`.", cases: built }, null, 2)}\n`);
    say(`wrote ${built.length} cases to ${path.relative(base, file) || file}`);
    return { exitCode: 0 };
  }

  // ---- offline checks --------------------------------------------------------------------------------------
  let cases: GmCase[];
  try { cases = await loadCases(resolve(values.cases, DEFAULT_CASES)); }
  catch (e) { deps.stderr.write(`error: ${scrubText(e instanceof CaseFileError ? e.message : "cannot read the cases")}\n`); return { exitCode: 2 }; }
  const positives = cases.filter((c) => c.label); const negatives = cases.filter((c) => !c.label);
  say(`cases: ${cases.length} (${positives.length} labelled met, ${negatives.length} negative controls labelled not met)`);
  for (const c of positives) if (!negatives.some((n) => n.scene.id === c.scene.id && n.condition === c.condition)) problems.push(`scene ${c.scene.id} has no negative control (a case labelled not met)`);
  for (const c of cases) { const req = requestFor(c); if (!req.system.includes(c.condition) || req.messages.length !== 1) problems.push(`case ${c.id}: the production prompt could not be built from it`); }
  const shipped = cases.filter((c) => c.source.startsWith("showcase:"));
  if (built.length > 0) {
    const fresh = JSON.stringify(built); const have = JSON.stringify(shipped);
    if (shipped.length === 0) problems.push("the cases hold no showcase cases (missing or empty showcase.json) although the showcase script has some: run `pnpm gm-eval --build tests/gm-cases`");
    else if (fresh !== have) problems.push("the showcase cases are out of date with the showcase script: run `pnpm gm-eval --build tests/gm-cases` and review the diff (labels are the human judgement in NEGATIVE_CUTS)");
    else say("the showcase cases are in step with the showcase script");
  }

  let corpus: CorpusEntry[] = [];
  try { corpus = await loadCorpus(resolve(values.corpus, DEFAULT_CORPUS)); }
  catch (e) { problems.push(e instanceof CaseFileError ? e.message : "cannot read the parser corpus"); }
  let corpusBad = 0;
  for (const e of corpus) {
    const got = parseGmReply(e.raw, { nonce: e.nonce });
    const ok = got.ok === e.expect.ok && (got.ok && e.expect.ok ? got.verdict === e.expect.verdict && (e.expect.via === undefined || got.via === e.expect.via) : !got.ok && !e.expect.ok ? got.reason === e.expect.reason : false);
    if (!ok) { corpusBad++; problems.push(`parser corpus ${e.id}: expected ${JSON.stringify(e.expect)} but the parser gave ${JSON.stringify(got.ok ? { ok: true, verdict: got.verdict, via: got.via } : got)}`); }
  }
  say(`parser corpus: ${corpus.length - corpusBad} of ${corpus.length} raw replies read as expected`);
  figures.offline = { cases: cases.length, positives: positives.length, negatives: negatives.length, corpus: corpus.length, corpusMismatches: corpusBad };

  if (values.trace !== undefined) {
    try {
      const r = await replayTrace(path.resolve(base, values.trace));
      say(`trace replay: ${r.records} replies; the current parser reads ${r.parsedNow} as a verdict (${Object.entries(r.viaNow).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}); no verdict by reason: ${Object.entries(r.byReasonNow).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}; ${r.unreadable} unreadable line(s)${r.noNonceRecorded > 0 ? `; ${r.noNonceRecorded} record(s) had no nonce recorded (an old trace: replayed with the offline rules, so a forged verdict object may read as accepted)` : ""}${r.ignoredNow > 0 ? `; ${r.ignoredNow} verdict object(s) without the recorded nonce were ignored` : ""}`);
      if (r.drift.length > 0) say(`  drift: ${r.drift.length} reply(ies) read differently now than when captured, e.g. line ${r.drift[0]!.index}: was ${r.drift[0]!.recorded}, now ${r.drift[0]!.now}`);
      figures.trace = r;
    } catch { problems.push(`cannot read the trace ${values.trace}`); }
  }

  // ---- live (by hand) --------------------------------------------------------------------------------------
  if (values.live) {
    let provider = deps.provider;
    const gmCfgAndBudgets = (() => {
      const timeouts = parseNpcTimeouts(deps.env); if (!timeouts.ok) return { error: timeouts.errors.join("; ") };
      const gm = parseGmConfig(deps.env, timeouts.replyTimeoutMs); if (!gm.ok) return { error: gm.errors.join("; ") };
      const budgets = parseTokenBudgets(deps.env); if (!budgets.ok) return { error: budgets.errors.join("; ") };
      const temps = parseTemperatures(deps.env); if (!temps.ok) return { error: temps.errors.join("; ") };
      return { gm, maxTokens: budgets.gmMaxTokens, temperature: temps.gmTemperature };
    })();
    if ("error" in gmCfgAndBudgets) { deps.stderr.write(`error: ${scrubText(gmCfgAndBudgets.error!)}\n`); return { exitCode: 2 }; }
    if (!provider) {
      try {
        if (describeModelProvider(deps.env) === "mock") { deps.stderr.write("error: --live needs a real model provider, but MODEL_PROVIDER resolves to mock. Set MODEL_PROVIDER (and its key) in your environment or .env.\n"); return { exitCode: 2 }; }
        const retry = parseModelRetry(deps.env); if (!retry.ok) throw new Error(retry.errors.join("; "));
        provider = withModelRetry(selectModelProvider(deps.env, "gm", { sdkRetries: false }), retry, "GM");
      } catch (e) { deps.stderr.write(`error: the model provider is not usable: ${scrubText(e instanceof Error ? e.message : String(e))}\n`); return { exitCode: 2 }; }
    }
    const { gm, maxTokens, temperature } = gmCfgAndBudgets;
    say(`NOTICE: --live sends the dialogue of ${cases.length} cases, ${runs} run(s) each (${cases.length * runs} to ${cases.length * runs * (gm.reask ? 2 : 1)} model calls), to the configured provider (${describeModelProvider(deps.env)}) and may cost money.`);
    const results: RunResult[] = [];
    for (const c of cases) {
      for (let k = 0; k < runs; k++) {
        const t0 = Date.now();
        const nonce = newGmNonce();
        const out = await runGmEvaluation({ provider: provider!, request: requestFor(c, { maxTokens, temperature, nonce, window: gm.transcriptWindow }), condition: c.condition, timeoutMs: gm.timeoutMs, reask: gm.reask, nonce });
        const latencyMs = Date.now() - t0;
        if (out.kind === "verdict") results.push({ caseId: c.id, verdict: out.verdict, attempts: out.attempts, latencyMs, via: out.via });
        else if (out.kind === "no_verdict") results.push({ caseId: c.id, verdict: null, attempts: out.attempts, latencyMs, reason: out.reason });
        else results.push({ caseId: c.id, verdict: null, attempts: 1, latencyMs, reason: "model_error" });
      }
    }
    const m = summarize(cases, results);
    say("live results:");
    for (const l of formatMetrics(m)) say(`  ${l}`);
    figures.live = m;
    if (results.length > 0 && results.every((r) => r.reason === "model_error")) problems.push("every live model call failed (nothing could be measured): check the provider settings and the model server");
  }

  say(problems.length === 0 ? "gm-eval: all checks passed" : `gm-eval: ${problems.length} problem(s)`);
  for (const p of problems) deps.stderr.write(`problem: ${scrubText(p)}\n`);
  if (values.json !== undefined) {
    const text = `${JSON.stringify({ ok: problems.length === 0, problems, ...figures }, null, 2)}\n`;
    if (values.json === "-") deps.stdout.write(text); else await writeFile(path.resolve(base, values.json), text);
  }
  return { exitCode: problems.length === 0 ? 0 : 1 };
}
