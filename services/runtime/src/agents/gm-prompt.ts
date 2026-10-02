import type { SessionState } from "@acr/events";
import type { Scene } from "@acr/script";
import type { ChatRequest } from "@acr/adapters";

/** Only the current scene's data, the condition text and role ids; never participant display names. */
export function buildGmRequest(opts: { scene: Scene; condition: string; state: SessionState }): ChatRequest {
  const { scene, condition, state } = opts;
  const lines = state.transcript.filter((u) => u.sceneId === scene.id).map((u) => `[${u.roleId}]: ${u.text}`).join("\n") || "(no dialogue yet)";
  const system = [
    "You are the Game Master of a role-play training session. You never speak as a character.",
    `Scene: ${scene.title}. Goal: ${scene.goal}.`,
    `Decide whether this condition is now true in the dialogue: "${condition}".`,
    'Answer with JSON only: {"verdict": true or false, "reasoning": "one sentence citing what was said"}.',
    "Be strict: the condition must be clearly met by what was said, not merely attempted.",
  ].join("\n");
  return { system, messages: [{ role: "user", content: `Dialogue so far:\n${lines}` }], maxTokens: 200, cacheSystem: false };
}

/**
 * Accepts one JSON object, optionally wrapped in prose or code fences. Returns null for anything else:
 * non-JSON, several objects, or a `verdict` that is not a real boolean (so "true" or 1 is never truthy).
 */
export function parseGmVerdict(text: string): { verdict: boolean; reasoning: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { verdict?: unknown; reasoning?: unknown };
    if (typeof obj.verdict !== "boolean") return null;
    return { verdict: obj.verdict, reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "" };
  } catch { return null; }
}
