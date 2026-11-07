import type { IncomingMessage, ServerResponse } from "node:http";
import { isFileSafeId, isSafeId } from "@acr/events";
import { z } from "zod";
import { BAD_REQUEST, fail, failClosed, HttpError, jsonBody, ok, parse } from "./http-util.js";
import { isConsoleName, type ModOutcome, type ModerationService } from "./moderation.js";
import { RoleIdSchema } from "./protocol.js";
import type { JobOutcome, ReportJobService } from "./report-job.js";

/**
 * The free-text routes (an edit's reason and rationale, a comment, a rewritten summary) may carry more than the 4 KB of every other
 * route: an edit alone may hold 2,000 characters, about 6 KB in CJK.
 */
export const MAX_TEXT_BODY_BYTES = 16 * 1024;
const REPORT_UNAVAILABLE = "The report is unavailable. Try again.";
const BUSY = "The report is busy. Try again.";

export type ReportRouteDeps = {
  /** The session id from the path, already checked as a valid session id. */
  sessionId: string;
  /** True when the session registry knows the session. */
  knows(id: string): boolean;
  jobs?: ReportJobService;
  moderation?: ModerationService;
};

// `by` is the typed name (the service checks the `--by` rule and appends `-console`); 64 UTF-16 units bound what is read.
const By = z.string().max(64);
const CriterionId = z.string().refine(isFileSafeId);
const Level = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]);
const EvaluateBody = z.strictObject({ confirmedCalls: z.number().int().min(0).max(1_000_000), by: By });
const OpenBody = z.strictObject({ by: By });
const NoBody = z.strictObject({});
const EditBody = z.strictObject({
  criterion: CriterionId, level: Level, reason: z.string(), rationale: z.string().optional(),
  expect: z.enum(["1", "2", "3", "4", "na", "invalid"]), by: By,
});
const AcceptBody = z.strictObject({ criterion: CriterionId.optional(), summary: z.literal(true).optional(), by: By });
const CommentBody = z.strictObject({ text: z.string(), criterion: CriterionId.optional(), feedback: z.boolean().optional(), by: By });
const EditSummaryBody = z.strictObject({
  reason: z.string(), strengths: z.array(z.string()).max(50).optional(), developments: z.array(z.string()).max(50).optional(),
  actions: z.array(z.strictObject({ lo: z.string(), text: z.string() })).max(50).optional(), by: By,
});

const ReleaseBody = z.strictObject({ subjects: z.array(CriterionId).min(1).max(50), by: By });
const ReasonBody = z.strictObject({ reason: z.string(), by: By });
const ResolveBody = z.strictObject({
  seq: z.number().int().min(1).max(999_999_999), outcome: z.enum(["upheld", "amended", "declined"]), reason: z.string(), by: By,
});
const ExportBody = z.strictObject({
  subject: CriterionId,
  audience: z.union([z.literal("facilitator"), z.string().refine((a) => a.startsWith("participant:") && isSafeId(a.slice("participant:".length))).transform((a) => a as `participant:${string}`)]),
  by: By,
});

const notFound = (): never => { throw new HttpError(404, "not_found", "Not found."); };

/** Answers a closed outcome: only a code (and the blocked subject ids), a fixed sentence, never text from the review layer. */
function respond<T>(res: ServerResponse, o: ModOutcome<T> | JobOutcome): void {
  switch (o.status) {
    case 200: ok(res, (o.value as unknown) ?? {}); return;
    // an unknown subject keeps its own closed code (no message) so the console can say which thing was not found
    case 404: if ("code" in o && o.code === "unknown_subject") { failClosed(res, 404, "unknown_subject"); return; } return notFound();
    case 400: fail(res, 400, o.code, BAD_REQUEST); return;
    case 409: failClosed(res, 409, o.code, "detail" in o && o.code === "blocked" && o.detail ? { blocked: o.detail.filter(isSafeId) } : null); return;
    default:
      if (o.code === "busy") fail(res, 503, "busy", BUSY, false, Math.max(1, Math.ceil(o.retryAfterMs / 1000)));
      else fail(res, 503, "unavailable", REPORT_UNAVAILABLE);
  }
}

/** A job call that throws (the log, scenario or rubrics cannot be read) is `unavailable`, never the error's text. */
async function job(res: ServerResponse, run: () => Promise<JobOutcome>): Promise<void> {
  let out: JobOutcome;
  try { out = await run(); } catch { fail(res, 503, "unavailable", REPORT_UNAVAILABLE); return; }
  respond(res, out);
}

const SUBJECT_ACTIONS = new Set(["edit", "accept", "comment", "edit-summary", "amend", "withdraw"]);

/**
 * The facilitator's evaluate and review routes under `/sessions/:id/report` (the caller has checked the service token and the session id).
 * Resolves to false for a path or method that is not one of them, or when the service behind it is absent, so the caller answers 404.
 * Ids in the path (the session, the subject) are checked and the session looked up BEFORE a body is read.
 */
