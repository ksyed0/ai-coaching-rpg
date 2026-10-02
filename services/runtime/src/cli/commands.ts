import { parseArgs as nodeParseArgs } from "node:util";
import type { ClientMessage, ServerMessage } from "../host/protocol.js";
import { MAX_UTTERANCE_CHARS } from "../host/protocol.js";

export const USAGE = "usage: pnpm play --role <roleId> --name <you> [--url ws://host:8080] [--session local]\n       pnpm play --facilitator [--url ws://host:8080] [--session local]";
export const PLAYER_HELP = "type to speak to the room; /quit to leave";
export const FACILITATOR_HELP = "commands: /start /pause /resume /advance /inject <id> /whisper <role> <text> /quit";
const MAX_NAME_CHARS = 64;
const MAX_ID_CHARS = 128;

export type Options = { facilitator: boolean; role?: string; name?: string; url: string; session: string };
export type ArgsResult = { ok: true; opts: Options } | { ok: false; error: string };

const fail = (msg: string): ArgsResult => ({ ok: false, error: `${msg}\n${USAGE}` });
const hasControl = (v: string) => new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(v);

/** Pure argv parser (argv excludes node and the script). Callers print `error` and exit with code 2. */
export function parseArgs(argv: string[]): ArgsResult {
  let values: { role?: string; name?: string; url?: string; session?: string; facilitator?: boolean };
  try {
    ({ values } = nodeParseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: { role: { type: "string" }, name: { type: "string" }, url: { type: "string" }, session: { type: "string" }, facilitator: { type: "boolean" } },
    }));
  } catch (err) { return fail(`error: ${(err as Error).message.split("\n")[0]}`); }

  const facilitator = values.facilitator === true;
  if (facilitator && (values.role !== undefined || values.name !== undefined)) return fail("error: --facilitator cannot be combined with --role or --name");
  if (!facilitator && (values.role === undefined || values.name === undefined)) return fail("error: a player needs --role and --name (or use --facilitator)");

  const url = values.url ?? "ws://localhost:8080";
  let protocol = "";
  try { protocol = new URL(url).protocol; } catch { /* invalid */ }
  if (protocol !== "ws:" && protocol !== "wss:") return fail("error: --url must be a ws:// or wss:// URL");

  const session = values.session ?? "local";
  if (!session || session.length > MAX_ID_CHARS || hasControl(session)) return fail("error: --session must be 1-128 printable characters");

  if (facilitator) return { ok: true, opts: { facilitator, role: undefined, name: undefined, url, session } };
  const role = values.role!;
  const name = values.name!.trim();
  if (!role || role.length > MAX_ID_CHARS || hasControl(role)) return fail("error: --role must be 1-128 printable characters");
  if (!name || name.length > MAX_NAME_CHARS || hasControl(name)) return fail(`error: --name must be 1-${MAX_NAME_CHARS} printable characters`);
  return { ok: true, opts: { facilitator, role, name, url, session } };
}

export function joinMessage(o: Options): ClientMessage {
  return o.facilitator
    ? { type: "join_facilitator", sessionId: o.session }
    : { type: "join", sessionId: o.session, roleId: o.role!, participantId: o.name! };
}

export type Input = { kind: "none" } | { kind: "quit" } | { kind: "help"; message: string } | { kind: "send"; message: ClientMessage };

/** Parses one typed line. A mistyped slash command is never sent as in-character speech. */
export function parseInput(line: string, isFacilitator: boolean): Input {
  const text = line.trim();
  const help = (message: string): Input => ({ kind: "help", message });
  const base = isFacilitator ? FACILITATOR_HELP : PLAYER_HELP;
  if (!text) return { kind: "none" };
  if (text === "/quit") return { kind: "quit" };
  if (text === "/help") return help(base);
  if (!isFacilitator) {
    if (text.startsWith("/")) return help(`unknown command. ${base}`);
    if (text.length > MAX_UTTERANCE_CHARS) return help(`too long (max ${MAX_UTTERANCE_CHARS} characters)`);
    return { kind: "send", message: { type: "say", text } };
  }
  if (!text.startsWith("/")) return help(`the facilitator cannot speak as a role. ${base}`);
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const cmdMsg = (command: Extract<ClientMessage, { type: "command" }>["command"]): Input => ({ kind: "send", message: { type: "command", command } });
  switch (cmd) {
    case "start": return rest.length ? help("usage: /start") : { kind: "send", message: { type: "start" } };
    case "pause": case "resume": case "advance": return rest.length ? help(`usage: /${cmd}`) : cmdMsg({ command: cmd });
    case "inject": return rest.length === 1 ? cmdMsg({ command: "fire_inject", injectId: rest[0]! }) : help("usage: /inject <id>");
    case "whisper": {
      const m = /^\/whisper\s+(\S+)\s+([\s\S]+)$/.exec(text);
      if (!m) return help("usage: /whisper <role> <text>");
      if (m[2]!.length > MAX_UTTERANCE_CHARS) return help(`too long (max ${MAX_UTTERANCE_CHARS} characters)`);
      return cmdMsg({ command: "whisper", roleId: m[1]!, text: m[2]! });
    }
    default: return help(`unknown command. ${base}`);
  }
}

/** Defensive parse of a server frame; anything that is not a known, well-shaped message is dropped. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let m: unknown;
  try { m = JSON.parse(raw); } catch { return null; }
  if (typeof m !== "object" || m === null || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  if (o.type === "joined" && typeof o.roleId === "string") return o as unknown as ServerMessage;
  if (o.type === "event" && typeof o.event === "object" && o.event !== null) return o as unknown as ServerMessage;
  if (o.type === "error" && typeof o.code === "string" && typeof o.message === "string") return o as unknown as ServerMessage;
  return null;
}

/** Any error before the join completes is fatal (role_taken, unknown_role, npc_role, unknown_session, ...). Later ones are not. */
export function isFatalError(_code: string, joined: boolean): boolean {
  return !joined;
}
