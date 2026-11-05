import { describeModelProvider, selectModelProvider, type ModelProvider } from "@acr/adapters";
import { isFileSafeId } from "@acr/events";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import { isValidModelId, type EvalConfig } from "../evaluator/config.js";
import { isMockProvider, startEvaluatorProvider } from "../evaluator/provider.js";

export class CalibrationInputError extends Error {}

export type JudgeSpec = { label: string; model: string; baseUrl?: string };
export type Judge = { label: string; model: string; family: string; provider: ModelProvider };

const FAMILIES = ["gemma", "qwen", "nemotron", "claude", "gpt", "llama", "mistral", "ministral", "holo", "raptor", "foundation", "gemini", "deepseek", "phi"];

const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);

/**
 * A family name matches only as a whole leading word: the character right after it must not be a letter (end of string, a digit, '-',
 * '_', '.' and ':' are fine), so philosopher-7b is not phi. One exception: gpt4all is a different project from the GPT models, so for
 * the gpt family a digit run followed by "all" belongs to the name (gpt4all is its own family; gpt4, gpt-4o and gpt-oss stay gpt).
 */
export function modelFamily(model: string): string {
  const tail = (model.toLowerCase().split("/").pop() ?? "").trim();
  if (tail === "") return "unknown";
  const hit = FAMILIES.find((f) => tail.startsWith(f) && !isLetter(tail[f.length]) && !(f === "gpt" && /^gpt\d+all/.test(tail)));
  if (hit === "ministral") return "mistral";
  return hit ?? (tail.split(/[-_.:]/)[0] || tail);
}

/** Normalizes like the adapters do (no trailing slash); the messages name the problem, never the value (it may hold a credential). */
function normalizeBaseUrl(raw: string, where: string): string {
  const value = raw.trim();
  let u: URL;
  try { u = new URL(value); } catch { throw new CalibrationInputError(`${where} must be a valid http or https URL`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CalibrationInputError(`${where} must be http or https`);
  if (u.username !== "" || u.password !== "") throw new CalibrationInputError(`${where} must not contain credentials (user:password@); put the key in LOCAL_API_KEY`);
  if (u.search !== "" || u.hash !== "") throw new CalibrationInputError(`${where} must not contain a query string or fragment`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export function parseJudgeSpec(raw: string): JudgeSpec {
  const parts = raw.split(",");
  if (parts.length < 2 || parts.length > 3) throw new CalibrationInputError("--judge must be label,model[,baseUrl] (a base URL cannot contain commas)");
  const [label, model, baseUrl] = parts as [string, string, string | undefined];
  if (!isFileSafeId(label)) throw new CalibrationInputError("a judge label must be 1 to 64 characters of lower-case letters, digits, '_' or '-'");
  if (!isValidModelId(model)) throw new CalibrationInputError("a judge model id must be 1 to 200 letters, digits and . _ : / + - (no spaces, no URL)");
  if (baseUrl === undefined) return { label, model };
  return { label, model, baseUrl: normalizeBaseUrl(baseUrl, "a --judge base URL") };
}

/**
 * The environment a judge's provider is built from. A second judge never inherits LOCAL_API_KEY for another host: the key is kept only
 * when the judge's endpoint is the caller's own LOCAL_BASE_URL (or the judge uses that variable itself).
 */
export function scopedJudgeEnv(spec: JudgeSpec, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // LOCAL_BASE_URL is validated only when it is used; with a URL of its own, a junk LOCAL_BASE_URL just means "not the caller's host".
  let own: string | undefined;
  if (env.LOCAL_BASE_URL !== undefined && env.LOCAL_BASE_URL.trim() !== "") {
    if (spec.baseUrl === undefined) own = normalizeBaseUrl(env.LOCAL_BASE_URL, "LOCAL_BASE_URL");
    else { try { own = normalizeBaseUrl(env.LOCAL_BASE_URL, "LOCAL_BASE_URL"); } catch { own = undefined; } }
  }
  const baseUrl = spec.baseUrl === undefined ? own : normalizeBaseUrl(spec.baseUrl, "a --judge base URL");
  if (!baseUrl) throw new CalibrationInputError(`judge ${spec.label}: no base URL (give one in --judge or set LOCAL_BASE_URL)`);
  const scoped: NodeJS.ProcessEnv = { ...env, MODEL_PROVIDER: "local", LOCAL_BASE_URL: baseUrl, NPC_MODEL: spec.model };
  if (baseUrl !== own) delete scoped.LOCAL_API_KEY;
  return scoped;
}

function provider(build: () => ModelProvider): ModelProvider {
  try { return build(); } catch (e) {
    if (e instanceof CalibrationInputError) throw e;
    throw new CalibrationInputError(e instanceof Error ? e.message : "the judge provider could not be configured");
  }
}

export function buildJudge(spec: JudgeSpec, env: NodeJS.ProcessEnv): Judge {
  if (!isValidModelId(spec.model)) throw new CalibrationInputError(`judge ${spec.label}: the model id is invalid`);
  const scoped = scopedJudgeEnv(spec, env);
  const retry = parseModelRetry(env);
  if (!retry.ok) throw new CalibrationInputError(retry.errors.join("; "));
  const p = provider(() => withModelRetry(selectModelProvider(scoped, "npc", { sdkRetries: false }), retry, "EVAL"));
  return { label: spec.label, model: spec.model, family: modelFamily(spec.model), provider: p };
}

/** The providers the adapters know (matched exactly, as the adapters do) and the base URL variable each one validates. */
const BASE_URL_VARIABLE = new Map<string, string>([["anthropic", "ANTHROPIC_BASE_URL"], ["openrouter", "OPENROUTER_BASE_URL"], ["local", ""]]);

export function buildPrimaryJudge(env: NodeJS.ProcessEnv, cfg: EvalConfig): Judge {
  const mp = (env.MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (mp === "" || mp === "mock" || isMockProvider(env)) {
    throw new CalibrationInputError("MODEL_PROVIDER is mock: calibration needs a real primary judge (set MODEL_PROVIDER, its key and EVAL_MODEL or NPC_MODEL; --judge only adds a second judge)");
  }
  const baseUrlVar = BASE_URL_VARIABLE.get(env.MODEL_PROVIDER ?? "");
  if (baseUrlVar === undefined) throw new CalibrationInputError("MODEL_PROVIDER is not a known provider (use anthropic, openrouter or local)");
  try { describeModelProvider(env); } catch {
    throw new CalibrationInputError(baseUrlVar ? `${baseUrlVar} is not a valid base URL for MODEL_PROVIDER=${env.MODEL_PROVIDER} (use https, or http on a loopback address)` : "the model provider settings are invalid");
  }
  const npc = (env.NPC_MODEL ?? "").trim();
  const model = cfg.model ?? npc;
  if (model === "") throw new CalibrationInputError("no judge model id: set EVAL_MODEL or NPC_MODEL so the judge can be named");
  if (!isValidModelId(model)) throw new CalibrationInputError("the judge model id (EVAL_MODEL or NPC_MODEL) is invalid: use 1 to 200 letters, digits and . _ : / + - (no spaces, no URL)");
  const p = provider(() => startEvaluatorProvider({ ...env, NPC_MODEL: model }, cfg));
  return { label: "primary", model, family: modelFamily(model), provider: p };
}
