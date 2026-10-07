import { z } from "zod";
import { CLIENT_ID_MAX_CHARS, type SessionEvent, type SessionState } from "@acr/events";
import { MAX_JOIN_CODE_INPUT_CHARS } from "../engine/join-codes.js";

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
  z.object({ type: z.literal("join"), sessionId: Id, roleId: Id, participantId: Id, reconnectToken: z.string().min(1).max(128).optional(), joinCode: z.string().max(MAX_JOIN_CODE_INPUT_CHARS).optional(), lastSeq: LastSeq }),
  z.object({ type: z.literal("join_facilitator"), sessionId: Id, token: z.string().max(256).optional(), lastSeq: LastSeq }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("say"), text: z.string().min(1).max(MAX_UTTERANCE_CHARS), expectSceneId: Id.optional() }),
  z.object({ type: z.literal("command"), command: FacilitatorCommandSchema, expectSceneId: Id.optional() }),
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
      replay?: ReplaySummary }
  | { type: "event"; event: SessionEvent }
  | { type: "error"; code: string; message: string };
