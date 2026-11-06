import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSafeId, isValidSessionId } from "@acr/events";
import { listDraftCandidates } from "@acr/runtime/reports";
import { evaluationCallBoundFromLog } from "@acr/runtime/run-summary";
import type { ControlConfig } from "./config.js";
import { REPO_ROOT } from "./config.js";
import { buildEvalChildEnv, EVALUATOR_ENTRY, nodeEvalSpawn, type EvalChild, type EvalSpawnFn } from "./eval-child.js";
import { readLogStatus } from "./log-tail.js";
import { scenarioDir } from "./scenarios.js";
import type { SetTimer } from "./supervisor.js";

export type JobState = "idle" | "running" | "done" | "failed";
export type JobReason = "interrupted" | "timeout" | "cancelled" | "error";
export type JobStatus = {
  state: JobState; reason?: JobReason; startedAt: number | null; progress: string[]; modelCalls: number | null;
  /** The report folder's name, relative to `reportsDir` (`<id>` or `<id>-N`), once the child said where it wrote. */
  outputDir: string | null;
};
export type Preflight = { ok: true; upTo: number } | { ok: false; code: "not_ended" | "already_evaluated" };
export type JobOutcome =
  | { status: 200; value: JobStatus }
  | { status: 404 }
  | { status: 409; code: "not_ended" | "already_evaluated" | "already_running" | "confirm_mismatch" | "too_many_running" };

/** Progress lines kept per job (the newest). */
export const PROGRESS_MAX = 50;
/** EVAL_TIMEOUT_MS when the environment does not set a usable one (the evaluator's own default). */
export const DEFAULT_EVAL_TIMEOUT_MS = 180_000;
/** The evaluator's accepted range for one call's timeout and its NPC reply timeout (`parseTimeoutEnv`), and the NPC reply default. */
const MIN_CALL_MS = 500;
const MAX_CALL_MS = 600_000;
const DEFAULT_NPC_REPLY_MS = 20_000;
/** The largest delay `setTimeout` accepts; a longer one fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long a signalled child may take before SIGKILL, and how long shutdown waits after that. */
export const KILL_GRACE_MS = 5_000;
/** The most of the child's stdout that is kept (its JSON summary is small) and the longest stderr line looked at. */
const STDOUT_CAP = 1024 * 1024;
const LINE_CAP = 4096;
const JOBS_FILE = "report-jobs.json";

/**
 * The progress ALLOWLIST: the child's stderr carries absolute paths, provider names and model or provider error text, so a line is kept
 * only when it matches one of these fixed shapes, and then only as the fixed text (or a safe id). Everything else is dropped.
 */
export function progressLine(raw: string): string | null {
  const line = raw.trim();
  const m = /^evaluating (\S+)$/.exec(line);
  if (m && isSafeId(m[1]!)) return `evaluating ${m[1]}`;
  if (line === "evaluating the team") return line;
  if (line.startsWith("NOTICE: MODEL_PROVIDER is mock")) return "using the scripted offline evaluator (demo scores, nothing leaves this machine)";
  if (line.startsWith("NOTICE: this sends the session transcript")) return "sending the transcript to the configured model provider";
  if (line.startsWith("reports written to ")) return "evaluation finished";
  return null;
}

type Persisted = { state: Exclude<JobState, "idle">; reason?: JobReason; startedAt: number | null; outputDir: string | null; modelCalls: number | null };
type Job = Persisted & { progress: string[] };
type Active = { id: string; child: EvalChild; cancelTimeout: () => void; exited: Promise<void>; by: string; /** Set the moment the child exits: a cancel or shutdown after that must not relabel the finished run. */ hasExited: boolean };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const STATES = new Set(["running", "done", "failed"]);
const REASONS = new Set(["interrupted", "timeout", "cancelled", "error"]);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/** `<id>` or `<id>-N` (2 to 99), as `listDraftCandidates` names a session's folders. */
const isCandidateName = (name: string, id: string): boolean =>
  name === id || (name.startsWith(`${id}-`) && /^([2-9]|[1-9][0-9])$/.test(name.slice(id.length + 1)));

