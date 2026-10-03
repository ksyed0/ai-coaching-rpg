import { visibleTranscript, type SessionState } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import type { ChatMessage, ChatRequest } from "@acr/adapters";

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

/**
 * Builds the NPC model request. Pure. Guardrails (Architecture section 4): only this role's own
 * persona/goals/knowledge, plus hidden facts the Game Master has released, ever reach the prompt.
 * The rubric, other roles' brief/private_facts, unreleased hidden facts and participant display
 * names are never read here; speakers are identified by role id only.
 */
export function buildNpcRequest(opts: { role: NpcRole; scene: Scene; state: SessionState; window?: number }): ChatRequest {
  const { role, scene, state } = opts;
  const npc = state.npcs[role.id] ?? { goals: role.goals, knowledge: role.knowledge, released: [] };
  const system = [
    `You are playing ${role.name}${role.title ? `, ${role.title}` : ""} in a live role-play training session.`,
    `Stay in character at all times. Speak only as ${role.name}. Reply in one to four sentences of natural spoken dialogue, no stage directions, no lists.`,
    `Other speakers are shown as [role_id]: text. Never mention role ids; address people the way ${role.name} would.`,
    "", "## Persona", role.persona,
    "", "## Your current goals", bullets(npc.goals),
    "", "## What you know", bullets([...npc.knowledge, ...npc.released]),
    "", "## Rules you must follow", bullets(role.guardrails),
    "", "## Current scene", `${scene.title}: ${scene.goal}`,
    "", `## Voice`, `Style: ${role.voice.style}. Pace: ${role.voice.pace}.`,
  ].join("\n");

  const allLines = visibleTranscript(state, role.id);
  const lines = allLines.slice(-(opts.window ?? 30));
  const messages: ChatMessage[] = [];
  for (const u of lines) {
    const turn: ChatMessage = u.roleId === role.id ? { role: "assistant", content: u.text } : { role: "user", content: `[${u.roleId}]: ${u.text}` };
    const last = messages.at(-1);
    if (last && last.role === turn.role) last.content += `\n${turn.content}`; else messages.push(turn);
  }
  // The Messages API requires the first turn to be `user` and (for us) the last to be `user`.
  // If the NPC spoke first, or the window cut landed on an NPC line, we PREPEND a synthetic
  // role-id-only scene marker rather than dropping the leading assistant turns: dropping would
  // erase the NPC's own earlier words from its context and let it contradict itself.
  if (messages.length === 0 || messages[0].role === "assistant") {
    const cut = lines.length < allLines.length;
    messages.unshift({ role: "user", content: cut ? "[scene]: Earlier lines of the conversation are omitted." : "[scene]: The scene has started. Speak first if it is natural for you to." });
  }
  if (messages.at(-1)!.role === "assistant") {
    messages.push({ role: "user", content: "[scene]: Continue the conversation in character." });
  }
  return { system, messages, maxTokens: 300, cacheSystem: true };
}
