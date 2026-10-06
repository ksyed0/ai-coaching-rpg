import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { describeModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadRubrics, loadScenario, readTextCapped, validateScenario, type Rubric, type Scenario } from "@acr/script";
import { createScriptedEvaluator } from "../demo/eval-mock.js";
import { scrubText } from "../demo/report.js";
import { parseEvalConfig } from "./config.js";
import { evaluateSession, EvaluatorInputError, type EvaluationResult } from "./evaluate.js";
import { readSessionLog, SessionLogError } from "./log-reader.js";
import { evaluatorInfo, isMockProvider, startEvaluatorProvider } from "./provider.js";
import { summaryLines } from "./summary.js";
import { ReportWriteError, writeReports, type WrittenReports } from "./report-write.js";

export const EVALUATE_USAGE = [
  "usage: pnpm evaluate <session.jsonl> [--scenario <dir>] [--out <dir>] [--json -] [--help]",
  "  <session.jsonl>    a recorded session log (data/sessions/<id>.jsonl)",
  "  --scenario <dir>   the scenario package the session was played from (default: found by the scenario id in the log, under scenarios/)",
  "  --out <dir>        where to write the reports, into <dir>/<session-id>/ (default: data/reports). Existing reports are never overwritten",
  "  --json -           also print a machine-readable summary to stdout (the narration then goes to stderr; run `pnpm -s evaluate ...`)",
  "  --help             this text",
  "exit codes: 0 reports written, 1 an evaluation failed (reports for the others are still written), 2 usage or input error",
  "settings (environment or .env): MODEL_PROVIDER and its key, EVAL_MODEL (default NPC_MODEL), EVAL_MAX_TOKENS (3000), EVAL_TEMPERATURE (0.2),",
  "  EVAL_TIMEOUT_MS (180000), EVAL_TRANSCRIPT_CHARS (60000). With MODEL_PROVIDER=mock (the default) a scripted offline evaluator is used.",
].join("\n");

export type Out = { write(chunk: string): unknown };
export type EvaluateDeps = {
  argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; repoRoot: string; /** Base for relative paths (default: INIT_CWD, else the cwd). */ cwd?: string;
  signal?: AbortSignal; /** Test hook: use this provider instead of the configured one. */ provider?: Parameters<typeof evaluateSession>[0]["provider"];
};

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
export const secretValues = (env: NodeJS.ProcessEnv): string[] => Object.entries(env).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v as string);

/** Finds `scenarios/<dir>` whose scenario.yaml has this id. Reads small files only. */
export async function findScenarioDir(repoRoot: string, scenarioId: string): Promise<string | null> {
  const root = path.join(repoRoot, "scenarios");
  let names: string[];
  try { names = await readdir(root); } catch { return null; }
  for (const name of names.sort()) {
    const file = path.join(root, name, "scenario.yaml");
    try {
      const meta = parse(await readTextCapped(file, 256 * 1024), { maxAliasCount: 10 }) as { id?: unknown } | null;
      if (meta && meta.id === scenarioId) return path.join(root, name);
    } catch { /* not a scenario folder */ }
  }
  return null;
}

/** The input every evaluation needs, validated: the scenario and its rubrics. Throws EvaluatorInputError with one line. */
export async function loadEvaluationInput(dir: string): Promise<{ scenario: Scenario; rubrics: Rubric[]; warnings: string[] }> {
  let scenario: Scenario;
  try {
    if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error("the scenario directory does not exist");
    scenario = await loadScenario(dir);
  } catch (err) { throw new EvaluatorInputError(`cannot load the scenario: ${err instanceof Error ? err.message : String(err)}`); }
  const v = validateScenario(scenario);
  if (v.errors.length) throw new EvaluatorInputError(`the scenario is invalid: ${v.errors.join("; ")}`);
  const loaded = await loadRubrics(dir, scenario);
  if (loaded.errors.length) throw new EvaluatorInputError(`the rubrics are invalid: ${loaded.errors.join("; ")}`);
  if (loaded.rubrics.length === 0) throw new EvaluatorInputError("the scenario has no rubrics, so there is nothing to score against");
  return { scenario, rubrics: loaded.rubrics, warnings: [...v.warnings, ...loaded.warnings] };
}

