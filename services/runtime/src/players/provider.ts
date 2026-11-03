import { selectModelProvider, type ModelProvider } from "@acr/adapters";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";

/**
 * The model provider for the generated player bots (`--players generated`): the same provider the live system uses for the AI
 * characters (the NPC model unless `model` overrides it) behind the same transient-error retry layer. Throws a message naming
 * variables, never values, when the configuration is unusable.
 */
export function startPlayerProvider(env: NodeJS.ProcessEnv, model?: string): ModelProvider {
  const retry = parseModelRetry(env);
  if (!retry.ok) throw new Error(retry.errors.join("; "));
  return withModelRetry(selectModelProvider(model === undefined ? env : { ...env, NPC_MODEL: model }, "npc", { sdkRetries: false }), retry, "NPC");
}
