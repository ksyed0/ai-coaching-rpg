import type { ModelProvider } from "@acr/adapters";
import { isValidModelId, MAX_EVAL_MODEL_CHARS } from "../evaluator/config.js";
import { parseTemperatureEnv, DEFAULT_PLAYER_TEMPERATURE, MIN_TEMPERATURE, MAX_TEMPERATURE } from "../agents/temperatures.js";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseTimeoutEnv } from "../agents/timeouts.js";
import { DEFAULT_NPC_MAX_TOKENS, MAX_TOKENS_LIMIT, MIN_TOKENS_LIMIT } from "../agents/token-budgets.js";
import { parseRetryEnv } from "../agents/retry-config.js";
import { DEFAULT_TURN_SETTINGS, type TurnSettings } from "./turn-policy.js";
import { startPlayerProvider } from "./provider.js";

export type AiPlayerSettings = {
  /** PLAYER_MODEL; undefined means "the NPC model". */
  model?: string;
  temperature: number;
  turn: TurnSettings;
  callsPerSession: number;
  firstTokenTimeoutMs: number;
  replyTimeoutMs: number;
  /** replyTimeoutMs + 5000: one live line never takes longer, whatever the provider does. */
  hardTimeoutMs: number;
  maxTokens: number;
};

type IntSpec = { name: string; min: number; max: number; fallback: number };
/** A whole number from min to max, digits only; unset or blank gives the fallback. The error never repeats the value. */
function parseInt10(s: IntSpec, raw: string | undefined): { ok: true; value: number } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: s.fallback };
  const rule = `use a whole number from ${s.min} to ${s.max} (digits only)`;
  if (!/^[0-9]{1,12}$/.test(text)) return { ok: false, error: `${s.name} is invalid: ${rule}` };
  const value = Number(text);
  if (value < s.min || value > s.max) return { ok: false, error: `${s.name} is out of range: ${rule}` };
  return { ok: true, value };
}

/** Reads the live AI players' settings from the control service environment. Every error names the variable and its rule, never the value. */
export function parseAiPlayerSettings(env: NodeJS.ProcessEnv): { ok: true; settings: AiPlayerSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const modelRaw = (env.PLAYER_MODEL ?? "").trim();
  if (modelRaw !== "" && !isValidModelId(modelRaw)) errors.push(`PLAYER_MODEL is invalid: use a model id of 1 to ${MAX_EVAL_MODEL_CHARS} letters, digits and . _ : / + - (no spaces, no URL)`);
  // The existing parsers decide validity; the messages are built here from the variable name and rule only (theirs quote the value).
  const temp = parseTemperatureEnv("PLAYER_TEMPERATURE", env.PLAYER_TEMPERATURE, DEFAULT_PLAYER_TEMPERATURE);
  if (!temp.ok) errors.push(`PLAYER_TEMPERATURE is invalid: use a number from ${MIN_TEMPERATURE} to ${MAX_TEMPERATURE} (digits and an optional decimal point only)`);
  const d = DEFAULT_TURN_SETTINGS;
  const specs = {
    minGapMs: { name: "AI_PLAYER_MIN_GAP_MS", min: 0, max: 600_000, fallback: d.minGapMs },
    nudgeMs: { name: "AI_PLAYER_NUDGE_MS", min: 10_000, max: 3_600_000, fallback: d.nudgeMs },
    linesPerScene: { name: "AI_PLAYER_LINES_PER_SCENE", min: 1, max: 100, fallback: d.linesPerScene },
    settleMs: { name: "AI_PLAYER_SETTLE_MS", min: 0, max: 60_000, fallback: d.settleMs },
  } as const;
  const turn: Partial<TurnSettings> = {};
  for (const k of Object.keys(specs) as Array<keyof TurnSettings>) {
    const r = parseInt10(specs[k], env[specs[k].name]);
    if (r.ok) turn[k] = r.value; else errors.push(r.error);
  }
  const calls = parseInt10({ name: "AI_PLAYER_CALLS_PER_SESSION", min: 0, max: 1000, fallback: 60 }, env.AI_PLAYER_CALLS_PER_SESSION);
  if (!calls.ok) errors.push(calls.error);
  const timeoutRule = `use a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} (digits only, no units)`;
  const first = parseTimeoutEnv("NPC_FIRST_TOKEN_TIMEOUT_MS", env.NPC_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
  const reply = parseTimeoutEnv("NPC_REPLY_TIMEOUT_MS", env.NPC_REPLY_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS);
  if (!first.ok) errors.push(`NPC_FIRST_TOKEN_TIMEOUT_MS is invalid: ${timeoutRule}`);
  if (!reply.ok) errors.push(`NPC_REPLY_TIMEOUT_MS is invalid: ${timeoutRule}`);
  if (first.ok && reply.ok && reply.value < first.value) errors.push("NPC_REPLY_TIMEOUT_MS must be at least NPC_FIRST_TOKEN_TIMEOUT_MS");
  // Only NPC_MAX_TOKENS: GM_MAX_TOKENS (also read by parseTokenBudgets) is not an AI player setting and must not refuse it.
  const tokens = parseRetryEnv({ name: "NPC_MAX_TOKENS", min: MIN_TOKENS_LIMIT, max: MAX_TOKENS_LIMIT, fallback: DEFAULT_NPC_MAX_TOKENS }, env.NPC_MAX_TOKENS);
  if (!tokens.ok) errors.push(`NPC_MAX_TOKENS is invalid: use a whole number from ${MIN_TOKENS_LIMIT} to ${MAX_TOKENS_LIMIT} (digits only)`);
  if (errors.length || !temp.ok || !calls.ok || !first.ok || !reply.ok || !tokens.ok) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      ...(modelRaw === "" ? {} : { model: modelRaw }), temperature: temp.value, turn: turn as TurnSettings, callsPerSession: calls.value,
      firstTokenTimeoutMs: first.value, replyTimeoutMs: reply.value, hardTimeoutMs: reply.value + 5_000, maxTokens: tokens.value,
    },
  };
}

/** The model provider for the live AI players: PLAYER_MODEL when set, otherwise the NPC model. */
export function startLivePlayerProvider(env: NodeJS.ProcessEnv, settings: AiPlayerSettings): ModelProvider {
  return startPlayerProvider(env, settings.model);
}
