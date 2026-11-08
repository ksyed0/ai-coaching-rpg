import { CLIENT_ID_MAX_CHARS, isFileSafeId, isSafeId, isScenarioId, isValidSessionId } from "@acr/events";

// The BFF's client for the control service (services/control: loopback HTTP, header `x-service-token`, envelope {success, data, error}).
// Every failure becomes a LauncherError whose `reason` is one word from a closed set. The server's own message text is never passed on
// (the BFF shows its own plain messages), and neither the token nor the launcher URL is ever put into an error, a log line or a URL.

export type LauncherReason =
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "capacity"
  | "bad_request"
  | "timeout"
  | "failed"
  | "ai_role"
  | "ai_notice"
  | "ai_started"
  | "ai_no_human"
  | "ai_too_many"
  | "ai_invalid"
  | "ai_busy"
  | "ai_budget"
  | "ai_absent"
  | "ai_expired"
  | "busy"
  // The facilitator's evaluate and review calls (US-0064): control's closed codes, one word each.
  | "invalid"
  | "not_ended"
  | "already_evaluated"
  | "already_running"
  | "too_many_running"
  | "confirm_mismatch"
  | "orphan"
  | "no_review"
  | "unknown_criterion"
  | "unknown_subject"
  | "stale"
  | "blocked"
  | "not_released"
  | "not_editable"
  | "superseded"
  | "needs_amend"
  | "refused";

/** A failed call to the control service. The message repeats only the reason word. */
export class LauncherError extends Error {
  /** `detail`: the control service's own sentence, kept only for the report-link calls (the caller checks it against a closed list). */
  constructor(readonly reason: LauncherReason, readonly detail?: string, /** The subject ids of a `blocked` refusal (safe ids only). */ readonly blocked?: string[]) {
    super(`launcher: ${reason}`);
    this.name = "LauncherError";
  }
}

export type SessionInfo = {
  sessionId: string;
  scenarioId: string;
  status: "running" | "stopped" | "ended";
  port?: number;
  modelLabel?: string;
  /** Whether AI players' scores count in the group score (US-0061); absent when the control service did not say. */
  includeInGroup?: boolean;
};
export type RoleCode = { roleId: string; code: string };
/** One line of an AI player's intent log, as the control service returns it (US-0060). */
export type IntentEntry = {
  ts: number;
  sceneId: string | null;
  trigger: "reply" | "nudge" | "prompt";
  outcome: "spoken" | "skipped" | "dropped";
  reason?: "model_failed" | "timeout" | "unusable" | "budget";
  hint?: string;
};
const MAX_INTENT_ENTRIES = 50;
const MAX_HINT_POINTS = 300;
const TRIGGERS: readonly string[] = ["reply", "nudge", "prompt"];
const OUTCOMES: readonly string[] = ["spoken", "skipped", "dropped"];
const REASONS: readonly string[] = ["model_failed", "timeout", "unusable", "budget"];
/** A report link as the console may see it: never the credential id, the token or the secret. */
export type ReportLinkInfo = { role: string; createdAt: number; expiresAt: number; revokedAt?: number; lastUsedAt?: number };
export type ReportLinksState = "ready" | "not_ready" | "unavailable";
/** How many criteria a draft player has rated; null for a released role and when the counts cannot be read. */
export type SelfRated = { rated: number; total: number };
export type ReportLinkRow = { role: string; credential: ReportLinkInfo | null; selfRated: SelfRated | null; draft: boolean; ai?: true };
/** Players with at least one rating out of draft players; null when the counts cannot be read. */
export type PlayersSummary = SelfRated;
export type IssuedReportLink = { credential: ReportLinkInfo; token: string };
export type ReportExchange = { credentialId: string; sessionId: string; role: string; expiresAt: number };
/** The blind self-assessment form of a draft report (the fields of the runtime's `FormResult` form kind). */
export type SelfAssessForm = {
  criteria: { id: string; name: string }[];
  scale: { level: number; label: string; meaning: string }[];
  existing: Record<string, { level: 1 | 2 | 3 | 4 | "na"; note?: string }>;
};
export type ReportRead =
  | { state: "released"; view: Record<string, unknown> }
  | ({ state: "self_assess" } & SelfAssessForm)
  | { state: "not_released" }
  | { state: "closed" }
  | { state: "old_schema" };
/** A participant write's outcome (ratings or a response): a closed set read from control's status and `error.code`, never its text. */
/** `link_full`: this link has written its 25 responses (BUG-0030); a reissued link has a fresh budget. */
export type WriteState = "closed" | "not_released" | "withdrawn" | "too_many" | "link_full" | "old_schema" | "invalid" | "busy" | "too_large";
export type WriteOutcome = { state: "ok" } | { state: WriteState } | { state: "throttled"; retryAfterMs: number };
export type RatingInput = { criterion: string; level: unknown; note?: string };
export type ResponseInput = { criterion?: string; text: string; dispute?: boolean };
export type CreatedSession = {
  sessionId: string;
  status: "running";
  port: number;
  modelLabel: string;
  codes: RoleCode[];
};