function readJobs(file: string): Map<string, Persisted> {
  const out = new Map<string, Persisted>();
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); }
  catch { return out; } // missing or unreadable: no jobs (a job is only bookkeeping; the reports folder is the truth)
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidSessionId(id) || typeof v !== "object" || v === null) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.state !== "string" || !STATES.has(e.state)) continue;
    if (e.reason !== undefined && (typeof e.reason !== "string" || !REASONS.has(e.reason))) continue;
    const startedAt = isCount(e.startedAt) ? e.startedAt : null;
    const outputDir = typeof e.outputDir === "string" && isCandidateName(e.outputDir, id) ? e.outputDir : null;
    const modelCalls = isCount(e.modelCalls) ? e.modelCalls : null;
    out.set(id, { state: e.state as Persisted["state"], ...(e.reason ? { reason: e.reason as JobReason } : {}), startedAt, outputDir, modelCalls });
  }
  return out;
}

/**
 * The evaluate job (spec section 3): runs the existing evaluate CLI as a child process for an ended session that has no draft or review
 * yet, at most one running across the service, and reads the folder it wrote from its `--json -` summary. Everything the child is given
 * is derived here (the log path, the scenario folder, the reports folder); a request supplies only `confirmedCalls` and `by`.
 *
 * Per session it keeps `{ state, reason, startedAt, outputDir, modelCalls }` in `<dataDir>/report-jobs.json` (0600, written atomically);
 * a job persisted as running is `failed (interrupted)` on construction. Progress lines live in memory only.
 */
export class ReportJobService {
  private readonly jobs: Map<string, Job>;
  private readonly spawnFn: EvalSpawnFn;
  private readonly now: () => number;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly setTimer: SetTimer;
  private readonly file: string;
  private active: Active | null = null;
  /** A start between its checks and its spawn: holds the one running slot across the awaits. */
  private starting: string | null = null;
  private closing: Promise<void> | null = null;

  constructor(private readonly o: {
    config: ControlConfig;
    sessions: { get(id: string): { scenarioId: string; ended: boolean } | undefined };
    spawn?: EvalSpawnFn;
    now?: () => number;
    parentEnv?: NodeJS.ProcessEnv;
    onDone?: (id: string, outputDir: string, by: string) => Promise<void>;
    /** Test hook for the run timeout and the kill grace. */
    setTimer?: SetTimer;
    /** Receives fixed, path-free lines only. */
    log?: (m: string) => void;
  }) {
    this.spawnFn = o.spawn ?? nodeEvalSpawn;
    this.now = o.now ?? Date.now;
    this.parentEnv = o.parentEnv ?? process.env;
    this.setTimer = o.setTimer ?? defaultSetTimer;
    this.file = path.join(o.config.dataDir, JOBS_FILE);
    this.jobs = new Map();
    let interrupted = false;
    for (const [id, p] of readJobs(this.file)) {
      if (p.state === "running") { interrupted = true; this.jobs.set(id, { ...p, state: "failed", reason: "interrupted", progress: [] }); }
      else this.jobs.set(id, { ...p, progress: [] });
    }
    if (interrupted) this.persist();
  }

  private logPath(id: string): string { return path.join(this.o.config.sessionsDir, `${id}.jsonl`); }

  /**
   * Whether the session can be evaluated now, and its call bound. Throws a plain error (no path) when the log cannot be read or the
   * scenario, its rubrics or the log are not usable: the caller answers `unavailable`.
   */
  async preflight(id: string): Promise<Preflight> {
    const entry = isValidSessionId(id) ? this.o.sessions.get(id) : undefined;
    if (!entry || !entry.ended) return { ok: false, code: "not_ended" };
    if (readLogStatus(this.logPath(id)) !== "ended") return { ok: false, code: "not_ended" };
    const candidates = await listDraftCandidates(this.o.config.reportsDir, id);
    // A corrupt review log reads hasReview:false, so `complete` decides; a folder with a review counts too (never spend twice).
    if (candidates.some((c) => c.complete || c.hasReview)) return { ok: false, code: "already_evaluated" };
    const upTo = await evaluationCallBoundFromLog(this.logPath(id), this.scenarioFolder(entry.scenarioId));
    if (upTo === null) throw new Error("the session cannot be evaluated");
    return { ok: true, upTo };
  }

  /** The scenario folder of a known session (from the session registry, never from a request); null when unknown or not usable. */
  scenarioFolderOf(id: string): string | null {
    const entry = isValidSessionId(id) ? this.o.sessions.get(id) : undefined;
    if (!entry) return null;
    try { return this.scenarioFolder(entry.scenarioId); } catch { return null; }
  }