export async function handleReportRoute(seg: string[], method: string, req: IncomingMessage, res: ServerResponse, deps: ReportRouteDeps): Promise<boolean> {
  try { return await route(seg, method, req, res, deps); }
  catch (e) {
    // A body that fails the schema or is not JSON is the one code `invalid` here (the web service sees one code); 413 and 404 stay as they are.
    if (e instanceof HttpError && e.status === 400) { fail(res, 400, "invalid", BAD_REQUEST); return true; }
    throw e;
  }
}

async function route(seg: string[], method: string, req: IncomingMessage, res: ServerResponse, deps: ReportRouteDeps): Promise<boolean> {
  if (seg[0] !== "sessions" || seg[2] !== "report") return false;
  const { jobs, moderation, sessionId: id } = deps;
  const exists = (): void => { if (!deps.knows(id)) notFound(); };
  const n = seg.length;

  if (n === 3 && method === "GET") {
    if (!moderation) return false;
    exists();
    respond(res, await moderation.overview(id));
    return true;
  }
  if (n >= 4 && seg[3] === "evaluate") {
    if (!jobs) return false;
    if (n === 4 && method === "POST") {
      exists();
      const b = parse(EvaluateBody, await jsonBody(req));
      if (!isConsoleName(b.by)) { fail(res, 400, "invalid", BAD_REQUEST); return true; }
      await job(res, () => jobs.start(id, { confirmedCalls: b.confirmedCalls, by: b.by }));
      return true;
    }
    if (n === 5 && seg[4] === "cancel" && method === "POST") {
      exists();
      parse(NoBody, (await jsonBody(req)) ?? {});
      await job(res, () => jobs.cancel(id));
      return true;
    }
    return false;
  }
  if (n === 4 && seg[3] === "open" && method === "POST") {
    if (!moderation) return false;
    exists();
    const b = parse(OpenBody, await jsonBody(req));
    respond(res, await moderation.open(id, b.by));
    return true;
  }
  if (n === 4 && method === "POST" && (seg[3] === "release" || seg[3] === "resolve" || seg[3] === "export")) {
    if (!moderation) return false;
    exists();
    if (seg[3] === "release") {
      const b = parse(ReleaseBody, await jsonBody(req));
      respond(res, await moderation.release(id, { subjects: b.subjects }, b.by));
    } else if (seg[3] === "resolve") {
      const b = parse(ResolveBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
      respond(res, await moderation.resolve(id, { seq: b.seq, outcome: b.outcome, reason: b.reason }, b.by));
    } else {
      const b = parse(ExportBody, await jsonBody(req));
      respond(res, await moderation.export(id, { subject: b.subject, audience: b.audience }, b.by));
    }
    return true;
  }
  if (n >= 5 && seg[3] === "subjects") {
    const isRead = n === 5 && method === "GET";
    const isWrite = n === 6 && method === "POST" && SUBJECT_ACTIONS.has(seg[5]!);
    if (!isRead && !isWrite) return false;
    if (!moderation) return false;
    let subject: string;
    try { subject = decodeURIComponent(seg[4]!); } catch { return notFound(); }
    if (subject !== "group" && !RoleIdSchema.safeParse(subject).success) return notFound(); // before the body is read or anything is called
    exists();
    if (isRead) { respond(res, await moderation.subject(id, subject)); return true; }
    switch (seg[5]) {
      case "edit": {
        const b = parse(EditBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
        respond(res, await moderation.edit(id, subject, {
          criterion: b.criterion, level: b.level, reason: b.reason, expect: b.expect, ...(b.rationale !== undefined ? { rationale: b.rationale } : {}),
        }, b.by));
        return true;
      }
      case "accept": {
        const b = parse(AcceptBody, await jsonBody(req));
        respond(res, await moderation.accept(id, subject, {
          ...(b.criterion !== undefined ? { criterion: b.criterion } : {}), ...(b.summary !== undefined ? { summary: b.summary } : {}),
        }, b.by));
        return true;
      }
      case "comment": {
        const b = parse(CommentBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
        respond(res, await moderation.comment(id, subject, {
          text: b.text, ...(b.criterion !== undefined ? { criterion: b.criterion } : {}), ...(b.feedback !== undefined ? { feedback: b.feedback } : {}),
        }, b.by));
        return true;
      }
      case "amend": {
        const b = parse(ReasonBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
        respond(res, await moderation.amend(id, subject, { reason: b.reason }, b.by));
        return true;
      }
      case "withdraw": {
        const b = parse(ReasonBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
        respond(res, await moderation.withdraw(id, subject, { reason: b.reason }, b.by));
        return true;
      }
      default: {
        const b = parse(EditSummaryBody, await jsonBody(req, MAX_TEXT_BODY_BYTES));
        respond(res, await moderation.editSummary(id, subject, {
          reason: b.reason, ...(b.strengths !== undefined ? { strengths: b.strengths } : {}),
          ...(b.developments !== undefined ? { developments: b.developments } : {}), ...(b.actions !== undefined ? { actions: b.actions } : {}),
        }, b.by));
        return true;
      }
    }
  }
  return false;
}
