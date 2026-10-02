import { AnthropicModelProvider } from "./anthropic.js";
import { MockModelProvider } from "./mock.js";
import type { ModelProvider } from "./types.js";

export function selectModelProvider(env: NodeJS.ProcessEnv, role: "npc" | "gm"): ModelProvider {
  const kind = env.MODEL_PROVIDER ?? "mock";
  if (kind === "mock") return new MockModelProvider();
  if (kind === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty");
    const model = (role === "npc" ? env.NPC_MODEL : env.GM_MODEL) || "claude-sonnet-4-5";
    return new AnthropicModelProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  throw new Error(`unknown MODEL_PROVIDER '${kind}'`);
}
