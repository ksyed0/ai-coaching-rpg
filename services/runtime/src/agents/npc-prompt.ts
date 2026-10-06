import { visibleTranscript, type SessionState } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import type { ChatMessage, ChatRequest } from "@acr/adapters";
import { DEFAULT_NPC_MAX_TOKENS } from "./token-budgets.js";

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

/** The sentence that names the character in the system prompt; the demo's scripted mock provider routes on it, so it lives in one place. */
export const npcIntro = (role: { name: string }): string => `You are playing ${role.name}`;

/** What an AI character may reply, exactly, to stay silent this turn. Never shown to players and never recorded. */
export const SILENT_MARKER = "<silent/>";
export const SILENCE_RULE = `If the last speaker already said what you would say and you have no decision, condition or number to add, reply with exactly ${SILENT_MARKER} and nothing else. Never stay silent when you are addressed by name or asked a question. Never describe silence in words.`;

/** What one character may know about another that is in the same scene: what any participant sees (name, title) plus the seniority it is judged by. Never goals, knowledge, hidden or private facts. */
export type PublicPeer = { id: string; name: string; title?: string; seniority?: number };

const DEFAULT_SENIORITY = 3;
const ITEM_CHARS = 160;
const MAX_ITEMS = 5;
const one = (t: string, max: number): string => { const x = t.replace(/\s+/g, " ").trim(); return x.length > max ? `${x.slice(0, max - 1)}…` : x; };
const relative = (other: number, mine: number): string => (other > mine ? "more senior than you" : other < mine ? "less senior than you" : "your peer");

/** The "## Who else is in the room" section: the other AI characters of the scene, or [] when there are none. */
export function roomSection(role: { id: string; seniority?: number }, peers: PublicPeer[]): string[] {
  const others = peers.filter((p) => p.id !== role.id);
  if (others.length === 0) return [];
  const mine = role.seniority ?? DEFAULT_SENIORITY;
  return ["", "## Who else is in the room", bullets(others.map((p) => `${one(p.name, 80)}${p.title ? `, ${one(p.title, 120)}` : ""} (${relative(p.seniority ?? DEFAULT_SENIORITY, mine)}); their lines are shown as [${p.id}]`))];
}

