/** Single source of truth for the NPC timeouts: used by NpcAgent, SessionHost and bootstrap(). */
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 10_000;
export const DEFAULT_REPLY_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 500;
/** The Game Master's model call may take at least this long (the showcase allows the same per condition). */
export const MIN_GM_DEADLINE_MS = 60_000;
/** The ONE computation of the Game Master call's deadline: max(NPC reply timeout, 60 s). Retries and backoff happen inside it. */
export function gmDeadlineMs(replyTimeoutMs: number): number { return Math.max(replyTimeoutMs, MIN_GM_DEADLINE_MS); }
export const MAX_TIMEOUT_MS = 600_000;

export type TimeoutParse = { ok: true; value: number } | { ok: false; error: string };

/** Quote an untrusted value for an error message: truncated, with control characters escaped (JSON.stringify). */
export function show(raw: string): string { return JSON.stringify(raw.slice(0, 40)); }

/**
 * Parses one timeout environment variable: a base-10 positive integer number of milliseconds (no sign, exponent,
 * hex, decimals or units) within MIN_TIMEOUT_MS..MAX_TIMEOUT_MS. Whitespace is trimmed; unset or blank gives `fallback`.
 */
export function parseTimeoutEnv(name: string, raw: string | undefined, fallback: number): TimeoutParse {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: fallback };
  const range = `a whole number of milliseconds from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`;
  if (!/^[0-9]+$/.test(text)) return { ok: false, error: `${name} ${show(text)} is invalid: use ${range} (digits only, no units)` };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return { ok: false, error: `${name} ${show(text)} is out of range: use ${range}` };
  }
  return { ok: true, value };
}

export type NpcTimeoutsParse = { ok: true; firstTokenTimeoutMs: number; replyTimeoutMs: number } | { ok: false; errors: string[] };

/** Reads NPC_FIRST_TOKEN_TIMEOUT_MS and NPC_REPLY_TIMEOUT_MS; the reply deadline must be >= the first-token timeout. */
export function parseNpcTimeouts(env: NodeJS.ProcessEnv): NpcTimeoutsParse {
  const first = parseTimeoutEnv("NPC_FIRST_TOKEN_TIMEOUT_MS", env.NPC_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_FIRST_TOKEN_TIMEOUT_MS);
  const reply = parseTimeoutEnv("NPC_REPLY_TIMEOUT_MS", env.NPC_REPLY_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS);
  const errors: string[] = [];
  if (!first.ok) errors.push(first.error);
  if (!reply.ok) errors.push(reply.error);
  if (first.ok && reply.ok && reply.value < first.value) {
    errors.push(`NPC_REPLY_TIMEOUT_MS (${reply.value}) must be at least NPC_FIRST_TOKEN_TIMEOUT_MS (${first.value}); the allowed range for both is ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms`);
  }
  if (errors.length || !first.ok || !reply.ok) return { ok: false, errors };
  return { ok: true, firstTokenTimeoutMs: first.value, replyTimeoutMs: reply.value };
}
