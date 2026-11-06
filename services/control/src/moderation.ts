import { constants } from "node:fs";
import { lstat, open as openFile } from "node:fs/promises";
import path from "node:path";
import { isSafeId, isValidSessionId } from "@acr/events";
import {
  acceptCriterion,
  acceptSummary,
  commentOn,
  editScore,
  editSummary,
  moderationStatus,
  openFacilitatorReview,
  subjectView,
  toModResult,
  type Base,
  type ExpectLevel,
  type ModerationCode,
  type ModResult,
  type SubjectStatus,
  type SubjectViewDto,
} from "@acr/runtime/moderation";
import { listDraftCandidates, type DraftCandidate } from "@acr/runtime/reports";
import { runSummaryFromLog, type RunSummary } from "@acr/runtime/run-summary";
import type { ControlConfig } from "./config.js";
import type { JobStatus, ReportJobService } from "./report-job.js";
import { retryWhileBusy } from "./retry.js";

export type Stage = "not_ended" | "not_evaluated" | "evaluating" | "failed" | "ready_to_open" | "in_review";
export type Overview = {
  stage: Stage;
  job: JobStatus;
  /**
   * The evaluation call bound whenever a run may start (`not_evaluated`, or `failed` without a complete draft) and no orphan folder
   * is left; null otherwise. The start request must confirm exactly this number.
   */
  confirm: { upTo: number } | null;
  orphan: boolean;
  /** Only `in_review`. */
  summary: RunSummary | null;
  /** Only `in_review`. */
  subjects: SubjectStatus[];
};
type Refusal = Exclude<ModerationCode, "busy" | "invalid" | "unavailable" | "unknown_subject">;
export type ModOutcome<T> =
  | { status: 200; value: T }
  | { status: 404 }
  | { status: 400; code: "invalid" }
  | { status: 409; code: Refusal; detail?: string[] }
  | { status: 503; code: "busy"; retryAfterMs: number }
  | { status: 503; code: "unavailable" };

export type EditBody = { criterion: string; level: 1 | 2 | 3 | 4 | null; reason: string; rationale?: string; expect: ExpectLevel };
export type AcceptBody = { criterion?: string; summary?: true };
export type CommentBody = { text: string; criterion?: string; feedback?: boolean };
export type EditSummaryBody = { reason: string; strengths?: string[]; developments?: string[]; actions?: { lo: string; text: string }[] };

/** The typed name: the `--by` rule (a safe id, the one definition in @acr/events) with room for the `-console` suffix inside the chain's 64 characters. */
const NAME_MAX = 56;
export const isConsoleName = (name: unknown): name is string => typeof name === "string" && name.length <= NAME_MAX && isSafeId(name);
export const AUTHOR_SUFFIX = "-console";
/** The session log `open` binds to, capped as `pnpm moderate open --session-log` reads it. */
const SESSION_LOG_CAP = 64 * 1024 * 1024;
/** Retry-After for a lock still held after every attempt. */
export const BUSY_RETRY_AFTER_MS = 1_000;
const REVIEW_FILE = "review.jsonl";

const INVALID = { status: 400, code: "invalid" } as const;
const UNAVAILABLE = { status: 503, code: "unavailable" } as const;
const NOT_FOUND = { status: 404 } as const;

/** Thrown inside the service only, to answer a fixed outcome from a helper. */
class Answer extends Error {
  constructor(readonly outcome: ModOutcome<never>) { super("answer"); }
}

function toOutcome<T>(r: ModResult<T>): ModOutcome<T> {
  if (r.ok) return { status: 200, value: r.value };
  switch (r.code) {
    case "invalid": return INVALID;
    case "busy": return { status: 503, code: "busy", retryAfterMs: BUSY_RETRY_AFTER_MS };
    case "unavailable": return UNAVAILABLE;
    case "unknown_subject": return NOT_FOUND;
    default: return { status: 409, code: r.code, ...(r.detail ? { detail: r.detail } : {}) };
  }
}

/** Throws unless `file` is a regular file (never a symbolic link) of at most `cap` bytes. */
async function checkRegular(file: string, cap: number): Promise<void> {
  const fh = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > cap) throw new Error("not usable");
  } finally {
    await fh.close();
  }
}

