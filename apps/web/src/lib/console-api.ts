import type { ApiResult } from "./api";
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
};
export type Readiness = {
  launcherStatus: "running" | "stopped" | "ended";
  status: "idle" | "running" | "ended" | null;
  modelLabel: string | null;
  roster: RosterEntry[];
  canStart: boolean;
  missing: string[];
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
