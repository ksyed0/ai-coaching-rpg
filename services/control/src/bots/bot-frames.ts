import { z } from "zod";
import { CLIENT_ID_MAX_CHARS } from "@acr/events";

/**
 * The control service's OWN reading of the runtime's server frames for a live AI player (it must not import the runtime; the shapes
 * are those of `ServerMessage` in services/runtime/src/host/protocol.ts, checked against real frames by bot-frames.real.test.ts).
 * Default deny: an unknown type, a malformed frame or an unlisted event parses to `{ type: "ignored" }`; keys not listed here are dropped.
 */
export type BotEvent =
  /** `to` (US-0082): the role the line is addressed to, when it is. */
  | { seq: number; type: "utterance"; roleId: string; text: string; to?: string }
  | { seq: number; type: "scene.entered"; sceneId: string; participants: string[] }
  | { seq: number; type: "scene.exited"; sceneId: string }
  | { seq: number; type: "session.started"; aiRoles: string[] }
  | { seq: number; type: "session.ended" }
  | { seq: number; type: "session.resumed" }
  | { seq: number; type: "facilitator.command"; command: "pause" | "resume" };

export type BotFrame =
  | {
    type: "joined"; roleId: string; brief: string; privateFacts: string[]; reconnectToken: string;
    state: {
      status: "idle" | "running" | "ended"; paused: boolean; aiRoles: string[]; currentScene: { id: string; participants: string[] } | null; lastSeq: number;
      transcript: { seq: number; roleId: string; text: string; sceneId: string | null; to?: string }[];
    };
    scenes: { id: string; title: string; goal: string }[];
    /** US-0082: the runtime takes this bot's `activity` reports (absent from an older runtime: the bot then sends none). */
    activity?: true;
  }
  | { type: "event"; event: BotEvent }
  | { type: "roster"; audience: "peers"; entries: { roleId: string; ready: boolean; ai: boolean }[] }
  | { type: "error"; code: string; message: string }
  | { type: "ignored" };

const MAX_TRANSCRIPT = 1_000;
const MAX_SCENES = 200;
const MAX_ROLES = 256;
const MAX_TEXT = 20_000;
const MAX_BRIEF = 50_000;
const MAX_SHORT = 500;

const Id = z.string().min(1).max(CLIENT_ID_MAX_CHARS);
const Seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Ids = z.array(Id).max(MAX_ROLES);

const EventSchema = z.discriminatedUnion("type", [
  z.object({ seq: Seq, type: z.literal("utterance"), roleId: Id, text: z.string().max(MAX_TEXT), to: Id.optional().catch(undefined) }),
  z.object({ seq: Seq, type: z.literal("scene.entered"), sceneId: Id, participants: Ids }),
  z.object({ seq: Seq, type: z.literal("scene.exited"), sceneId: Id }),
  z.object({ seq: Seq, type: z.literal("session.started"), aiRoles: Ids.default([]) }),
  z.object({ seq: Seq, type: z.literal("session.ended") }),
  z.object({ seq: Seq, type: z.literal("session.resumed") }),
  z.object({ seq: Seq, type: z.literal("facilitator.command"), command: z.enum(["pause", "resume"]) }),
]);

const JoinedSchema = z.object({
  type: z.literal("joined"),
  roleId: Id,
  brief: z.string().max(MAX_BRIEF),
  privateFacts: z.array(z.string().max(MAX_TEXT)).max(MAX_ROLES).default([]),
  reconnectToken: z.string().min(1).max(128),
  state: z.object({
    status: z.enum(["idle", "running", "ended"]),
    paused: z.boolean(),
    aiRoles: Ids.default([]),
    currentScene: z.object({ id: Id, participants: Ids }).nullable(),
    lastSeq: Seq,
    // The runtime does not cap the snapshot: keep the LAST MAX_TRANSCRIPT entries rather than refusing the frame (a refused joined leaves the bot mute).
    transcript: z.array(z.object({ seq: Seq, roleId: Id, text: z.string().max(MAX_TEXT), sceneId: Id.nullable(), to: Id.optional().catch(undefined) })).transform((t) => t.slice(-MAX_TRANSCRIPT)),
  }),
  scenes: z.array(z.object({ id: Id, title: z.string().max(MAX_SHORT), goal: z.string().max(MAX_TEXT) })).max(MAX_SCENES).default([]),
  activity: z.literal(true).optional().catch(undefined),
});

const RosterSchema = z.object({
  type: z.literal("roster"),
  audience: z.literal("peers"),
  entries: z.array(z.object({ roleId: Id, ready: z.boolean(), ai: z.unknown().optional() })).max(MAX_ROLES),
});

const ErrorSchema = z.object({ type: z.literal("error"), code: z.string().max(MAX_SHORT), message: z.string().max(MAX_TEXT) });

const IGNORED: BotFrame = { type: "ignored" };

export function parseBotFrame(raw: string): BotFrame {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return IGNORED; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return IGNORED;
  switch ((json as { type?: unknown }).type) {
    case "joined": {
      const r = JoinedSchema.safeParse(json);
      return r.success ? r.data : IGNORED;
    }
    case "event": {
      const r = EventSchema.safeParse((json as { event?: unknown }).event);
      return r.success ? { type: "event", event: r.data } : IGNORED;
    }
    case "roster": {
      const r = RosterSchema.safeParse(json);
      return r.success ? { type: "roster", audience: "peers", entries: r.data.entries.map((e) => ({ roleId: e.roleId, ready: e.ready, ai: e.ai === true })) } : IGNORED;
    }
    case "error": {
      const r = ErrorSchema.safeParse(json);
      return r.success ? r.data : IGNORED;
    }
    default: return IGNORED;
  }
}
