import { describeModelProvider, selectModelProvider, type ModelProvider } from "@acr/adapters";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import type { EvalConfig } from "./config.js";
import type { Rubric } from "@acr/script";
import { rubricHash } from "../calibration/rubric-hash.js";
import { lookupCalibration, type StampState } from "../calibration/stamp.js";
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
export function evaluatorInfo(env: NodeJS.ProcessEnv, cfg: EvalConfig, o: { scripted?: boolean; /** The effective model id (EVAL_MODEL, else NPC_MODEL): the one the calibration lookup used. */ model?: string } = {}): EvaluatorInfo {
  if (o.scripted) return { provider: "scripted offline evaluator (demo data, not a real assessment)", scripted: true };
  return { provider: describeModelProvider(env), ...(o.model ? { model: o.model } : cfg.model ? { model: cfg.model } : {}) };
}

/** The evaluator prompt variant in use. Only the base prompt exists (variants are US-0038), so this is a constant. Bump it whenever the prompt or parser changes. */
export const PROMPT_VARIANT = "v1";

/**
 * The complete EvaluatorInfo of a run, shared by `pnpm evaluate` and the showcase `--evaluate`: provider label, the effective model (EVAL_MODEL, else the
 * trimmed NPC_MODEL), prompt variant, rubric hash and the calibration stamp. The scripted evaluator is never looked up (its scores are demo data).
 * Never throws for a calibration problem: an unhashable rubric or an unreadable file gives not_calibrated.
 */
export async function buildEvaluatorInfo(o: { env: NodeJS.ProcessEnv; cfg: EvalConfig; scripted: boolean; scenarioId: string; rubrics: Rubric[]; calibrationDir: string }): Promise<EvaluatorInfo> {
  const model = o.cfg.model ?? (o.env.NPC_MODEL ?? "").trim();
  let hash: string | undefined;
  try { hash = rubricHash(o.rubrics); } catch { hash = undefined; }
  const calibration: StampState = o.scripted || model === "" || hash === undefined ? { state: "not_calibrated" }
    : await lookupCalibration(o.calibrationDir, o.scenarioId, model, PROMPT_VARIANT, hash);
  return { ...evaluatorInfo(o.env, o.cfg, { scripted: o.scripted, ...(model === "" ? {} : { model }) }), variant: PROMPT_VARIANT, ...(hash === undefined ? {} : { rubricHash: hash }), calibration };
}
