import { createHash } from "node:crypto";
import { isFileSafeId, isSafeId } from "@acr/events";
import { REPORT_REFUSALS, type ReportRefusal } from "../lib/messages";
import { readConsoleCookie } from "./console-session";
import type { ConsoleCaller } from "./console-handlers";
import { failure, guard, isId, sessionIdOf } from "./console-sessions";
import { fail, ok } from "./envelope";
import type { Deps } from "./handlers";
import { LauncherError } from "./launcher-client";
import { readCapped } from "./report-handlers";
import { realTimer } from "./runtime-connection";

// The facilitator's evaluate and review routes (US-0064), mirroring services/control/src/moderation-routes.ts under
// /api/v1/console/sessions/:id/report. Plain Request -> Response. Every write: console cookie (401), then Origin and Fetch-Metadata (403),
// then the session's ownership (the neutral 404), and only then the write throttle. The author (`by`, control appends `-console`) is, for an
// account (US-0083), `accountSlug` of the account's name and id, set here: a `by` in the body is ignored. A legacy (shared secret) sign-in
// keeps the old rule: the name the facilitator TYPED, sent as `by` in the body. Control's text and headers never reach the browser: only a
// fixed sentence per closed code (lib/messages.ts).

/** Control may be slow: its lock retries (about 1.5 s) and its per-session queue. */
export const CONTROL_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024;
/** edit (a reason and a rationale: about 6 KB in CJK), comment and edit-summary carry free text: 16 KB, as on control. */
const MAX_TEXT_BODY_BYTES = 16 * 1024;
const MAX_ITEMS = 50;
const WRITE_ROLE = "*console-report-write";
/** `-console` is appended once by control; the typed name leaves room for it inside the 64 characters of a safe id. */
const NAME = /^[A-Za-z0-9_-]{1,56}$/;

const CLOSED: ReadonlySet<string> = new Set([
  // no unknown_subject: control answers it 404 (with that code), and so does the BFF, with its own sentence
  "not_ended", "already_evaluated", "already_running", "too_many_running", "confirm_mismatch", "orphan", "no_review", "unknown_criterion",
  "stale", "blocked", "not_released", "not_editable", "superseded", "needs_amend", "refused",
]);

const priv = (res: Response): Response => {
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
};
const say = (status: number, code: ReportRefusal, init?: ResponseInit, data?: unknown) => priv(fail(status, code, REPORT_REFUSALS[code], init, data));
const badRequest = () => priv(fail(400, "bad_request", "The request could not be read."));
const notFound = () => priv(fail(404, "not_found", "That session was not found."));
const tooLarge = () => say(413, "payload_too_large");
const throttled = (retryMs: number) =>
  priv(fail(429, "rate_limited", "Too many attempts. Wait a minute and try again.", { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryMs / 1000))) } }));

/** A control failure as an answer: a fixed sentence by closed code, never control's text or headers. */
export function reportFailure(err: unknown): Response {
  if (!(err instanceof LauncherError)) return priv(failure(err));
  const r: string = err.reason;
  if (CLOSED.has(r)) return say(409, r as ReportRefusal, undefined, r === "blocked" && err.blocked !== undefined ? { blocked: err.blocked } : null);
  switch (err.reason) {
    case "invalid": return say(400, "invalid");
    case "not_found": return notFound();
    case "unknown_subject": return say(404, "unknown_subject");
    case "busy": return say(503, "busy", { headers: { "Retry-After": "2" } });
    case "unavailable": return say(503, "unavailable");
    case "timeout": return say(504, "timeout");
    case "failed": return say(502, "generic");
    default: return priv(failure(err));
  }
}

/** Runs a handler; an unexpected throw is a 500 that logs only the error's name. */
async function safely(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error(`web: console report request failed: ${err instanceof Error ? err.name : "error"}`);
    return priv(fail(500, "internal", "Something went wrong. Try again."));
  }
}

/** Waits for a control call at most CONTROL_TIMEOUT_MS on the injected timer; past that it is a `timeout`. */
async function timed<T>(deps: Deps, call: Promise<T>): Promise<T> {
  let cancel = () => {};
  const late = new Promise<never>((_, reject) => { cancel = (deps.setTimer ?? realTimer)(() => reject(new LauncherError("timeout")), CONTROL_TIMEOUT_MS); });
  try {
    return await Promise.race([call, late]);
  } finally {
    cancel();
  }
}

