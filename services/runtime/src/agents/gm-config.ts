import { parseTimeoutEnv, gmDeadlineMs } from "./timeouts.js";
import { parseRetryEnv } from "./retry-config.js";

/** The Game Master judges each gm_detects condition after this many NEW utterances in a scene (GM_EVERY_N_UTTERANCES). */
export const DEFAULT_GM_EVERY_N_UTTERANCES = 3;
export const MIN_GM_EVERY_N = 1;
export const MAX_GM_EVERY_N = 20;

export type GmConfig = { timeoutMs: number; reask: boolean; everyNUtterances: number };
export type GmConfigParse = ({ ok: true } & GmConfig) | { ok: false; errors: string[] };

/**
 * Reads GM_TIMEOUT_MS (500..600000 ms; unset keeps max(NPC_REPLY_TIMEOUT_MS, 60 s), the deadline of one Game Master call with its
 * retries and re-ask), GM_REASK (0 or 1, default 1: one re-ask after a reply with no usable verdict) and GM_EVERY_N_UTTERANCES
 * (1..20, default 3). Errors name the variable, never a value beyond a short quote of the bad input.
 */
export function parseGmConfig(env: NodeJS.ProcessEnv, replyTimeoutMs: number): GmConfigParse {
  const timeout = parseTimeoutEnv("GM_TIMEOUT_MS", env.GM_TIMEOUT_MS, gmDeadlineMs(replyTimeoutMs));
  const reask = parseRetryEnv({ name: "GM_REASK", min: 0, max: 1, fallback: 1 }, env.GM_REASK);
  const every = parseRetryEnv({ name: "GM_EVERY_N_UTTERANCES", min: MIN_GM_EVERY_N, max: MAX_GM_EVERY_N, fallback: DEFAULT_GM_EVERY_N_UTTERANCES }, env.GM_EVERY_N_UTTERANCES);
  const errors = [timeout, reask, every].flatMap((r) => (r.ok ? [] : [r.error]));
  if (!timeout.ok || !reask.ok || !every.ok) return { ok: false, errors };
  return { ok: true, timeoutMs: timeout.value, reask: reask.value === 1, everyNUtterances: every.value };
}
