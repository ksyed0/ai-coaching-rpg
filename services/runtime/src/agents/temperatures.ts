import { show } from "./timeouts.js";

/**
 * Sampling temperature per model call: NPC_TEMPERATURE (AI characters), PLAYER_TEMPERATURE (the demo's generated player bots) and
 * GM_TEMPERATURE (Game Master verdicts, lower for steadier JSON). A decimal from 0 to 2.
 */
export const DEFAULT_NPC_TEMPERATURE = 0.8;
export const DEFAULT_PLAYER_TEMPERATURE = 0.9;
export const DEFAULT_GM_TEMPERATURE = 0.2;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;

export type TemperatureEnvParse = { ok: true; value: number } | { ok: false; error: string };

/** One strict decimal variable: digits with an optional fraction (no sign, exponent or units), 0 to 2; unset or blank gives the default. */
export function parseTemperatureEnv(name: string, raw: string | undefined, fallback: number): TemperatureEnvParse {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: fallback };
  const range = `a number from ${MIN_TEMPERATURE} to ${MAX_TEMPERATURE}`;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(text)) return { ok: false, error: `${name} ${show(text)} is invalid: use ${range} (digits and an optional decimal point only)` };
  const value = Number(text);
  if (!Number.isFinite(value) || value < MIN_TEMPERATURE || value > MAX_TEMPERATURE) return { ok: false, error: `${name} ${show(text)} is out of range: use ${range}` };
  return { ok: true, value };
}

export type TemperaturesParse = { ok: true; npcTemperature: number; playerTemperature: number; gmTemperature: number } | { ok: false; errors: string[] };

export function parseTemperatures(env: NodeJS.ProcessEnv): TemperaturesParse {
  const npc = parseTemperatureEnv("NPC_TEMPERATURE", env.NPC_TEMPERATURE, DEFAULT_NPC_TEMPERATURE);
  const player = parseTemperatureEnv("PLAYER_TEMPERATURE", env.PLAYER_TEMPERATURE, DEFAULT_PLAYER_TEMPERATURE);
  const gm = parseTemperatureEnv("GM_TEMPERATURE", env.GM_TEMPERATURE, DEFAULT_GM_TEMPERATURE);
  if (!npc.ok || !player.ok || !gm.ok) return { ok: false, errors: [npc, player, gm].flatMap((r) => (r.ok ? [] : [r.error])) };
  return { ok: true, npcTemperature: npc.value, playerTemperature: player.value, gmTemperature: gm.value };
}