  private scenarioFolder(scenarioId: string): string {
    try { return scenarioDir(this.o.config.scenariosDir, scenarioId); }
    catch { throw new Error("the session cannot be evaluated"); }
  }

  async start(id: string, o: { confirmedCalls: number; by: string }): Promise<JobOutcome> {
    const entry = isValidSessionId(id) ? this.o.sessions.get(id) : undefined;
    if (!entry) return { status: 404 };
    const busy = this.active?.id ?? this.starting;
    if (busy === id) return { status: 409, code: "already_running" };
    if (busy !== null || this.closing) return { status: 409, code: "too_many_running" };
    this.starting = id;
    try {
      const pre = await this.preflight(id);
      if (!pre.ok) return { status: 409, code: pre.code };
      if (o.confirmedCalls !== pre.upTo) return { status: 409, code: "confirm_mismatch" };
      if (this.closing) return { status: 409, code: "too_many_running" };
      this.launch(id, entry.scenarioId, pre.upTo, o.by);
      return { status: 200, value: this.status(id) };
    } finally {
      this.starting = null;
    }
  }

  private launch(id: string, scenarioId: string, bound: number, by: string): void {
    const argv = [
      process.execPath, "--import", "tsx", EVALUATOR_ENTRY, this.logPath(id),
      "--scenario", this.scenarioFolder(scenarioId), "--out", this.o.config.reportsDir, "--json", "-",
    ];
    const job: Job = { state: "running", startedAt: this.now(), outputDir: null, modelCalls: null, progress: [] };
    this.jobs.set(id, job);
    let child: EvalChild;
    try {
      // The cwd is the repo root: `--import tsx` resolves from it (a root devDependency) and the calibration stamp reads data/calibration.
      child = this.spawnFn({ argv, cwd: REPO_ROOT, env: buildEvalChildEnv(this.parentEnv, this.o.config) });
    } catch {
      job.state = "failed"; job.reason = "error";
      this.persist();
      return;
    }
    this.persist();

    let stdout = "";
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (overflow) return;
      stdout += chunk.toString();
      if (stdout.length > STDOUT_CAP) { overflow = true; stdout = ""; }
    });
    let partial = "";
    let skipping = false; // inside an over-long line: drop it up to its newline
    child.stderr.on("data", (chunk: Buffer | string) => {
      const parts = (partial + chunk.toString()).split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        if (skipping) { skipping = false; continue; }
        const p = progressLine(line);
        if (p !== null) { job.progress.push(p); if (job.progress.length > PROGRESS_MAX) job.progress.shift(); }
      }
      if (partial.length > LINE_CAP) { partial = ""; skipping = true; }
    });
    child.stdout.on("error", () => {});
    child.stderr.on("error", () => {});

    const timeoutMs = Math.min(bound * this.callTimeoutMs() + this.o.config.evaluateMarginMs, MAX_TIMER_MS);
    let exitResolve!: () => void;
    const exited = new Promise<void>((r) => { exitResolve = r; });
    const active: Active = { id, child, by, exited, cancelTimeout: () => {}, hasExited: false };
    active.cancelTimeout = this.setTimer(() => { this.stop(active, "timeout"); }, timeoutMs);
    this.active = active;

    child.onExit((code) => {
      active.hasExited = true;
      active.cancelTimeout();
      void this.finish(active, job, code, overflow ? null : stdout).finally(() => {
        if (this.active === active) this.active = null;
        exitResolve();
      });
    });
  }

  /**
   * One evaluator call's deadline as the evaluator computes it: max(EVAL_TIMEOUT_MS, NPC_REPLY_TIMEOUT_MS), each within 500..600000
   * (a value outside the range is clamped, one that is not a whole number falls back to its default).
   */
  private callTimeoutMs(): number {
    const read = (name: string, fallback: number): number => {
      const raw = (this.parentEnv[name] ?? "").trim();
      if (!/^[0-9]{1,15}$/.test(raw)) return fallback;
      return Math.min(MAX_CALL_MS, Math.max(MIN_CALL_MS, Number(raw)));
    };
    return Math.max(read("EVAL_TIMEOUT_MS", DEFAULT_EVAL_TIMEOUT_MS), read("NPC_REPLY_TIMEOUT_MS", DEFAULT_NPC_REPLY_MS));
  }

  /** Signals the child (SIGTERM, then SIGKILL after the grace) and marks the job failed with `reason` at once. */
  private stop(active: Active, reason: JobReason): void {
    if (active.hasExited) return;
    const job = this.jobs.get(active.id);
    if (job && job.state === "running") { job.state = "failed"; job.reason = reason; this.persist(); }
    active.child.kill("SIGTERM");
    let gone = false;
    void active.exited.then(() => { gone = true; });
    const cancel = this.setTimer(() => { if (!gone) active.child.kill("SIGKILL"); }, KILL_GRACE_MS);
    void active.exited.then(cancel);
  }

  private async finish(active: Active, job: Job, code: number | null, stdout: string | null): Promise<void> {
    const summary = stdout === null ? null : this.parseSummary(stdout);
    if (summary) {
      job.modelCalls = summary.modelCalls;
      job.outputDir = await this.candidateName(active.id, summary.dir);
    }
    if (job.state !== "running") { this.persist(); return; } // cancelled, timed out or interrupted: keep that reason
    if (code === 0 && job.outputDir !== null) {
      job.state = "done";
      this.persist();
      // The overview reads `ready_to_open` when this fails (a complete draft without a review): the job itself is done.
      try { await this.o.onDone?.(active.id, job.outputDir, active.by); } catch { /* offered again as Open */ }
      return;
    }
    job.state = "failed"; job.reason = "error";
    this.persist();
  }

  private parseSummary(text: string): { dir: unknown; modelCalls: number | null } | null {
    try {
      const v: unknown = JSON.parse(text);
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      const r = v as Record<string, unknown>;
      return { dir: r.dir, modelCalls: isCount(r.modelCalls) ? r.modelCalls : null };
    } catch { return null; }
  }

  /** The folder name when `dir` is a direct child of the reports folder and a complete candidate of this session; else null. */
  private async candidateName(id: string, dir: unknown): Promise<string | null> {
    if (typeof dir !== "string" || !path.isAbsolute(dir) || dir.split(/[\\/]/).includes("..")) return null;
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(this.o.config.reportsDir)) return null;
    const name = path.basename(resolved);
    if (!isCandidateName(name, id)) return null;
    const found = (await listDraftCandidates(this.o.config.reportsDir, id)).find((c) => c.name === name);
    return found?.complete ? name : null;
  }

  async cancel(id: string): Promise<JobOutcome> {
    if (!isValidSessionId(id) || !this.o.sessions.get(id)) return { status: 404 };
    const a = this.active;
    if (a && a.id === id && !a.hasExited && this.jobs.get(id)?.state === "running") this.stop(a, "cancelled");
    return { status: 200, value: this.status(id) };
  }

  status(id: string): JobStatus {
    const j = this.jobs.get(id);
    if (!j) return { state: "idle", startedAt: null, progress: [], modelCalls: null, outputDir: null };
    return {
      state: j.state, ...(j.reason ? { reason: j.reason } : {}), startedAt: j.startedAt, progress: [...j.progress],
      modelCalls: j.modelCalls, outputDir: j.outputDir,
    };
  }

  /**
   * True when one of the session's report folders holds an incomplete draft set or one that does not load (spec section 3: an orphan,
   * left by a hard kill during the write; it is never reused). Never while that session's own run is writing.
   */
  async orphan(id: string): Promise<boolean> {
    if (!isValidSessionId(id)) return false;
    if (this.active?.id === id) return false;
    return (await listDraftCandidates(this.o.config.reportsDir, id)).some((c) => !c.complete);
  }

  /** Kills a running child (its job reads failed/interrupted) and waits for it, at most two grace periods. Safe to call twice. */
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    const a = this.active;
    if (!a) { this.closing = Promise.resolve(); return this.closing; }
    this.stop(a, "interrupted"); // a no-op when the child has already exited: the run is finishing, only wait for it
    this.closing = new Promise<void>((resolve) => {
      const cancel = this.setTimer(resolve, 2 * KILL_GRACE_MS);
      void a.exited.then(() => { cancel(); resolve(); });
    });
    return this.closing;
  }

  /** Atomic write: a 0600 temp file in the same folder, then rename. A failure is swallowed (the reports folder is the truth). */
  private persist(): void {
    const data: Record<string, Persisted> = {};
    for (const [id, j] of this.jobs) {
      data[id] = { state: j.state as Persisted["state"], ...(j.reason ? { reason: j.reason } : {}), startedAt: j.startedAt, outputDir: j.outputDir, modelCalls: j.modelCalls };
    }
    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      this.o.log?.("report job state could not be saved");
      try { rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    }
  }
}
