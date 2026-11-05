import { aiRolesOfStarted, includeInGroupOf, type SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";

export type AiPlayers = { roles: string[]; includeInGroup: boolean };

type Started = Extract<SessionEvent, { type: "session.started" }>;
const firstStarted = (events: SessionEvent[]): Started | null => {
  const e = Array.isArray(events) ? events[0] : undefined;
  return e && e.type === "session.started" ? e : null;
};

/**
 * The AI player roles of a session, read from its log only (never the seat file or control state). `[]` when the first event is not
 * session.started or records no AI players; "invalid" when the record is inconsistent (callers refuse it); else the roles in scenario
 * order. Never uses a reducer (a log may start at any seq) and never throws.
 */
export function aiRolesOf(events: SessionEvent[], scenario: Scenario): string[] | "invalid" {
  try {
    const e = firstStarted(events);
    if (!e) return [];
    const hasRoles = e.aiRoles !== undefined;
    const hasOption = e.includeInGroup !== undefined;
    if (!hasRoles && !hasOption) return [];
    if (!hasRoles) return "invalid";
    const raw = e.aiRoles as unknown;
    if (!Array.isArray(raw)) return "invalid";
    if (typeof e.logFormat !== "number" || e.logFormat < 3) return "invalid";
    const seen = new Set<string>();
    for (const r of raw as unknown[]) {
      if (typeof r !== "string" || seen.has(r)) return "invalid";
      seen.add(r);
      const sc = Object.hasOwn(scenario.roles, r) ? scenario.roles[r] : undefined;
      if (!sc || sc.type !== "player") return "invalid";
      if (!Object.hasOwn(e.roles, r) || e.roles[r]?.kind !== "player") return "invalid";
    }
    const ok = new Set(aiRolesOfStarted(e));
    return Object.keys(scenario.roles).filter((id) => ok.has(id));
  } catch {
    return "invalid";
  }
}

/** Whether AI players count toward group scores: "invalid" when the field is present and not a boolean; on when absent. */
export function aiOptionOf(events: SessionEvent[]): boolean | "invalid" {
  try {
    const e = firstStarted(events);
    if (!e) return true;
    if (e.includeInGroup !== undefined && typeof e.includeInGroup !== "boolean") return "invalid";
    return includeInGroupOf(e);
  } catch {
    return "invalid";
  }
}