/** The path after /sessions/:id/report/subjects/, kept only when it is `group` or a role id. */
function subjectOf(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/");
  const at = parts.indexOf("sessions");
  if (at < 0 || parts[at + 2] !== "report" || parts[at + 3] !== "subjects") return null;
  const raw = parts[at + 4];
  if (raw === undefined) return null;
  try {
    const s = decodeURIComponent(raw);
    return s === "group" || isId(s) ? s : null;
  } catch {
    return null;
  }
}

type Body = Record<string, unknown>;
/** A JSON object of at most `max` bytes whose keys are all in `allowed` (an empty body is `{}`); "too_big" past the cap; null for anything else. */
async function readObject(req: Request, allowed: readonly string[], max: number): Promise<Body | "too_big" | null> {
  const text = await readCapped(req, max);
  if (text === "too_big" || text === null) return text;
  if (text.trim() === "") return {};
  if ((req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return Object.keys(v).every((k) => allowed.includes(k)) ? (v as Body) : null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const optCriterion = (v: unknown): boolean => v === undefined || (isStr(v) && isFileSafeId(v));
const strings = (v: unknown): boolean => v === undefined || (Array.isArray(v) && v.length <= MAX_ITEMS && v.every(isStr));
const EXPECT: readonly unknown[] = ["1", "2", "3", "4", "na", "invalid"];

type Spec = {
  keys: readonly string[];
  max?: number;
  /** Whether the body (without `by`) has the right shape for this route. */
  valid(b: Body): boolean;
  /** The call to control; `b` has been checked and `by` is the typed name. */
  send(deps: Deps & { launcher: NonNullable<Deps["launcher"]> }, id: string, subject: string | null, b: Body, by: string): Promise<unknown>;
  /** Whether the route needs a subject in its path / a typed name in its body. */
  subject: boolean;
  named: boolean;
  /** Builds the success answer itself (export); by default the data goes in the JSON envelope. */
  build?(data: unknown): Response;
};

/**
 * The write throttle's key (an in-memory key only: never logged or returned): a digest of the account's id, so signing in again (a new
 * cookie) does not reset its budget; for a legacy sign-in, a digest of the console cookie as before.
 */
const throttleKey = (req: Request, who: ConsoleCaller): string =>
  createHash("sha256").update(who.accountId !== null ? `account\0${who.accountId}` : `cookie\0${readConsoleCookie(req) ?? ""}`).digest("hex").slice(0, 32);

const SLUG_NAME_MAX = 40;
const SLUG_ID_HEX = 6;
/**
 * US-0083: an account's review author name: its display name lower-cased, every character that is not [a-z0-9] as `-`, at most 40
 * characters, then `-` and the first 6 hex characters of the account id (control's ids are hex; an id with fewer is hashed for them).
 * Always matches NAME, so with control's `-console` it stays a safe id; two accounts with the same name differ by the id part.
 */
export function accountSlug(name: string, accountId: string): string {
  const base = Array.from(name.toLowerCase(), (c) => (/^[a-z0-9]$/.test(c) ? c : "-")).slice(0, SLUG_NAME_MAX).join("");
  let hex = accountId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length < SLUG_ID_HEX) hex = createHash("sha256").update(accountId).digest("hex");
  return `${base}-${hex.slice(0, SLUG_ID_HEX)}`;
}

function write(req: Request, deps: Deps, s: Spec): Promise<Response> {
  return safely(async () => {
    const g = await guard(req, deps, true); // the console cookie, then Origin and Fetch-Metadata: both before anything is counted
    if ("response" in g) return priv(g.response);
    const t = deps.consoleReportThrottle;
    const key = throttleKey(req, g.who);
    const blocked = t.blockedForMs(key, WRITE_ROLE);
    if (blocked > 0) return throttled(blocked);
    t.fail(key, WRITE_ROLE);
    const justBlocked = t.blockedForMs(key, WRITE_ROLE);
    if (justBlocked > 0) return throttled(justBlocked);

    const id = sessionIdOf(req);
    if (id === null) return notFound();
    let subject: string | null = null;
    if (s.subject) {
      subject = subjectOf(req);
      if (subject === null) return notFound();
    }
    const b = await readObject(req, s.named ? [...s.keys, "by"] : s.keys, s.max ?? MAX_BODY_BYTES);
    if (b === "too_big") return tooLarge();
    if (b === null || !s.valid(b)) return badRequest();
    let by = "";
    if (s.named && g.who.accountId !== null) {
      // Set here, from the account: whatever `by` the body carries is ignored.
      by = accountSlug(g.who.name, g.who.accountId);
    } else if (s.named) {
      if (!isStr(b.by)) return badRequest();
      if (!NAME.test(b.by)) return say(400, "invalid_name");
      by = b.by;
    }
    if (!deps.launcher) return say(503, "unavailable");
    try {
      const data = await timed(deps, s.send(deps as Deps & { launcher: NonNullable<Deps["launcher"]> }, id, subject, b, by));
      return s.build ? s.build(data) : priv(ok(data));
    } catch (err) {
      return reportFailure(err);
    }
  });
}

function read(req: Request, deps: Deps, subject: boolean): Promise<Response> {
  return safely(async () => {
    const g = await guard(req, deps, false);
    if ("response" in g) return priv(g.response);
    const id = sessionIdOf(req);
    if (id === null) return notFound();
    const sub = subject ? subjectOf(req) : null;
    if (subject && sub === null) return notFound();
    const launcher = deps.launcher;
    if (!launcher) return say(503, "unavailable");
    try {
      const view = sub === null ? launcher.reportOverview(id) : launcher.reportSubject(id, sub);
      return priv(ok(await timed<unknown>(deps, view)));
    } catch (err) {
      return reportFailure(err);
    }
  });
}

const actions = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.length <= MAX_ITEMS && v.every((a) => typeof a === "object" && a !== null && !Array.isArray(a) && Object.keys(a).every((k) => k === "lo" || k === "text") && isStr((a as Body).lo) && isStr((a as Body).text)));

/** GET .../report: where the report stands. */
export const handleConsoleReportOverview = (req: Request, deps: Deps): Promise<Response> => read(req, deps, false);
/** GET .../report/subjects/:subject */
export const handleConsoleReportSubject = (req: Request, deps: Deps): Promise<Response> => read(req, deps, true);

/** POST .../report/evaluate { confirmedCalls, by } */
export const handleConsoleReportEvaluate = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["confirmedCalls"], subject: false, named: true,
    valid: (b) => typeof b.confirmedCalls === "number" && Number.isInteger(b.confirmedCalls) && b.confirmedCalls >= 0 && b.confirmedCalls <= 1_000_000,
    send: (d, id, _s, b, by) => d.launcher.reportEvaluate(id, { confirmedCalls: b.confirmedCalls as number, by }),
  });

