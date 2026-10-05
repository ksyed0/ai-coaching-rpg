import { DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS, withRetry, type ModelProvider, type RetryInfo } from "@acr/adapters";
import { show } from "./timeouts.js";

/** MODEL_MAX_RETRIES and MODEL_RETRY_BASE_MS: the defaults live in @acr/adapters (retry.ts); only the allowed ranges live here. */
export const MIN_MODEL_RETRIES = 0;
export const MAX_MODEL_RETRIES = 5;
export const MIN_RETRY_BASE_MS = 100;
export const MAX_RETRY_BASE_MS = 10_000;

export type RetryEnvSpec = { name: string; min: number; max: number; fallback: number };
export type RetryEnvParse = { ok: true; value: number } | { ok: false; error: string };

/** One strict integer variable (same style as parseTimeoutEnv): digits only after trimming; unset or blank gives the default. */
export function parseRetryEnv(spec: RetryEnvSpec, raw: string | undefined): RetryEnvParse {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, value: spec.fallback };
  const range = `a whole number from ${spec.min} to ${spec.max}`;
  if (!/^[0-9]+$/.test(text)) return { ok: false, error: `${spec.name} ${show(text)} is invalid: use ${range} (digits only)` };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) return { ok: false, error: `${spec.name} ${show(text)} is out of range: use ${range}` };
  return { ok: true, value };
}

export type ModelRetryConfig = { maxRetries: number; baseMs: number };
export type ModelRetryParse = ({ ok: true } & ModelRetryConfig) | { ok: false; errors: string[] };

/** Reads MODEL_MAX_RETRIES (0..5, default 2; 0 disables retrying) and MODEL_RETRY_BASE_MS (100..10000, default 500). */
export function parseModelRetry(env: NodeJS.ProcessEnv): ModelRetryParse {
  const retries = parseRetryEnv({ name: "MODEL_MAX_RETRIES", min: MIN_MODEL_RETRIES, max: MAX_MODEL_RETRIES, fallback: DEFAULT_MODEL_MAX_RETRIES }, env.MODEL_MAX_RETRIES);
  const base = parseRetryEnv({ name: "MODEL_RETRY_BASE_MS", min: MIN_RETRY_BASE_MS, max: MAX_RETRY_BASE_MS, fallback: DEFAULT_MODEL_RETRY_BASE_MS }, env.MODEL_RETRY_BASE_MS);
  const errors = [retries, base].flatMap((r) => (r.ok ? [] : [r.error]));
  if (!retries.ok || !base.ok) return { ok: false, errors };
  return { ok: true, maxRetries: retries.value, baseMs: base.value };
}

/**
 * Wraps a LIVE provider with the retry policy (the name is unchanged). `log` receives at most one short line per model call
 * that needed a retry: the role label, the failure kind, an HTTP status and the delay; never a message, URL or key.
 */
export function withModelRetry(provider: ModelProvider, cfg: ModelRetryConfig, role: "NPC" | "GM", log?: (m: string) => void): ModelProvider {
  const onRetry = log ? (i: RetryInfo) => log(`${role} model call: ${i.kind}${i.status !== undefined ? ` (HTTP ${i.status})` : ""}, retrying in ${i.delayMs} ms`) : undefined;
  return withRetry(provider, { maxRetries: cfg.maxRetries, baseMs: cfg.baseMs, onRetry });
}
