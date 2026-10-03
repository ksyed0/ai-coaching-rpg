import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { describeModelProvider, selectModelProvider } from "@acr/adapters";
import { loadScenario, validateScenario } from "@acr/script";
import { REPO_ROOT } from "../main.js";
import { DEMO_USAGE, parseDemoArgs } from "./args.js";
import { playAudit } from "./audit.js";
import { Recorder, buildMarkers, type RunKind } from "./checks.js";
import { newStory, type Ctx } from "./ctx.js";
import { FAKE_KEY, makeTempRoot, startLiveSystem, startMockSystem, type System } from "./harness.js";
import { playLab } from "./lab.js";
import { createNarrator, shouldColor } from "./narrator.js";
import { buildReport, exitCodeFor, formatChecklist, scrubText, type CheckResult, type DemoMode, type Report } from "./report.js";
import { playStory } from "./story.js";

export const TOOL = "acr-demo";
export const DEFAULT_WATCHDOG_MS = 120_000;
export const LIVE_WATCHDOG_MS = 600_000;

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
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** The repo-root .env plus the real environment; the real environment wins (as in bootstrap). Called ONLY for --live. */
export function loadLiveEnv(repoRoot: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = path.join(repoRoot, ".env");
  let fileEnv: NodeJS.ProcessEnv = {};
  if (existsSync(file)) fileEnv = parseEnv(readFileSync(file, "utf8"));
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

  // --live without --url: resolve the provider BEFORE starting anything, and refuse mock.
  let liveEnv: NodeJS.ProcessEnv | undefined;
  let providerLabel = "";
  if (opts.live && !opts.url) {
    try {
      liveEnv = (deps.resolveLiveEnv ?? (() => loadLiveEnv(repoRoot, process.env)))();
      providerLabel = describeModelProvider(liveEnv);
      selectModelProvider(liveEnv, "npc"); selectModelProvider(liveEnv, "gm"); // fails now, with a message that names variables, not values
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
  const n = createNarrator({ write, color, speed: opts.speed, fast: opts.fast, sleep: deps.sleep ?? realSleep, signal: ac.signal });
  const secretValues = [FAKE_KEY, ...Object.entries(deps.env).filter(([k, v]) => SECRETISH.test(k) && typeof v === "string" && v.length >= 8).map(([, v]) => v as string)];
  if (liveEnv) for (const [k, v] of Object.entries(liveEnv)) if (SECRETISH.test(k) && typeof v === "string" && v.length >= 8) secretValues.push(v);

  const startedMs = now();
  const rec = new Recorder({
    kind, now, forceFail: new Set(deps.forceFail ?? []), bypass: new Set(deps.bypass ?? []), aborted: () => ac.signal.aborted,
    onResult: (r) => { if (r.status === "passed") n.ok(`${r.id} ${r.details}`); else if (r.status === "failed") n.fail(`${r.id} ${r.details}`); },
  });
  const cleanups: (() => Promise<void> | void)[] = [];
  let closed = false;
  const register = (fn: () => Promise<void> | void) => { if (closed) void Promise.resolve(fn()).catch(() => undefined); else cleanups.push(fn); };
  const extra: CheckResult[] = [];
  let unexpected = false;
  const bots: Ctx["bots"] = [];

  const execute = async (): Promise<void> => {
    n.line(`The Friday Escalation demo (${mode} mode${opts.fast ? ", fast" : opts.speed !== 1 ? `, speed ${opts.speed}` : ""})`);
    if (opts.live) {
      n.styled(opts.url
        ? "NOTICE: --live with --url: the server you point at uses ITS configured model provider. Scenario text and the scripted lines go there and may cost money."
        : `NOTICE: --live sends the scenario text and the scripted lines to the configured model provider (${providerLabel}) and may cost money.`, "yellow");
      if (opts.url) n.line("The checks that depend on exact model output are skipped.");
    }
    if (opts.url) {
      n.styled("NOTICE: --url sends test traffic to the TARGET server's real session and its permanent event log:", "yellow");
      n.line("  - scripted player lines (as delivery_lead, tech_lead, account_manager) and a line containing an escape sequence and a forged newline;");
      n.line("  - a facilitator join and the commands start, pause, resume, advance and whisper;");
      n.line("  - malformed frames (bad JSON, an unknown type, an over-long line) and one oversized (~70 kB) frame.");
      n.line("The server must allow facilitator joins (Slice 1 has no authentication) and have a FRESH session (restart it between runs). Structure is checked, not model content.");
    }

    const scenario = await loadScenario(path.join(repoRoot, "scenarios", "friday-escalation"));
    const { errors } = validateScenario(scenario);
    if (errors.length) throw new Error(`the scenario is invalid: ${errors.join("; ")}`);
    const markers = buildMarkers(scenario);
    const ctx: Ctx = {
      kind, n, rec, signal: ac.signal, scenario, markers, sessionId, wsUrl: opts.url ?? "", repoRoot, npcWaitMs: deps.npcWaitMs ?? (kind === "mock" ? 5_000 : 40_000),
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
  const limit = deps.watchdogMs ?? (kind === "live" ? LIVE_WATCHDOG_MS : DEFAULT_WATCHDOG_MS);
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

  // Close everything, newest first, whatever happened. Later registrations (from a run that is still unwinding) clean up at once.
  closed = true;
  ac.abort();
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* best effort: keep closing */ } }

  rec.finish(finishReason);
  const report = buildReport({
    tool: TOOL, version: deps.version ?? readVersion(), mode, startedAt: new Date(startedMs).toISOString(), durationMs: now() - startedMs,
    results: [...rec.ordered(), ...extra], secrets: secretValues,
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
  return { exitCode: code, report };
}