/** POST .../report/evaluate/cancel {} */
export const handleConsoleReportCancel = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, { keys: [], subject: false, named: false, valid: () => true, send: (d, id) => d.launcher.reportCancel(id) });

/** POST .../report/open { by } */
export const handleConsoleReportOpen = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, { keys: [], subject: false, named: true, valid: () => true, send: (d, id, _s, _b, by) => d.launcher.reportOpen(id, by) });

/** POST .../report/subjects/:subject/edit { criterion, level, reason, rationale?, expect, by } (16 KB) */
export const handleConsoleReportEdit = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["criterion", "level", "reason", "rationale", "expect"], max: MAX_TEXT_BODY_BYTES, subject: true, named: true,
    valid: (b) => isStr(b.criterion) && isFileSafeId(b.criterion) && (b.level === null || b.level === 1 || b.level === 2 || b.level === 3 || b.level === 4) && isStr(b.reason) && optStr(b.rationale) && EXPECT.includes(b.expect),
    send: async (d, id, sub, b, by) => {
      await d.launcher.reportEdit(id, sub!, {
        criterion: b.criterion as string, level: b.level as 1 | 2 | 3 | 4 | null, reason: b.reason as string, expect: b.expect as "1",
        ...(b.rationale !== undefined && { rationale: b.rationale as string }), by,
      });
      return {};
    },
  });

/** POST .../report/subjects/:subject/accept { criterion?, summary?, by } */
export const handleConsoleReportAccept = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["criterion", "summary"], subject: true, named: true,
    valid: (b) => optCriterion(b.criterion) && (b.summary === undefined || b.summary === true),
    send: async (d, id, sub, b, by) => {
      await d.launcher.reportAccept(id, sub!, { ...(b.criterion !== undefined && { criterion: b.criterion as string }), ...(b.summary !== undefined && { summary: true as const }), by });
      return {};
    },
  });

/** POST .../report/subjects/:subject/comment { text, criterion?, feedback?, by } (16 KB) */
export const handleConsoleReportComment = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["text", "criterion", "feedback"], max: MAX_TEXT_BODY_BYTES, subject: true, named: true,
    valid: (b) => isStr(b.text) && optCriterion(b.criterion) && (b.feedback === undefined || typeof b.feedback === "boolean"),
    send: async (d, id, sub, b, by) => {
      await d.launcher.reportComment(id, sub!, {
        text: b.text as string, ...(b.criterion !== undefined && { criterion: b.criterion as string }), ...(b.feedback !== undefined && { feedback: b.feedback as boolean }), by,
      });
      return {};
    },
  });

