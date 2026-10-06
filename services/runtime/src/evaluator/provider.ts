import { describeModelProvider, selectModelProvider, type ModelProvider } from "@acr/adapters";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import type { EvalConfig } from "./config.js";
import type { EvaluatorInfo } from "./report-model.js";

/** True when MODEL_PROVIDER resolves to the scripted mock (the default). */
export function isMockProvider(env: NodeJS.ProcessEnv): boolean {
  try { return describeModelProvider(env) === "mock"; } catch { return false; } // an invalid MODEL_PROVIDER is reported when the provider is started
}

/**
 * The model provider for the evaluator: the same selection and retry layer the AI characters use, with `EVAL_MODEL` (when set) in place of
 * `NPC_MODEL`. Throws a message that names variables, never values, when the configuration is unusable.
 */
export function startEvaluatorProvider(env: NodeJS.ProcessEnv, cfg: EvalConfig): ModelProvider {
  const retry = parseModelRetry(env);
  if (!retry.ok) throw new Error(retry.errors.join("; "));
  const scoped = cfg.model === undefined ? env : { ...env, NPC_MODEL: cfg.model };
  return withModelRetry(selectModelProvider(scoped, "npc", { sdkRetries: false }), retry, "EVAL");
}

/** What a report says about who produced the scores: a fixed provider label (no endpoint, no key) and the model id when EVAL_MODEL is set. */
export function evaluatorInfo(env: NodeJS.ProcessEnv, cfg: EvalConfig, o: { scripted?: boolean } = {}): EvaluatorInfo {
  if (o.scripted) return { provider: "scripted offline evaluator (demo data, not a real assessment)", scripted: true };
  return { provider: describeModelProvider(env), ...(cfg.model ? { model: cfg.model } : {}) };
}