const DEFAULT_TIMEOUT_MS = 5_000;
/** A create against a hung child can take the child's ready timeout plus two grace periods (ruling R10). */
const DEFAULT_LONG_TIMEOUT_MS = 120_000;
/** A participant write waits out control's retry window and its per-session queue. */
const WRITE_TIMEOUT_MS = 15_000;
/** The evaluate and review calls wait out control's lock retries (about 1.5 s) and its per-session queue. */
const REPORT_CALL_TIMEOUT_MS = 15_000;
/** The most subject ids kept from a `blocked` refusal. */
const MAX_BLOCKED = 64;
const CONFLICT_STATES: ReadonlySet<string> = new Set(["closed", "not_released", "withdrawn", "too_many", "link_full", "old_schema"]);
/** Far above any real answer. The body is buffered whole (`res.text()`) before this is checked, so it bounds what we parse, not what we read; the control service is a trusted internal service. */
const MAX_RESPONSE_CHARS = 1024 * 1024;
/**
 * A released report (structured view plus the rendered markdown of the participant's and the group's report) is the one answer that can
 * be large, so `readReport` alone gets a higher cap. 4 MiB is a safety limit well above a real report, not a size we expect.
 */
export const MAX_REPORT_RESPONSE_CHARS = 4 * 1024 * 1024;
/** The longest control sentence kept as `detail`. */
const MAX_DETAIL_CHARS = 300;
/** A credential id as it goes into a path: base64url only. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The control service's ControlError / API codes. Anything else is generic. */
const BY_CODE: Record<string, LauncherReason> = {
  unauthorized: "unauthorized",
  bad_request: "bad_request",
  unknown_scenario: "bad_request",
  payload_too_large: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  capacity: "capacity",
  timeout: "timeout",
  start_failed: "failed",
  unavailable: "unavailable",
  internal: "failed",
  ai_role: "ai_role",
  ai_notice: "ai_notice",
  ai_started: "ai_started",
  ai_no_human: "ai_no_human",
  ai_too_many: "ai_too_many",
  ai_invalid: "ai_invalid",
  ai_busy: "ai_busy",
  ai_budget: "ai_budget",
  ai_absent: "ai_absent",
  ai_expired: "ai_expired",
  busy: "busy",
  invalid: "invalid",
  not_ended: "not_ended",
  already_evaluated: "already_evaluated",
  already_running: "already_running",
  too_many_running: "too_many_running",
  confirm_mismatch: "confirm_mismatch",
  orphan: "orphan",
  no_review: "no_review",
  unknown_criterion: "unknown_criterion",
  unknown_subject: "unknown_subject",
  stale: "stale",
  blocked: "blocked",
  not_released: "not_released",
  not_editable: "not_editable",
  superseded: "superseded",
  needs_amend: "needs_amend",
  refused: "refused",
};
/** Used only when the answer has no readable error envelope. */
const BY_STATUS: Record<number, LauncherReason> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
  413: "bad_request",
  429: "capacity",
  503: "unavailable",
  504: "timeout",
};

// ---- shape checks (no schema library in this app) ----

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65_535;
const isStatus = (v: unknown): v is SessionInfo["status"] =>
  v === "running" || v === "stopped" || v === "ended";

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length <= CLIENT_ID_MAX_CHARS && isScenarioId(v);

const bad = (): never => {
  throw new LauncherError("failed");
};

function toRoleCodes(v: unknown): RoleCode[] {
  if (!Array.isArray(v)) return bad();
  return v.map((e) =>
    isObject(e) && isText(e.roleId) && isText(e.code)
      ? { roleId: e.roleId, code: e.code }
      : bad(),
  );
}
function toInfo(v: unknown): SessionInfo {
  if (
    !isObject(v) ||
    !isText(v.sessionId) ||
    !isText(v.scenarioId) ||
    !isStatus(v.status)
  )
    return bad();
  if (v.port !== undefined && !isPort(v.port)) return bad();
  if (v.modelLabel !== undefined && typeof v.modelLabel !== "string")
    return bad();
  return {
    sessionId: v.sessionId,
    scenarioId: v.scenarioId,
    status: v.status,
    ...(v.port !== undefined && { port: v.port }),
    ...(v.modelLabel !== undefined && { modelLabel: v.modelLabel }),
    ...(typeof v.includeInGroup === "boolean" && { includeInGroup: v.includeInGroup }),
  };
}

