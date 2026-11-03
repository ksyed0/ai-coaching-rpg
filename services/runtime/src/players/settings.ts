import type { ModelProvider } from "@acr/adapters";
import { isValidModelId, MAX_EVAL_MODEL_CHARS } from "../evaluator/config.js";
import { parseTemperatureEnv, DEFAULT_PLAYER_TEMPERATURE } from "../agents/temperatures.js";
import { parseNpcTimeouts } from "../agents/timeouts.js";
import { parseTokenBudgets } from "../agents/token-budgets.js";
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

/** An existing parser's error with any quoted value or number in parentheses removed: an error names a variable and its rule only. */
const redact = (e: string): string => e.replace(/\s"(?:[^"\\]|\\.)*"/g, "").replace(/\s\(\d+\)/g, "");

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
  const temp = parseTemperatureEnv("PLAYER_TEMPERATURE", env.PLAYER_TEMPERATURE, DEFAULT_PLAYER_TEMPERATURE);
  if (!temp.ok) errors.push(redact(temp.error));
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
  const timeouts = parseNpcTimeouts(env);
  if (!timeouts.ok) errors.push(...timeouts.errors.map(redact));
  const budgets = parseTokenBudgets(env);
  if (!budgets.ok) errors.push(...budgets.errors.map(redact));
  if (errors.length || !temp.ok || !calls.ok || !timeouts.ok || !budgets.ok) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      ...(modelRaw === "" ? {} : { model: modelRaw }), temperature: temp.value, turn: turn as TurnSettings, callsPerSession: calls.value,
      firstTokenTimeoutMs: timeouts.firstTokenTimeoutMs, replyTimeoutMs: timeouts.replyTimeoutMs, hardTimeoutMs: timeouts.replyTimeoutMs + 5_000, maxTokens: budgets.npcMaxTokens,
    },
  };
}

/** The model provider for the live AI players: PLAYER_MODEL when set, otherwise the NPC model. */
export function startLivePlayerProvider(env: NodeJS.ProcessEnv, settings: AiPlayerSettings): ModelProvider {
  return startPlayerProvider(env, settings.model);
}
