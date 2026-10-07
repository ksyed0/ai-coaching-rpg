import { selectModelProvider, type ModelProvider } from "@acr/adapters";
import { isFileSafeId } from "@acr/events";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import type { EvalConfig } from "../evaluator/config.js";
import { isMockProvider, startEvaluatorProvider } from "../evaluator/provider.js";

export class CalibrationInputError extends Error {}

export type JudgeSpec = { label: string; model: string; baseUrl?: string };
export type Judge = { label: string; model: string; family: string; provider: ModelProvider };

const FAMILIES = ["gemma", "qwen", "nemotron", "claude", "gpt", "llama", "mistral", "ministral", "holo", "raptor", "foundation", "gemini", "deepseek", "phi"];

export function modelFamily(model: string): string {
  const tail = (model.toLowerCase().split("/").pop() ?? "").trim();
  const hit = FAMILIES.find((f) => tail.startsWith(f));
  if (hit === "ministral") return "mistral";
  return hit ?? (tail.split(/[-_.:]/)[0] || tail);
}

function validModel(m: string): boolean {
  return m.length > 0 && m.length <= 200 && !m.includes("://") && !/\s/.test(m);
}

export function parseJudgeSpec(raw: string): JudgeSpec {
  const parts = raw.split(",");
  if (parts.length < 2 || parts.length > 3) throw new CalibrationInputError(`--judge must be label,model[,baseUrl]: got "${raw.slice(0, 60)}"`);
  const [label, model, baseUrl] = parts as [string, string, string | undefined];
  if (!isFileSafeId(label)) throw new CalibrationInputError("a judge label must be 1 to 64 characters of lower-case letters, digits, '_' or '-'");
  if (!validModel(model)) throw new CalibrationInputError("a judge model id must be 1 to 200 characters with no spaces and no ://");
  if (baseUrl === undefined) return { label, model };
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new CalibrationInputError("a judge base URL must be a valid http or https URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CalibrationInputError("a judge base URL must be http or https");
  return { label, model, baseUrl };
}

export function buildJudge(spec: JudgeSpec, env: NodeJS.ProcessEnv): Judge {
  const baseUrl = spec.baseUrl ?? env.LOCAL_BASE_URL;
  if (!baseUrl) throw new CalibrationInputError(`judge ${spec.label}: no base URL (give one in --judge or set LOCAL_BASE_URL)`);
  const retry = parseModelRetry(env);
  if (!retry.ok) throw new CalibrationInputError(retry.errors.join("; "));
  const scoped = { ...env, MODEL_PROVIDER: "local", LOCAL_BASE_URL: baseUrl, NPC_MODEL: spec.model };
  const provider = withModelRetry(selectModelProvider(scoped, "npc", { sdkRetries: false }), retry, "EVAL");
  return { label: spec.label, model: spec.model, family: modelFamily(spec.model), provider };
}

export function buildPrimaryJudge(env: NodeJS.ProcessEnv, cfg: EvalConfig): Judge {
  if (isMockProvider(env)) {
    throw new CalibrationInputError("MODEL_PROVIDER is mock: calibration needs a real judge (set MODEL_PROVIDER and the model variables, or pass --judge)");
  }
  const model = cfg.model ?? env.NPC_MODEL ?? "default";
  return { label: "primary", model, family: modelFamily(model), provider: startEvaluatorProvider(env, cfg) };
}
