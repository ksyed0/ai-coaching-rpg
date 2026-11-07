import { getJson, postForFile, postJson, type ApiResult } from "./api";
import { MESSAGES, REPORT_CONSOLE, REPORT_REFUSALS, type ReportRefusal } from "./messages";

// What the console pages know about the BFF's answers. Everything from the network is untrusted: shapes are checked here and text is
// shown as text. The server's own message is never shown; every failure maps to one of these sentences.

export type CodeEntry = { roleId: string; code: string };
export type RosterEntry = {
  roleId: string;
  name?: string;
  joined: boolean;
  consented: boolean;
  connected: boolean;
  /** US-0060: an AI player holds this seat (only ever the literal true). */
  ai?: true;
};
export type Readiness = {
  launcherStatus: "running" | "stopped" | "ended";
  status: "idle" | "running" | "ended" | null;
  modelLabel: string | null;
  roster: RosterEntry[];
  canStart: boolean;
  missing: string[];
  /** US-0060: AI roles whose bot has not connected yet. Empty when the server does not send it (an older server). */
  aiWaiting: string[];
  /** US-0061: the group-score option (on unless the server says it is off). */
  includeInGroup: boolean;
};
export type ListedSession = {
  sessionId: string;
  scenarioId: string;
  status: "running" | "stopped" | "ended";
  modelLabel?: string;
};

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const LAUNCHER = ["running", "stopped", "ended"] as const;
const RUNTIME = ["idle", "running", "ended"] as const;

export function parseCodes(v: unknown): CodeEntry[] {
  if (!Array.isArray(v)) return [];
  const out: CodeEntry[] = [];
  for (const x of v) {
    const o = obj(x);
    if (o && typeof o.roleId === "string" && typeof o.code === "string")
      out.push({ roleId: o.roleId, code: o.code });
  }
  return out;
}

export function parseSessions(v: unknown): ListedSession[] {
  if (!Array.isArray(v)) return [];
  const out: ListedSession[] = [];
  for (const x of v) {
    const o = obj(x);
    if (
      !o ||
      typeof o.sessionId !== "string" ||
      typeof o.scenarioId !== "string"
    )
      continue;
    const status = LAUNCHER.find((s) => s === o.status);
    if (!status) continue;
    out.push({
      sessionId: o.sessionId,
      scenarioId: o.scenarioId,
      status,
      ...(typeof o.modelLabel === "string" ? { modelLabel: o.modelLabel } : {}),
    });
  }
  return out;
}

export function parseScenarios(v: unknown): { id: string; title: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { id: string; title: string }[] = [];
  for (const x of v) {
    const o = obj(x);
    if (o && typeof o.id === "string" && typeof o.title === "string")
      out.push({ id: o.id, title: o.title });
  }
  return out;
}

export function parseReadiness(v: unknown): Readiness | null {
  const o = obj(v);
  if (!o) return null;
  const launcherStatus = LAUNCHER.find((s) => s === o.launcherStatus);
  if (!launcherStatus) return null;
  const status =
    o.status === null ? null : (RUNTIME.find((s) => s === o.status) ?? null);
  const roster: RosterEntry[] = [];
  for (const x of Array.isArray(o.roster) ? o.roster : []) {
    const r = obj(x);
    if (!r || typeof r.roleId !== "string") continue;
    roster.push({
      roleId: r.roleId,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      joined: r.joined === true,
      consented: r.consented === true,
      connected: r.connected === true,
      ...(r.ai === true ? { ai: true as const } : {}),
    });
  }
  return {
    launcherStatus,
    status,
    modelLabel: typeof o.modelLabel === "string" ? o.modelLabel : null,
    roster,
    canStart: o.canStart === true,
    missing: Array.isArray(o.missing)
      ? o.missing.filter((m): m is string => typeof m === "string")
      : [],
    aiWaiting: Array.isArray(o.aiWaiting)
      ? o.aiWaiting.filter((m): m is string => typeof m === "string")
      : [],
    includeInGroup: o.includeInGroup !== false,
  };
}

