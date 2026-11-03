// Types and one small guard. Hand-written mirror of the runtime's wire protocol, because services/runtime/src/host/protocol.ts
// (zod schemas, runtime imports) is not importable from a Next app. SOURCE: services/runtime/src/host/protocol.ts (ClientMessageSchema,
// ServerMessage) and host/roster.ts (roster entries). Only the messages the BFF sends or reads are mirrored. The contract tests against the
// real runtime (hub.runtime.test.ts) pin this file against drift: change both together.
import type { FacilitatorInject, PlayerScene, PlayerSnapshot, SessionEvent, SessionState } from "@acr/events";

export type SessionStatus = SessionState["status"];

/** SOURCE: FacilitatorCommandSchema in the runtime's protocol.ts. */
export type FacilitatorCommand =
  | { command: "pause" } | { command: "resume" } | { command: "advance" }
  | { command: "fire_inject"; injectId: string }
  | { command: "whisper"; roleId: string; text: string }
  | { command: "release_hidden"; roleId: string; fact: number }
  | { command: "set_npc_stance"; roleId: string; goals: string[] };

export type ClientMessage =
  | { type: "join"; sessionId: string; roleId: string; participantId: string; reconnectToken?: string; joinCode?: string; lastSeq?: number;
      /** Ask a join by code for a durable credential (returned once in `joined`). */
      issueCredential?: boolean; /** Rejoin with the credential instead of the code. */ credential?: string; displayName?: string }
  /** The facilitator's login. The token is the control service's per-start secret; never logged. */
  | { type: "join_facilitator"; sessionId: string; token: string; lastSeq?: number }
  /** The facilitator's Start (refused by the runtime until its start gate is met). */
  | { type: "start" }
  | { type: "consent"; noticeVersion: string }
  | { type: "withdraw_consent" }
  | { type: "leave" }
  | { type: "say"; text: string; expectSceneId?: string }
  /** US-0059: a facilitator control. `by` is the facilitator's name; `ref` asks the runtime to answer with an `ack` (or an `error` carrying it). */
  | { type: "command"; command: FacilitatorCommand; expectSceneId?: string; by?: string; ref?: string }
  | { type: "end_now"; message?: string; by?: string; ref?: string };

/** A command as the hub's callers give it: the hub adds the `ref`. */
export type CommandMessage = Extract<ClientMessage, { type: "command" | "end_now" }> extends infer M ? (M extends unknown ? Omit<M, "ref"> : never) : never;

export type ReplaySummary = { afterSeq: number; toSeq: number; events: number; complete: boolean };

export type JoinedFrame = {
  type: "joined";
  roleId: string;
  brief?: string;
  privateFacts?: string[];
  reconnectToken?: string;
  /** A player join carries a PlayerSnapshot; the facilitator join carries the full SessionState (with `talk`). */
  state: SessionState | PlayerSnapshot;
  /** Present only when the join carried lastSeq: `events` event frames follow at once. */
  replay?: ReplaySummary;
  /** The durable credential, only on the join by code that asked for it. The one copy. */
  credential?: string;
  /** Title, goal and time box of the scenes this role takes part in, in script order; the facilitator join lists every scene. */
  scenes?: (PlayerScene & { injects?: FacilitatorInject[] })[];
  /** Facilitator join only: each AI character's hidden facts, in the order `release_hidden` numbers them (1-based). */
  hiddenFacts?: Record<string, string[]>;
  /** The session's random log identity, on every player join when the server keeps seats. */
  logIdentity?: string;
  /** The notice to agree to and whether this participant has agreed. */
  consent?: { noticeVersion: string; notice: string; given: boolean };
};

/** What the facilitator sees of a seat. */
export type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean };
/** What a player sees of another seat. */
export type PeerRosterEntry = { roleId: string; name?: string; ready: boolean; /** US-0060: an AI player holds this seat. */ ai?: true };

export type ServerMessage =
  | JoinedFrame
  | { type: "event"; event: SessionEvent }
  | { type: "roster"; audience: "facilitator"; entries: FacilitatorRosterEntry[] }
  | { type: "roster"; audience: "peers"; entries: PeerRosterEntry[] }
  /** US-0059: the runtime's answer to a `command` or `end_now` that carried a `ref`, to the sender only. */
  | { type: "ack"; ref: string }
  | { type: "error"; code: string; message: string; ref?: string };

export type FacilitatorRoster = Extract<ServerMessage, { type: "roster"; audience: "facilitator" }>;
/** A roster frame meant for the facilitator (the runtime sends it right after `joined`, and again on every change). */
export const isFacilitatorRoster = (m: ServerMessage): m is FacilitatorRoster => m.type === "roster" && m.audience === "facilitator";