/** One entry, picked field by field; null for anything that is not a well-formed entry (an unknown word drops it). */
function toIntent(v: unknown): IntentEntry | null {
  if (!isObject(v)) return null;
  if (typeof v.ts !== "number" || !Number.isFinite(v.ts)) return null;
  if (v.sceneId !== null && !isId(v.sceneId)) return null;
  if (typeof v.trigger !== "string" || !TRIGGERS.includes(v.trigger)) return null;
  if (typeof v.outcome !== "string" || !OUTCOMES.includes(v.outcome)) return null;
  if (v.reason !== undefined && (typeof v.reason !== "string" || !REASONS.includes(v.reason))) return null;
  if (v.hint !== undefined && typeof v.hint !== "string") return null;
  return {
    ts: v.ts,
    sceneId: v.sceneId,
    trigger: v.trigger as IntentEntry["trigger"],
    outcome: v.outcome as IntentEntry["outcome"],
    ...(v.reason !== undefined && { reason: v.reason as NonNullable<IntentEntry["reason"]> }),
    ...(v.hint !== undefined && { hint: Array.from(v.hint).slice(0, MAX_HINT_POINTS).join("") }),
  };
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
function toCount(v: unknown): SelfRated {
  if (!isObject(v) || !isCount(v.rated) || !isCount(v.total)) return bad();
  return { rated: v.rated, total: v.total };
}

/** The form fields of a self_assess answer, picked field by field; anything that does not fit fails closed. */
function toForm(d: Record<string, unknown>): SelfAssessForm {
  if (!Array.isArray(d.criteria) || !Array.isArray(d.scale) || !isObject(d.existing)) return bad();
  const criteria = d.criteria.map((c) => (isObject(c) && isText(c.id) && typeof c.name === "string" ? { id: c.id, name: c.name } : bad()));
  const scale = d.scale.map((c) =>
    isObject(c) && typeof c.level === "number" && Number.isFinite(c.level) && typeof c.label === "string" && typeof c.meaning === "string"
      ? { level: c.level, label: c.label, meaning: c.meaning }
      : bad(),
  );
  // Control (and the runtime) store Not observed as `level: null`; the page's own form type calls it "na". A literal "na" is accepted too.
  const entries = Object.entries(d.existing).map(([k, v]) => {
    if (!isObject(v) || !(v.level === 1 || v.level === 2 || v.level === 3 || v.level === 4 || v.level === "na" || v.level === null)) return bad();
    if (v.note !== undefined && typeof v.note !== "string") return bad();
    return [k, { level: v.level === null ? ("na" as const) : v.level, ...(v.note !== undefined ? { note: v.note } : {}) }] as const;
  });
  const existing: SelfAssessForm["existing"] = Object.fromEntries(entries); // own keys only; a key such as __proto__ stays a plain data key
  return { criteria, scale, existing };
}

/** Picked field by field, so the credential's id (and anything else) is dropped here and can never be forwarded by mistake. */
function toReportLink(v: unknown): ReportLinkInfo {
  if (!isObject(v) || !isId(v.role) || !isTime(v.createdAt) || !isTime(v.expiresAt)) return bad();
  if (v.revokedAt !== undefined && !isTime(v.revokedAt)) return bad();
  if (v.lastUsedAt !== undefined && !isTime(v.lastUsedAt)) return bad();
  return {
    role: v.role,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    ...(v.revokedAt !== undefined && { revokedAt: v.revokedAt }),
    ...(v.lastUsedAt !== undefined && { lastUsedAt: v.lastUsedAt }),
  };
}
function toIssued(d: unknown): IssuedReportLink {
  if (!isObject(d) || !isText(d.token)) return bad();
  return { credential: toReportLink(d.credential), token: d.token };
}

// ---- the facilitator's evaluate and review (US-0064) ----

export type ReportJobState = "idle" | "running" | "done" | "failed";
export type ReportJobReason = "interrupted" | "timeout" | "cancelled" | "error";
/** The job as the browser may see it: control's `outputDir` (a folder name on the server) is checked and then dropped here. */
export type ReportJob = { state: ReportJobState; reason?: ReportJobReason; startedAt: number | null; progress: string[]; modelCalls: number | null };
export type ReportStage = "not_ended" | "not_evaluated" | "evaluating" | "failed" | "ready_to_open" | "in_review";
export type SubjectState = "draft" | "released" | "amending" | "withdrawn";
export type SubjectStatusRow = {
  id: string; state: SubjectState; version: number | null; criteriaTotal: number; openCriteria: string[]; summaryStale: boolean; tableStale: boolean;
  evaluationOk: boolean;
  /** Criteria release requires to be scored by hand (an evaluation that failed, or an invalid level): accepting them does not unblock it. */
  scoreByHand: string[];
  selfRated: number; openDisputes: { seq: number; role: string; criterion: string | null }[];
};
export type ReportRunSummary = {
  npcReplies: number; fallbackReplies: number; scenesEndedByGm: number;
  byCharacter: { roleId: string; name: string; replies: number; fallbackReplies: number }[];
  alerts: { seq: number; level: "info" | "warning"; role: string | null; fallback: boolean; reason: string; replySeq: number | null }[];
};
export type ReportOverview = {
  stage: ReportStage; job: ReportJob; confirm: { upTo: number } | null; orphan: boolean; summary: ReportRunSummary | null; subjects: SubjectStatusRow[];
  /** US-0068: the session's AI player roles (in_review only, display only); absent when control did not send a well-made list. */
  aiRoles?: string[];
};
export type CriterionLevel = 1 | 2 | 3 | 4 | null;
export type SubjectView = {
  id: string; state: SubjectState;
  criteria: { id: string; name: string; current: CriterionLevel | "invalid"; status: "needs_review" | "accepted" | "edited" | "clear"; rationale: string; evidence: { quote: string; scene?: string }[]; flags: string[]; selfLevel?: CriterionLevel }[];
  summary: { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] };
  objectives: { id: string; label: string }[];
  comments: { visibility: "internal" | "feedback"; text: string; criterion?: string }[];
  responses: { seq: number; role: string; text: string; criterion?: string; dispute: boolean; resolution?: { outcome: string; reason: string } }[];
  versions: number[];
};
export type ReportEditInput = { criterion: string; level: CriterionLevel; reason: string; rationale?: string; expect: "1" | "2" | "3" | "4" | "na" | "invalid"; by: string };
export type ReportAcceptInput = { criterion?: string; summary?: true; by: string };
export type ReportCommentInput = { text: string; criterion?: string; feedback?: boolean; by: string };
export type ReportEditSummaryInput = { reason: string; strengths?: string[]; developments?: string[]; actions?: { lo: string; text: string }[]; by: string };

const JOB_STATES: readonly string[] = ["idle", "running", "done", "failed"];
const JOB_REASONS: readonly string[] = ["interrupted", "timeout", "cancelled", "error"];
const STAGES: readonly string[] = ["not_ended", "not_evaluated", "evaluating", "failed", "ready_to_open", "in_review"];
const SUBJECT_STATES: readonly string[] = ["draft", "released", "amending", "withdrawn"];
const CRITERION_STATUSES: readonly string[] = ["needs_review", "accepted", "edited", "clear"];
const VISIBILITIES: readonly string[] = ["internal", "feedback"];
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
/** Control keeps the newest 50 progress lines (PROGRESS_MAX in services/control/src/report-job.ts), each a short fixed sentence. */
const MAX_PROGRESS = 50;
const MAX_PROGRESS_CHARS = 200;
const isProgress = (v: unknown): v is string[] => isStrings(v) && v.length <= MAX_PROGRESS && v.every((l) => l.length <= MAX_PROGRESS_CHARS);
const isFileIds = (v: unknown): v is string[] => isStrings(v) && v.every(isFileSafeId);
const isLevel = (v: unknown): v is CriterionLevel => v === null || v === 1 || v === 2 || v === 3 || v === 4;
const list = <T,>(v: unknown, pick: (e: unknown) => T): T[] => (Array.isArray(v) ? v.map(pick) : bad());
const orNull = <T,>(v: unknown, pick: (e: unknown) => T): T | null => (v === null ? null : pick(v));

