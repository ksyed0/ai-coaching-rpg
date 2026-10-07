import { lstat, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isSafeId } from "@acr/events";
import type { Scenario } from "@acr/script";
import { scrubText } from "../demo/report.js";
import { loadEvaluationInput, secretValues, type Out } from "../evaluator/cli.js";
import { parseEvalConfig } from "../evaluator/config.js";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { buildJudge, buildPrimaryJudge, CalibrationInputError, parseJudgeSpec, type Judge, type JudgeSpec } from "./judge.js";
import { loadProbes, printable } from "./probe-load.js";
import type { Probe } from "./probe-schema.js";
import { buildJudgeReport, buildRun, renderMarkdown, writeRun, writeSummaries, type CalibrationRun, type JudgeReport } from "./report.js";
import { MAX_REPEAT, runJudge, selectProbes } from "./runner.js";
import { loadTargets } from "./targets.js";
import type { Outcome } from "./types.js";

export const CALIBRATE_USAGE = [
  "usage: pnpm calibrate [run] --scenario <dir> [--judge label,model[,baseUrl]] [--repeat n] [--only id,id] [--criteria all|probe]",
  "                      [--variant v1] [--out <dir>] [--strict] [--json -|<file>] [--help]",
  "  run                the default (and for now the only) subcommand: score the scenario's probes with each judge",
  "  --scenario <dir>   the scenario package whose calibration/ probes are run (relative to the current directory, else the repository)",
  "  --judge ...        a second judge on an OpenAI-compatible server, e.g. second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1",
  "                     (at most one; without a base URL LOCAL_BASE_URL is used). The judges run one after the other, blind",
  `  --repeat n         score every probe n times (1 to ${MAX_REPEAT}, default 1) to measure the judge's own noise`,
  "  --only id,id       run only these probes",
  "  --criteria all     the judge scores every individual criterion (default, as in a real evaluation); probe: only the probe's criterion",
  "  --variant v1       the evaluator prompt variant (only v1 exists so far)",
  "  --out <dir>        results go to <dir>/<scenario-id>/ (default: data/calibration, git-ignored). Run reports are never overwritten",
  "  --strict           exit 1 when any judge is labelled FAIL (for CI)",
  "  --json -           print the run as JSON to stdout (the narration then goes to stderr; run `pnpm -s calibrate ...`); --json <file> writes it to a new file",
  "  --help             this text",
  "exit codes: 0 results written (whatever the labels), 1 --strict and a judge FAILed, 2 usage, input or output error",
  "the primary judge is the evaluator's configuration (MODEL_PROVIDER, EVAL_MODEL or NPC_MODEL, EVAL_*); MODEL_PROVIDER=mock is refused.",
  "This sends the probe transcripts (synthetic text) to the judges' model providers and may cost money: the planned call count is printed first.",
].join("\n");

const SUBCOMMANDS_LATER = new Set(["draft", "excerpt", "approve", "assign-splits"]);
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
const SUMMARY_SCREEN = 25;
const MAX_LINE = 4000;

export type CalibrateDeps = {
  argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; repoRoot: string; /** Base for relative paths (default: INIT_CWD, else the cwd). */ cwd?: string;
  signal?: AbortSignal; /** Test hook: use these judges instead of the configured ones. */ judges?: Judge[]; /** Test hook: the clock. */ now?: () => Date;
};

/**
 * The model calls a run makes before re-asks: per probe, the scenario players with at least 2 lines in its transcript (scored or not: the
 * evaluator scores each of them), times `repeat`, times the number of judges.
 */