/** Splits the roles a start still waits for into humans and AI players, by the roster's `ai` flag (never by a name); AI roles keep their order, once each. */
export function splitWaiting(roster: readonly RosterEntry[], missing: readonly string[], aiWaiting: readonly string[]): { humans: string[]; ai: string[] } {
  const aiSeats = new Set(roster.filter((e) => e.ai === true).map((e) => e.roleId));
  return {
    humans: missing.filter((m) => !aiSeats.has(m)),
    ai: [...new Set([...aiWaiting, ...missing.filter((m) => aiSeats.has(m))])],
  };
}

/** A short session id label: the first 8 characters. */
export const shortId = (id: string): string => id.slice(0, 8);

export const CONSOLE_COPY = {
  signedOut: "You have been signed out. Sign in again.",
  unreachable: "The session service is not reachable. Try again.",
  capacity:
    "The maximum number of sessions is running. End one, then try again.",
  conflict: "That action is not possible in the session's current state.",
  notFound: "That session was not found.",
  startTimeout:
    "The session did not confirm the start. Check the lobby, then try again.",
  notReady: "Not everyone has joined and consented yet.",
  aiNotConnected: "AI player not connected yet:",
  started: "The session has started.",
} as const;

/** A failed call as one plain sentence for the facilitator (never the server's own text). */
export function failureText(r: Extract<ApiResult, { ok: false }>): string {
  if (r.status === 0) return CONSOLE_COPY.unreachable;
  if (r.status === 401 || r.status === 403) return CONSOLE_COPY.signedOut;
  if (r.status === 404) return CONSOLE_COPY.notFound;
  if (r.status === 409) return CONSOLE_COPY.conflict;
  if (r.status === 429) return CONSOLE_COPY.capacity;
  if (r.status === 504) return CONSOLE_COPY.startTimeout;
  if (r.status === 502 || r.status === 503) return CONSOLE_COPY.unreachable;
  return MESSAGES.generic;
}

// ---- participant report links (console) ----

export type ReportLink = { role: string; createdAt: number; expiresAt: number; lastUsedAt?: number; active: boolean; revoked: boolean };
/** Criteria a draft player has rated out of all criteria. */
export type RatedCount = { rated: number; total: number };
/** `draft`: the report is not released yet. `selfRated` is null for a released role and when the counts cannot be read. */
export type ReportLinkRole = { role: string; link: ReportLink | null; selfRated: RatedCount | null; draft: boolean; ai: boolean };
/** `players` is null when the counts cannot be read. */
export type ReportLinksView = { state: "ready" | "not_ready" | "unavailable"; players: RatedCount | null; roles: ReportLinkRole[] };

/** The fixed sentence for a session with nothing released yet (the same words the control service uses: NOT_READY in services/control/src/reports.ts, also listed in KNOWN_CONFLICTS in report-handlers.ts). */
export const REPORT_NOT_READY =
  "No reports are ready for this session yet. Evaluate it from the Report panel of its console.";
export const REPORT_UNAVAILABLE = "The reports for this session cannot be read. Check them with moderate status.";
/** US-0060: the refusal for an AI role (AI_LINK_REFUSED in services/control/src/reports.ts, also listed in KNOWN_CONFLICTS in report-handlers.ts; change all copies together). */
export const REPORT_AI_LINK_REFUSED = "AI players do not get report links.";

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseReportLink(role: string, v: unknown): ReportLink | null {
  const o = obj(v);
  if (!o || !num(o.createdAt) || !num(o.expiresAt)) return null;
  return {
    role,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    ...(num(o.lastUsedAt) ? { lastUsedAt: o.lastUsedAt } : {}),
    active: o.active === true,
    revoked: o.revoked === true,
  };
}

function parseCount(v: unknown): RatedCount | null {
  const o = obj(v);
  if (!o) return null;
  const { rated, total } = o;
  if (typeof rated !== "number" || typeof total !== "number" || !Number.isInteger(rated) || !Number.isInteger(total)) return null;
  return rated >= 0 && rated <= total ? { rated, total } : null;
}

