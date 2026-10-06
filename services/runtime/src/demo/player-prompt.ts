import type { SessionEvent } from "@acr/events";
import type { Scene } from "@acr/script";
import type { ChatRequest } from "@acr/adapters";
import { NO_REPEAT_RULE, lastLinesSection, toChatTurns, type SpokenLine } from "../agents/npc-prompt.js";
import { DEFAULT_NPC_MAX_TOKENS } from "../agents/token-budgets.js";

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");
/** `tech_lead` reads as "tech lead". */
export const roleLabel = (roleId: string): string => roleId.replace(/[_-]+/g, " ").trim();

/** Everything one player role is allowed to know: the data its own join message and event stream carried, plus the scene's title and goal (read from the scenario file: the server does not send them to players). */
export type PlayerView = {
  roleId: string;
  /** From the `joined` message (this role's own brief and private facts). */
  brief: string;
  privateFacts: string[];
  scene: { title: string; goal: string };
  /** The injects addressed to this role in the current scene. */
  injects: string[];
  /** The conversation this role has seen, in order. */
  lines: SpokenLine[];
};

/**
 * Derives what a player saw from the events ITS OWN connection received (the server already filtered them: other scenes, other
 * roles' injects, NPC internals and Game Master reasoning never arrive). Pure. `sceneId` is the scene being played.
 */
export function viewFromEvents(o: { roleId: string; joined: { brief?: string; privateFacts?: string[] }; scene: Pick<Scene, "id" | "title" | "goal">; events: SessionEvent[] }): PlayerView {
  const lines: SpokenLine[] = [];
  let injects: string[] = [];
  for (const e of o.events) {
    if (e.type === "scene.entered") { if (e.sceneId === o.scene.id) injects = []; }
    else if (e.type === "utterance") lines.push({ roleId: e.roleId, text: e.text });
    else if (e.type === "inject.fired" && e.sceneId === o.scene.id && e.to.includes(o.roleId)) injects.push(e.content);
  }
  return { roleId: o.roleId, brief: o.joined.brief ?? "", privateFacts: o.joined.privateFacts ?? [], scene: { title: o.scene.title, goal: o.scene.goal }, injects, lines };
}

/**
 * Builds the model request that makes a player bot speak one line. Pure. The model sees only the role's own view (see PlayerView):
 * never NPC goals, hidden facts, the rubric, other roles' briefs or private facts, or participant names. The scripted line is passed
 * as a PRIVATE intent (what to get across), appended to the last user turn, never as something to quote.
 */
export function buildPlayerRequest(o: { view: PlayerView; intent: string; window?: number; maxTokens?: number; temperature?: number }): ChatRequest {
  const { view } = o;
  const label = roleLabel(view.roleId);
  const system = [
    `You are playing the ${label} (role id ${view.roleId}) as a human trainee in a live role-play training session. The others hear what you say as if you spoke it aloud.`,
    "Speak only your own words: one to three sentences of natural spoken dialogue. No stage directions, no lists, no [role] tags, never write a line for anyone else and never continue the conversation for the other speakers. Never mention that you are an AI, a model or a script.",
    `Other speakers are shown as [role_id]: text. Never write role ids; address people the way a colleague would (by first name if you know it, otherwise by role). Your own earlier lines are your previous turns.`,
    "A private note at the end says what you want to get across this turn. Put it in your own words, react to what was just said, and never quote the note or mention that it exists.",
    NO_REPEAT_RULE,
    "", "## Your role (private to you)", view.brief || "(no brief)",
    "", "## What you know privately", bullets(view.privateFacts),
    "", "## Current scene", `${view.scene.title}: ${view.scene.goal}`,
    "", "## Messages delivered to you in this scene", bullets(view.injects),
    ...lastLinesSection(view.lines, view.roleId),
  ].join("\n");
  const messages = toChatTurns(view.lines, view.roleId, o.window);
  // toChatTurns guarantees the last turn is `user`: the private note joins it.
  const last = messages.at(-1)!;
  last.content += `\n\n[note to you only, not spoken]: What you want to get across in this turn (do not quote it): ${o.intent}`;
  return { system, messages, maxTokens: o.maxTokens ?? DEFAULT_NPC_MAX_TOKENS, cacheSystem: false, ...(o.temperature !== undefined ? { temperature: o.temperature } : {}) };
}
