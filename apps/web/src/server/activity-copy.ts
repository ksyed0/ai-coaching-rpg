import { CLIENT_ID_MAX_CHARS } from "@acr/events";

// US-0082: the BFF's copies of the runtime's transient `activity` frame ("someone is composing a reply"). Picked field by field, never
// spread: a player's page gets the role and the state only; the console also gets the outcome (why a turn ended without its line).
// Anything malformed is dropped (the indicator is a convenience: no frame is better than a wrong one).

const STATES: readonly string[] = ["thinking", "idle"];
const OUTCOMES: readonly string[] = ["timed_out", "failed"];
type Raw = { roleId?: unknown; state?: unknown; outcome?: unknown };

const roleOk = (r: unknown): r is string => typeof r === "string" && r.length > 0 && r.length <= CLIENT_ID_MAX_CHARS;

/** What a participant's page may get: `{ roleId, state }`, or null. The runtime already sent it only to players who share the scene. */
export function playerActivity(m: Raw): { roleId: string; state: "thinking" | "idle" } | null {
  if (!roleOk(m.roleId) || typeof m.state !== "string" || !STATES.includes(m.state)) return null;
  return { roleId: m.roleId, state: m.state as "thinking" | "idle" };
}

/** What the facilitator console gets: the player copy plus a known `outcome`, or null. */
export function consoleActivity(m: Raw): { roleId: string; state: "thinking" | "idle"; outcome?: "timed_out" | "failed" } | null {
  const p = playerActivity(m);
  if (!p) return null;
  return typeof m.outcome === "string" && OUTCOMES.includes(m.outcome) ? { ...p, outcome: m.outcome as "timed_out" | "failed" } : p;
}