export function parseReportLinks(v: unknown): ReportLinksView | null {
  const o = obj(v);
  if (!o) return null;
  const state = (["ready", "not_ready", "unavailable"] as const).find((s) => s === o.state);
  if (!state) return null;
  const roles: ReportLinkRole[] = [];
  for (const x of Array.isArray(o.roles) ? o.roles : []) {
    const r = obj(x);
    if (!r || typeof r.role !== "string") continue;
    roles.push({ role: r.role, link: r.credential === null || r.credential === undefined ? null : parseReportLink(r.role, r.credential), selfRated: parseCount(r.selfRated), draft: r.draft === true, ai: r.ai === true });
  }
  return { state, players: parseCount(o.players), roles };
}

/** The one-time token from an issue or reissue answer; null when the answer is not shaped like one. */
export function parseIssuedToken(v: unknown): string | null {
  const o = obj(v);
  return o && typeof o.token === "string" && o.token.length > 0 ? o.token : null;
}

const linksPath = (sessionId: string) => `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/report-links`;

export const fetchReportLinks = (sessionId: string, f?: typeof fetch) => getJson(linksPath(sessionId), f);
export const issueReportLink = (sessionId: string, role: string, f?: typeof fetch) => postJson(linksPath(sessionId), { role }, f);
export const reportLinkAction = (sessionId: string, role: string, action: "reissue" | "revoke", f?: typeof fetch) =>
  postJson(`${linksPath(sessionId)}/${encodeURIComponent(role)}`, { action }, f);

// ---- the facilitator's evaluate and review (US-0064) ----
// The BFF has checked these shapes already (src/server/launcher-client.ts); they are checked again here because the browser trusts nothing
// from the network. Anything that does not fit is null (the panel shows a fixed sentence). Text is shown as text.

export type ReportStage = "not_ended" | "not_evaluated" | "evaluating" | "failed" | "ready_to_open" | "in_review";
export type ReportJobReason = "interrupted" | "timeout" | "cancelled" | "error";
export type ReportJobView = { state: "idle" | "running" | "done" | "failed"; reason?: ReportJobReason; progress: string[]; modelCalls: number | null };
export type ReportSubjectState = "draft" | "released" | "amending" | "withdrawn";
export type ReportSubjectRow = {
  id: string; state: ReportSubjectState; openCriteria: string[]; openDisputes: number; summaryStale: boolean; tableStale: boolean;
  /** False when the evaluation of this subject failed: every criterion is then scored by hand. */
  evaluationOk: boolean;
  /** Criteria release requires to be scored by hand (edited); accepting them does not unblock it. */
  scoreByHand: string[];
};
export type ReportRunSummaryView = {
  npcReplies: number; fallbackReplies: number; scenesEndedByGm: number;
  byCharacter: { roleId: string; name: string; replies: number; fallbackReplies: number }[];
  alerts: { level: "info" | "warning"; role: string | null; fallback: boolean; reason: string }[];
};
export type ReportOverviewView = { stage: ReportStage; job: ReportJobView; upTo: number | null; orphan: boolean; summary: ReportRunSummaryView | null; subjects: ReportSubjectRow[] };
export type ReportLevel = 1 | 2 | 3 | 4 | null;
export type ReportCriterion = {
  id: string; name: string; current: ReportLevel | "invalid"; status: "needs_review" | "accepted" | "edited" | "clear"; rationale: string;
  evidence: { quote: string; scene?: string }[]; flags: string[]; selfLevel?: ReportLevel;
};
export type ReportSubjectDetail = {
  id: string; state: ReportSubjectState; criteria: ReportCriterion[];
  summary: { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] };
  comments: { visibility: "internal" | "feedback"; text: string; criterion?: string }[];
  /** The participants' responses; a dispute is open until it has a resolution. */
  responses: ReportResponse[];
  /** The log sequence numbers of this subject's releases, oldest first. */
  versions: number[];
};
export type ReportResponse = { seq: number; role: string; text: string; criterion?: string; dispute: boolean; resolution?: { outcome: string; reason: string } };
export type ResolveOutcome = "upheld" | "amended" | "declined";
/** What an edit names as the level it expects to replace (`--expect`): the level the form showed. */
export type ReportExpect = "1" | "2" | "3" | "4" | "na" | "invalid";

