export type RoleKind = "player" | "npc";
export type Channel = "voice" | "text";
export type ExitReason = "time_box_elapsed" | "facilitator_advance" | "gm_detects";
export type FacilitatorCommand =
  | { command: "pause" }
  | { command: "resume" }
  | { command: "advance" }
  | { command: "fire_inject"; injectId: string }
  | { command: "whisper"; roleId: string; text: string }
  | { command: "set_npc_stance"; roleId: string; goals: string[] };

export type EventEnvelope = { seq: number; ts: number; sessionId: string };

export type EventBody =
  | { type: "session.started"; scenarioId: string; version: string; roles: Record<string, { kind: RoleKind; participantId?: string }> }
  | { type: "scene.entered"; sceneId: string; participants: string[] }
  | { type: "scene.exited"; sceneId: string; reason: ExitReason }
  | { type: "utterance"; roleId: string; text: string; channel: Channel;
      /** Set only by an NPC agent's fallback path: this line is the character's canned fallback text standing in for a model reply. */
      fallback?: true }
  | { type: "inject.fired"; injectId: string; sceneId: string; to: string[]; content: string }
  | { type: "npc.updated"; roleId: string; goals: string[]; knowledge: string[]; released?: string[] }
  | { type: "gm.decision"; sceneId: string; condition: string; verdict: boolean; reasoning: string }
  | ({ type: "facilitator.command" } & FacilitatorCommand)
  | { type: "facilitator.alert"; level: "info" | "warning"; message: string }
  | { type: "session.ended"; reason: "script_complete" | "facilitator_end" };

export type SessionEvent = EventEnvelope & EventBody;
export type EventType = EventBody["type"];