function toJob(v: unknown): ReportJob {
  if (!isObject(v) || !isStr(v.state) || !JOB_STATES.includes(v.state) || !(v.startedAt === null || isTime(v.startedAt)) || !isProgress(v.progress)) return bad();
  if (!(v.modelCalls === null || isCount(v.modelCalls)) || !(v.outputDir === null || (isStr(v.outputDir) && /^[A-Za-z0-9_-]{1,128}$/.test(v.outputDir)))) return bad();
  if (v.reason !== undefined && (!isStr(v.reason) || !JOB_REASONS.includes(v.reason))) return bad();
  return {
    state: v.state as ReportJobState, startedAt: v.startedAt, progress: v.progress, modelCalls: v.modelCalls,
    ...(v.reason !== undefined && { reason: v.reason as ReportJobReason }),
  };
}
function toSubjectStatus(v: unknown): SubjectStatusRow {
  if (!isObject(v) || !isStr(v.id) || !isFileSafeId(v.id) || !isStr(v.state) || !SUBJECT_STATES.includes(v.state)) return bad();
  if (!(v.version === null || isCount(v.version)) || !isCount(v.criteriaTotal) || !isFileIds(v.openCriteria) || !isCount(v.selfRated)) return bad();
  if (typeof v.summaryStale !== "boolean" || typeof v.tableStale !== "boolean" || typeof v.evaluationOk !== "boolean" || !isFileIds(v.scoreByHand)) return bad();
  return {
    id: v.id, state: v.state as SubjectState, version: v.version, criteriaTotal: v.criteriaTotal, openCriteria: v.openCriteria,
    summaryStale: v.summaryStale, tableStale: v.tableStale, evaluationOk: v.evaluationOk, scoreByHand: v.scoreByHand, selfRated: v.selfRated,
    openDisputes: list(v.openDisputes, (d) => (isObject(d) && isCount(d.seq) && isStr(d.role) && (d.criterion === null || isStr(d.criterion)) ? { seq: d.seq, role: d.role, criterion: d.criterion } : bad())),
  };
}
function toRunSummary(v: unknown): ReportRunSummary {
  if (!isObject(v) || !isCount(v.npcReplies) || !isCount(v.fallbackReplies) || !isCount(v.scenesEndedByGm)) return bad();
  return {
    npcReplies: v.npcReplies, fallbackReplies: v.fallbackReplies, scenesEndedByGm: v.scenesEndedByGm,
    byCharacter: list(v.byCharacter, (c) => (isObject(c) && isStr(c.roleId) && isStr(c.name) && isCount(c.replies) && isCount(c.fallbackReplies) ? { roleId: c.roleId, name: c.name, replies: c.replies, fallbackReplies: c.fallbackReplies } : bad())),
    alerts: list(v.alerts, (a) =>
      isObject(a) && isCount(a.seq) && (a.level === "info" || a.level === "warning") && (a.role === null || isStr(a.role)) && typeof a.fallback === "boolean" && isStr(a.reason) && (a.replySeq === null || isCount(a.replySeq))
        ? { seq: a.seq, level: a.level, role: a.role, fallback: a.fallback, reason: a.reason, replySeq: a.replySeq }
        : bad()),
  };
}
/** Control sends at most this many AI roles (AI_ROLES_MAX in services/control/src/moderation.ts). */
const MAX_AI_ROLES = 64;
/**
 * US-0068: a copy of a well-made `aiRoles` (distinct file-safe ids, at most MAX_AI_ROLES), else undefined. Unlike the rest of the
 * overview a malformed list is DROPPED, never `bad()`: the row it feeds is display only and must not take the Report panel down.
 */
