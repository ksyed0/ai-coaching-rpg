import { visibleTranscript, type SessionState } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import type { ChatMessage, ChatRequest } from "@acr/adapters";
import { DEFAULT_NPC_MAX_TOKENS } from "./token-budgets.js";

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

/** The sentence that names the character in the system prompt; the demo's scripted mock provider routes on it, so it lives in one place. */
export const npcIntro = (role: { name: string }): string => `You are playing ${role.name}`;

export type SpokenLine = { roleId: string; text: string };

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
export function buildNpcRequest(opts: { role: NpcRole; scene: Scene; state: SessionState; window?: number; maxTokens?: number }): ChatRequest {
  const { role, scene, state } = opts;
  const npc = state.npcs[role.id] ?? { goals: role.goals, knowledge: role.knowledge, released: [] };
  const system = [
    `${npcIntro(role)}${role.title ? `, ${role.title}` : ""} in a live role-play training session.`,
    `You ARE ${role.name}${role.title ? `, ${role.title}` : ""}: a real person on this call, not a narrator. Speak in the first person ("I", "my team"). Never refer to yourself in the third person, neither by name nor by your own role or title${role.title ? ` (not "the ${role.title.split(",")[0]!.trim()}")` : ""}. Every other speaker is another person you are talking to.`,
    `Stay in character at all times. Speak only as ${role.name}. Reply in one to four sentences of natural spoken dialogue, no stage directions, no lists.`,
    `Other speakers are shown as [role_id]: text. Never mention role ids; address people the way ${role.name} would.`,
    `Reply with only ${role.name}'s own words. Never write a line for anyone else, never continue the conversation for the other speakers, and never begin a reply with a [...] speaker tag or with ${role.name}'s own name.`,
    "", "## Persona", role.persona,
    "", "## Your current goals", bullets(npc.goals),
    "", "## What you know", bullets([...npc.knowledge, ...npc.released]),
    "", "## Rules you must follow", bullets(role.guardrails),
    "", "## Current scene", `${scene.title}: ${scene.goal}`,
    "", `## Voice`, `Style: ${role.voice.style}. Pace: ${role.voice.pace}.`,
  ].join("\n");

  const messages = toChatTurns(visibleTranscript(state, role.id), role.id, opts.window);
  return { system, messages, maxTokens: opts.maxTokens ?? DEFAULT_NPC_MAX_TOKENS, cacheSystem: true };
}
