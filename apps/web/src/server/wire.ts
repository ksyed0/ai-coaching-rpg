// Types and one small guard. Hand-written mirror of the runtime's wire protocol, because services/runtime/src/host/protocol.ts
// (zod schemas, runtime imports) is not importable from a Next app. SOURCE: services/runtime/src/host/protocol.ts (ClientMessageSchema,
// ServerMessage) and host/roster.ts (roster entries). Only the messages the BFF sends or reads are mirrored. The contract tests against the
// real runtime (hub.runtime.test.ts) pin this file against drift: change both together.
import type { PlayerScene, PlayerSnapshot, SessionEvent, SessionState } from "@acr/events";

export type SessionStatus = SessionState["status"];

export type ClientMessage =
  | { type: "join"; sessionId: string; roleId: string; participantId: string; reconnectToken?: string; joinCode?: string; lastSeq?: number;
      /** Ask a join by code for a durable credential (returned once in `joined`). */
      issueCredential?: boolean; /** Rejoin with the credential instead of the code. */ credential?: string; displayName?: string }
  /** The facilitator's login. The token is the control service's per-start secret; never logged. */
  | { type: "join_facilitator"; sessionId: string; token: string }
  /** The facilitator's Start (refused by the runtime until its start gate is met). */
  | { type: "start" }
  | { type: "consent"; noticeVersion: string }
  | { type: "withdraw_consent" }
  | { type: "leave" }
  | { type: "say"; text: string; expectSceneId?: string };

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
  /** Title, goal and time box of the scenes this role takes part in, in script order. */
  scenes?: PlayerScene[];
  /** The session's random log identity, on every player join when the server keeps seats. */
  logIdentity?: string;
  /** The notice to agree to and whether this participant has agreed. */
  consent?: { noticeVersion: string; notice: string; given: boolean };
};

/** What the facilitator sees of a seat. */
export type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean };
/** What a player sees of another seat. */
export type PeerRosterEntry = { roleId: string; name?: string; ready: boolean };

export type ServerMessage =
  | JoinedFrame
  | { type: "event"; event: SessionEvent }
  | { type: "roster"; audience: "facilitator"; entries: FacilitatorRosterEntry[] }
  | { type: "roster"; audience: "peers"; entries: PeerRosterEntry[] }
  | { type: "error"; code: string; message: string };

export type FacilitatorRoster = Extract<ServerMessage, { type: "roster"; audience: "facilitator" }>;
/** A roster frame meant for the facilitator (the runtime sends it right after `joined`, and again on every change). */
export const isFacilitatorRoster = (m: ServerMessage): m is FacilitatorRoster => m.type === "roster" && m.audience === "facilitator";
