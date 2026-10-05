import { z } from "zod";
import type { SessionEvent, SessionState } from "@acr/events";

export const MAX_UTTERANCE_CHARS = 2_000;
const Id = z.string().min(1).max(128);

const FacilitatorCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("pause") }), z.object({ command: z.literal("resume") }), z.object({ command: z.literal("advance") }),
  z.object({ command: z.literal("fire_inject"), injectId: Id }),
  z.object({ command: z.literal("whisper"), roleId: Id, text: z.string().min(1).max(MAX_UTTERANCE_CHARS) }),
  z.object({ command: z.literal("set_npc_stance"), roleId: Id, goals: z.array(z.string().max(MAX_UTTERANCE_CHARS)).max(50) }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), sessionId: Id, roleId: Id, participantId: Id, reconnectToken: z.string().min(1).max(128).optional() }),
  z.object({ type: z.literal("join_facilitator"), sessionId: Id }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("say"), text: z.string().min(1).max(MAX_UTTERANCE_CHARS), expectSceneId: Id.optional() }),
  z.object({ type: z.literal("command"), command: FacilitatorCommandSchema, expectSceneId: Id.optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "joined"; roleId: string | "facilitator"; brief?: string; privateFacts?: string[]; reconnectToken?: string; state: SessionState }
  | { type: "event"; event: SessionEvent }
  | { type: "error"; code: string; message: string };