/** A regular file (never a symbolic link), at most `cap` bytes, as UTF-8; throws otherwise. */
async function readRegular(file: string, cap: number): Promise<string> {
  const fh = await openFile(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a file");
    if (st.size > cap) throw new Error("too large");
    const len = st.size;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * The facilitator's review operations for the console (spec section 5, part A), in-process over `@acr/runtime/moderation`. Every
 * answer is a closed outcome: no text from the review layer, no path and no id other than subject ids reaches the caller.
 *
 * Everything is derived here: the review folder (from `listDraftCandidates`), the session log (`<sessionsDir>/<id>.jsonl`), the
 * join-code record (`sessionsDir`) and the author (`<name>-console`, the typed name checked with the `--by` rule). A held review
 * lock is retried as the participant writes are (`retry.ts`), then `busy`.
 */
export class ModerationService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly o: {
    config: ControlConfig;
    jobs: ReportJobService;
    secrets: string[];
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    now?: () => number;
  }) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms).unref(); }));
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  private logPath(id: string): string { return path.join(this.o.config.sessionsDir, `${id}.jsonl`); }

  /** 404 unless the id is a valid session id with a session log on disk. */
  private async known(id: string): Promise<void> {
    if (typeof id !== "string" || !isValidSessionId(id)) throw new Answer(NOT_FOUND);
    let st;
    try { st = await lstat(this.logPath(id)); }
    catch (e) { throw new Answer((e as NodeJS.ErrnoException).code === "ENOENT" ? NOT_FOUND : UNAVAILABLE); }
    if (!st.isFile()) throw new Answer(NOT_FOUND); // a symbolic link or a folder is no session log
  }

  private author(name: unknown): string {
    if (!isConsoleName(name)) throw new Answer(INVALID);
    return `${name}${AUTHOR_SUFFIX}`;
  }

  /**
   * The session's report folders, split: the one live review (opened, not superseded), the complete drafts without a review, and
   * whether any folder is damaged. A folder that has a review log which does not read as an opened review (`hasReview` false) is
   * damaged: it answers `unavailable`, never "nothing here".
   */
  private async folders(id: string): Promise<{ live: string | null; unopened: DraftCandidate[]; any: boolean }> {
    const candidates = await listDraftCandidates(this.o.config.reportsDir, id);
    const live: string[] = [];
    let superseded = 0;
    const unopened: DraftCandidate[] = [];
    for (const c of candidates) {
      if (c.hasReview) {
        const s = await toModResult(() => moderationStatus(c.dir));
        if (!s.ok) throw new Answer(UNAVAILABLE);
        if (s.value.superseded === null) live.push(c.dir); else superseded++;
        continue;
      }
      let logged = false;
      try { await lstat(path.join(c.dir, REVIEW_FILE)); logged = true; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Answer(UNAVAILABLE); }
      if (logged) throw new Answer(UNAVAILABLE);
      if (c.complete) unopened.push(c);
    }
    if (live.length > 1 || (live.length === 0 && superseded > 0)) throw new Answer(UNAVAILABLE);
    return { live: live[0] ?? null, unopened, any: candidates.length > 0 };
  }

  private async liveReview(id: string): Promise<string> {
    const f = await this.folders(id);
    if (f.live === null) throw new Answer({ status: 409, code: "no_review" });
    return f.live;
  }

  /** Runs `fn`, answering any `Answer` it throws and `unavailable` for anything else. */
  private async guard<T>(fn: () => Promise<ModOutcome<T>>): Promise<ModOutcome<T>> {
    try { return await fn(); }
    catch (e) { return e instanceof Answer ? (e.outcome as ModOutcome<T>) : UNAVAILABLE; }
  }

  /** A write: name, session and live review first, then the call under the lock retry. */
  private write(id: string, name: unknown, run: (b: Base) => Promise<void>): Promise<ModOutcome<void>> {
    return this.guard(async () => {
      const by = this.author(name);
      await this.known(id);
      const dir = await this.liveReview(id);
      const base: Base = { dir, by, now: this.now, secrets: this.o.secrets };
      return toOutcome(await this.retried(() => run(base)));
    });
  }

  private retried<T>(fn: () => Promise<T>): Promise<ModResult<T>> {
    return retryWhileBusy(() => toModResult(fn), (r) => !r.ok && r.code === "busy", { sleep: this.sleep, random: this.random });
  }

  /** Where the session's report stands (spec section 5, "Stage and state"); there is no released stage. */
  overview(id: string): Promise<ModOutcome<Overview>> {
    return this.guard(async () => {
      await this.known(id);
      const { jobs } = this.o;
      const job = jobs.status(id);
      const base = { job, confirm: null, summary: null, subjects: [] as SubjectStatus[] };
      const orphan = await jobs.orphan(id);
      const ok = (v: Overview): ModOutcome<Overview> => ({ status: 200, value: v });
      // the run counts until the service lets go of it, the automatic open after a successful run included (the job may read done)
      if (job.state === "running" || jobs.isActive(id)) return ok({ ...base, stage: "evaluating", orphan });
      const f = await this.folders(id);
      if (f.live !== null) {
        const s = await toModResult(() => moderationStatus(f.live!));
        if (!s.ok) return UNAVAILABLE;
        return ok({ ...base, stage: "in_review", orphan, summary: await this.summary(id), subjects: s.value.subjects });
      }
      if (f.unopened.length > 0) return ok({ ...base, stage: "ready_to_open", orphan });
      const pre = await jobs.preflight(id);
      if (!pre.ok) return pre.code === "not_ended" ? ok({ ...base, stage: "not_ended", orphan }) : UNAVAILABLE;
      // the bound is offered whenever a run may start, a failed one included (a retry), but not while an orphan folder is left
      const confirm = orphan ? null : { upTo: pre.upTo };
      return ok({ ...base, stage: job.state === "failed" ? "failed" : "not_evaluated", orphan, confirm });
    });
  }

  /** The run summary of the session's log; null when the log or its scenario folder cannot be read. */
  private async summary(id: string): Promise<RunSummary | null> {
    const folder = this.o.jobs.scenarioFolderOf(id);
    if (folder === null) return null;
    try { await checkRegular(this.logPath(id), SESSION_LOG_CAP); } catch { return null; } // the same no-follow, capped rule as `open`
    return runSummaryFromLog(this.logPath(id), folder, this.o.secrets);
  }

  /** Opens the review of the session's complete, unopened draft, bound to its session log and join-code record. */
  open(id: string, name: string): Promise<ModOutcome<{ subjects: number }>> {
    return this.guard(async () => {
      const by = this.author(name);
      await this.known(id);
      const f = await this.folders(id);
      if (f.live !== null) return { status: 409, code: "refused" };
      let target: DraftCandidate | undefined;
      if (f.unopened.length === 1) target = f.unopened[0];
      else if (f.unopened.length > 1) {
        const out = this.o.jobs.status(id).outputDir;
        target = f.unopened.find((c) => c.name === out);
        if (!target) return UNAVAILABLE;
      }
      if (!target) return { status: 409, code: "no_review" };
      let sessionLogText: string;
      try { sessionLogText = await readRegular(this.logPath(id), SESSION_LOG_CAP); } catch { return UNAVAILABLE; }
      const dir = target.dir;
      return toOutcome(await this.retried(() =>
        openFacilitatorReview({ dir, by, now: this.now, sessionLogText, codesDir: this.o.config.sessionsDir })));
    });
  }

  subject(id: string, subject: string): Promise<ModOutcome<SubjectViewDto>> {
    return this.guard(async () => {
      await this.known(id);
      const dir = await this.liveReview(id);
      return toOutcome(await toModResult(() => subjectView(dir, subject, this.o.secrets)));
    });
  }

  edit(id: string, subject: string, body: EditBody, name: string): Promise<ModOutcome<void>> {
    // the console always carries `expect` (the CLI keeps it optional), so two open tabs cannot overwrite each other
    if (typeof body?.expect !== "string") return Promise.resolve(INVALID);
    return this.write(id, name, (b) => editScore({
      ...b, subject, criterion: body.criterion, level: body.level, reason: body.reason, expect: body.expect,
      ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
    }));
  }

  accept(id: string, subject: string, body: AcceptBody, name: string): Promise<ModOutcome<void>> {
    const criterion = typeof body?.criterion === "string";
    const summary = body?.summary === true;
    if (criterion === summary) return Promise.resolve(INVALID);
    return this.write(id, name, (b) =>
      criterion ? acceptCriterion({ ...b, subject, criterion: body.criterion! }) : acceptSummary({ ...b, subject }));
  }

  comment(id: string, subject: string, body: CommentBody, name: string): Promise<ModOutcome<void>> {
    return this.write(id, name, (b) => commentOn({
      ...b, subject, text: body?.text,
      ...(body?.criterion !== undefined ? { criterion: body.criterion } : {}),
      ...(body?.feedback !== undefined ? { feedback: body.feedback } : {}),
    }));
  }

  editSummary(id: string, subject: string, body: EditSummaryBody, name: string): Promise<ModOutcome<void>> {
    return this.write(id, name, (b) => editSummary({
      ...b, subject, reason: body?.reason,
      ...(body?.strengths !== undefined ? { strengths: body.strengths } : {}),
      ...(body?.developments !== undefined ? { developments: body.developments } : {}),
      ...(body?.actions !== undefined ? { actions: body.actions } : {}),
    }));
  }
}
