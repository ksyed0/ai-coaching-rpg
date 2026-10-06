import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { describeModelProvider, selectModelProvider } from "@acr/adapters";
import { loadRubrics, loadScenario, validateScenario, type Rubric, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../main.js";
import { DEMO_USAGE, parseDemoArgs } from "./args.js";
import { playAudit } from "./audit.js";
import { CHECKS, Recorder, buildMarkers, type RunKind } from "./checks.js";
import { newStory, type Ctx } from "./ctx.js";
import { FAKE_KEY, makeTempDataDir, makeTempRoot, startLiveSystem, startMockSystem, startPlayerProvider, startShowcaseMockSystem, type System } from "./harness.js";
import { PlayerBotGenerator } from "./player-bot.js";
import { PlayerLines } from "./player-lines.js";
import { playLab } from "./lab.js";
import { createNarrator, shouldColor } from "./narrator.js";
import { buildReport, exitCodeFor, formatChecklist, scrubText, type CheckResult, type DemoMode, type Report } from "./report.js";
import { SHOWCASE_CHECKS, SHOWCASE_EVAL_CHECKS, SHOWCASE_PLAYER_CHECKS, expectedModelCalls, playShowcase, showcaseMarkers, type ShowcaseEvaluate, type ShowcaseHolder, type ShowcaseHooks } from "./showcase.js";
import { loadShowcaseScript, type ShowcaseScript } from "./showcase-script.js";
import { playStory } from "./story.js";
import type { ProviderKind } from "./provenance.js";
import { Transcript } from "./transcript.js";
import { checkTranscriptTarget, writeTranscriptFile } from "./transcript-path.js";
import { renderTranscript } from "./transcript-md.js";
import { parseNpcTimeouts, DEFAULT_REPLY_TIMEOUT_MS } from "../agents/timeouts.js";
import { parseModelRetry } from "../agents/retry-config.js";
import { parseTokenBudgets } from "../agents/token-budgets.js";
import { parseTemperatures } from "../agents/temperatures.js";
import { parseEvalConfig, type EvalConfig } from "../evaluator/config.js";
import { evaluateSession } from "../evaluator/evaluate.js";
import { readSessionLog } from "../evaluator/log-reader.js";
import { evaluatorInfo, startEvaluatorProvider } from "../evaluator/provider.js";
import { writeReports } from "../evaluator/report-write.js";
import { createScriptedEvaluator } from "./eval-mock.js";

export const TOOL = "acr-demo";
export const DEFAULT_WATCHDOG_MS = 120_000;
export const LIVE_WATCHDOG_MS = 600_000;
export const DEFAULT_SHOWCASE_SCENARIO = "scenarios/friday-escalation-extended";
export const SHOWCASE_WATCHDOG_MINUTES = 3;
export const SHOWCASE_LIVE_WATCHDOG_MINUTES = 30;
/** With `--evaluate --live` the watchdog (default or explicit `--watchdog`) grows by the evaluator's worst case: EVAL timeout x (players + 1 calls) x 2 (each may be re-asked). */
export function evaluateExtraMs(timeoutMs: number, players: number): number { return timeoutMs * (players + 1) * 2; }

export type Out = { write(chunk: string): unknown; isTTY?: boolean };
export type RunDeps = {
  argv: string[];
  stdout: Out;
  stderr: Out;
  /** Used for NO_COLOR and for spotting key-like values to keep out of the output. Provider settings are NEVER read from it in mock mode. */
  env: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  repoRoot?: string;
  version?: string;
  /** Real-time limit for the whole run. */
  watchdogMs?: number;
  /** Check ids to fail on purpose (exit-code tests). */
  forceFail?: string[];
  /** Check ids to leave unrun, simulating a code path that skips a check (tests). */
  bypass?: string[];
  /** Where SIGINT/SIGTERM are observed (run.ts passes `process`). An interrupt aborts the run, cleans up and exits 130 / 143. */
  signals?: { on(event: "SIGINT" | "SIGTERM", fn: () => void): unknown; off(event: "SIGINT" | "SIGTERM", fn: () => void): unknown };
  /** Called before each act; tests block it to simulate a hung run. */
  beforeAct?: (name: string) => Promise<void>;
  /** Only called for --live without --url. Default: the repo-root .env plus the real environment (real env wins). */
  resolveLiveEnv?: () => NodeJS.ProcessEnv;
  /** Where a relative --json path is resolved from. Default: the directory the user ran pnpm from (INIT_CWD), else the cwd. */
  cwd?: string;
  /** How long to wait for an NPC reply when the model is real or remote. */
  npcWaitMs?: number;
  /** Where the showcase makes its temp directory (default: the OS temp dir). Tests give each file its own, so parallel files never see each other's. */
  tempParent?: string;
  /** Test hooks that run inside the showcase story (to force scene races). */
  showcaseHooks?: ShowcaseHooks;
  /** Test hook for `--evaluate`: runs after the reports are written and before check S-16 reads them back (tests tamper with a file here). */
  afterReportsWritten?: (dir: string) => Promise<void>;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** The repo-root .env plus the real environment; the real environment wins (as in bootstrap). Called ONLY for --live. */
export function loadLiveEnv(repoRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = path.join(repoRoot, ".env");
  let fileEnv: NodeJS.ProcessEnv = {};
  try { fileEnv = parseEnv(readFileSync(file, "utf8")); } // a single read: no existence check to race with
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  return { ...fileEnv, ...env };
}

export function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

/**
 * Runs the demo. Never calls process.exit and never leaves a socket, server, timer or temp dir behind. Returns the exit
 * code (0 all executed checks passed, 1 a check failed or something unexpected happened, 2 usage error).
 */
export async function runDemo(deps: RunDeps): Promise<{ exitCode: number; report?: Report }> {
  const parsed = parseDemoArgs(deps.argv);
  if (!parsed.ok) { deps.stderr.write(`${scrubText(parsed.error)}\n${parsed.usage}\n`); return { exitCode: 2 }; }
  const opts = parsed.opts;
  if (opts.help) { deps.stdout.write(`${DEMO_USAGE}\n`); return { exitCode: 0 }; }

  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const now = deps.now ?? Date.now;
  const kind: RunKind = opts.url ? "url" : opts.live ? "live" : "mock";
  const mode: DemoMode = opts.url ? (opts.live ? "url+live" : "url") : opts.live ? "live" : "mock";
  const sessionId = opts.session ?? (opts.url ? "local" : "demo");

  // --transcript: validate the target before anything starts (a directory is refused; missing parents are created only in safe places).
  let transcriptPath: string | undefined;
  if (opts.transcript !== undefined) {
    const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
    const target = path.resolve(base, opts.transcript);
    const jsonPath = opts.json !== undefined && opts.json !== "-" ? path.resolve(base, opts.json) : undefined;
    const problem = await checkTranscriptTarget(target, { base, repoRoot, jsonPath });
    if (problem) { deps.stderr.write(`error: --transcript cannot use ${scrubText(opts.transcript)}: ${problem}\n`); return { exitCode: 2 }; }
    transcriptPath = target;
  }

  // --showcase: the scenario and its showcase script must load before anything starts (and before any .env is read).
  let showcase: { scenario: Scenario; script: ShowcaseScript; rubrics: Rubric[] } | undefined;
  if (opts.showcase) {
    const dir = path.resolve(repoRoot, opts.scenario ?? DEFAULT_SHOWCASE_SCENARIO);
    try {
      if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new Error("the scenario directory does not exist");
      const scenario = await loadScenario(dir);
      const { errors } = validateScenario(scenario);
      if (errors.length) throw new Error(`the scenario is invalid: ${errors.join("; ")}`);
      let rubrics: Rubric[] = [];
      if (opts.evaluate) {
        const loaded = await loadRubrics(dir, scenario);
        if (loaded.errors.length) throw new Error(`the rubrics are invalid: ${loaded.errors.join("; ")}`);
        if (loaded.rubrics.length === 0) throw new Error("--evaluate needs rubrics, but the scenario names none");
        rubrics = loaded.rubrics;
      }
      showcase = { scenario, script: await loadShowcaseScript(dir, scenario, { mode: opts.live ? "live" : "mock", maxLines: opts.maxLines }), rubrics };
    } catch (err) {
      deps.stderr.write(`error: --showcase cannot use that scenario: ${scrubText(err instanceof Error ? err.message : String(err))}\n`);
      return { exitCode: 2 };
    }
  }

  // --live without --url: resolve the provider BEFORE starting anything, and refuse mock.
  let liveEnv: NodeJS.ProcessEnv | undefined;
  let providerLabel = "";
  if (opts.live && !opts.url) {
    try {
      liveEnv = (deps.resolveLiveEnv ?? (() => loadLiveEnv(repoRoot, process.env)))();
      providerLabel = describeModelProvider(liveEnv);
      selectModelProvider(liveEnv, "npc"); selectModelProvider(liveEnv, "gm"); // fails now, with a message that names variables, not values
      const retryConfig = parseModelRetry(liveEnv);
      if (!retryConfig.ok) throw new Error(retryConfig.errors.join("; "));
      const temperatures = parseTemperatures(liveEnv);
      if (!temperatures.ok) throw new Error(temperatures.errors.join("; "));
      if (opts.players === "generated") startPlayerProvider(liveEnv, opts.playerModel); // fails now, naming variables, not values
      if (opts.evaluate) {
        const ec = parseEvalConfig(liveEnv);
        if (!ec.ok) throw new Error(ec.errors.join("; "));
        startEvaluatorProvider(liveEnv, ec); // fails now, naming variables, not values
      }
    } catch (err) {
      deps.stderr.write(`error: --live cannot use the configured model provider: ${scrubText(err instanceof Error ? err.message : String(err))}\n`);
      return { exitCode: 2 };
    }
    if (providerLabel === "mock") {
      deps.stderr.write("error: --live needs a real model provider, but MODEL_PROVIDER resolves to mock. Set MODEL_PROVIDER (and its key) in your environment or .env, or drop --live.\n");
      return { exitCode: 2 };
    }
  }

  const toStderr = opts.json === "-";
  const sink = toStderr ? deps.stderr : deps.stdout;
  const color = shouldColor({ isTTY: sink.isTTY, env: deps.env, noColor: opts.noColor });
  const tap: string[] = [];
  const write = (line: string) => { tap.push(line); sink.write(`${line}\n`); };
  const ac = new AbortController();
  const providerKind: ProviderKind = opts.url ? "remote" : opts.live ? "live" : "mock";
  const startedForTranscript = now();
  const tr = transcriptPath ? new Transcript(now, startedForTranscript) : undefined;
  const n = createNarrator({ write, color, speed: opts.speed, fast: opts.fast, sleep: deps.sleep ?? realSleep, signal: ac.signal, record: tr ? (r) => tr.add(r) : undefined });
  let scenarioTitle = "Friday Escalation";
  const secretValues = [FAKE_KEY, ...Object.entries(deps.env).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v as string)];
  if (liveEnv) for (const [k, v] of Object.entries(liveEnv)) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 8) secretValues.push(v);

  const startedMs = now();
  const holder: ShowcaseHolder = {};
  const rec = new Recorder({
    kind, now, defs: showcase ? [...SHOWCASE_CHECKS, ...(opts.players === "generated" ? SHOWCASE_PLAYER_CHECKS : []), ...(opts.evaluate ? SHOWCASE_EVAL_CHECKS : [])] : CHECKS, forceFail: new Set(deps.forceFail ?? []), bypass: new Set(deps.bypass ?? []), aborted: () => ac.signal.aborted,
    onResult: (r) => { if (r.status === "passed") n.ok(`${r.id} ${r.details}`); else if (r.status === "failed") n.fail(`${r.id} ${r.details}`); },
  });
  const cleanups: (() => Promise<void> | void)[] = [];
  let closed = false;
  const register = (fn: () => Promise<void> | void) => { if (closed) void Promise.resolve(fn()).catch(() => undefined); else cleanups.push(fn); };
  const extra: CheckResult[] = [];
  let unexpected = false;
  const bots: Ctx["bots"] = [];

  let evalExtraMinutes = 0;
  if (showcase && opts.evaluate && kind === "live" && liveEnv) {
    const ec = parseEvalConfig(liveEnv); // validated before anything started
    if (ec.ok) evalExtraMinutes = Math.ceil(evaluateExtraMs(ec.timeoutMs, Object.values(showcase.scenario.roles).filter((r) => r.type === "player").length) / 60_000);
  }
  const watchdogMinutes = (opts.watchdog ?? (kind === "live" ? SHOWCASE_LIVE_WATCHDOG_MINUTES : SHOWCASE_WATCHDOG_MINUTES)) + evalExtraMinutes;
  const limit = deps.watchdogMs ?? (opts.watchdog !== undefined || showcase ? watchdogMinutes * 60_000 : kind === "live" ? LIVE_WATCHDOG_MS : DEFAULT_WATCHDOG_MS);

  const executeShowcase = async (sc: { scenario: Scenario; script: ShowcaseScript; rubrics: Rubric[] }): Promise<void> => {
    const pacing = opts.fast ? ", fast" : opts.speed !== 1 ? `, speed ${opts.speed}` : "";
    scenarioTitle = sc.scenario.meta.title;
    n.line(`${sc.scenario.meta.title}: AI showcase (${mode} mode${opts.players === "generated" ? ", generated players" : ""}${pacing})`);
    const calls = expectedModelCalls(sc.scenario, sc.script, opts.maxLines ?? null);
    if (opts.live) {
      n.styled(`NOTICE: --live sends the AI characters' personas and goals and ${opts.players === "generated" ? "the conversation so far" : "the scripted conversation"} to the configured model provider (${providerLabel}) and may cost money. Expect up to about ${calls.npc} AI character replies and ${calls.gm} Game Master calls.`, "yellow");
      if (opts.players === "generated") n.styled(`NOTICE: --players generated also sends each player role's brief and private facts, the scene title and goal, the injects addressed to that role and the conversation it has seen to the model provider to write the player lines (up to about ${calls.player} more calls, one per line slot and more with retries${opts.playerModel ? `, model ${opts.playerModel}` : ", the NPC model"}). A failed generation falls back to the scripted line.`, "yellow");
      n.line("The AI characters and the Game Master answer for real; how long it takes depends on the model.");
    } else n.line("Mock mode: the AI characters and the Game Master are scripted (offline and deterministic); nothing leaves this machine.");
    const markers = showcaseMarkers(sc.scenario);
    const ctx: Ctx = {
      kind, tr, provider: providerKind, n, rec, signal: ac.signal, scenario: sc.scenario, markers, sessionId, wsUrl: "", repoRoot, npcWaitMs: deps.npcWaitMs ?? (kind === "mock" ? 5_000 : 40_000),
      outputTap: tap, labLogs: [], labHostLog: [], bots, secretValues, beforeAct: deps.beforeAct, register, now,
    };
    register(() => { for (const b of bots) b.terminate(); });
    const t = await makeTempDataDir(deps.tempParent);
    register(() => t.cleanup());
    const base = { scenario: sc.scenario, sessionId, dataDir: t.dataDir };
    const sys = kind === "live"
      ? await startLiveSystem({ ...base, env: liveEnv! })
      : await startShowcaseMockSystem({ ...base, scenes: sc.script.scenes });
    register(() => sys.stop());
    ctx.sys = sys; ctx.tmp = { root: t.root, dataDir: t.dataDir, scenarioDir: "", cleanup: t.cleanup }; ctx.wsUrl = `ws://127.0.0.1:${sys.port}`;
    const timeouts = liveEnv ? parseNpcTimeouts(liveEnv) : undefined;
    let players: { generator: PlayerBotGenerator; lines: PlayerLines } | undefined;
    if (opts.players === "generated") {
      if (!liveEnv) throw new Error("--players generated needs the live environment");
      if (!timeouts?.ok) throw new Error(`the NPC timeouts are invalid: ${timeouts?.errors.join("; ")}`);
      const budgets = parseTokenBudgets(liveEnv);
      if (!budgets.ok) throw new Error(budgets.errors.join("; "));
      const temps = parseTemperatures(liveEnv);
      if (!temps.ok) throw new Error(temps.errors.join("; "));
      players = {
        lines: new PlayerLines(),
        generator: new PlayerBotGenerator({
          provider: startPlayerProvider(liveEnv, opts.playerModel), scenario: sc.scenario, signal: ac.signal,
          firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs, maxTokens: budgets.npcMaxTokens, temperature: temps.playerTemperature,
        }),
      };
    }
    let evaluate: ShowcaseEvaluate | undefined;
    if (opts.evaluate) {
      const outDir = path.resolve(deps.cwd ?? deps.env.INIT_CWD ?? process.cwd(), opts.evalOut ?? "data/reports");
      const mockRun = kind !== "live";
      let config: EvalConfig;
      if (mockRun) { const d = parseEvalConfig({}); if (!d.ok) throw new Error(d.errors.join("; ")); config = d; } // a mock run never reads provider settings from the environment
      else { const c = parseEvalConfig(liveEnv!); if (!c.ok) throw new Error(c.errors.join("; ")); config = c; }
      evaluate = {
        mock: mockRun,
        run: async (logFile, signal) => {
          const events = await readSessionLog(logFile);
          const provider = mockRun ? createScriptedEvaluator(events, sc.scenario, sc.rubrics) : startEvaluatorProvider(liveEnv!, config);
          const result = await evaluateSession({ events, scenario: sc.scenario, rubrics: sc.rubrics, provider, config, signal });
          const written = await writeReports(result, { outDir, evaluator: evaluatorInfo(mockRun ? {} : liveEnv!, config, { scripted: mockRun }), secrets: secretValues });
          await deps.afterReportsWritten?.(written.dir);
          return { result, written };
        },
      };
      n.line(mockRun ? "Evaluation: after the checks the scripted offline evaluator writes feedback reports (demo data, deterministic)." : `NOTICE: --evaluate sends the whole session transcript (what every participant and AI character said) to the configured model provider (${providerLabel}) at the end, up to ${sc.scenario.script.scenes.length > 0 ? Object.values(sc.scenario.roles).filter((r) => r.type === "player").length * 2 + 2 : 0} calls, and may cost money.`, false);
    }
    await playShowcase(ctx, newStory(), {
      script: sc.script, mode: kind === "live" ? "live" : "mock", maxLines: opts.maxLines ?? null, maxFallbacks: opts.maxFallbacks ?? null,
      watchdogMinutes, watchdogMs: limit, provider: kind === "live" ? providerLabel : undefined,
      replyTimeoutMs: timeouts?.ok ? timeouts.replyTimeoutMs : DEFAULT_REPLY_TIMEOUT_MS, startedMs, holder, hooks: deps.showcaseHooks, players, evaluate,
    });
  };

  const execute = async (): Promise<void> => {
    if (showcase) return executeShowcase(showcase);
    n.line(`The Friday Escalation demo (${mode} mode${opts.fast ? ", fast" : opts.speed !== 1 ? `, speed ${opts.speed}` : ""})`);
    if (opts.live) {
      n.styled(opts.url
        ? "NOTICE: --live with --url: the server you point at uses ITS configured model provider. Scenario text and the scripted lines go there and may cost money."
        : `NOTICE: --live sends the scenario text and the scripted lines to the configured model provider (${providerLabel}) and may cost money.`, "yellow");
      if (opts.url) n.line("The checks that depend on exact model output are skipped.");
    }
    if (opts.url) {
      n.styled("NOTICE: --url drives the TARGET server's real session and writes to its permanent event log. Point it only at a throwaway server with a FRESH session:", "yellow");
      n.line("  - it ADVANCES THE SESSION TO ITS END (script_complete); that session then cannot be resumed;");
      n.line("  - a facilitator join and the commands start, pause, resume, advance and whisper;");
      n.line("  - scripted player lines (as delivery_lead, tech_lead, account_manager), including one containing an escape sequence and a forged newline, and speech while the session is paused;");
      n.line("  - role-claim attempts (a taken, an NPC and an unknown role), forged-token takeover attempts and a rejoin with the real token;");
      n.line("  - player-issued start and pause, speech before the start, a facilitator say, speech from a role that is absent from the scene, speech and a resume command after the session ends, speech before joining, and a whisper to the NPC role (all expected to be refused);");
      n.line("  - malformed frames (bad JSON, an unknown type, an over-long line, an empty id) and one oversized (~70 kB) frame.");
      n.line("The server must allow facilitator joins (Slice 1 has no authentication). Structure is checked, not model content.");
    }

    const scenario = await loadScenario(path.join(repoRoot, "scenarios", "friday-escalation"));
    const { errors } = validateScenario(scenario);
    if (errors.length) throw new Error(`the scenario is invalid: ${errors.join("; ")}`);
    const markers = buildMarkers(scenario);
    scenarioTitle = scenario.meta.title;
    const ctx: Ctx = {
      kind, tr, provider: providerKind, n, rec, signal: ac.signal, scenario, markers, sessionId, wsUrl: opts.url ?? "", repoRoot, npcWaitMs: deps.npcWaitMs ?? (kind === "mock" ? 5_000 : 40_000),
      outputTap: tap, labLogs: [], labHostLog: [], bots, secretValues, beforeAct: deps.beforeAct, register, now,
    };
    register(() => { for (const b of bots) b.terminate(); });

    if (kind !== "url") {
      const t = await makeTempRoot(repoRoot);
      register(() => t.cleanup());
      let sys: System;
      if (kind === "live") sys = await startLiveSystem({ scenario, sessionId, dataDir: t.dataDir, env: liveEnv! });
      else sys = await startMockSystem({ scenario, sessionId, dataDir: t.dataDir });
      register(() => sys.stop());
      ctx.sys = sys; ctx.tmp = t; ctx.wsUrl = `ws://127.0.0.1:${sys.port}`;
    }
    const st = newStory();
    await playStory(ctx, st);
    await playLab(ctx, st);
    await playAudit(ctx, st);
    if (st.broken) { rec.finish("prerequisite failed"); extra.push({ id: "STORY", title: "The story ran to its end", status: "failed", details: st.broken, durationMs: 0 }); }
  };

  // Global watchdog: a real-time limit, so a hung server or step can never hang the process.
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), limit); });
  let interrupted: "SIGINT" | "SIGTERM" | null = null;
  let onInterrupt: (() => void) | undefined;
  const interruptP = new Promise<"interrupt">((resolve) => { onInterrupt = () => resolve("interrupt"); });
  const onSigint = () => { interrupted ??= "SIGINT"; onInterrupt?.(); };
  const onSigterm = () => { interrupted ??= "SIGTERM"; onInterrupt?.(); };
  deps.signals?.on("SIGINT", onSigint); deps.signals?.on("SIGTERM", onSigterm);
  const body = execute().then(() => "done" as const, (err: unknown) => err);
  const outcome = await Promise.race([body, watchdog, interruptP]);
  clearTimeout(timer);
  deps.signals?.off("SIGINT", onSigint); deps.signals?.off("SIGTERM", onSigterm);
  let finishReason = "prerequisite failed";
  if (outcome === "interrupt") {
    unexpected = true; finishReason = "run interrupted";
    ac.abort();
    extra.push({ id: "INTERRUPTED", title: "The run was not interrupted", status: "failed", details: `stopped by ${interrupted}`, durationMs: 0 });
  } else if (outcome === "timeout") {
    unexpected = true; finishReason = "run aborted";
    ac.abort();
    extra.push({ id: "WATCHDOG", title: "The run finished within its time limit", status: "failed", details: `aborted after ${Math.round(limit / 1000)} s of real time`, durationMs: limit });
  } else if (outcome !== "done") {
    unexpected = true; finishReason = ac.signal.aborted ? "run aborted" : "run stopped by an error";
    extra.push({ id: "ERROR", title: "The run completed without an unexpected error", status: "failed", details: outcome instanceof Error ? outcome.message : String(outcome), durationMs: 0 });
  }
  if (outcome === "timeout" || outcome === "interrupt") void body.then(() => undefined);

  const showcaseReport = holder.report ?? (() => { try { return holder.snapshot?.(); } catch { return undefined; } })();

  // Close everything, newest first, whatever happened. Later registrations (from a run that is still unwinding) clean up at once.
  closed = true;
  ac.abort();
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort: keep closing */ } }

  rec.finish(finishReason);
  const report = buildReport({
    tool: TOOL, version: deps.version ?? readVersion(), mode, startedAt: new Date(startedMs).toISOString(), durationMs: now() - startedMs,
    results: [...rec.ordered(), ...extra], secrets: secretValues, showcase: showcaseReport,
    evaluation: holder.evaluation ? {
      dir: holder.evaluation.written.dir, files: holder.evaluation.written.files.map((f) => path.relative(holder.evaluation!.written.dir, f)), modelCalls: holder.evaluation.result.modelCalls,
      participants: holder.evaluation.result.participants.map((p) => ({ role: p.roleId, status: p.status })), group: { status: holder.evaluation.result.group.status }, failures: holder.evaluation.result.failures,
    } : undefined,
  });
  const code = interrupted ? (interrupted === "SIGINT" ? 130 : 143) : exitCodeFor(report, unexpected || extra.length > 0);
  for (const line of ["", ...formatChecklist(report, color)]) sink.write(`${line}\n`);

  if (opts.json !== undefined) {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (opts.json === "-") deps.stdout.write(text);
    else {
      // `pnpm demo` runs inside services/runtime; a relative path is meant relative to where the user typed the command.
      const target = path.resolve(deps.cwd ?? deps.env.INIT_CWD ?? process.cwd(), opts.json);
      try { await writeFile(target, text, "utf8"); sink.write(`report written to ${scrubText(opts.json)}\n`); }
      catch (err) { deps.stderr.write(`error: cannot write the report to ${scrubText(opts.json)}: ${(err as NodeJS.ErrnoException).code ?? "failed"}\n`); return { exitCode: 1, report }; }
    }
  }
  if (tr && transcriptPath) {
    const providerText = opts.url ? "AI line tags are unverified: remote server (its provider is not known to the runner)" : opts.live ? providerLabel : "scripted mock providers";
    const text = renderTranscript({
      title: `${scenarioTitle}${showcase ? " AI showcase" : " demo"} transcript`,
      meta: {
        mode, provider: providerText, scenario: scenarioTitle, date: report.startedAt, version: report.version,
        summary: `${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped (exit ${code})`,
      },
      records: tr.records, results: report.results, showcase: report.showcase, secrets: secretValues,
    });
    try {
      await writeTranscriptFile(transcriptPath, text, { anchors: [deps.cwd ?? deps.env.INIT_CWD ?? process.cwd(), repoRoot, os.tmpdir()] });
      sink.write(`transcript written to ${scrubText(opts.transcript!)}\n`);
    } catch (err) { deps.stderr.write(`error: cannot write the transcript to ${scrubText(opts.transcript!)}: ${(err as NodeJS.ErrnoException).code ?? "failed"}\n`); return { exitCode: 1, report }; }
  }
  return { exitCode: code, report };
}
