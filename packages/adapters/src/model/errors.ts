/**
 * Typed model-provider failures. A provider classifies what went wrong at the point where it still knows (HTTP status,
 * in-band error object, SDK error class, socket error code) so that a retry wrapper and the callers can tell a brief
 * capacity blip (transient) from a configuration or request problem (permanent) without parsing message text.
 *
 * The caller's own abort (AbortError) is NEVER classified: providers rethrow it untouched.
 */
export type ModelErrorKind = "overloaded" | "rate_limited" | "server_error" | "network" | "timeout" | "auth" | "not_found" | "bad_request" | "unknown";

export type ModelProviderErrorInit = { kind: ModelErrorKind; transient: boolean; status?: number; retryAfterMs?: number; attempts?: number; elapsedMs?: number };

/** `message` is already sanitized by the provider (no keys, URLs, query strings, userinfo or raw control characters). */
export class ModelProviderError extends Error {
  readonly kind: ModelErrorKind;
  readonly transient: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** Set by the retry wrapper: how many attempts were made before this error was thrown. */
  readonly attempts?: number;
  readonly elapsedMs?: number;

  constructor(message: string, init: ModelProviderErrorInit) {
    super(message);
    this.name = "ModelProviderError";
    this.kind = init.kind;
    this.transient = init.transient;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.attempts !== undefined) this.attempts = init.attempts;
    if (init.elapsedMs !== undefined) this.elapsedMs = init.elapsedMs;
  }
}

export function isTransientModelError(err: unknown): err is ModelProviderError {
  return err instanceof ModelProviderError && err.transient;
}

export type Classification = { kind: ModelErrorKind; transient: boolean; status?: number };

/** A server that says "retry-after: 3600" must not park a conversational reply for an hour. */
export const MAX_RETRY_AFTER_MS = 10_000;

/** HTTP status -> classification. 429, 500/502/503/504/529 and 408 are transient; every other status is permanent. */
export function classifyHttpStatus(status: number): { kind: ModelErrorKind; transient: boolean } {
  if (status === 429) return { kind: "rate_limited", transient: true };
  if (status === 503 || status === 529) return { kind: "overloaded", transient: true };
  if (status === 500 || status === 502 || status === 504) return { kind: "server_error", transient: true };
  if (status === 408) return { kind: "timeout", transient: true };
  if (status === 401 || status === 403) return { kind: "auth", transient: false };
  if (status === 404) return { kind: "not_found", transient: false };
  if (status === 400 || status === 422) return { kind: "bad_request", transient: false };
  if (status >= 500 && status < 600) return { kind: "server_error", transient: false }; // e.g. 501: not going to change on retry
  return { kind: "unknown", transient: false };
}

const QUOTA_TEXT = /insufficient_quota|exceeded your current quota|billing|insufficient.credits|quota.exceeded|payment.required/i;

/** An exhausted quota, credit balance or billing limit: a 429 that waiting cannot fix, so it is permanent. */
export function isPermanentQuotaText(text: string): boolean { return QUOTA_TEXT.test(text); }

const TRANSIENT_TEXT = /overload|rate.?limit|capacity|temporar|try again|unavailable/i;

/**
 * An error object or string that arrived inside a 200 response or an event stream (`{error:{code,message}}`).
 * Transient when its numeric code is 429 or 5xx or its text suggests a capacity blip; otherwise permanent.
 */
export function classifyInBandError(err: unknown): Classification {
  const obj = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; message?: unknown; type?: unknown };
  const message = typeof err === "string" ? err : typeof obj.message === "string" ? obj.message : "";
  const rawCode = obj.code;
  const status = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode
    : typeof rawCode === "string" && /^\d{3}$/.test(rawCode.trim()) ? Number(rawCode.trim()) : undefined;
  const text = `${message} ${typeof rawCode === "string" ? rawCode : ""} ${typeof obj.type === "string" ? obj.type : ""}`;
  const withStatus = (c: { kind: ModelErrorKind; transient: boolean }): Classification => (status === undefined ? c : { ...c, status });
  if (isPermanentQuotaText(text)) return withStatus({ kind: "rate_limited", transient: false });
  if (status !== undefined) {
    const byStatus = classifyHttpStatus(status);
    if (byStatus.transient) return withStatus(byStatus);
    if (status >= 500 && status < 600) return withStatus({ kind: "server_error", transient: true });
  }
  if (TRANSIENT_TEXT.test(text)) return withStatus({ kind: /rate.?limit/i.test(text) ? "rate_limited" : "overloaded", transient: true });
  if (status !== undefined) return withStatus(classifyHttpStatus(status));
  return { kind: "unknown", transient: false };
}

const TRANSIENT_SOCKET_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE"]);
const TRANSIENT_SOCKET_TEXT = /socket hang up|other side closed|terminated/i;

/** A fetch/socket failure: known connection failures are transient (bounded by the caller's retry cap); anything else is permanent. */
export function classifyNetworkError(err: unknown): { kind: "network"; transient: boolean } {
  const parts: unknown[] = [err, (err as { cause?: unknown } | null)?.cause];
  for (const p of parts) {
    if (typeof p !== "object" || p === null) continue;
    const { code, message } = p as { code?: unknown; message?: unknown };
    if (typeof code === "string" && (TRANSIENT_SOCKET_CODES.has(code) || code.startsWith("UND_ERR_"))) return { kind: "network", transient: true };
    if (typeof message === "string" && TRANSIENT_SOCKET_TEXT.test(message)) return { kind: "network", transient: true };
  }
  return { kind: "network", transient: false };
}

/** `Retry-After`: delta-seconds or an HTTP date, in milliseconds, never negative and at most MAX_RETRY_AFTER_MS; undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  const text = (value ?? "").trim();
  if (text === "") return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(text)) ms = Math.round(Number(text) * 1000);
  else if (/[a-z]/i.test(text) && Number.isFinite(Date.parse(text))) ms = Math.max(0, Date.parse(text) - nowMs);
  else return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
