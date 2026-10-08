import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { isSafeId } from "@acr/events";
import type { Scenario } from "@acr/script";
import { scrubDeep, scrubText } from "../demo/report.js";
import { loadEvaluationInput, secretValues, type Out } from "../evaluator/cli.js";
import { isValidModelId, parseEvalConfig } from "../evaluator/config.js";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { readSessionLog, SessionLogError } from "../evaluator/log-reader.js";
import { approveDraft, assignSplits, checkDraftCriteria, checkDrafter, draftCriteria, draftProbes, excerptDraft, MAX_PER_LEVEL, plannedDraftCalls, subjectOf } from "./draft.js";
import { buildJudge, buildPrimaryJudge, CalibrationInputError, modelFamily, parseJudgeSpec, type Judge, type JudgeSpec } from "./judge.js";
import { CONTRAST_MIN_USABLE_SHARE, usableFraction } from "./metrics.js";
import { loadProbes, printable } from "./probe-load.js";
import type { Expected, Level, Probe } from "./probe-schema.js";
import { buildJudgeReport, buildRun, renderMarkdown, writeRun, writeSummaries, type CalibrationRun, type JudgeReport } from "./report.js";
import { MAX_REPEAT, runJudge, selectProbes } from "./runner.js";
import { loadTargets } from "./targets.js";
import type { Outcome } from "./types.js";

export const CALIBRATE_USAGE = [
  "usage: pnpm calibrate [run] --scenario <dir> [--judge label,model[,baseUrl]] [--repeat n] [--only id,id] [--criteria all|probe]",
  "                      [--variant v1] [--out <dir>] [--strict] [--json -|<file>] [--help]",
  "       pnpm calibrate draft --scenario <dir> --drafter label,model[,baseUrl] [--criterion id] [--subject role] [--per-level 1..3] [--allow-same-family]",
  "       pnpm calibrate excerpt --scenario <dir> --log <session.jsonl> --from <seq> --to <seq> --subject <role> --criterion <id> --id <draft id>",
  "       pnpm calibrate approve --scenario <dir> --draft <id> --by <name> [--expected 1|2|3|4|not_observed] [--id <final id>]",
  "       pnpm calibrate assign-splits --scenario <dir>",
  "subcommands:",
  "  run                the default: score the scenario's probes (calibration/*.yaml) with each judge",
  "  draft              ask a drafter model for candidate transcripts, one per individual criterion (or --criterion), level 1 to 4 and",
  "                     --per-level (default 1), written to calibration/drafts/ (never used by a run). The drafter must be of another",
  "                     model family than the primary judge unless --allow-same-family. --subject: the player whose lines are scored",
  "                     (default: the first player role by id). The prompt holds only public scenario data, never hidden facts",
  "  excerpt            cut a draft from a real session log: the lines with event seq --from..--to, with no level yet (a human rates it).",
  "                     Real customer sessions need consent and redaction first; the repository is public",
  "  approve            OWNER ONLY (an agent never approves on the owner's behalf): turn a reviewed draft into calibration/<id>.yaml,",
  "                     recording --by and the time; --expected is required for an excerpt; the final id drops the draft- prefix",
  "  assign-splits      add a tune/holdout split to every probe file that has none (an existing split is never changed)",
  "options of run:",
  "  --scenario <dir>   the scenario package whose calibration/ probes are run (relative to the current directory, else the repository)",
  "  --judge ...        a second judge on an OpenAI-compatible server, e.g. second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1",
  "                     (at most one; without a base URL LOCAL_BASE_URL is used). The judges run one after the other, blind",
  `  --repeat n         score every probe n times (1 to ${MAX_REPEAT}, default 1) to measure the judge's own noise`,
  "  --only id,id       run only these probes",
  "  --criteria all     the judge scores every individual criterion (default, as in a real evaluation); probe: only the probe's criterion",
  "  --variant v1       the evaluator prompt variant (only v1 exists so far)",
  "  --out <dir>        results go to <dir>/<scenario-id>/ (default: data/calibration, git-ignored). Run reports are never overwritten",
  "                     the summary per judge (<model>-<variant>.json) is replaced only by a complete run: every probe (--only naming every",
  "                     probe counts), --criteria all, no failure or abort, at least one usable answer, usable answers >= minUsable",
  `                     (calibration/targets.yaml, default 0.9) and, when there are contrast probes, at least ${CONTRAST_MIN_USABLE_SHARE * 100}% of them usable`,
  "  --strict           exit 1 when any judge is labelled FAIL (for CI)",
  "  --json -           print the run as JSON to stdout (the narration then goes to stderr; run `pnpm -s calibrate ...`); --json <file> writes it to a new file",
  "  --help             this text",
  "exit codes: 0 done; 1 work was done but part of it failed (run: --strict and a judge FAILed, or the results could not be written; draft:",
  "            some drafts failed; approve: the draft could not be deleted; assign-splits: some files could not be changed); 2 usage or input",
  "            error (nothing was run or written)",
  "the primary judge is the evaluator's configuration (MODEL_PROVIDER, EVAL_MODEL or NPC_MODEL, EVAL_*); MODEL_PROVIDER=mock is refused.",
  "run sends the probe transcripts (synthetic text) to the judges' model providers, draft sends the scenario's public context and the rubric",
  "anchors to the drafter's: both may cost money, and the planned call count is printed first.",
].join("\n");