const str = (v: unknown): v is string => typeof v === "string";
const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every(str);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const lvl = (v: unknown): v is ReportLevel => v === null || v === 1 || v === 2 || v === 3 || v === 4;
const pick = <T extends string>(all: readonly T[], v: unknown): T | undefined => all.find((x) => x === v);
/** Every element through `f`; null when the value is not a list or one element does not fit. */
function each<T>(v: unknown, f: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v)) return null;
  const out: T[] = [];
  for (const x of v) {
    const y = f(x);
    if (y === null) return null;
    out.push(y);
  }
  return out;
}
const SUBJECT_STATES = ["draft", "released", "amending", "withdrawn"] as const;

function parseJob(v: unknown): ReportJobView | null {
  const o = obj(v);
  const state = pick(["idle", "running", "done", "failed"] as const, o?.state);
  if (!o || !state || !strs(o.progress) || !(o.modelCalls === null || count(o.modelCalls))) return null;
  const reason = pick(["interrupted", "timeout", "cancelled", "error"] as const, o.reason);
  if (o.reason !== undefined && !reason) return null;
  return { state, progress: o.progress, modelCalls: o.modelCalls, ...(reason ? { reason } : {}) };
}

function parseRow(v: unknown): ReportSubjectRow | null {
  const o = obj(v);
  const state = pick(SUBJECT_STATES, o?.state);
  if (!o || !str(o.id) || !state || !strs(o.openCriteria) || !Array.isArray(o.openDisputes)) return null;
  if (typeof o.summaryStale !== "boolean" || typeof o.tableStale !== "boolean" || typeof o.evaluationOk !== "boolean" || !strs(o.scoreByHand)) return null;
  return {
    id: o.id, state, openCriteria: o.openCriteria, openDisputes: o.openDisputes.length, summaryStale: o.summaryStale, tableStale: o.tableStale,
    evaluationOk: o.evaluationOk, scoreByHand: o.scoreByHand,
  };
}

function parseSummary(v: unknown): ReportRunSummaryView | null {
  const o = obj(v);
  if (!o || !count(o.npcReplies) || !count(o.fallbackReplies) || !count(o.scenesEndedByGm)) return null;
  const byCharacter = each(o.byCharacter, (x) => {
    const c = obj(x);
    return c && str(c.roleId) && str(c.name) && count(c.replies) && count(c.fallbackReplies) ? { roleId: c.roleId, name: c.name, replies: c.replies, fallbackReplies: c.fallbackReplies } : null;
  });
  const alerts = each(o.alerts, (x) => {
    const a = obj(x);
    const level = pick(["info", "warning"] as const, a?.level);
    return a && level && (a.role === null || str(a.role)) && typeof a.fallback === "boolean" && str(a.reason) ? { level, role: a.role, fallback: a.fallback, reason: a.reason } : null;
  });
  return byCharacter && alerts ? { npcReplies: o.npcReplies, fallbackReplies: o.fallbackReplies, scenesEndedByGm: o.scenesEndedByGm, byCharacter, alerts } : null;
}

export function parseReportOverview(v: unknown): ReportOverviewView | null {
  const o = obj(v);
  const stage = pick(["not_ended", "not_evaluated", "evaluating", "failed", "ready_to_open", "in_review"] as const, o?.stage);
  if (!o || !stage || typeof o.orphan !== "boolean") return null;
  const job = parseJob(o.job);
  const c = obj(o.confirm);
  if (!job || !(o.confirm === null || (c && count(c.upTo)))) return null;
  const summary = o.summary === null ? null : parseSummary(o.summary);
  if (o.summary !== null && summary === null) return null;
  const subjects = each(o.subjects, parseRow);
  if (!subjects) return null;
  return { stage, job, upTo: c && count(c.upTo) ? c.upTo : null, orphan: o.orphan, summary, subjects };
}

