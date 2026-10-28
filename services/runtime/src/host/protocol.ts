import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, type PlayerScene, type SessionEvent, type SessionState } from "@acr/events";
import { MAX_JOIN_CODE_INPUT_CHARS } from "../engine/join-codes.js";
import { MAX_CREDENTIAL_INPUT_CHARS } from "../engine/credentials.js";
import type { FacilitatorRosterEntry, PeerRosterEntry } from "./roster.js";

export const MAX_UTTERANCE_CHARS = 2_000;
const Id = z.string().min(1).max(CLIENT_ID_MAX_CHARS);
/** The largest hidden-fact number a release may name (the scenario schema allows at most this many facts per character). */
export const MAX_HIDDEN_FACT_NUMBER = 50;

const FacilitatorCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("pause") }), z.object({ command: z.literal("resume") }), z.object({ command: z.literal("advance") }),
  z.object({ command: z.literal("fire_inject"), injectId: Id }),
  z.object({ command: z.literal("whisper"), roleId: Id, text: z.string().min(1).max(MAX_UTTERANCE_CHARS) }),
  z.object({ command: z.literal("release_hidden"), roleId: Id, fact: z.number().int().min(1).max(MAX_HIDDEN_FACT_NUMBER) }),
  z.object({ command: z.literal("set_npc_stance"), roleId: Id, goals: z.array(z.string().max(MAX_UTTERANCE_CHARS)).max(50) }),
]);

/**
 * US-0013: the seq of the last event this client saw (0: none). Optional; absent, a join behaves as before (snapshot, then live events).
 * A whole number from 0; one past the session's last event is refused (bad_message) after the join is authorised.
 */
const LastSeq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  // US-0033: joinCode is the role's code (required when the server issues codes); a live rejoin may present the reconnect token instead.
  // US-0053: issueCredential asks a join by code for a durable credential (returned once in `joined`); `credential` rejoins with it
  // instead of the code; displayName is the person's name (cleaned and limited to 60 code points by the server; 200 raw bounds the work).
  z.object({
    type: z.literal("join"), sessionId: Id, roleId: Id, participantId: Id, reconnectToken: z.string().min(1).max(128).optional(), joinCode: z.string().max(MAX_JOIN_CODE_INPUT_CHARS).optional(), lastSeq: LastSeq,
    issueCredential: z.boolean().optional(), credential: z.string().min(1).max(MAX_CREDENTIAL_INPUT_CHARS).optional(), displayName: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal("join_facilitator"), sessionId: Id, token: z.string().max(256).optional(), lastSeq: LastSeq }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("say"), text: z.string().min(1).max(MAX_UTTERANCE_CHARS), expectSceneId: Id.optional() }),
  z.object({ type: z.literal("command"), command: FacilitatorCommandSchema, expectSceneId: Id.optional() }),
  // US-0053: a player gives up the seat for good: the credential is revoked, consent withdrawn and the connection closed (1000).
  z.object({ type: z.literal("leave") }),
  // US-0054: a player agrees to the consent notice of this version (it must be the server's current one), or takes the consent back
  // (which, like leave, revokes the credential and frees the seat). Both are refused once the start has begun.
  z.object({ type: z.literal("consent"), noticeVersion: z.string().min(1).max(32) }),
  z.object({ type: z.literal("withdraw_consent") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ReplaySummary = { afterSeq: number; toSeq: number; events: number; complete: boolean };

export type ServerMessage =
  | { type: "joined"; roleId: string | "facilitator"; brief?: string; privateFacts?: string[]; reconnectToken?: string; state: SessionState; /** Facilitator only: a one-line note, e.g. that the server is open. */ notice?: string;
      /** Facilitator only, and only after a facilitator join (behind FACILITATOR_TOKEN when it is set): each AI character's hidden facts, in the order `release_hidden` numbers them (1-based). Never sent to a player. */
      hiddenFacts?: Record<string, string[]>;
      /**
       * US-0013: present only when the join carried `lastSeq`. `events` event frames follow this message at once, before any live event:
       * the events with seq in (afterSeq, toSeq] this viewer may see, oldest first (toSeq equals state.lastSeq). Every later event frame
       * has a seq above toSeq. `complete: false` (events 0): the range was too old or too large to replay (see MAX_REPLAY_EVENTS); rely on `state`.
       */
      replay?: ReplaySummary;
      /** US-0053: the durable credential, only on the join by code that asked for it (issueCredential). The one copy: never sent again. */
      credential?: string;
      /** US-0055: player joins only: title, goal and time box of the scenes this role takes part in, in script order. Never sent to the facilitator, never lists another role's scene. */
      scenes?: PlayerScene[];
      /** US-0053: the session's random log identity, on every player join when the server keeps seats. */
      logIdentity?: string;
      /** US-0054: players only, when the server keeps seats: the notice to agree to and whether this participant has agreed. Never another role's. */
      consent?: { noticeVersion: string; notice: string; given: boolean } }
  | { type: "event"; event: SessionEvent }
  // US-0055: who sits where. Each audience gets only its own frame: the facilitator's shows consent and connection, a player's only who is ready.
  | { type: "roster"; audience: "facilitator"; entries: FacilitatorRosterEntry[] }
  | { type: "roster"; audience: "peers"; entries: PeerRosterEntry[] }
  | { type: "error"; code: string; message: string };
