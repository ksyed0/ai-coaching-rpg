import { isKnownEventType, type EventType, type SessionEvent, type SessionState } from "@acr/events";
import { entryOf } from "./console-roster";
import type { FacilitatorRosterEntry } from "./wire";

/**
 * What the facilitator's BROWSER may see of the session, as explicit allowlists. The runtime's facilitator frames carry the full state
 * (NPC goals, knowledge and hidden facts, participant ids, the log identity); none of that is for the page. A state copy is built key
 * by key, never by spread, so a new SessionState field is denied until listed (a missing entry is a compile error). Every event type
 * has its own copier that picks fields, so an extra key on an event never passes, and a new event type fails to compile until listed.
 */

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

type Ev<T extends EventType> = Extract<SessionEvent, { type: T }>;
const env = (e: SessionEvent) => ({ seq: e.seq, ts: e.ts, sessionId: e.sessionId });

/** Raw runtime or provider error text can carry keys, headers or codes, and the web cannot scrub it, so an alert shows a fixed line per level. */
const ALERT_MESSAGES = {
  info: "The runtime posted a notice. Details are in the facilitator log.",
  warning: "The runtime raised an alert. Details are in the facilitator log.",
} as const;

const EVENT_COPY: { [T in EventType]: (e: Ev<T>) => SessionEvent } = {
  "session.started": (e) => {
    const out: Ev<"session.started"> = { type: e.type, ...env(e), scenarioId: e.scenarioId, version: e.version, roles: kindsOnly(e.roles) };
    if (e.consents) out.consents = Object.fromEntries(Object.entries(e.consents).map(([id, c]) => [id, { noticeVersion: c.noticeVersion, at: c.at }]));
    if (e.names) out.names = { ...e.names };
    return out;
  },
  "scene.entered": (e) => ({ type: e.type, ...env(e), sceneId: e.sceneId, participants: e.participants }),
  "scene.exited": (e) => ({ type: e.type, ...env(e), sceneId: e.sceneId, reason: e.reason }),
  utterance: (e) => ({ type: e.type, ...env(e), roleId: e.roleId, text: e.text, channel: e.channel, ...(e.fallback && { fallback: e.fallback }) }),
  "inject.fired": (e) => ({ type: e.type, ...env(e), injectId: e.injectId, sceneId: e.sceneId, to: e.to, content: e.content }),
  // The frame stays so sequence numbers have no gap; the text does not.
  "npc.updated": (e) => ({ type: e.type, ...env(e), roleId: e.roleId, goals: [], knowledge: [], released: [] }),
  "gm.decision": (e) => ({ type: e.type, ...env(e), sceneId: e.sceneId, condition: e.condition, verdict: e.verdict, reasoning: e.reasoning, ...(e.via && { via: e.via }) }),
  "gm.no_verdict": (e) => ({ type: e.type, ...env(e), sceneId: e.sceneId, condition: e.condition, reason: e.reason, attempts: e.attempts }),
  "gm.fact_earned": (e) => ({ type: e.type, ...env(e), sceneId: e.sceneId, roleId: e.roleId, fact: e.fact, reasoning: e.reasoning, ...(e.via && { via: e.via }), ...(e.autoRelease && { autoRelease: e.autoRelease }) }),
  "facilitator.command": (e) => {
    const base = { type: e.type, ...env(e), ...(e.by !== undefined && { by: e.by }) };
    switch (e.command) {
      case "pause": case "resume": case "advance": return { ...base, command: e.command };
      case "fire_inject": return { ...base, command: e.command, injectId: e.injectId };
      case "whisper": return { ...base, command: e.command, roleId: e.roleId, text: e.text };
      // The NPC's goal text is a secret of the character; the command stays so the log reads whole.
      case "set_npc_stance": return { ...base, command: e.command, roleId: e.roleId, goals: [] };
      case "release_hidden": return { ...base, command: e.command, roleId: e.roleId, fact: e.fact };
    }
  },
  "facilitator.alert": (e) => ({ type: e.type, ...env(e), level: e.level === "info" ? "info" : "warning", message: e.level === "info" ? ALERT_MESSAGES.info : ALERT_MESSAGES.warning }),
  "session.ended": (e) => ({ type: e.type, ...env(e), reason: e.reason, ...(e.message !== undefined && { message: e.message }) }),
  "session.resumed": (e) => ({ type: e.type, ...env(e), downFromTs: e.downFromTs }),
};

/** An event whose type this version does not know goes as its envelope only (the sequence stays gap-free, the unknown fields stay home). */
export function consoleEvent(e: SessionEvent): SessionEvent {
  if (!isKnownEventType(e.type)) return { type: e.type, ...env(e) } as unknown as SessionEvent;
  return (EVENT_COPY[e.type] as (e: SessionEvent) => SessionEvent)(e);
}

export const consoleRoster = (entries: FacilitatorRosterEntry[]): FacilitatorRosterEntry[] => entries.map(entryOf);
