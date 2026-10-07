import { parseTemperatureEnv } from "../agents/temperatures.js";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseNpcTimeouts, parseTimeoutEnv } from "../agents/timeouts.js";
import { parseRetryEnv } from "../agents/retry-config.js";

/** EVAL_MAX_TOKENS: the evaluator's reply is a long JSON document, so its budget is far above the NPC's. */
export const DEFAULT_EVAL_MAX_TOKENS = 3_000;
export const MIN_EVAL_TOKENS = 200;
export const MAX_EVAL_TOKENS = 8_000;
export const DEFAULT_EVAL_TEMPERATURE = 0.2;
export const DEFAULT_EVAL_TIMEOUT_MS = 180_000;
/** The most transcript text (characters) sent in one evaluator call before it is trimmed. */
export const DEFAULT_EVAL_TRANSCRIPT_CHARS = 60_000;
export const MIN_EVAL_TRANSCRIPT_CHARS = 5_000;
export const MAX_EVAL_TRANSCRIPT_CHARS = 400_000;
export const MAX_EVAL_MODEL_CHARS = 200;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
/** The one rule for a model id (EVAL_MODEL, NPC_MODEL, a calibration judge): 1 to 200 characters of the MODEL_ID class, never a URL. */
export function isValidModelId(m: string): boolean {
  return m.length > 0 && m.length <= MAX_EVAL_MODEL_CHARS && MODEL_ID.test(m) && !m.includes("://");
}

export type EvalConfig = {
  /** EVAL_MODEL; undefined means "the NPC model". */
  model: string | undefined;
  maxTokens: number;
  temperature: number;
  /** One overall deadline per evaluator call (retries and backoff happen inside it); never below the NPC reply timeout. */
  timeoutMs: number;
  /** The first-token wait: at least the NPC's, at least 60 s (a reasoning model may think first), never above the overall deadline. */
  firstTokenTimeoutMs: number;
  transcriptChars: number;
};
export type EvalConfigParse = ({ ok: true } & EvalConfig) | { ok: false; errors: string[] };

/**
 * Reads EVAL_MODEL (default: the NPC model), EVAL_MAX_TOKENS (3000, 200..8000), EVAL_TEMPERATURE (0.2, 0..2), EVAL_TIMEOUT_MS (180000,
 * 500..600000, validated like the NPC timeouts; the effective value is exactly max(EVAL_TIMEOUT_MS, NPC_REPLY_TIMEOUT_MS), with no other floor)
 * and EVAL_TRANSCRIPT_CHARS (60000). The first-token wait is max(NPC_FIRST_TOKEN_TIMEOUT_MS, 60 s), capped at the deadline.
 * Every error names a variable, never a value beyond a short quoted fragment.
 */
export function parseEvalConfig(env: NodeJS.ProcessEnv): EvalConfigParse {
  const errors: string[] = [];
  const model = (env.EVAL_MODEL ?? "").trim();
  if (model !== "" && !isValidModelId(model)) {
    errors.push(`EVAL_MODEL is invalid: use a model id of 1 to ${MAX_EVAL_MODEL_CHARS} letters, digits and . _ : / + - (no spaces, no URL)`);
  }
  const tokens = parseRetryEnv({ name: "EVAL_MAX_TOKENS", min: MIN_EVAL_TOKENS, max: MAX_EVAL_TOKENS, fallback: DEFAULT_EVAL_MAX_TOKENS }, env.EVAL_MAX_TOKENS);
  const temp = parseTemperatureEnv("EVAL_TEMPERATURE", env.EVAL_TEMPERATURE, DEFAULT_EVAL_TEMPERATURE);
  const timeout = parseTimeoutEnv("EVAL_TIMEOUT_MS", env.EVAL_TIMEOUT_MS, DEFAULT_EVAL_TIMEOUT_MS);
  const chars = parseRetryEnv({ name: "EVAL_TRANSCRIPT_CHARS", min: MIN_EVAL_TRANSCRIPT_CHARS, max: MAX_EVAL_TRANSCRIPT_CHARS, fallback: DEFAULT_EVAL_TRANSCRIPT_CHARS }, env.EVAL_TRANSCRIPT_CHARS);
  const npc = parseNpcTimeouts(env);
  for (const r of [tokens, temp, timeout, chars]) if (!r.ok) errors.push(r.error);
  if (!npc.ok) errors.push(...npc.errors);
  if (errors.length || !tokens.ok || !temp.ok || !timeout.ok || !chars.ok || !npc.ok) return { ok: false, errors };
  const timeoutMs = Math.max(timeout.value, npc.replyTimeoutMs);
  return {
    ok: true, model: model === "" ? undefined : model, maxTokens: tokens.value, temperature: temp.value, timeoutMs,
    firstTokenTimeoutMs: Math.min(timeoutMs, Math.max(npc.firstTokenTimeoutMs, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, 60_000)), transcriptChars: chars.value,
  };
}

export const EVAL_TIMEOUT_RANGE = { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS };
