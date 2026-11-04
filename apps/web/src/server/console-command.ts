import { guard, isId, readBody, sessionIdOf } from "./console-sessions";
import { fail, ok } from "./envelope";
import type { CommandOutcome } from "./facilitator-hub";
import type { Deps } from "./handlers";
import type { CommandMessage } from "./wire";

// US-0059: the facilitator console's command and hidden-fact routes. Plain Request -> Response. The facilitator's name (`by`) comes only
// from the sealed cookie: a body carrying `by` is refused. A refusal is answered with our own fixed copy, never the runtime's text.
// Nothing is logged here: no line could carry the channel, a name or the command text.

export const COMMAND_KINDS = ["pause", "resume", "advance", "fire_inject", "whisper", "release_hidden", "set_npc_stance", "end_now"] as const;
export const COMMAND_MAX_BODY_BYTES = 32 * 1024;
/** The union of every kind's keys; parseConsoleCommand refuses any key the kind does not take. */
export const COMMAND_BODY_KEYS = ["channel", "kind", "expectSceneId", "injectId", "roleId", "text", "fact", "goals", "message"] as const;

const MAX_WHISPER_UNITS = 2000;
const MAX_GOALS = 10;
const MAX_GOAL_UNITS = 500;
const MAX_FACT = 50;
const MAX_END_MESSAGE_CODE_POINTS = 300;
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ConsoleCommand =
  | { kind: "pause" } | { kind: "resume" }
  | { kind: "advance"; expectSceneId?: string }
  | { kind: "fire_inject"; injectId: string; expectSceneId?: string }
  | { kind: "whisper"; roleId: string; text: string; expectSceneId?: string }
  | { kind: "release_hidden"; roleId: string; fact: number; expectSceneId?: string }
  | { kind: "set_npc_stance"; roleId: string; goals: string[]; expectSceneId?: string }
  | { kind: "end_now"; message?: string };

const KIND_KEYS: Record<ConsoleCommand["kind"], readonly string[]> = {
  pause: [], resume: [],
  advance: ["expectSceneId"],
  fire_inject: ["injectId", "expectSceneId"],
  whisper: ["roleId", "text", "expectSceneId"],
  release_hidden: ["roleId", "fact", "expectSceneId"],
  set_npc_stance: ["roleId", "goals", "expectSceneId"],
  end_now: ["message"],
};


