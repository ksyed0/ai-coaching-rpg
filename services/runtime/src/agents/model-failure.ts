import { ModelProviderError, getRetryProgress } from "@acr/adapters";

/**
 * How a failed model call is worded in a facilitator alert. A classified error says which kind it was and, when it went
 * through the retry wrapper, after how many attempts; anything else keeps the original `model error: <message>` wording.
 * `suffix` is appended before the message (the Game Master names the condition there). The message of a ModelProviderError
 * is already sanitized by the provider.
 */
export function describeModelFailure(err: unknown, suffix = ""): string {
  if (err instanceof ModelProviderError) {
    const n = err.attempts;
    const attempts = n === undefined ? "" : ` after ${n} ${n === 1 ? "attempt" : "attempts"}`;
    return `model error${attempts} (${err.kind})${suffix}: ${err.message}`;
  }
  return `model error${suffix}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * When a deadline cut a retry short, the abort carries no history: the retry wrapper remembers, per signal, how many attempts it
 * started and why the last one failed. Returns " (2 attempts made; last error: overloaded)", or "" when no retry happened.
 */
export function describeRetryProgress(signal: AbortSignal | undefined): string {
  const p = getRetryProgress(signal);
  if (!p?.lastError) return "";
  return ` (${p.attempts} ${p.attempts === 1 ? "attempt" : "attempts"} made; last error: ${p.lastError.kind})`;
}