/** The options each subcommand accepts (any other given option is a usage error). */
const OPTIONS_OF = new Map<string, ReadonlySet<string>>([
  ["run", new Set(["scenario", "judge", "variant", "repeat", "only", "criteria", "out", "strict", "json"])],
  ["draft", new Set(["scenario", "drafter", "criterion", "subject", "per-level", "allow-same-family"])],
  ["excerpt", new Set(["scenario", "log", "from", "to", "subject", "criterion", "id"])],
  ["approve", new Set(["scenario", "draft", "by", "expected", "id"])],
  ["assign-splits", new Set(["scenario"])],
]);
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]");
const SUMMARY_SCREEN = 25;
const MAX_LINE = 4000;

export type CalibrateDeps = {
  argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; repoRoot: string; /** Base for relative paths (default: INIT_CWD, else the cwd). */ cwd?: string;
  signal?: AbortSignal; /** Test hook: use these judges instead of the configured ones. */ judges?: Judge[]; /** Test hook: the clock. */ now?: () => Date;
  /** Test hook: use this drafter instead of building one from --drafter (which is still required). */ drafter?: Judge;
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

/**
 * `pnpm calibrate` and its subcommands. Never calls process.exit. Returns 0 done; 1 work was done but part of it failed (run: --strict and a
 * judge FAILed or the results could not be written; draft: some drafts failed; approve: the draft could not be deleted; assign-splits: some
 * files could not be changed); 2 usage or input error (nothing was run or written).
 */
export async function runCalibrate(deps: CalibrateDeps): Promise<{ exitCode: number; run?: CalibrationRun }> {
  const secrets = secretValues(deps.env);
  // Split first: scrubText turns a newline into a visible marker, and a multi-line message (the probe problems) prints one line each.
  const clean = (m: string): string => m.split("\n").map((l) => printable(scrubText(l, secrets), MAX_LINE)).join("\n");
  const err = (m: string) => deps.stderr.write(`${clean(m)}\n`);
  const fail = (m: string, usage = false) => { err(`error: ${m}`); if (usage) deps.stderr.write(`${CALIBRATE_USAGE}\n`); return { exitCode: 2 }; };

  let parsed;
  try {
    parsed = parseArgs({
      args: deps.argv, allowPositionals: true, strict: true,
      options: {
        scenario: { type: "string" }, judge: { type: "string", multiple: true }, variant: { type: "string" }, repeat: { type: "string" }, only: { type: "string" },
        criteria: { type: "string" }, out: { type: "string" }, strict: { type: "boolean" }, json: { type: "string" }, help: { type: "boolean" },
        drafter: { type: "string" }, criterion: { type: "string" }, subject: { type: "string" }, "per-level": { type: "string" }, "allow-same-family": { type: "boolean" },
        log: { type: "string" }, from: { type: "string" }, to: { type: "string" }, id: { type: "string" }, draft: { type: "string" }, by: { type: "string" }, expected: { type: "string" },
      },
    });
  } catch (e) { return fail(firstLine(e), true); }
  const { values, positionals } = parsed;
  if (values.help) { deps.stdout.write(`${CALIBRATE_USAGE}\n`); return { exitCode: 0 }; }
  const sub = positionals[0] ?? "run";
  const allowed = OPTIONS_OF.get(sub);
  if (!allowed) return fail(`unknown subcommand ${JSON.stringify(printable(sub, 40))} (use run, draft, excerpt, approve or assign-splits)`, true);
  if (positionals.length > 1) return fail(`unexpected argument ${JSON.stringify(printable(positionals[1]!, 40))}`, true);
  const stray = Object.keys(values).find((k) => !allowed.has(k));
  if (stray !== undefined) return fail(`--${stray} is not an option of ${sub}`, true);

  if (values.scenario === undefined) return fail("--scenario <dir> is required", true);
  for (const [flag, v] of [["scenario", values.scenario], ["out", values.out], ["json", values.json], ["log", values.log]] as const) {
    if (v !== undefined && (v === "" || CONTROL.test(v))) return fail(`--${flag} needs a path`);
  }
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
  if (sub !== "run") {
    const scn = await scenarioInput(base, deps.repoRoot, values.scenario);
    if ("error" in scn) return fail(scn.error);
    const say = (m: string) => deps.stdout.write(`${clean(m)}\n`);
    for (const w of scn.input.warnings) say(`warning: ${w}`);
    try { return { exitCode: await runAuthoring(sub, values, deps, scn.dir, scn.input, { say, err }) }; }
    catch (e) {
      if (e instanceof CalibrationInputError) return fail(e.message);
      err(`error: ${sub} failed: ${(e as NodeJS.ErrnoException).code ?? firstLine(e)}`);
      return { exitCode: 1 };
    }
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
    if (new Set(only).size !== only.length) return fail("--only lists a probe twice");
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
  const jsonFile = values.json !== undefined && !toErr ? path.resolve(base, values.json) : undefined;
  // Preflight from a listing of the parent directory, never a check on the target itself (the exclusive create at the end is the real guard).
  if (jsonFile) {
    const names = await readdir(path.dirname(jsonFile)).catch(() => null);
    if (names === null) return fail("--json: the directory for the file does not exist");
    if (names.includes(path.basename(jsonFile))) return fail("--json: the file already exists (results are never overwritten)");
  }

  const scn = await scenarioInput(base, deps.repoRoot, values.scenario);
  if ("error" in scn) return fail(scn.error);
  const { dir: scenarioDir, input } = scn;
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
  if (judges.length === 2 && judges[0]!.model === judges[1]!.model) say("warning: both judges use the same model id: they share one summary file, and the last complete run wins");

  for (const w of loaded.warnings) say(`lint: ${w}`);
  say(`judges: ${judges.map((j) => `${j.label} (${j.model})`).join(", ")}. This sends the probe transcripts to their model providers and may cost money.`);
  say(`planned: ${plural(plannedCalls(chosen, input.scenario, repeat, judges.length), "model call")} (${plural(chosen.length, "probe")}, repeat ${repeat}, ${plural(judges.length, "judge")}; plus one re-ask for each unusable reply)`);

  const startedAt = (deps.now?.() ?? new Date()).toISOString();
  const reports: JudgeReport[] = [];
  /** Why a judge's summary file must not be replaced by this run (null: the run is complete for that judge). */
  const skipped = new Map<JudgeReport, string>();
  // Sequential, one judge at a time: a judge never sees another judge's output, and a failing judge cannot take the others down.
  for (const judge of judges) {
    if (deps.signal?.aborted) { err(`run aborted: judge ${judge.label} was not run`); continue; }
    const got: Outcome[] = [];
    let threw = false;
    try {
      await runJudge(judge, chosen, input.scenario, input.rubrics, cfg, {
        repeat, allCriteria: criteria === "all", signal: deps.signal, onProgress: say, onOutcome: (o) => { got.push(o); },
      });
    } catch (e) { threw = true; err(`judge ${judge.label}: run failed: ${firstLine(e)} (the ${plural(got.length, "probe")} finished before it are kept)`); }
    if (deps.signal?.aborted) err(`run aborted: judge ${judge.label} has results for ${got.length} of ${chosen.length} probes`);
    const report = buildJudgeReport(judge, got, targets, chosen);
    const us = report.metrics.usability;
    const usable = usableFraction(report.metrics);
    const ct = report.metrics.contrast;
    // A subset is fewer probes than the scenario has: --only naming every probe is a full run.
    const subset = chosen.length < loaded.probes.length;
    const reason = deps.signal?.aborted ? "aborted" : threw ? "run failed" : subset ? "subset (--only)" : criteria !== "all" ? "one criterion (--criteria probe)"
      : us.slots - us.unusable === 0 ? "no usable answers"
      // A judge that degraded mid-run (provider errors become "failed" slots, not a throw) must not replace a good summary.
      : usable !== null && usable < targets.minUsable ? `too few usable answers (${us.slots - us.unusable} of ${us.slots})`
      // Overall usability can stay high while a judge loses most of the contrast answers, which is what the headline metric rests on.
      : ct.n > 0 && ct.usable / ct.n < CONTRAST_MIN_USABLE_SHARE ? `contrast thinly measured (${ct.usable} of ${ct.n} contrast probes usable)` : null;
    if (reason) skipped.set(report, reason);
    reports.push(report);
  }
  if (reports.length === 0) return fail("the run was aborted before any judge ran: nothing was written");

  const built = buildRun({ scenario: { id: input.scenario.meta.id, version: input.scenario.meta.version }, rubrics: input.rubrics, variant, startedAt, probes: chosen, lint: loaded.warnings, judges: reports });
  // Everything written or printed from here on is scrubbed: a judge may have put a secret into a rationale.
  const run = scrubDeep(built, secrets);
  const dataDir = path.resolve(base, values.out ?? "data/calibration");
  // A summary file is what reports will stamp as "the" calibration of a model: only a complete run may create or replace it.
  const complete = run.judges.filter((_j, i) => !skipped.has(built.judges[i]!));
  for (const [i, j] of built.judges.entries()) {
    const reason = skipped.get(j);
    if (reason) say(`summary for ${run.judges[i]!.judge.label} (${run.judges[i]!.judge.model}) not updated: ${reason}`);
  }
  let written;
  try { written = await writeRun(run, dataDir); }
  catch (e) { err(`error: cannot write the results: ${(e as NodeJS.ErrnoException).code ?? firstLine(e)}`); return { exitCode: 1, run }; }
  try {
    if (complete.length) {
      const summaries = await writeSummaries({ ...run, judges: complete }, dataDir);
      say(`summaries updated: ${[...new Set(summaries.map((f) => path.basename(f)))].join(", ")}`);
    }
  } catch (e) {
    const rel = path.join(path.basename(dataDir), path.relative(dataDir, written.dir));
    err(`error: the run was written to ${rel} but the summaries could not be updated: ${firstLine(e)}`);
    return { exitCode: 1, run };
  }
  say("");
  for (const l of renderMarkdown(run).split("\n").slice(0, SUMMARY_SCREEN)) say(l);
  say(`report written to ${written.markdown}`);

  const json = JSON.stringify(run);
  if (toErr) deps.stdout.write(`${json}\n`);
  if (jsonFile) {
    try { await writeFile(jsonFile, `${json}\n`, { flag: "wx", mode: 0o600 }); say(`run JSON written to ${jsonFile}`); }
    catch (e) {
      err(`error: --json: cannot write the file: ${(e as NodeJS.ErrnoException).code === "EEXIST" ? "it already exists" : (e as NodeJS.ErrnoException).code ?? "failed"}`);
      return { exitCode: 1, run };
    }
  }
  const failed = run.judges.filter((j) => j.label.label === "FAIL").map((j) => j.judge.label);
  if (values.strict && failed.length) { err(`--strict: judge ${failed.join(", ")} labelled FAIL`); return { exitCode: 1, run }; }
  return { exitCode: 0, run };
}

/** The scenario package: relative to the current directory, else to the repository; with its scenario and rubrics loaded. */
async function scenarioInput(base: string, repoRoot: string, arg: string): Promise<{ dir: string; input: Awaited<ReturnType<typeof loadEvaluationInput>> } | { error: string }> {
  const local = path.resolve(base, arg);
  const localStat = await stat(local).catch(() => null);
  const dir = localStat ? local : path.resolve(repoRoot, arg);
  const dirStat = localStat ?? (await stat(dir).catch(() => null));
  if (dirStat && !dirStat.isDirectory()) return { error: `--scenario ${JSON.stringify(printable(arg, 200))} is not a directory` };
  try { return { dir, input: await loadEvaluationInput(dir) }; } catch (e) { return { error: firstLine(e) }; }
}

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
const str = (v: Values, k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
const need = (v: Values, k: string, what: string): string => {
  const x = str(v, k);
  if (x === undefined || x === "") throw new CalibrationInputError(`--${k} ${what} is required`);
  return x;
};
const wholeNumber = (raw: string, flag: string): number => {
  if (!/^\d{1,9}$/.test(raw)) throw new CalibrationInputError(`--${flag} must be a whole number`);
  return Number(raw);
};
/** A --drafter spec, with the judge wording of parseJudgeSpec/buildJudge messages turned into the drafter's. */
const asDrafter = <T>(f: () => T): T => {
  try { return f(); } catch (e) {
    if (e instanceof CalibrationInputError) throw new CalibrationInputError(e.message.replace(/--judge/g, "--drafter").replace(/^judge /, "drafter ").replace(/\ba judge (label|model)/g, "a drafter $1"));
    throw new CalibrationInputError("the drafter could not be configured");
  }
};

/** draft, excerpt, approve and assign-splits. Returns the exit code; a CalibrationInputError (exit 2) means nothing was written. */
async function runAuthoring(sub: string, values: Values, deps: CalibrateDeps, dir: string, input: Awaited<ReturnType<typeof loadEvaluationInput>>, out: { say: (m: string) => void; err: (m: string) => void }): Promise<number> {
  const { say, err } = out;
  const rel = (f: string) => path.relative(dir, f);
  if (sub === "draft") {
    const raw = need(values, "drafter", "label,model[,baseUrl]");
    const spec = asDrafter(() => parseJudgeSpec(raw));
    const perLevelRaw = str(values, "per-level");
    const perLevel = perLevelRaw === undefined ? 1 : /^\d$/.test(perLevelRaw) ? Number(perLevelRaw) : NaN;
    if (!(perLevel >= 1 && perLevel <= MAX_PER_LEVEL)) throw new CalibrationInputError(`--per-level must be a whole number from 1 to ${MAX_PER_LEVEL}`);
    const cfg = parseEvalConfig(deps.env);
    if (!cfg.ok) throw new CalibrationInputError(cfg.errors.join("; "));
    // The primary judge's family, from the evaluator's model id (EVAL_MODEL, else NPC_MODEL); null when it is not known.
    const primaryModel = cfg.model ?? (deps.env.NPC_MODEL ?? "").trim();
    const primaryFamily = primaryModel !== "" && isValidModelId(primaryModel) ? modelFamily(primaryModel) : null;
    const allowSameFamily = values["allow-same-family"] === true;
    const criteria = draftCriteria(input.rubrics, str(values, "criterion"));
    // Everything draftProbes would refuse is refused here, before the planned-calls line (exit 2, nothing planned or called).
    checkDraftCriteria(criteria);
    subjectOf(input.scenario, str(values, "subject"));
    const drafter = deps.drafter ?? asDrafter(() => buildJudge(spec, deps.env));
    checkDrafter(drafter, primaryFamily, allowSameFamily);
    say(`drafter: ${drafter.label} (${drafter.model}). This sends the scenario's public context and the rubric anchors to its model provider and may cost money.`);
    say(`planned: ${plural(plannedDraftCalls(criteria.length, perLevel), "drafter call")} (${criteria.length} ${criteria.length === 1 ? "criterion" : "criteria"} x 4 levels x ${perLevel} per level)`);
    const r = await draftProbes({
      dir, scenario: input.scenario, rubrics: input.rubrics, drafter, primaryFamily, allowSameFamily, criterion: str(values, "criterion"), subject: str(values, "subject"),
      perLevel, timeouts: { firstTokenTimeoutMs: cfg.firstTokenTimeoutMs, replyTimeoutMs: cfg.timeoutMs }, maxTokens: cfg.maxTokens, signal: deps.signal, onProgress: say,
    });
    for (const p of r.problems) err(p);
    say(`drafts written: ${r.written.length} of ${plannedDraftCalls(criteria.length, perLevel)} in calibration/drafts/ (never used by a run). Review and edit each; the owner approves it with pnpm calibrate approve.`);
    return r.problems.length ? 1 : 0;
  }
  if (sub === "excerpt") {
    const logArg = need(values, "log", "<session.jsonl>");
    if (!logArg.endsWith(".jsonl")) throw new CalibrationInputError("--log must name a session log (a .jsonl file)");
    const from = wholeNumber(need(values, "from", "<seq>"), "from");
    const to = wholeNumber(need(values, "to", "<seq>"), "to");
    const subject = need(values, "subject", "<role>");
    const criterion = need(values, "criterion", "<id>");
    const id = need(values, "id", "<draft id>");
    const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
    let log;
    try { log = await readSessionLog(path.resolve(base, logArg)); }
    catch (e) { throw new CalibrationInputError(`--log: ${e instanceof SessionLogError ? e.message : "cannot read the session log"}`); }
    const r = await excerptDraft({ log, scenario: input.scenario, rubrics: input.rubrics, from, to, subject, criterion, id, dir });
    for (const w of r.warnings) say(`lint: ${w}`);
    say(`excerpt draft written: ${rel(r.file)} (seq ${from} to ${to}). Check it is demo or synthetic text (or consented and redacted), rate the subject's level, then the owner approves it with pnpm calibrate approve --draft ${id} --by <name> --expected <level>.`);
    return 0;
  }
  if (sub === "approve") {
    const draftId = need(values, "draft", "<id>");
    const by = need(values, "by", "<name>");
    const ex = str(values, "expected");
    let expected: Expected | undefined;
    if (ex !== undefined) {
      if (ex === "not_observed") expected = "not_observed";
      else if (/^[1-4]$/.test(ex)) expected = Number(ex) as Level;
      else throw new CalibrationInputError("--expected must be 1, 2, 3, 4 or not_observed");
    }
    const loaded = await loadProbes(dir, input.scenario, input.rubrics);
    if (loaded.errors.length) say(`warning: ${plural(loaded.errors.length, "probe problem")} in calibration/ (run pnpm calibrate to list them); approving anyway`);
    const r = await approveDraft({ dir, draftId, by, expected, finalId: str(values, "id"), scenario: input.scenario, rubrics: input.rubrics, existing: loaded.probes, now: deps.now ?? (() => new Date()) });
    for (const w of r.warnings) say(`lint: ${w}`);
    say(`approved: ${rel(r.file)} (approved by ${by.trim()})`);
    if (!r.draftRemoved) { err(`error: the probe was written but the draft calibration/drafts/${draftId}.yaml could not be deleted: delete it by hand`); return 1; }
    return 0;
  }
  // assign-splits
  const r = await assignSplits(dir);
  for (const f of r.changed) say(`split added: ${rel(f)}`);
  for (const p of r.problems) err(`not changed: ${p}`);
  say(`${plural(r.changed.length, "file")} changed${r.problems.length ? `, ${plural(r.problems.length, "file")} not changed` : ""}`);
  return r.problems.length ? 1 : 0;
}