/** The "## How you respond" section: this character's own kind of contribution and the rules against echoing. */
export function respondSection(role: { name: string; seniority?: number; responds_with?: string[]; only_you_say?: string[]; defer_to?: string[]; defers_text?: string }, peers: PublicPeer[], allowSilence: boolean): string[] {
  const mine = role.seniority ?? DEFAULT_SENIORITY;
  const items = (l: string[] | undefined) => (l ?? []).slice(0, MAX_ITEMS).map((x) => one(x, ITEM_CHARS));
  const own = items(role.responds_with); const only = items(role.only_you_say);
  const juniors = peers.filter((p) => (p.seniority ?? DEFAULT_SENIORITY) < mine);
  const deferTo = peers.filter((p) => (role.defer_to ?? []).includes(p.id));
  return [
    "", "## How you respond",
    ...(own.length ? ["The kind of contribution you make:", bullets(own)] : []),
    ...(only.length ? ["What only you say (topics that are yours):", bullets(only)] : []),
    ...(deferTo.length ? [role.defers_text ? one(role.defers_text, 200) : `Leave the final decision on price, terms and approval to ${deferTo.map((p) => `${one(p.name, 80)}${p.title ? ` (${one(p.title, 120)})` : ""}`).join(" or ")}; say what you need, do not rule on it.`, `Speak to your own area first; do not pre-empt ${deferTo.map((p) => `${one(p.name, 80)}'s`).join(" or ")} decision on price or terms.`] : []),
    `Do not restate, paraphrase or agree-and-repeat what the previous speaker (a player or another character) just said. Open with your own angle, in your own kind of contribution.`,
    ...(juniors.length ? [`If ${juniors.map((p) => one(p.name, 80)).join(" or ")} has just answered, do not agree with them or say it again. Your first sentence must be one of: a decision (approve, refuse, or 'not in this shape'), a condition with a number or a date, or the cost or consequence in money or time. Then stop.`] : []),
    ...(allowSilence ? [SILENCE_RULE] : []),
  ];
}

export type SpokenLine = { roleId: string; text: string };

/** The rule against repeating, shared by the AI character and the generated player prompts. */
export const NO_REPEAT_RULE = "Never repeat or reword anything that has already been said, by you or by anyone else. React to the LATEST line and move the conversation forward with something new: a question, a concrete number, a concession, a condition or a next step. Speak from your own priorities, which differ from the other participants'.";
const LAST_LINES = 3;
const LAST_LINE_CHARS = 200;

/** The "## Your last lines" system section (the speaker's own most recent lines, trimmed), or [] when it has said nothing yet. Bounded: 3 lines of at most 200 characters. */
export function lastLinesSection(lines: SpokenLine[], selfId: string): string[] {
  const own = lines.filter((l) => l.roleId === selfId).slice(-LAST_LINES);
  if (own.length === 0) return [];
  const trim = (t: string) => { const one = t.replace(/\s+/g, " ").trim(); return one.length > LAST_LINE_CHARS ? `${one.slice(0, LAST_LINE_CHARS - 1)}…` : one; };
  return ["", "## Your last lines (do not repeat or reword these)", bullets(own.map((l) => trim(l.text)))];
}

/**
 * Turns the lines a role can see into Messages API turns: the role's own lines are `assistant` turns, every other speaker's are
 * `user` turns shown as `[role_id]: text`, consecutive turns of one kind are merged. The API needs the first turn to be `user` and
 * (for us) the last to be `user`. If the role spoke first, or the window cut landed on its own line, a synthetic role-id-only scene
 * marker is PREPENDED rather than dropping the leading assistant turns: dropping would erase the role's own earlier words from its
 * context and let it contradict itself. Shared by the AI characters and the demo's generated player bots.
 */
export function toChatTurns(allLines: SpokenLine[], selfId: string, window = 30): ChatMessage[] {
  const lines = allLines.slice(-window);
  const messages: ChatMessage[] = [];
  for (const u of lines) {
    const turn: ChatMessage = u.roleId === selfId ? { role: "assistant", content: u.text } : { role: "user", content: `[${u.roleId}]: ${u.text}` };
    const last = messages.at(-1);
    if (last && last.role === turn.role) last.content += `\n${turn.content}`; else messages.push(turn);
  }
  if (messages.length === 0 || messages[0]!.role === "assistant") {
    const cut = lines.length < allLines.length;
    messages.unshift({ role: "user", content: cut ? "[scene]: Earlier lines of the conversation are omitted." : "[scene]: The scene has started. Speak first if it is natural for you to." });
  }
  if (messages.at(-1)!.role === "assistant") {
    messages.push({ role: "user", content: "[scene]: Continue the conversation in character." });
  }
  return messages;
}

/**
 * Builds the NPC model request. Pure. Guardrails (Architecture section 4): only this role's own
 * persona/goals/knowledge, plus hidden facts the Game Master has released, ever reach the prompt.
 * The rubric, other roles' brief/private_facts, unreleased hidden facts and participant display
 * names are never read here; speakers are identified by role id only.
 */
export function buildNpcRequest(opts: {
  role: NpcRole; scene: Scene; state: SessionState; window?: number; maxTokens?: number; temperature?: number;
  /** The other AI characters of the scene, as every participant sees them (public data only: the type has no room for goals or secrets). */
  peers?: PublicPeer[];
  /** Offer the `<silent/>` reply (default: only when another AI character is in the room). */
  allowSilence?: boolean;
}): ChatRequest {
  const { role, scene, state } = opts;
  const npc = state.npcs[role.id] ?? { goals: role.goals, knowledge: role.knowledge, released: [] };
  const allLines = visibleTranscript(state, role.id);
  const peers = (opts.peers ?? []).filter((p) => p.id !== role.id && scene.participants.includes(p.id)).map((p): PublicPeer => ({ id: p.id, name: p.name, title: p.title, seniority: p.seniority }));
  const allowSilence = opts.allowSilence ?? peers.length > 0;
  const system = [
    `${npcIntro(role)}${role.title ? `, ${role.title}` : ""} in a live role-play training session.`,
    `You ARE ${role.name}${role.title ? `, ${role.title}` : ""}: a real person on this call, not a narrator. Speak in the first person ("I", "my team"). Never refer to yourself in the third person, neither by name nor by your own role or title${role.title ? ` (not "the ${role.title.split(",")[0]!.trim()}")` : ""}. Every other speaker is another person you are talking to.`,
    `Stay in character at all times. Speak only as ${role.name}. Reply in one to four sentences of natural spoken dialogue, no stage directions, no lists.`,
    `Other speakers are shown as [role_id]: text. Never mention role ids; address people the way ${role.name} would.`,
    `Reply with only ${role.name}'s own words. Never write a line for anyone else, never continue the conversation for the other speakers, and never begin a reply with a [...] speaker tag or with ${role.name}'s own name.`,
    NO_REPEAT_RULE,
    "", "## Persona", role.persona,
    "", "## Your current goals", bullets(npc.goals),
    "", "## What you know", bullets([...npc.knowledge, ...npc.released]),
    "", "## Rules you must follow", bullets(role.guardrails),
    "", "## Current scene", `${scene.title}: ${scene.goal}`,
    "", `## Voice`, `Style: ${role.voice.style}. Pace: ${role.voice.pace}.`,
    ...roomSection(role, peers),
    ...respondSection(role, peers, allowSilence),
    ...lastLinesSection(allLines, role.id),
  ].join("\n");

  const messages = toChatTurns(allLines, role.id, opts.window);
  return { system, messages, maxTokens: opts.maxTokens ?? DEFAULT_NPC_MAX_TOKENS, cacheSystem: true, ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) };
}
