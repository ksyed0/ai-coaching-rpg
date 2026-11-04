export type RoleKind = "player" | "npc";
export type Channel = "voice" | "text";
/** Why a Game Master reply gave no usable verdict, and how a recorded verdict was read (see gm.no_verdict and gm.decision). */
export type GmNoVerdictReason = "empty" | "no_json" | "bad_verdict" | "truncated" | "reasoning_only"
  /** The usable verdicts of one reply disagree, so none is accepted. */
  | "conflict"
  /** Verdict objects were present but none carried this evaluation's nonce (forged or echoed). */
  | "no_nonce";
export type GmVia = "strict" | "tolerant" | "reask";
export type ExitReason = "time_box_elapsed" | "facilitator_advance" | "gm_detects" | "facilitator_end";
export type FacilitatorCommand =
  | { command: "pause" }
  | { command: "resume" }
  | { command: "advance" }
  | { command: "fire_inject"; injectId: string }
  | { command: "whisper"; roleId: string; text: string }
  | { command: "set_npc_stance"; roleId: string; goals: string[] }
  /** Facilitator only. `fact` is the 1-based number of the NPC's hidden fact. The event carries no fact text: the text goes only in the facilitator-only `npc.updated` that follows it. */
  | { command: "release_hidden"; roleId: string; fact: number }
  /**
   * US-0060, facilitator only: the facilitator asks the AI player of `roleId` to speak now. Carries NO hint or free text anywhere: what the
   * facilitator might want to say is never written to the session log. Players never receive it. Counts as one AI call (ResumeInfo.aiCalls).
   */
  | { command: "prompt_ai"; roleId: string };

export type EventEnvelope = { seq: number; ts: number; sessionId: string };

export type EventBody =
  | { type: "session.started"; scenarioId: string; version: string; roles: Record<string, { kind: RoleKind; participantId?: string }>;
      /** The session log's format (US-0018): LOG_FORMAT for new logs; absent in older logs, which count as format 0. */
      logFormat?: number;
      /** sha256 (hex) of the loaded scenario, so a restart can refuse to resume a log against a different scenario. Absent in format 0. */
      scenarioHash?: string;
      /**
       * Log format 2 (US-0054), all optional and never in SessionState. consents: per role, the notice version and time of the consent given
       * before the start. names: per role, the cleaned display name. logIdentity: 32 hex ties the web seats to this log. Players see only
       * their own consent; names and logIdentity are facilitator-only.
       */
      consents?: Record<string, { noticeVersion: string; at: number }>;
      names?: Record<string, string>;
      logIdentity?: string;
      /**
       * US-0060: player roles an AI plays, in scenario order; present only when non-empty. Readers treat absence as none. Unlike `consents`
       * it is public to every player (labels), and never lists an AI character.
       */
      aiRoles?: string[] }
  | { type: "scene.entered"; sceneId: string; participants: string[] }
  | { type: "scene.exited"; sceneId: string; reason: ExitReason }
  | { type: "utterance"; roleId: string; text: string; channel: Channel;
      /** Set only by an NPC agent's fallback path: this line is the character's canned fallback text standing in for a model reply. */
      fallback?: true }
  | { type: "inject.fired"; injectId: string; sceneId: string; to: string[]; content: string }
  | { type: "npc.updated"; roleId: string; goals: string[]; knowledge: string[]; released?: string[] }
  | { type: "gm.decision"; sceneId: string; condition: string; verdict: boolean; reasoning: string;
      /** How the verdict was read: strict JSON, tolerantly (prose, a fence, plain text) or from the one re-ask. Absent in older logs. */
      via?: GmVia }
  /** Facilitator-only: the Game Master gave no usable verdict for `condition` after `attempts` model replies (1, or 2 with the re-ask). */
  | { type: "gm.no_verdict"; sceneId: string; condition: string; reason: GmNoVerdictReason; attempts: number }
  /**
   * US-0034, facilitator-only: the Game Master judged the `earned_when` condition of hidden fact number `fact` (1-based) of AI character `roleId`
   * true (a nonce-verified verdict), so it suggests releasing it with `/release <roleId> <fact>`. Recorded at most once per fact for the whole
   * session; carries NO fact text. Written only by the engine's Game Master path, never from a client message. `autoRelease`: the operator's
   * GM_AUTO_RELEASE was on, so the Game Master released the fact itself: the facilitator-only `npc.updated` with the text follows directly.
   */
  | { type: "gm.fact_earned"; sceneId: string; roleId: string; fact: number; reasoning: string; via?: GmVia; autoRelease?: true }
  /** `by`: US-0059, the facilitator's name as the control service gave it (cleaned, at most 60 code points). A label, not proof of identity; facilitator-only (players' copies drop it). Absent for terminal facilitators and older logs. */
  | ({ type: "facilitator.command"; by?: string } & FacilitatorCommand)
  | { type: "facilitator.alert"; level: "info" | "warning"; message: string }
  /** `message`: US-0059, the facilitator's closing message for participants (cleaned, at most 300 code points); only with reason `facilitator_end`. */
  | { type: "session.ended"; reason: "script_complete" | "facilitator_end"; message?: string }
  /**
   * US-0018: the server restarted and resumed this session from its log. The session comes back paused; the time since
   * `downFromTs` (the last event recorded before the restart) counts as paused time, so no timer runs on during the downtime.
   */
  | { type: "session.resumed"; downFromTs: number };

export type SessionEvent = EventEnvelope & EventBody;
export type EventType = EventBody["type"];

/** The newest session log format this version reads and writes (session.started.logFormat). A log without the field is format 0. Format 3 (US-0060) adds `aiRoles`. */
export const LOG_FORMAT = 3;
/** The format written when a session has no AI roles, so an older runtime can still resume it after a rollback. */
export const LOG_FORMAT_WITHOUT_AI_ROLES = 2;
/** The format a new log gets: 3 only when it records AI roles, else 2. */
export const logFormatFor = (aiRoles: readonly string[]): number => (aiRoles.length > 0 ? LOG_FORMAT : LOG_FORMAT_WITHOUT_AI_ROLES);

const EVENT_TYPE_SET: Record<EventType, true> = {
  "session.started": true, "scene.entered": true, "scene.exited": true, utterance: true, "inject.fired": true, "npc.updated": true,
  "gm.decision": true, "gm.no_verdict": true, "gm.fact_earned": true, "facilitator.command": true, "facilitator.alert": true, "session.ended": true, "session.resumed": true,
};
/** Every event type this version knows (a compile error until a new EventBody member is listed). */
export const EVENT_TYPES: readonly EventType[] = Object.keys(EVENT_TYPE_SET) as EventType[];
export const isKnownEventType = (t: unknown): t is EventType => typeof t === "string" && Object.prototype.hasOwnProperty.call(EVENT_TYPE_SET, t);