export function plannedCalls(probes: Probe[], scenario: Scenario, repeat: number, judges: number): number {
  let perRun = 0;
  for (const p of probes) {
    const counts = new Map<string, number>();
    for (const l of p.transcript) counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
    for (const [role, n] of counts) {
      const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
      if (def?.type === "player" && n >= MIN_UTTERANCES) perRun++;
    }
  }
  return perRun * repeat * judges;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;
const firstLine = (e: unknown): string => ((e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "");

/** `pnpm calibrate`. Never calls process.exit. Returns 0 results written, 1 --strict and a judge FAILed, 2 usage, input or output error. */
export async function runCalibrate(deps: CalibrateDeps): Promise<{ exitCode: number; run?: CalibrationRun }> {
  const secrets = secretValues(deps.env);
  const clean = (m: string): string => scrubText(m, secrets).split("\n").map((l) => printable(l, MAX_LINE)).join("\n");
  const err = (m: string) => deps.stderr.write(`${clean(m)}\n`);
  const fail = (m: string, usage = false) => { err(`error: ${m}`); if (usage) deps.stderr.write(`${CALIBRATE_USAGE}\n`); return { exitCode: 2 }; };

  let parsed;
  try {
    parsed = parseArgs({
      args: deps.argv, allowPositionals: true, strict: true,
      options: {
        scenario: { type: "string" }, judge: { type: "string", multiple: true }, variant: { type: "string" }, repeat: { type: "string" }, only: { type: "string" },
        criteria: { type: "string" }, out: { type: "string" }, strict: { type: "boolean" }, json: { type: "string" }, help: { type: "boolean" },
      },
    });
  } catch (e) { return fail(firstLine(e), true); }
  const { values, positionals } = parsed;
  if (values.help) { deps.stdout.write(`${CALIBRATE_USAGE}\n`); return { exitCode: 0 }; }
  const sub = positionals[0] ?? "run";
  if (SUBCOMMANDS_LATER.has(sub)) return fail(`subcommand "${sub}" is not available yet`);
  if (sub !== "run") return fail(`unknown subcommand ${JSON.stringify(printable(sub, 40))} (only run is available)`, true);
  if (positionals.length > 1) return fail(`unexpected argument ${JSON.stringify(printable(positionals[1]!, 40))}`, true);

  if (values.scenario === undefined) return fail("--scenario <dir> is required", true);
  for (const [flag, v] of [["scenario", values.scenario], ["out", values.out], ["json", values.json]] as const) {
    if (v !== undefined && (v === "" || CONTROL.test(v))) return fail(`--${flag} needs a path`);
  }
  let repeat = 1;
  if (values.repeat !== undefined) {
    repeat = /^\d+$/.test(values.repeat) ? Number(values.repeat) : NaN;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) return fail(`--repeat must be a whole number from 1 to ${MAX_REPEAT}`);
  }
  let only: string[] | undefined;
  if (values.only !== undefined) {
    only = values.only.split(",").map((s) => s.trim());
    if (only.some((s) => s === "")) return fail("--only needs a comma-separated list of probe ids (no empty entries)");
  }
  const criteria = values.criteria ?? "all";
  if (criteria !== "all" && criteria !== "probe") return fail("--criteria must be all or probe");
  const variant = values.variant ?? "v1";
  if (!isSafeId(variant)) return fail("--variant must be a prompt variant name such as v1");
  if (variant !== "v1") return fail("only the v1 prompt variant exists so far");
  const specs = values.judge ?? [];
  if (specs.length > 1) return fail("at most one --judge (the second judge; the primary judge comes from the evaluator settings)");
  let second: JudgeSpec | undefined;
  try { second = specs[0] === undefined ? undefined : parseJudgeSpec(specs[0]); } catch (e) { return fail(firstLine(e)); }
  if (second?.label === "primary") return fail("the --judge label primary is taken by the primary judge: choose another label");

  const toErr = values.json === "-";
  const say = (m: string) => (toErr ? deps.stderr : deps.stdout).write(`${clean(m)}\n`);
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
  const jsonFile = values.json !== undefined && !toErr ? path.resolve(base, values.json) : undefined;
  if (jsonFile && (await lstat(jsonFile).then(() => true, () => false))) return fail("--json: the file already exists (results are never overwritten)");

  // The scenario: relative to the current directory, else to the repository.
  const local = path.resolve(base, values.scenario);
  const scenarioDir = (await stat(local).catch(() => null))?.isDirectory() ? local : path.resolve(deps.repoRoot, values.scenario);
  let input;
  try { input = await loadEvaluationInput(scenarioDir); } catch (e) { return fail(firstLine(e)); }
  for (const w of input.warnings) say(`warning: ${w}`);
  const loaded = await loadProbes(scenarioDir, input.scenario, input.rubrics);
  if (loaded.errors.length) return fail(`the probes are invalid (${plural(loaded.errors.length, "problem")}):\n${loaded.errors.map((e) => `  - ${e}`).join("\n")}`);
  if (loaded.probes.length === 0) return fail(`the scenario has no probes (add calibration/<probe-id>.yaml files)${loaded.warnings.length ? `: ${loaded.warnings[0]}` : ""}`);
  let chosen: Probe[];
  try { chosen = selectProbes(loaded.probes, only); } catch (e) { return fail(firstLine(e)); }
  let targets;
  try { targets = await loadTargets(scenarioDir); } catch (e) { return fail(firstLine(e)); }
  const cfg = parseEvalConfig(deps.env);
  if (!cfg.ok) return fail(cfg.errors.join("; "));

  let judges: Judge[];
  try { judges = deps.judges ?? [buildPrimaryJudge(deps.env, cfg), ...(second ? [buildJudge(second, deps.env)] : [])]; }
  catch (e) { return fail(e instanceof CalibrationInputError ? e.message : "the judges could not be configured"); }
  if (judges.length === 2 && judges[0]!.model === judges[1]!.model) say("warning: both judges use the same model id: they share one summary file (the second one is kept)");

  for (const w of loaded.warnings) say(`lint: ${w}`);
  say(`judges: ${judges.map((j) => `${j.label} (${j.model})`).join(", ")}. This sends the probe transcripts to their model providers and may cost money.`);
  say(`planned: ${plural(plannedCalls(chosen, input.scenario, repeat, judges.length), "model call")} (${plural(chosen.length, "probe")}, repeat ${repeat}, ${plural(judges.length, "judge")}; plus one re-ask for each unusable reply)`);

  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const reports: JudgeReport[] = [];
  // Sequential, one judge at a time: a judge never sees another judge's output, and a failing judge cannot take the others down.
  for (const judge of judges) {
    if (deps.signal?.aborted) { err(`run aborted: judge ${judge.label} was not run`); continue; }
    const got: Outcome[] = [];
    try {
      await runJudge(judge, chosen, input.scenario, input.rubrics, cfg, {
        repeat, allCriteria: criteria === "all", signal: deps.signal, onProgress: say, onOutcome: (o) => { got.push(o); },
      });
    } catch (e) { err(`judge ${judge.label}: run failed: ${firstLine(e)} (the ${plural(got.length, "probe")} finished before it are kept)`); }
    if (deps.signal?.aborted) err(`run aborted: judge ${judge.label} has results for ${got.length} of ${chosen.length} probes`);
    reports.push(buildJudgeReport(judge, got, targets, chosen));
  }
  if (reports.length === 0) return fail("the run was aborted before any judge ran: nothing was written");

  const run = buildRun({ scenario: { id: input.scenario.meta.id, version: input.scenario.meta.version }, rubrics: input.rubrics, variant, startedAt, probes: chosen, lint: loaded.warnings, judges: reports });
  const dataDir = path.resolve(base, values.out ?? "data/calibration");
  let written;
  try {
    written = await writeRun(run, dataDir);
    const summaries = await writeSummaries(run, dataDir);
    say(`summaries updated: ${summaries.map((f) => path.basename(f)).join(", ")}`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ...fail(`cannot write the results: ${code ?? firstLine(e)}`), run };
  }
  say("");
  for (const l of renderMarkdown(run).split("\n").slice(0, SUMMARY_SCREEN)) say(l);
  say(`report written to ${written.markdown}`);

  const json = JSON.stringify(run, (_k, v: unknown) => (typeof v === "string" ? scrubText(v, secrets) : v));
  if (toErr) deps.stdout.write(`${json}\n`);
  if (jsonFile) {
    try { await writeFile(jsonFile, `${json}\n`, { flag: "wx", mode: 0o600 }); say(`run JSON written to ${jsonFile}`); }
    catch (e) { return { ...fail(`--json: cannot write the file: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "it already exists" : (e as NodeJS.ErrnoException).code ?? "failed"}`), run }; }
  }
  const failed = run.judges.filter((j) => j.label.label === "FAIL").map((j) => j.judge.label);
  if (values.strict && failed.length) { err(`--strict: judge ${failed.join(", ")} labelled FAIL`); return { exitCode: 1, run }; }
  return { exitCode: 0, run };
}