/** A command body, or null for anything the kind does not take or the limits refuse. */
export function parseConsoleCommand(body: Record<string, unknown>): { channel: string; command: ConsoleCommand } | null {
  const { channel, kind } = body;
  if (typeof channel !== "string" || !CHANNEL.test(channel)) return null;
  if (typeof kind !== "string" || !(COMMAND_KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as ConsoleCommand["kind"];
  const allowed = KIND_KEYS[k];
  for (const key of Object.keys(body)) if (key !== "channel" && key !== "kind" && !allowed.includes(key)) return null;
  const scene = body.expectSceneId;
  if (scene !== undefined && !isId(scene)) return null;
  const withScene = scene === undefined ? {} : { expectSceneId: scene as string };
  switch (k) {
    case "pause": case "resume":
      return { channel, command: { kind: k } };
    case "advance":
      return { channel, command: { kind: k, ...withScene } };
    case "fire_inject":
      if (!isId(body.injectId)) return null;
      return { channel, command: { kind: k, injectId: body.injectId, ...withScene } };
    case "whisper": {
      const t = body.text;
      if (!isId(body.roleId) || typeof t !== "string" || t.length < 1 || t.length > MAX_WHISPER_UNITS || t.trim() === "") return null;
      return { channel, command: { kind: k, roleId: body.roleId, text: t, ...withScene } };
    }
    case "release_hidden": {
      const f = body.fact;
      if (!isId(body.roleId) || typeof f !== "number" || !Number.isInteger(f) || f < 1 || f > MAX_FACT) return null;
      return { channel, command: { kind: k, roleId: body.roleId, fact: f, ...withScene } };
    }
    case "set_npc_stance": {
      const g = body.goals;
      if (!isId(body.roleId) || !Array.isArray(g) || g.length < 1 || g.length > MAX_GOALS) return null;
      const goals: string[] = [];
      for (const x of g) {
        if (typeof x !== "string") return null;
        const t = x.trim();
        if (t.length < 1 || t.length > MAX_GOAL_UNITS) return null;
        goals.push(t);
      }
      return { channel, command: { kind: k, roleId: body.roleId, goals, ...withScene } };
    }
    case "end_now": {
      const m = body.message;
      if (m === undefined) return { channel, command: { kind: k } };
      if (typeof m !== "string" || [...m].length > MAX_END_MESSAGE_CODE_POINTS) return null;
      return { channel, command: { kind: k, message: m } };
    }
  }
}

/** The runtime message for a command; `by` is the cookie's name. */
export function toWire(c: ConsoleCommand, by: string): CommandMessage {
  switch (c.kind) {
    case "pause": return { type: "command", command: { command: "pause" }, by };
    case "resume": return { type: "command", command: { command: "resume" }, by };
    case "end_now": return { type: "end_now", ...(c.message !== undefined && { message: c.message }), by };
    default: {
      const scene = c.expectSceneId === undefined ? {} : { expectSceneId: c.expectSceneId };
      switch (c.kind) {
        case "advance": return { type: "command", command: { command: "advance" }, ...scene, by };
        case "fire_inject": return { type: "command", command: { command: "fire_inject", injectId: c.injectId }, ...scene, by };
        case "whisper": return { type: "command", command: { command: "whisper", roleId: c.roleId, text: c.text }, ...scene, by };
        case "release_hidden": return { type: "command", command: { command: "release_hidden", roleId: c.roleId, fact: c.fact }, ...scene, by };
        case "set_npc_stance": return { type: "command", command: { command: "set_npc_stance", roleId: c.roleId, goals: c.goals }, ...scene, by };
      }
    }
  }
}

type Answer = { status: number; code: string; message: string };
const CONFLICT_MESSAGE = "That action is not possible in the session's current state.";
export const COMMAND_ANSWERS = {
  stale_scene: { status: 409, code: "stale_scene", message: "The scene changed. Review the live view and try again." },
  not_started: { status: 409, code: "not_started", message: "The session has not started yet." },
  starting: { status: 409, code: "starting", message: "The session is still starting. Try again in a moment." },
  ended: { status: 409, code: "ended", message: "The session has ended." },
  already_released: { status: 409, code: "already_released", message: "That fact is already released." },
  unknown_inject: { status: 409, code: "conflict", message: CONFLICT_MESSAGE },
  unknown_role: { status: 409, code: "conflict", message: CONFLICT_MESSAGE },
  npc_role: { status: 409, code: "conflict", message: CONFLICT_MESSAGE },
  not_ai_role: { status: 409, code: "conflict", message: CONFLICT_MESSAGE },
  paused: { status: 409, code: "paused", message: "The session is paused. Resume it before you prompt an AI player." },
  not_in_scene: { status: 409, code: "not_in_scene", message: "That AI player is not in the current scene." },
  unknown_fact: { status: 409, code: "conflict", message: CONFLICT_MESSAGE },
  rate_limited: { status: 429, code: "rate_limited", message: "Too many actions at once. Wait a moment and try again." },
  other: { status: 502, code: "command_failed", message: "The session could not take that action. Check the live view, then try again." },
  unconfirmed: { status: 504, code: "command_unconfirmed", message: "The session did not confirm the action. Check the live view before you try again." },
  no_channel: { status: 409, code: "no_channel", message: "The live view is not connected. Wait until it is live again, then try again." },
  pending: { status: 409, code: "command_pending", message: "Another action is still being confirmed. Wait a moment, then try again." },
} as const satisfies Record<string, Answer>;

const answer = (a: Answer) => fail(a.status, a.code, a.message);
const badRequest = () => fail(400, "bad_request", "The request could not be read.");
const notFound = () => fail(404, "not_found", "That session was not found.");
const unreachable = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");

/** The answer for a command that did not succeed (or did): our own copy only. */
export function answerFor(o: CommandOutcome): Response {
  switch (o.kind) {
    case "ok": return ok({ done: true });
    case "unconfirmed": return answer(COMMAND_ANSWERS.unconfirmed);
    case "no_channel": return answer(COMMAND_ANSWERS.no_channel);
    case "pending": return answer(COMMAND_ANSWERS.pending);
    case "refused": {
      // Only the code selects our copy; the runtime's message text is never read here.
      const known = Object.prototype.hasOwnProperty.call(COMMAND_ANSWERS, o.code) && o.code !== "other" && o.code !== "unconfirmed" && o.code !== "no_channel" && o.code !== "pending";
      return answer(known ? COMMAND_ANSWERS[o.code as keyof typeof COMMAND_ANSWERS] : COMMAND_ANSWERS.other);
    }
  }
}

/** POST /api/v1/console/sessions/:id/command { channel, kind, ...fields } */
export async function handleConsoleCommand(req: Request, deps: Deps): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, COMMAND_BODY_KEYS, COMMAND_MAX_BODY_BYTES);
  if (body === null) return badRequest();
  const parsed = parseConsoleCommand(body);
  if (parsed === null) return badRequest();
  if (!deps.launcher) return unreachable();
  const outcome = await deps.facilitatorHub.send({ sessionId: id, channel: parsed.channel, message: toWire(parsed.command, g.who.name) });
  return answerFor(outcome);
}

/** POST /api/v1/console/sessions/:id/facts { channel }: the hidden-fact text of this tab's stream, from the hub's memory. */
export async function handleConsoleFacts(req: Request, deps: Deps): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, ["channel"]);
  if (body === null || typeof body.channel !== "string" || !CHANNEL.test(body.channel)) return badRequest();
  const roles = deps.facilitatorHub.factsFor(id, body.channel);
  if (roles === null) return answer(COMMAND_ANSWERS.no_channel);
  // Field by field: nothing but roleId, n and text can leave, whatever the hub's value carries.
  return ok({ roles: roles.map((r) => ({ roleId: r.roleId, facts: r.facts.map((f) => ({ n: f.n, text: f.text })) })) });
}
