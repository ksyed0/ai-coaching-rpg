import { ModelProviderError } from "@acr/adapters";

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
  return `model error: ${err instanceof Error ? err.message : String(err)}`;
}
