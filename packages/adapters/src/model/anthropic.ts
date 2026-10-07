import Anthropic from "@anthropic-ai/sdk";
import { ModelProviderError, classifyHttpStatus, classifyInBandError, parseRetryAfter, type Classification } from "./errors.js";
import { sanitizeSnippet } from "./openai-compatible.js";
import type { ChatRequest, ModelProvider } from "./types.js";

/**
 * Global fetch that refuses redirects; drops node-fetch-only init (`agent`). Only a refused REDIRECT is rewritten (to a fixed
 * message without any URL, detected through fetch's own "unexpected redirect" cause); every other failure (reset, refusal,
 * DNS, TLS) is rethrown unchanged so the SDK reports it as a connection error that can be classified as transient.
 */
const noRedirectFetch = (async (url: unknown, init?: Record<string, unknown>) => {
  const { agent: _agent, ...rest } = init ?? {};
  void _agent;
  try { return await fetch(url as string, { ...rest, redirect: "error" } as RequestInit); }
  catch (err) {
    if ((rest.signal as AbortSignal | undefined)?.aborted) throw err;
    const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
    if (typeof cause?.message === "string" && /unexpected redirect/i.test(cause.message)) {
      throw new Error("request to the custom Anthropic endpoint failed (redirects are refused)");
    }
    throw err;
  }
}) as unknown as NonNullable<ConstructorParameters<typeof Anthropic>[0]>["fetch"];

/** An in-stream error body ({"type":"error","error":{"type":"overloaded_error","message":...}}) -> classification. */
function classifyStreamErrorType(type: unknown, message: string): Classification {
  if (type === "overloaded_error") return { kind: "overloaded", transient: true };
  if (type === "rate_limit_error") return { kind: "rate_limited", transient: true };
  if (type === "api_error") return { kind: "server_error", transient: true };
  if (type === "timeout_error" || type === "timeout") return { kind: "timeout", transient: true };
  if (type === "authentication_error" || type === "permission_error") return { kind: "auth", transient: false };
  if (type === "not_found_error") return { kind: "not_found", transient: false };
  if (type === "invalid_request_error") return { kind: "bad_request", transient: false };
  return classifyInBandError(message);
}

const SSE_PREFIX = "SSE Error: ";

/**
 * Turns an SDK error into a ModelProviderError, or returns null when it is not a provider failure (the caller's abort,
 * a programming error): those must pass through untouched. Duck-typed on `status` and the SDK class NAME, so it works
 * with the real SDK classes and with the mocked-SDK seam used in tests. The message is built from fixed text plus a
 * sanitized snippet of the API's own error message, never from request data, URLs or headers.
 *
 * The SDK raises an SSE `event: error` as `APIError.generate(undefined, "SSE Error: <json>", ...)`, which (no status) is an
 * APIConnectionError whose `cause` carries that text: it is told apart from a real connection failure by the prefix.
 * Not classified: a socket error in the middle of a response body, which the SDK's MessageStream rethrows as a generic
 * AnthropicError that cannot be told apart reliably (it surfaces unchanged, as a permanent error).
 */
export function classifyAnthropicError(err: unknown, redact: (text: string) => string = (t) => t): ModelProviderError | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; headers?: Record<string, string | null | undefined>; error?: unknown; cause?: { message?: unknown; code?: unknown } };
  const name = (err as object).constructor?.name;
  if (name === "APIUserAbortError") return null;
  const snippet = (t: string) => sanitizeSnippet(redact(t));
  if (name === "APIConnectionTimeoutError") return new ModelProviderError("anthropic request failed: timed out", { kind: "timeout", transient: true });
  if (name === "APIConnectionError") {
    const causeMessage = typeof e.cause?.message === "string" ? e.cause.message : "";
    if (causeMessage.startsWith(SSE_PREFIX)) {
      const raw = causeMessage.slice(SSE_PREFIX.length);
      let body: { type?: unknown; error?: { type?: unknown; message?: unknown } } | undefined;
      try { body = JSON.parse(raw) as typeof body; } catch { body = undefined; }
      const message = typeof body?.error?.message === "string" ? body.error.message : body === undefined ? raw : "";
      const c = classifyStreamErrorType(body?.error?.type, message);
      return new ModelProviderError(`anthropic reported an error${message ? `: ${snippet(message)}` : ""}`, c);
    }
    const redirect = /redirects are refused/.test(causeMessage);
    const notFound = e.cause?.code === "ENOTFOUND";
    return new ModelProviderError(`anthropic request failed: ${redirect ? "redirects are refused" : "connection error"}`, { kind: "network", transient: !redirect && !notFound });
  }
  if (typeof e.status === "number") {
    const body = e.error as { message?: unknown; error?: { message?: unknown } } | undefined;
    const apiMessage = [body?.error?.message, body?.message].find((m): m is string => typeof m === "string" && m !== "");
    const c = classifyHttpStatus(e.status);
    const retryAfterMs = c.transient ? parseRetryAfter(e.headers?.["retry-after"]) : undefined;
    return new ModelProviderError(`anthropic request failed with HTTP ${e.status}${apiMessage ? `: ${snippet(apiMessage)}` : ""}`, { ...c, status: e.status, retryAfterMs });
  }
  return null;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  readonly #apiKey: string;
  private readonly sdkRetries: boolean;
  /** `baseUrl` is an optional custom endpoint (proxy / gateway); it must already be validated (see endpoint.ts). */
  /**
   * `sdkRetries: false` passes `maxRetries: 0` with every request, so the SDK's own retries (twice, honoring Retry-After up to
   * 60 s, not abortable) stay off; the code that wraps this provider in a RetryingModelProvider sets it, so only ONE layer
   * retries and the wrapper's backoff stays abortable. Default true: an unwrapped provider keeps the SDK's behavior.
   */
  constructor(opts: { apiKey: string; model: string; baseUrl?: string; sdkRetries?: boolean }) {
    this.sdkRetries = opts.sdkRetries ?? true;
    // Default path stays exactly as before. With a custom endpoint the SDK's own node-fetch would FOLLOW redirects and
    // forward x-api-key to the target, so route through the global fetch with redirect:"error".
    this.client = new Anthropic(opts.baseUrl ? { apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: noRedirectFetch } : { apiKey: opts.apiKey });
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    const n = req.cachePrefixChars;
    const split = n !== undefined && Number.isInteger(n) && n > 0 && n < req.system.length;
    const system = req.cacheSystem === false
      ? req.system
      : split // US-0019: the breakpoint after the stable prefix only; the changing rest follows uncached, and the two texts rebuild the prompt exactly
        ? [{ type: "text" as const, text: req.system.slice(0, n), cache_control: { type: "ephemeral" as const } }, { type: "text" as const, text: req.system.slice(n) }]
        : [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }];
    try {
      const stream = this.client.messages.stream(
        { model: req.model ?? this.model, max_tokens: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), system, messages: req.messages },
        { signal, ...(this.sdkRetries ? {} : { maxRetries: 0 }) },
      );
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
      }
    } catch (err) {
      if (signal?.aborted) throw err; // the caller's own abort is never classified
      throw classifyAnthropicError(err, (t) => (this.#apiKey ? t.split(this.#apiKey).join("[redacted]") : t)) ?? err;
    }
  }
}