/** `pnpm evaluate`. Never calls process.exit. Returns 0 ok, 1 an evaluation failed, 2 usage or input error. */
export async function runEvaluate(deps: EvaluateDeps): Promise<{ exitCode: number; result?: EvaluationResult; written?: WrittenReports }> {
  const secrets = secretValues(deps.env);
  const err = (m: string) => deps.stderr.write(`${scrubText(m, secrets)}\n`);
  let parsed;
  try {
    parsed = parseArgs({ args: deps.argv, allowPositionals: true, strict: true, options: { scenario: { type: "string" }, out: { type: "string" }, json: { type: "string" }, help: { type: "boolean" } } });
  } catch (e) { err(`error: ${(e as Error).message.split("\n")[0]}\n${EVALUATE_USAGE}`); return { exitCode: 2 }; }
  const { values, positionals } = parsed;
  if (values.help) { deps.stdout.write(`${EVALUATE_USAGE}\n`); return { exitCode: 0 }; }
  if (positionals.length !== 1) { err(`error: give exactly one session log (a .jsonl file)\n${EVALUATE_USAGE}`); return { exitCode: 2 }; }
  if (values.json !== undefined && values.json !== "-") { err("error: --json only supports - (stdout)"); return { exitCode: 2 }; }
  for (const [flag, v] of [["scenario", values.scenario], ["out", values.out]] as const) {
    if (v !== undefined && (v === "" || new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(v))) { err(`error: --${flag} needs a path`); return { exitCode: 2 }; }
  }
  const toErr = values.json === "-";
  const say = (m: string) => (toErr ? deps.stderr : deps.stdout).write(`${scrubText(m, secrets)}\n`);
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();

  let events: SessionEvent[];
  try { events = await readSessionLog(path.resolve(base, positionals[0]!)); }
  catch (e) { err(`error: ${e instanceof SessionLogError ? e.message : "cannot read the session log"}`); return { exitCode: 2 }; }
  const started = events[0];
  const scenarioId = started && started.type === "session.started" ? started.scenarioId : "";
  let scenarioDir: string | null;
  if (values.scenario !== undefined) scenarioDir = path.resolve(base, values.scenario);
  else {
    scenarioDir = await findScenarioDir(deps.repoRoot, scenarioId);
    if (!scenarioDir) { err(`error: no scenario with id ${JSON.stringify(scenarioId.slice(0, 60))} under scenarios/; pass --scenario <dir>`); return { exitCode: 2 }; }
  }
  let input;
  try { input = await loadEvaluationInput(scenarioDir); }
  catch (e) { err(`error: ${e instanceof Error ? e.message : String(e)}`); return { exitCode: 2 }; }
  for (const w of input.warnings) say(`warning: ${w}`);

  const cfg = parseEvalConfig(deps.env);
  if (!cfg.ok) { err(`error: ${cfg.errors.join("; ")}`); return { exitCode: 2 }; }
  const scripted = deps.provider === undefined && isMockProvider(deps.env);
  let provider = deps.provider;
  if (!provider) {
    if (scripted) provider = createScriptedEvaluator(events, input.scenario, input.rubrics);
    else {
      try { provider = startEvaluatorProvider(deps.env, cfg); }
      catch (e) { err(`error: the model provider is not usable: ${e instanceof Error ? e.message : String(e)}`); return { exitCode: 2 }; }
    }
  }
  if (scripted) say("NOTICE: MODEL_PROVIDER is mock: using the scripted offline evaluator. Nothing leaves this machine, and the scores are demo data, not a real assessment.");
  else say(`NOTICE: this sends the session transcript (what every participant and AI character said) to the configured model provider (${describeModelProvider(deps.env)}) and may cost money.`);

  let result: EvaluationResult;
  try {
    result = await evaluateSession({ events, scenario: input.scenario, rubrics: input.rubrics, provider, config: cfg, signal: deps.signal, onProgress: (m) => say(m) });
  } catch (e) {
    err(`error: ${e instanceof EvaluatorInputError ? e.message : "the evaluation could not run"}`);
    return { exitCode: e instanceof EvaluatorInputError ? 2 : 1 };
  }
  let written: WrittenReports;
  try { written = await writeReports(result, { outDir: path.resolve(base, values.out ?? "data/reports"), evaluator: evaluatorInfo(deps.env, cfg, { scripted }), secrets }); }
  catch (e) {
    err(`error: cannot write the reports: ${e instanceof EvaluatorInputError || e instanceof ReportWriteError ? e.message : (e as NodeJS.ErrnoException).code ?? "failed"}`);
    return { exitCode: e instanceof EvaluatorInputError ? 2 : 1, result };
  }
  say("");
  for (const l of summaryLines(result)) say(l);
  say(`reports written to ${written.dir} (index.md links them all)`);
  for (const f of result.failures) err(`evaluation failed: ${f}`);
  if (toErr) {
    deps.stdout.write(`${JSON.stringify({
      ok: result.failures.length === 0, session: result.sessionId, dir: written.dir, files: written.files.map((f) => path.relative(written.dir, f)), modelCalls: result.modelCalls,
      participants: result.participants.map((p) => ({ role: p.roleId, status: p.status, ...(p.reason ? { reason: p.reason } : {}) })), group: { status: result.group.status }, failures: result.failures,
    }, null, 2)}\n`);
  }
  return { exitCode: result.failures.length > 0 ? 1 : 0, result, written };
}