function toAiRoles(v: unknown): string[] | undefined {
  if (!isFileIds(v) || v.length > MAX_AI_ROLES || new Set(v).size !== v.length) return undefined;
  return [...v];
}
function toOverview(v: unknown): ReportOverview {
  if (!isObject(v) || !isStr(v.stage) || !STAGES.includes(v.stage) || typeof v.orphan !== "boolean") return bad();
  const aiRoles = toAiRoles(v.aiRoles);
  return {
    stage: v.stage as ReportStage, job: toJob(v.job), orphan: v.orphan,
    confirm: orNull(v.confirm, (c) => (isObject(c) && isCount(c.upTo) ? { upTo: c.upTo } : bad())),
    summary: orNull(v.summary, toRunSummary),
    subjects: list(v.subjects, toSubjectStatus),
    ...(aiRoles && { aiRoles }),
  };
}
function toSubjectView(v: unknown): SubjectView {
  if (!isObject(v) || !isStr(v.id) || !isFileSafeId(v.id) || !isStr(v.state) || !SUBJECT_STATES.includes(v.state) || !isObject(v.summary)) return bad();
  const sm = v.summary;
  if (!isStrings(sm.strengths) || !isStrings(sm.developments) || !Array.isArray(v.versions) || !v.versions.every(isCount)) return bad();
  return {
    id: v.id, state: v.state as SubjectState,
    criteria: list(v.criteria, (c) => {
      if (!isObject(c) || !isStr(c.id) || !isFileSafeId(c.id) || !isStr(c.name) || !(isLevel(c.current) || c.current === "invalid") || !isStr(c.status) || !CRITERION_STATUSES.includes(c.status)) return bad();
      if (!isStr(c.rationale) || !isStrings(c.flags) || !(c.selfLevel === undefined || isLevel(c.selfLevel))) return bad();
      return {
        id: c.id, name: c.name, current: c.current, status: c.status as SubjectView["criteria"][number]["status"], rationale: c.rationale, flags: c.flags,
        evidence: list(c.evidence, (e) => (isObject(e) && isStr(e.quote) && (e.scene === undefined || isStr(e.scene)) ? { quote: e.quote, ...(e.scene !== undefined && { scene: e.scene }) } : bad())),
        ...(c.selfLevel !== undefined && { selfLevel: c.selfLevel }),
      };
    }),
    summary: { strengths: sm.strengths, developments: sm.developments, actions: list(sm.actions, (a) => (isObject(a) && isStr(a.lo) && isStr(a.text) ? { lo: a.lo, text: a.text } : bad())) },
    objectives: list(v.objectives, (o) => (isObject(o) && isStr(o.id) && isStr(o.label) ? { id: o.id, label: o.label } : bad())),
    comments: list(v.comments, (c) =>
      isObject(c) && isStr(c.visibility) && VISIBILITIES.includes(c.visibility) && isStr(c.text) && (c.criterion === undefined || isStr(c.criterion))
        ? { visibility: c.visibility as "internal" | "feedback", text: c.text, ...(c.criterion !== undefined && { criterion: c.criterion }) }
        : bad()),
    responses: list(v.responses, (r) => {
      if (!isObject(r) || !isCount(r.seq) || !isStr(r.role) || !isStr(r.text) || typeof r.dispute !== "boolean" || !(r.criterion === undefined || isStr(r.criterion))) return bad();
      if (r.resolution !== undefined && !(isObject(r.resolution) && isStr(r.resolution.outcome) && isStr(r.resolution.reason))) return bad();
      const res = r.resolution as { outcome: string; reason: string } | undefined;
      return {
        seq: r.seq, role: r.role, text: r.text, dispute: r.dispute,
        ...(r.criterion !== undefined && { criterion: r.criterion }),
        ...(res !== undefined && { resolution: { outcome: res.outcome, reason: res.reason } }),
      };
    }),
    versions: v.versions,
  };
}
/** The subject ids of a `blocked` refusal: safe ids only, at most MAX_BLOCKED; anything else is dropped. */
function toBlocked(data: unknown): string[] | undefined {
  if (!isObject(data) || !Array.isArray(data.blocked)) return undefined;
  return data.blocked.filter((x): x is string => isStr(x) && isSafeId(x)).slice(0, MAX_BLOCKED);
}

export type LauncherOptions = {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  longTimeoutMs?: number;
};