export function parseReportSubject(v: unknown): ReportSubjectDetail | null {
  const o = obj(v);
  const state = pick(SUBJECT_STATES, o?.state);
  const sm = obj(o?.summary);
  if (!o || !str(o.id) || !state || !sm || !strs(sm.strengths) || !strs(sm.developments)) return null;
  const criteria = each(o.criteria, (x): ReportCriterion | null => {
    const c = obj(x);
    const status = pick(["needs_review", "accepted", "edited", "clear"] as const, c?.status);
    if (!c || !str(c.id) || !str(c.name) || !status || !(lvl(c.current) || c.current === "invalid") || !str(c.rationale) || !strs(c.flags)) return null;
    if (!(c.selfLevel === undefined || lvl(c.selfLevel))) return null;
    const evidence = each(c.evidence, (e) => {
      const q = obj(e);
      return q && str(q.quote) && (q.scene === undefined || str(q.scene)) ? { quote: q.quote, ...(str(q.scene) ? { scene: q.scene } : {}) } : null;
    });
    if (!evidence) return null;
    return { id: c.id, name: c.name, current: c.current as ReportLevel | "invalid", status, rationale: c.rationale, evidence, flags: c.flags, ...(c.selfLevel !== undefined ? { selfLevel: c.selfLevel as ReportLevel } : {}) };
  });
  const actions = each(sm.actions, (x) => {
    const a = obj(x);
    return a && str(a.lo) && str(a.text) ? { lo: a.lo, text: a.text } : null;
  });
  const comments = each(o.comments, (x) => {
    const c = obj(x);
    const visibility = pick(["internal", "feedback"] as const, c?.visibility);
    return c && visibility && str(c.text) && (c.criterion === undefined || str(c.criterion)) ? { visibility, text: c.text, ...(str(c.criterion) ? { criterion: c.criterion } : {}) } : null;
  });
  const responses = each(o.responses, (x): ReportResponse | null => {
    const r = obj(x);
    if (!r || !count(r.seq) || !str(r.role) || !str(r.text) || typeof r.dispute !== "boolean" || !(r.criterion === undefined || str(r.criterion))) return null;
    const res = obj(r.resolution);
    if (r.resolution !== undefined && !(res && str(res.outcome) && str(res.reason))) return null;
    return {
      seq: r.seq, role: r.role, text: r.text, dispute: r.dispute, ...(str(r.criterion) ? { criterion: r.criterion } : {}),
      ...(res && str(res.outcome) && str(res.reason) ? { resolution: { outcome: res.outcome, reason: res.reason } } : {}),
    };
  });
  const versions = each(o.versions, (x) => (count(x) ? x : null));
  if (!criteria || !actions || !comments || !responses || !versions) return null;
  return { id: o.id, state, criteria, summary: { strengths: sm.strengths, developments: sm.developments, actions }, comments, responses, versions };
}

/** The level a criterion shows, as the edit's `expect`. */
export const expectOf = (current: ReportLevel | "invalid"): ReportExpect => (current === null ? "na" : current === "invalid" ? "invalid" : (String(current) as ReportExpect));

/** A failed report call as one fixed sentence: by the BFF's closed code (never its text), else by status. */
export function reportFailureText(r: Extract<ApiResult, { ok: false }>): string {
  if (Object.hasOwn(REPORT_REFUSALS, r.code)) return REPORT_REFUSALS[r.code as ReportRefusal];
  if (r.code === "bad_request") return REPORT_REFUSALS.invalid;
  if (r.status === 429) return REPORT_CONSOLE.throttled;
  return failureText(r);
}

const reportPath = (sessionId: string) => `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/report`;
const subjectPath = (sessionId: string, subject: string) => `${reportPath(sessionId)}/subjects/${encodeURIComponent(subject)}`;

