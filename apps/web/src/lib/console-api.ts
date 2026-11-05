import { getJson, postJson, type ApiResult } from "./api";
import { MESSAGES } from "./messages";

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
export type ReportLinkRole = { role: string; link: ReportLink | null };
export type ReportLinksView = { state: "ready" | "not_ready" | "unavailable"; roles: ReportLinkRole[] };

/** The fixed sentence for a session with nothing released yet (the same words the control service uses). */
export const REPORT_NOT_READY =
  "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).";
export const REPORT_UNAVAILABLE = "The reports for this session cannot be read. Check them with moderate status.";

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

export function parseReportLinks(v: unknown): ReportLinksView | null {
  const o = obj(v);
  if (!o) return null;
  const state = (["ready", "not_ready", "unavailable"] as const).find((s) => s === o.state);
  if (!state) return null;
  const roles: ReportLinkRole[] = [];
  for (const x of Array.isArray(o.roles) ? o.roles : []) {
    const r = obj(x);
    if (!r || typeof r.role !== "string") continue;
    roles.push({ role: r.role, link: r.credential === null || r.credential === undefined ? null : parseReportLink(r.role, r.credential) });
  }
  return { state, roles };
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