/** POST .../report/subjects/:subject/edit-summary { reason, strengths?, developments?, actions?, by } (16 KB) */
export const handleConsoleReportEditSummary = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["reason", "strengths", "developments", "actions"], max: MAX_TEXT_BODY_BYTES, subject: true, named: true,
    valid: (b) => isStr(b.reason) && strings(b.strengths) && strings(b.developments) && actions(b.actions),
    send: async (d, id, sub, b, by) => {
      await d.launcher.reportEditSummary(id, sub!, {
        reason: b.reason as string, ...(b.strengths !== undefined && { strengths: b.strengths as string[] }),
        ...(b.developments !== undefined && { developments: b.developments as string[] }), ...(b.actions !== undefined && { actions: b.actions as { lo: string; text: string }[] }), by,
      });
      return {};
    },
  });

/** POST .../report/release { subjects, by }: an explicit list of 1 to 50 subject ids, forwarded unchanged; an `all` flag is not a key. */
export const handleConsoleReportRelease = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["subjects"], subject: false, named: true,
    valid: (b) => Array.isArray(b.subjects) && b.subjects.length >= 1 && b.subjects.length <= MAX_ITEMS && b.subjects.every((x) => isStr(x) && isFileSafeId(x)),
    send: (d, id, _s, b, by) => d.launcher.reportRelease(id, { subjects: b.subjects as string[], by }),
  });

/** POST .../report/resolve { seq, outcome, reason, by } (16 KB) */
export const handleConsoleReportResolve = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["seq", "outcome", "reason"], max: MAX_TEXT_BODY_BYTES, subject: false, named: true,
    valid: (b) => typeof b.seq === "number" && Number.isInteger(b.seq) && b.seq >= 1 && b.seq <= 999_999_999 && (b.outcome === "upheld" || b.outcome === "amended" || b.outcome === "declined") && isStr(b.reason),
    send: async (d, id, _s, b, by) => {
      await d.launcher.reportResolve(id, { seq: b.seq as number, outcome: b.outcome as "upheld", reason: b.reason as string, by });
      return {};
    },
  });

/** POST .../report/subjects/:subject/amend { reason, by } (16 KB) */
export const handleConsoleReportAmend = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["reason"], max: MAX_TEXT_BODY_BYTES, subject: true, named: true, valid: (b) => isStr(b.reason),
    send: async (d, id, sub, b, by) => {
      await d.launcher.reportAmend(id, sub!, { reason: b.reason as string, by });
      return {};
    },
  });

/** POST .../report/subjects/:subject/withdraw { reason, by } (16 KB) */
export const handleConsoleReportWithdraw = (req: Request, deps: Deps): Promise<Response> =>
  write(req, deps, {
    keys: ["reason"], max: MAX_TEXT_BODY_BYTES, subject: true, named: true, valid: (b) => isStr(b.reason),
    send: (d, id, sub, b, by) => d.launcher.reportWithdraw(id, sub!, { reason: b.reason as string, by }),
  });

/** A download name the BFF is willing to send: `report-<safe id>.md` (`report-index.md` included); anything else is `report.md`. */
function downloadName(v: unknown): string {
  const m = typeof v === "string" ? /^report-([A-Za-z0-9_-]+)\.md$/.exec(v) : null;
  return m !== null && isSafeId(m[1]!) ? (v as string) : "report.md";
}
const PARTICIPANT = "participant:";
/** `facilitator`, or `participant:` and a safe id (the one rule in @acr/events, as control checks it). */
const isAudience = (a: string): boolean => a === "facilitator" || (a.startsWith(PARTICIPANT) && isSafeId(a.slice(PARTICIPANT.length)));

/**
 * POST .../report/export { subject, audience, by }: the BFF builds the attachment itself from control's { fileName, markdown } with exactly four
 * headers; nothing from control's response headers is copied. Only POST: any other method is a 404, before any check.
 */
export const handleConsoleReportExport = (req: Request, deps: Deps): Promise<Response> => {
  if (req.method !== "POST") return Promise.resolve(notFound());
  return write(req, deps, {
    keys: ["subject", "audience"], subject: false, named: true,
    valid: (b) => isStr(b.subject) && isFileSafeId(b.subject) && isStr(b.audience) && isAudience(b.audience),
    send: (d, id, _s, b, by) => d.launcher.reportExport(id, { subject: b.subject as string, audience: b.audience as string, by }),
    build: (data) => {
      const f = data as { fileName: string; markdown: string };
      return new Response(f.markdown, {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="${downloadName(f.fileName)}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  });
};