export const fetchReportOverview = (sessionId: string, f?: typeof fetch) => getJson(reportPath(sessionId), f);
export const startEvaluate = (sessionId: string, confirmedCalls: number, by: string, f?: typeof fetch) => postJson(`${reportPath(sessionId)}/evaluate`, { confirmedCalls, by }, f);
export const cancelEvaluate = (sessionId: string, f?: typeof fetch) => postJson(`${reportPath(sessionId)}/evaluate/cancel`, {}, f);
export const openReview = (sessionId: string, by: string, f?: typeof fetch) => postJson(`${reportPath(sessionId)}/open`, { by }, f);
export const fetchReportSubject = (sessionId: string, subject: string, f?: typeof fetch) => getJson(subjectPath(sessionId, subject), f);
export const editCriterion = (
  sessionId: string, subject: string, b: { criterion: string; level: ReportLevel; reason: string; rationale?: string; expect: ReportExpect; by: string }, f?: typeof fetch,
) => postJson(`${subjectPath(sessionId, subject)}/edit`, b, f);
export const acceptItem = (sessionId: string, subject: string, b: { criterion: string; by: string } | { summary: true; by: string }, f?: typeof fetch) =>
  postJson(`${subjectPath(sessionId, subject)}/accept`, b, f);
export const commentOn = (sessionId: string, subject: string, b: { text: string; criterion?: string; feedback?: true; by: string }, f?: typeof fetch) =>
  postJson(`${subjectPath(sessionId, subject)}/comment`, b, f);
/** Replaces the WHOLE summary (a list sent empty is cleared), so all three lists are always sent. An action is `{ lo, text }`. */
export const editSummary = (
  sessionId: string, subject: string,
  input: { reason: string; strengths: string[]; developments: string[]; actions: { lo: string; text: string }[]; by: string }, f?: typeof fetch,
): Promise<ApiResult> =>
  postJson(`${subjectPath(sessionId, subject)}/edit-summary`, {
    reason: input.reason, strengths: input.strengths, developments: input.developments,
    actions: input.actions.map((a) => ({ lo: a.lo, text: a.text })), by: input.by,
  }, f);

// ---- release and after (US-0064, part B) ----

/** A safe subject id, as the BFF checks it (a role, `group`). */
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A release answer: the subjects released and whether the released group's per-role table is now out of date. Null when it does not fit. */
export function parseReleased(v: unknown): { released: string[]; groupTableStale: boolean } | null {
  const o = obj(v);
  if (!o || !strs(o.released) || !o.released.every((x) => SUBJECT_ID.test(x)) || typeof o.groupTableStale !== "boolean") return null;
  return { released: o.released, groupTableStale: o.groupTableStale };
}


/** The subject ids of a `blocked` release refusal (safe ids only, at most 50); empty for any other answer. */
export function blockedOf(r: Extract<ApiResult, { ok: false }>): string[] {
  const d = obj(r.data);
  if (r.code !== "blocked" || !d || !Array.isArray(d.blocked)) return [];
  return d.blocked.filter((x): x is string => str(x) && SUBJECT_ID.test(x)).slice(0, 50);
}

/** An explicit, non-empty list of subjects: the server refuses an empty list and has no `all` flag. */
export const releaseSubjects = (sessionId: string, subjects: string[], by: string, f?: typeof fetch) => postJson(`${reportPath(sessionId)}/release`, { subjects, by }, f);
export const amendSubject = (sessionId: string, subject: string, reason: string, by: string, f?: typeof fetch) =>
  postJson(`${subjectPath(sessionId, subject)}/amend`, { reason, by }, f);
export const withdrawSubject = (sessionId: string, subject: string, reason: string, by: string, f?: typeof fetch) =>
  postJson(`${subjectPath(sessionId, subject)}/withdraw`, { reason, by }, f);
export const resolveDispute = (sessionId: string, b: { seq: number; outcome: ResolveOutcome; reason: string; by: string }, f?: typeof fetch) =>
  postJson(`${reportPath(sessionId)}/resolve`, b, f);
/** The export is a POST (it records the export first); the answer is the Markdown text to save, never to render. */
export const exportReport = (sessionId: string, b: { subject: string; audience: "facilitator" | `participant:${string}`; by: string }, f?: typeof fetch) =>
  postForFile(`${reportPath(sessionId)}/export`, b, f);
