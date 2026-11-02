import type { SessionEvent, SessionState } from "@acr/events";
import { entryOf } from "./console-sessions";
import type { FacilitatorRosterEntry } from "./wire";

/**
 * What the facilitator's BROWSER may see of the session, as explicit allowlists. The runtime's facilitator frames carry the full state
 * (NPC goals, knowledge and hidden facts, participant ids, the log identity); none of that is for the page. A copy is built key by key,
 * never by spread, so a field added to the state or to an event is denied until someone lists it here (a missing entry is a compile error).
 */

type StartedEvent = Extract<SessionEvent, { type: "session.started" }>;
type NpcEvent = Extract<SessionEvent, { type: "npc.updated" }>;

const kindsOnly = (roles: SessionState["roles"]): SessionState["roles"] =>
  Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, { kind: r.kind }]));

/** Every SessionState key must be listed. Roles lose their participantId; the NPCs' goals, knowledge and released facts never leave the BFF. */
export const CONSOLE_STATE: { [K in keyof SessionState]: (s: SessionState) => SessionState[K] } = {
  status: (s) => s.status,
  lastSeq: (s) => s.lastSeq,
  scenarioId: (s) => s.scenarioId,
  version: (s) => s.version,
  roles: (s) => kindsOnly(s.roles),
  currentScene: (s) => s.currentScene,
  sceneHistory: (s) => s.sceneHistory,
  paused: (s) => s.paused,
  pausedSince: (s) => s.pausedSince,
  transcript: (s) => s.transcript,
  injectsFired: (s) => s.injectsFired,
  npcs: () => ({}),
  advanceRequested: (s) => s.advanceRequested,
  gmVerdicts: (s) => s.gmVerdicts,
  factsEarned: (s) => s.factsEarned,
  talk: (s) => s.talk,
};

export function consoleState(s: SessionState): SessionState {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(CONSOLE_STATE) as (keyof SessionState)[]) out[k] = CONSOLE_STATE[k](s);
  return out as SessionState;
}

/** session.started and npc.updated are copied key by key; every other event goes whole (its fields are the facilitator's to see). */
export function consoleEvent(e: SessionEvent): SessionEvent {
  if (e.type === "session.started") {
    const s = e as StartedEvent;
    const out: StartedEvent = { type: s.type, seq: s.seq, ts: s.ts, sessionId: s.sessionId, scenarioId: s.scenarioId, version: s.version, roles: kindsOnly(s.roles) };
    if (s.consents) out.consents = Object.fromEntries(Object.entries(s.consents).map(([id, c]) => [id, { noticeVersion: c.noticeVersion, at: c.at }]));
    if (s.names) out.names = { ...s.names };
    return out;
  }
  if (e.type === "npc.updated") {
    // The frame stays so sequence numbers have no gap; the text does not.
    const n = e as NpcEvent;
    return { type: n.type, seq: n.seq, ts: n.ts, sessionId: n.sessionId, roleId: n.roleId, goals: [], knowledge: [], released: [] };
  }
  return e;
}

export const consoleRoster = (entries: FacilitatorRosterEntry[]): FacilitatorRosterEntry[] => entries.map(entryOf);
