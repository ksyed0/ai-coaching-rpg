import type { PlayerLine, SessionEvent } from "@acr/events";
import { roleLabel } from "./names";

// US-0082: the browser side of "who is composing a reply" (the transient `activity` frame) and "waiting for you" (an AI line addressed to
// this player). Pure functions; the hooks keep the state and the components render it. Nothing here is ever sent back or stored.

/** A thinking indicator older than this is cleared by the page itself, so a lost "idle" never leaves it stuck (the runtime uses the same). */
export const ACTIVITY_EXPIRY_MS = 120_000;

export type ActivityState = "thinking" | "idle";
export type ActivityOutcome = "timed_out" | "failed";
/** Per role: the latest report and when the page received it. `outcome` only on the console (why a turn ended without its line). */
export type ActivityEntry = { state: ActivityState; at: number; outcome?: ActivityOutcome };
export type ActivityMap = Readonly<Record<string, ActivityEntry>>;

const STATES: readonly string[] = ["thinking", "idle"];
const OUTCOMES: readonly string[] = ["timed_out", "failed"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads an `activity` stream event; anything malformed is null (default deny: no indicator is better than a wrong one). */
export function toActivity(d: unknown): { roleId: string; state: ActivityState; outcome?: ActivityOutcome } | null {
  if (!isObj(d) || typeof d.roleId !== "string" || d.roleId === "" || d.roleId.length > 128 || typeof d.state !== "string" || !STATES.includes(d.state)) return null;
  const out: { roleId: string; state: ActivityState; outcome?: ActivityOutcome } = { roleId: d.roleId, state: d.state as ActivityState };
  if (typeof d.outcome === "string" && OUTCOMES.includes(d.outcome)) out.outcome = d.outcome as ActivityOutcome;
  return out;
}

/** The map after one report. Own keys only (a role id such as "__proto__" is an ordinary key of a fresh object). */
export function applyActivity(m: ActivityMap, a: { roleId: string; state: ActivityState; outcome?: ActivityOutcome }, now: number): ActivityMap {
  const entry: ActivityEntry = a.outcome !== undefined ? { state: a.state, at: now, outcome: a.outcome } : { state: a.state, at: now };
  return { ...m, [a.roleId]: entry };
}

/**
 * What a session event does to the indicators: a line from a role ends its "thinking" (the reply landed); a scene change, a pause and the
 * end clear every "thinking" (the runtime does the same). An idle entry (with its outcome) is kept: the console shows it.
 */
export function activityAfterEvent(m: ActivityMap, e: SessionEvent): ActivityMap {
  const idleAll = () => Object.fromEntries(Object.entries(m).map(([r, x]) => [r, x.state === "thinking" ? { state: "idle" as const, at: x.at } : x]));
  switch (e.type) {
    case "utterance": {
      if (!Object.hasOwn(m, e.roleId) || m[e.roleId]!.state !== "thinking") return m;
      return { ...m, [e.roleId]: { state: "idle", at: m[e.roleId]!.at } };
    }
    case "scene.entered": case "scene.exited": case "session.ended": return idleAll();
    case "facilitator.command": return e.command === "pause" ? idleAll() : m;
    default: return m;
  }
}

/** The roles thinking now (not expired), oldest first. */
export function thinkingRoles(m: ActivityMap, now: number): string[] {
  return Object.entries(m).filter(([, x]) => x.state === "thinking" && now - x.at < ACTIVITY_EXPIRY_MS).sort((a, b) => a[1].at - b[1].at).map(([r]) => r);
}

/** Milliseconds until the next "thinking" entry expires, or null when none is thinking. */
export function nextExpiryMs(m: ActivityMap, now: number): number | null {
  const left = Object.values(m).filter((x) => x.state === "thinking").map((x) => x.at + ACTIVITY_EXPIRY_MS - now).filter((ms) => ms > 0);
  return left.length > 0 ? Math.min(...left) : null;
}

/** How a speaker is named on the page: the same rule as the transcript (you; a typed name; else the role label, always for an AI player). */
export function speakerName(roleId: string, o: { selfRole: string; names: Readonly<Record<string, string>>; aiRoles: ReadonlySet<string> }): string {
  if (roleId === o.selfRole) return "You";
  if (!o.aiRoles.has(roleId) && Object.hasOwn(o.names, roleId)) return o.names[roleId]!;
  return roleLabel(roleId);
}

/** Whether a speaker is an AI: an AI player seat (from `aiRoles`, never a name) or a speaker that is no player seat (an AI character). */
export const isAiSpeaker = (roleId: string, aiRoles: ReadonlySet<string>, playerRoles: ReadonlySet<string>): boolean => aiRoles.has(roleId) || !playerRoles.has(roleId);

/**
 * "Waiting for you": the latest AI line of the CURRENT scene addressed to `selfRole` that `selfRole` has not answered yet (any line by that
 * role after it clears it), or null. Null when there is no current scene, the session is not running or the role is an AI seat itself.
 */
export function waitingForYou(v: { status: string; scene: { id: string } | null; transcript: readonly PlayerLine[] }, o: { selfRole: string; aiRoles: ReadonlySet<string>; playerRoles: ReadonlySet<string> }): PlayerLine | null {
  if (v.status !== "running" || v.scene === null || o.aiRoles.has(o.selfRole)) return null;
  for (let i = v.transcript.length - 1; i >= 0; i--) {
    const l = v.transcript[i]!;
    if (l.sceneId !== v.scene.id) return null; // only the current scene's lines count
    if (l.roleId === o.selfRole) return null; // answered
    if (l.to === o.selfRole && isAiSpeaker(l.roleId, o.aiRoles, o.playerRoles)) return l;
  }
  return null;
}
