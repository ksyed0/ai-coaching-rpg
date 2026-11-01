import { visibleTranscript, type PlayerSnapshot, type SessionEvent, type SessionState } from "@acr/events";

/**
 * Everything a player may see of the session, as explicit allowlists. A copy is built key by key from these tables, never by spread,
 * so a field added to the state or to an event is denied to players until someone lists it here (and a missing entry is a compile error).
 * The facilitator receives the state and every event whole; none of this applies to it.
 */

export type StartedEvent = Extract<SessionEvent, { type: "session.started" }>;
export type CommandEvent = Extract<SessionEvent, { type: "facilitator.command" }>;
export type EndedEvent = Extract<SessionEvent, { type: "session.ended" }>;

export function redactRoles(roles: SessionState["roles"]): SessionState["roles"] {
  return Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, { kind: r.kind }]));
}

/** How one state field is copied for the player `who`; "omit" leaves it out. */
type PlayerField<K extends keyof SessionState> = ((s: SessionState, who: string) => SessionState[K]) | "omit";

/** Every SessionState key must be listed. The rules are those of the old snapshotFor: only scenes the player takes part in, no NPC internals, verdicts, participant ids or other scenes' lines. */
export const PLAYER_SNAPSHOT: { [K in keyof SessionState]: PlayerField<K> } = {
  status: (s) => s.status,
  lastSeq: (s) => s.lastSeq,
  scenarioId: (s) => s.scenarioId,
  version: (s) => s.version,
  roles: (s) => redactRoles(s.roles),
  currentScene: (s, who) => (s.currentScene && s.currentScene.participants.includes(who) ? s.currentScene : null),
  sceneHistory: (s, who) => s.sceneHistory.filter((sc) => sc.participants.includes(who)),
  paused: (s) => s.paused,
  pausedSince: (s) => s.pausedSince,
  transcript: (s, who) => visibleTranscript(s, who),
  injectsFired: () => [],
  npcs: () => ({}),
  advanceRequested: () => false,
  gmVerdicts: () => ({}),
  factsEarned: () => ({}),
  talk: "omit", // US-0059: words spoken are for the facilitator console only
};

export function snapshotForPlayer(s: SessionState, who: string): PlayerSnapshot {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(PLAYER_SNAPSHOT) as (keyof SessionState)[]) {
    const field = PLAYER_SNAPSHOT[k] as ((s: SessionState, who: string) => unknown) | "omit";
    if (field !== "omit") out[k] = field(s, who);
  }
  return out as PlayerSnapshot;
}

/** Fields of session.started copied to a player as they are. A field added to the event type must be listed here (or handled in startedForPlayer) to compile. */
const STARTED_FOR_PLAYERS: Record<Exclude<keyof StartedEvent, "roles" | "consents" | "names" | "logIdentity">, true> = {
  type: true, seq: true, ts: true, sessionId: true, scenarioId: true, version: true, logFormat: true, scenarioHash: true,
};

export function startedForPlayer(e: StartedEvent, who: string): StartedEvent {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(STARTED_FOR_PLAYERS)) if (Object.hasOwn(e, k)) out[k] = (e as Record<string, unknown>)[k];
  out.roles = redactRoles(e.roles);
  const own = e.consents && Object.hasOwn(e.consents, who) ? e.consents[who] : undefined;
  // Copied key by key: a hand-edited log entry with extra keys must not leak them.
  if (own) out.consents = { [who]: { noticeVersion: own.noticeVersion, at: own.at } };
  return out as StartedEvent;
}

/**
 * Players learn of pause and resume, and of a whisper addressed to them. Everything else (advance, inject, NPC stance, release) stays
 * private. Only the listed keys are copied, so `by` and any later field never reach a player.
 */
export function commandForPlayer(e: CommandEvent, who: string): CommandEvent | null {
  if (e.command === "pause" || e.command === "resume") return { type: e.type, seq: e.seq, ts: e.ts, sessionId: e.sessionId, command: e.command };
  if (e.command === "whisper" && e.roleId === who) return { type: e.type, seq: e.seq, ts: e.ts, sessionId: e.sessionId, command: e.command, roleId: e.roleId, text: e.text };
  return null;
}

/** Fields of session.ended copied to a player. A field added to the event type must be listed here to compile. */
export const ENDED_FOR_PLAYERS: Record<keyof EndedEvent, true> = { type: true, seq: true, ts: true, sessionId: true, reason: true };

export function endedForPlayer(e: EndedEvent): EndedEvent {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(ENDED_FOR_PLAYERS)) if (Object.hasOwn(e, k)) out[k] = (e as Record<string, unknown>)[k];
  return out as EndedEvent;
}