export class LauncherClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly longTimeoutMs: number;

  constructor(o: LauncherOptions) {
    this.base = o.baseUrl;
    this.token = o.token;
    this.fetchFn = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.longTimeoutMs = o.longTimeoutMs ?? DEFAULT_LONG_TIMEOUT_MS;
  }

  async scenarios(): Promise<{ id: string; title: string }[]> {
    const d = await this.call("GET", "/scenarios", undefined, this.timeoutMs);
    if (!Array.isArray(d)) return bad();
    return d.map((e) =>
      isObject(e) && isText(e.id) && typeof e.title === "string"
        ? { id: e.id, title: e.title }
        : bad(),
    );
  }

  async createSession(scenarioId: string): Promise<CreatedSession> {
    const d = await this.call(
      "POST",
      "/sessions",
      { scenarioId },
      this.longTimeoutMs,
    );
    if (!isObject(d)) return bad();
    const info = toInfo({ ...d, scenarioId: "-" });
    if (
      info.status !== "running" ||
      info.port === undefined ||
      typeof info.modelLabel !== "string"
    )
      return bad();
    return {
      sessionId: info.sessionId,
      status: "running",
      port: info.port,
      modelLabel: info.modelLabel,
      codes: toRoleCodes(d.codes),
    };
  }

  async sessions(): Promise<SessionInfo[]> {
    const d = await this.call("GET", "/sessions", undefined, this.timeoutMs);
    if (!Array.isArray(d)) return bad();
    return d.map(toInfo);
  }

  async session(id: string): Promise<SessionInfo> {
    return toInfo(
      await this.call(
        "GET",
        `/sessions/${this.id(id)}`,
        undefined,
        this.timeoutMs,
      ),
    );
  }

  /** The facilitator socket's port and token, always as one pair: they belong to the same start of the child. */
  async facilitator(id: string): Promise<{ port: number; token: string }> {
    const d = await this.call(
      "GET",
      `/sessions/${this.id(id)}/facilitator`,
      undefined,
      this.timeoutMs,
    );
    if (!isObject(d) || !isPort(d.port) || !isText(d.token)) return bad();
    return { port: d.port, token: d.token };
  }

  /** With `reason: "removed"` the runtime treats the reissue as a removal (refused once the session has started). */
  async reissue(
    id: string,
    roleId: string,
    by: string,
    reason?: "removed",
  ): Promise<string> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/codes/reissue`,
      reason === undefined ? { roleId, by } : { roleId, by, reason },
      this.longTimeoutMs,
    );
    if (!isObject(d) || !isText(d.code)) return bad();
    return d.code;
  }

  async reissueAll(id: string, by: string): Promise<RoleCode[]> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/codes/reissue`,
      { all: true, by },
      this.longTimeoutMs,
    );
    if (!isObject(d)) return bad();
    return toRoleCodes(d.codes);
  }

  async restart(id: string): Promise<SessionInfo & { codes?: RoleCode[] }> {
    const d = await this.call(
      "POST",
      `/sessions/${this.id(id)}/restart`,
      {},
      this.longTimeoutMs,
    );
    const info = toInfo(d);
    const codes = (d as Record<string, unknown>).codes;
    return codes === undefined ? info : { ...info, codes: toRoleCodes(codes) };
  }

  /**
   * Sets which roles AI players play. The reply's `codes` are the human roles' codes only (the control service never returns an AI
   * code); the BFF filters again. `includeInGroup` is sent only when given (absent = keep the current value); the reply must carry it.
   */
  async setAiRoles(
    id: string,
    roles: string[],
    includeInGroup?: boolean,
  ): Promise<{ roles: string[]; includeInGroup: boolean; codes: RoleCode[] }> {
    const d = await this.call(
      "PUT",
      `/sessions/${this.id(id)}/ai-roles`,
      includeInGroup === undefined ? { roles } : { roles, includeInGroup },
      this.longTimeoutMs,
    );
    if (!isObject(d) || !Array.isArray(d.roles) || typeof d.includeInGroup !== "boolean") return bad();
    return {
      roles: d.roles.map((r) => (isId(r) ? r : bad())),
      includeInGroup: d.includeInGroup,
      codes: toRoleCodes(d.codes),
    };
  }

  /** The last intents of one AI player. A role id that is not an id never reaches the network. */
  async intents(id: string, roleId: string): Promise<IntentEntry[]> {
    if (
      typeof roleId !== "string" ||
      !isId(roleId)
    )
      throw new LauncherError("not_found");
    const d = await this.call(
      "GET",
      `/sessions/${this.id(id)}/ai-roles/${encodeURIComponent(roleId)}/intents`,
      undefined,
      this.timeoutMs,
    );
    if (!isObject(d) || !Array.isArray(d.entries)) return bad();
    return d.entries
      .map(toIntent)
      .filter((e): e is IntentEntry => e !== null)
      .slice(-MAX_INTENT_ENTRIES);
  }

  /** Reserves the next turn of an AI player; the reservation (32 hex) is a secret between the BFF and the control service. */
  async reserveTurn(id: string, roleId: string): Promise<string> {
    const d = await this.call("POST", this.turnPath(id, roleId, "reserve"), {}, this.timeoutMs);
    if (!isObject(d) || typeof d.reservation !== "string" || !/^[0-9a-f]{32}$/.test(d.reservation)) return bad();
    return d.reservation;
  }

  /** Starts the reserved turn. The hint goes only here. */
  async runTurn(id: string, roleId: string, reservation: string, hint?: string): Promise<void> {
    await this.call(
      "POST",
      this.turnPath(id, roleId, "run"),
      hint === undefined ? { reservation } : { reservation, hint },
      this.timeoutMs,
    );
  }

  async releaseTurn(id: string, roleId: string, reservation: string): Promise<void> {
    await this.call("POST", this.turnPath(id, roleId, "release"), { reservation }, this.timeoutMs);
  }

  private turnPath(id: string, roleId: string, leaf: "reserve" | "run" | "release"): string {
    if (!isId(roleId)) throw new LauncherError("not_found");
    return `/sessions/${this.id(id)}/ai-roles/${encodeURIComponent(roleId)}/${leaf}`;
  }

  // ---- report links (US-0062) ----

  async reportLinks(id: string): Promise<{ state: ReportLinksState; players: PlayersSummary | null; roles: ReportLinkRow[] }> {
    const d = await this.call("GET", `/sessions/${this.id(id)}/report-links`, undefined, this.timeoutMs);
    if (!isObject(d) || !Array.isArray(d.roles)) return bad();
    if (d.state !== "ready" && d.state !== "not_ready" && d.state !== "unavailable") return bad();
    return {
      state: d.state,
      players: d.players === null || d.players === undefined ? null : toCount(d.players),
      roles: d.roles.map((r) =>
        isObject(r) && isId(r.role)
          ? { role: r.role, credential: r.credential === null ? null : toReportLink(r.credential), selfRated: r.selfRated === null || r.selfRated === undefined ? null : toCount(r.selfRated), draft: r.draft === true, ...(r.ai === true ? { ai: true as const } : {}) }
          : bad(),
      ),
    };
  }

  async issueReportLink(id: string, role: string): Promise<IssuedReportLink> {
    if (!isId(role)) throw new LauncherError("not_found");
    return toIssued(await this.call("POST", `/sessions/${this.id(id)}/report-links`, { role }, this.timeoutMs, { detail: true }));
  }

  async reissueReportLink(id: string, role: string): Promise<IssuedReportLink> {
    return toIssued(await this.call("POST", this.linkPath(id, role, "/reissue"), {}, this.timeoutMs, { detail: true }));
  }

  async revokeReportLink(id: string, role: string): Promise<boolean> {
    const d = await this.call("DELETE", this.linkPath(id, role, ""), undefined, this.timeoutMs);
    if (!isObject(d) || typeof d.revoked !== "boolean") return bad();
    return d.revoked;
  }

  /** Trades a link token for the credential behind it. A not_found is the control service's one neutral refusal. */
  async exchangeReportToken(token: string): Promise<ReportExchange> {
    const d = await this.call("POST", "/report-access/exchange", { token }, this.timeoutMs);
    if (!isObject(d) || !isText(d.credentialId) || !isText(d.sessionId) || !isId(d.role) || !isTime(d.expiresAt)) return bad();
    return { credentialId: d.credentialId, sessionId: d.sessionId, role: d.role, expiresAt: d.expiresAt };
  }

  /** One participant's report, for the credential the sealed cookie names. Its answer alone may exceed the usual response cap. */
  async readReport(id: string, credentialId: string): Promise<ReportRead> {
    if (typeof credentialId !== "string" || !CREDENTIAL_ID.test(credentialId)) throw new LauncherError("not_found");
    const d = await this.call("GET", `/sessions/${this.id(id)}/reports/${encodeURIComponent(credentialId)}`, undefined, this.timeoutMs, { maxChars: MAX_REPORT_RESPONSE_CHARS });
    if (!isObject(d)) return bad();
    if (d.state === "not_released") return { state: "not_released" };
    if (d.state === "closed") return { state: "closed" };
    if (d.state === "old_schema") return { state: "old_schema" };
    if (d.state === "released" && isObject(d.view)) return { state: "released", view: d.view };
    if (d.state === "self_assess") return { state: "self_assess", ...toForm(d) };
    return bad();
  }

  /** Saves a participant's self-ratings. Control's status and code decide the outcome; its message is never read. */
  async rateReport(id: string, credentialId: string, ratings: RatingInput[]): Promise<WriteOutcome> {
    return this.write("PUT", id, credentialId, "self-ratings", { ratings });
  }

  /** Saves a participant's response (optionally a dispute of one criterion). */
  async respondReport(id: string, credentialId: string, input: ResponseInput): Promise<WriteOutcome> {
    return this.write("POST", id, credentialId, "responses", input);
  }

  private async write(method: "PUT" | "POST", id: string, credentialId: string, leaf: string, body: unknown): Promise<WriteOutcome> {
    if (typeof credentialId !== "string" || !CREDENTIAL_ID.test(credentialId)) throw new LauncherError("not_found");
    const path = `/sessions/${this.id(id)}/reports/${encodeURIComponent(credentialId)}/${leaf}`;
    const signal = AbortSignal.timeout(Math.max(this.timeoutMs, WRITE_TIMEOUT_MS));
    let status: number;
    let text: string;
    let retryAfter: string | null;
    try {
      const res = await this.fetchFn(new URL(path, this.base).toString(), {
        method,
        signal,
        redirect: "error",
        headers: { "x-service-token": this.token, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      status = res.status;
      retryAfter = res.headers.get("Retry-After");
      text = await res.text();
    } catch {
      throw new LauncherError(signal.aborted ? "timeout" : "unavailable");
    }
    if (text.length > MAX_RESPONSE_CHARS) throw new LauncherError("failed");
    let env: unknown;
    try {
      env = JSON.parse(text);
    } catch {
      env = undefined;
    }
    const e = isObject(env) ? env : undefined;
    if (status >= 200 && status < 300) {
      if (e?.success !== true) throw new LauncherError("failed");
      return { state: "ok" };
    }
    const err = e && isObject(e.error) ? e.error : undefined;
    const code = err && typeof err.code === "string" ? err.code : undefined;
    if (status === 400) return { state: "invalid" };
    if (status === 413) return { state: "too_large" };
    if (status === 404) throw new LauncherError("not_found");
    if (status === 429) {
      const secs = retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : 1;
      return { state: "throttled", retryAfterMs: Math.max(1, secs) * 1000 };
    }
    if (status === 409 && code !== undefined && CONFLICT_STATES.has(code)) return { state: code as WriteState };
    if (status === 503 && code === "busy") return { state: "busy" };
    if (status === 503) throw new LauncherError("unavailable");
    if (status === 401) throw new LauncherError("unauthorized");
    throw new LauncherError(status === 504 ? "timeout" : "failed");
  }

  // ---- the facilitator's evaluate and review (US-0064) ----

  async reportOverview(id: string): Promise<ReportOverview> {
    return toOverview(await this.reportCall("GET", id, ""));
  }
  async reportEvaluate(id: string, input: { confirmedCalls: number; by: string }): Promise<ReportJob> {
    return toJob(await this.reportCall("POST", id, "/evaluate", { confirmedCalls: input.confirmedCalls, by: input.by }));
  }
  async reportCancel(id: string): Promise<ReportJob> {
    return toJob(await this.reportCall("POST", id, "/evaluate/cancel", {}));
  }
  async reportOpen(id: string, by: string): Promise<{ subjects: number }> {
    const d = await this.reportCall("POST", id, "/open", { by });
    if (!isObject(d) || !isCount(d.subjects)) return bad();
    return { subjects: d.subjects };
  }
  /** The subject view alone gets the larger report cap. */
  async reportSubject(id: string, subject: string): Promise<SubjectView> {
    return toSubjectView(await this.reportCall("GET", id, this.subjectPath(subject, ""), undefined, MAX_REPORT_RESPONSE_CHARS));
  }
  async reportEdit(id: string, subject: string, b: ReportEditInput): Promise<void> {
    await this.reportWrite(id, this.subjectPath(subject, "/edit"), {
      criterion: b.criterion, level: b.level, reason: b.reason, ...(b.rationale !== undefined && { rationale: b.rationale }), expect: b.expect, by: b.by,
    });
  }
  async reportAccept(id: string, subject: string, b: ReportAcceptInput): Promise<void> {
    await this.reportWrite(id, this.subjectPath(subject, "/accept"), {
      ...(b.criterion !== undefined && { criterion: b.criterion }), ...(b.summary !== undefined && { summary: b.summary }), by: b.by,
    });
  }
  async reportComment(id: string, subject: string, b: ReportCommentInput): Promise<void> {
    await this.reportWrite(id, this.subjectPath(subject, "/comment"), {
      text: b.text, ...(b.criterion !== undefined && { criterion: b.criterion }), ...(b.feedback !== undefined && { feedback: b.feedback }), by: b.by,
    });
  }
  async reportEditSummary(id: string, subject: string, b: ReportEditSummaryInput): Promise<void> {
    await this.reportWrite(id, this.subjectPath(subject, "/edit-summary"), {
      reason: b.reason, ...(b.strengths !== undefined && { strengths: b.strengths }), ...(b.developments !== undefined && { developments: b.developments }),
      ...(b.actions !== undefined && { actions: b.actions.map((a) => ({ lo: a.lo, text: a.text })) }), by: b.by,
    });
  }

  /** Releases an explicit list of subjects; the answer is parsed closed. */
  async reportRelease(id: string, b: { subjects: string[]; by: string }): Promise<{ released: string[]; groupTableStale: boolean }> {
    const d = await this.reportCall("POST", id, "/release", { subjects: b.subjects, by: b.by });
    if (!isObject(d) || !isFileIds(d.released) || d.released.length > MAX_BLOCKED || typeof d.groupTableStale !== "boolean") return bad();
    return { released: d.released, groupTableStale: d.groupTableStale };
  }
  async reportResolve(id: string, b: { seq: number; outcome: "upheld" | "amended" | "declined"; reason: string; by: string }): Promise<void> {
    await this.reportWrite(id, "/resolve", { seq: b.seq, outcome: b.outcome, reason: b.reason, by: b.by });
  }
  /** The audience's Markdown for one subject; the file name is kept as control said it (the BFF checks it before it names a download). */
  async reportExport(id: string, b: { subject: string; audience: string; by: string }): Promise<{ fileName: string; markdown: string }> {
    const d = await this.reportCall("POST", id, "/export", { subject: b.subject, audience: b.audience, by: b.by }, MAX_REPORT_RESPONSE_CHARS);
    if (!isObject(d) || !isStr(d.markdown)) return bad();
    return { fileName: isStr(d.fileName) ? d.fileName : "", markdown: d.markdown };
  }
  async reportAmend(id: string, subject: string, b: { reason: string; by: string }): Promise<void> {
    await this.reportWrite(id, this.subjectPath(subject, "/amend"), { reason: b.reason, by: b.by });
  }
  async reportWithdraw(id: string, subject: string, b: { reason: string; by: string }): Promise<{ groupTableStale: boolean }> {
    const d = await this.reportCall("POST", id, this.subjectPath(subject, "/withdraw"), { reason: b.reason, by: b.by });
    if (!isObject(d) || typeof d.groupTableStale !== "boolean") return bad();
    return { groupTableStale: d.groupTableStale };
  }

  private async reportWrite(id: string, tail: string, body: unknown): Promise<void> {
    if (!isObject(await this.reportCall("POST", id, tail, body))) bad();
  }
  private reportCall(method: "GET" | "POST", id: string, tail: string, body?: unknown, maxChars?: number): Promise<unknown> {
    return this.call(method, `/sessions/${this.id(id)}/report${tail}`, body, Math.max(this.timeoutMs, REPORT_CALL_TIMEOUT_MS), maxChars === undefined ? {} : { maxChars });
  }
  /** A subject is `group` or a role id; anything else never reaches the network. */
  private subjectPath(subject: string, leaf: string): string {
    if (subject !== "group" && !isId(subject)) throw new LauncherError("not_found");
    return `/subjects/${encodeURIComponent(subject)}${leaf}`;
  }

  private linkPath(id: string, role: string, leaf: string): string {
    if (!isId(role)) throw new LauncherError("not_found");
    return `/sessions/${this.id(id)}/report-links/${encodeURIComponent(role)}${leaf}`;
  }

  /** A session id is checked before it goes into a path, so nothing can change the route. */
  private id(raw: string): string {
    if (!isValidSessionId(raw)) throw new LauncherError("not_found");
    return encodeURIComponent(raw);
  }

  /** One request. Resolves with the envelope's `data`, or throws a LauncherError; nothing from the transport escapes. */
  private async call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    timeoutMs: number,
    o: { maxChars?: number; detail?: boolean } = {},
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await this.fetchFn(new URL(path, this.base).toString(), {
        method,
        signal,
        redirect: "error",
        headers: {
          "x-service-token": this.token,
          Accept: "application/json",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      status = res.status;
      text = await res.text();
    } catch {
      throw new LauncherError(signal.aborted ? "timeout" : "unavailable");
    }
    if (text.length > (o.maxChars ?? MAX_RESPONSE_CHARS)) throw new LauncherError("failed");
    let env: unknown;
    try {
      env = JSON.parse(text);
    } catch {
      env = undefined;
    }
    const e = isObject(env) ? env : undefined;
    if (status >= 200 && status < 300) {
      if (e?.success !== true || e.data === null || e.data === undefined)
        throw new LauncherError("failed");
      return e.data;
    }
    const err = e && isObject(e.error) ? e.error : undefined;
    if (err && typeof err.code === "string") {
      const detail = o.detail && typeof err.message === "string" && err.message.length <= MAX_DETAIL_CHARS ? err.message : undefined;
      const reason = Object.hasOwn(BY_CODE, err.code) ? BY_CODE[err.code]! : "failed";
      const blocked = reason === "blocked" ? toBlocked(e?.data) : undefined;
      throw new LauncherError(reason, detail, blocked);
    }
    throw new LauncherError(BY_STATUS[status] ?? "failed");
  }
}
