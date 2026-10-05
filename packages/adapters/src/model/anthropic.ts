import Anthropic from "@anthropic-ai/sdk";
import { ModelProviderError, classifyHttpStatus, classifyInBandError, parseRetryAfter, type Classification } from "./errors.js";
import { sanitizeSnippet } from "./openai-compatible.js";
import type { ChatRequest, ModelProvider } from "./types.js";

/** Global fetch that refuses redirects; drops node-fetch-only init (`agent`) and reports failures without URL or headers. */
const noRedirectFetch = (async (url: unknown, init?: Record<string, unknown>) => {
  const { agent: _agent, ...rest } = init ?? {};
  void _agent;
  try { return await fetch(url as string, { ...rest, redirect: "error" } as RequestInit); }
  catch (err) {
    if ((rest.signal as AbortSignal | undefined)?.aborted) throw err;
    throw new Error("request to the custom Anthropic endpoint failed (redirects are refused)");
  }
}) as unknown as NonNullable<ConstructorParameters<typeof Anthropic>[0]>["fetch"];

/** In-stream `event: error` bodies carry a type such as "overloaded_error"; the SDK raises them as an APIError WITHOUT a status. */
function classifyStreamErrorType(type: unknown, message: string): Classification {
  if (type === "overloaded_error") return { kind: "overloaded", transient: true };
  if (type === "rate_limit_error") return { kind: "rate_limited", transient: true };
  if (type === "api_error") return { kind: "server_error", transient: true };
  if (type === "authentication_error" || type === "permission_error") return { kind: "auth", transient: false };
  if (type === "not_found_error") return { kind: "not_found", transient: false };
  if (type === "invalid_request_error") return { kind: "bad_request", transient: false };
  return classifyInBandError(message);
}

/**
 * Turns an SDK error into a ModelProviderError, or returns null when it is not a provider failure (the caller's abort,
 * a programming error): those must pass through untouched. Duck-typed on `status` and the SDK class NAME, so it works
 * with the real SDK classes and with the mocked-SDK seam used in tests. The message is built from fixed text plus a
 * sanitized snippet of the API's own error message, never from request data, URLs or headers.
 */
export function classifyAnthropicError(err: unknown, redact: (text: string) => string = (t) => t): ModelProviderError | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; headers?: Record<string, string | null | undefined>; error?: unknown; cause?: { message?: unknown } };
  const name = (err as object).constructor?.name;
  if (name === "APIUserAbortError") return null;
  const snippet = (t: string) => sanitizeSnippet(redact(t));
  if (name === "APIConnectionTimeoutError") return new ModelProviderError("anthropic request failed: timed out", { kind: "timeout", transient: true });
  if (name === "APIConnectionError") {
    const redirect = typeof e.cause?.message === "string" && /redirects are refused/.test(e.cause.message);
    return new ModelProviderError(`anthropic request failed: ${redirect ? "redirects are refused" : "connection error"}`, { kind: "network", transient: !redirect });
  }
  const body = e.error as { type?: unknown; message?: unknown; error?: { type?: unknown; message?: unknown } } | undefined;
  const apiMessage = [body?.error?.message, body?.message].find((m): m is string => typeof m === "string" && m !== "");
  if (typeof e.status === "number") {
    const c = classifyHttpStatus(e.status);
    const retryAfterMs = c.transient ? parseRetryAfter(e.headers?.["retry-after"]) : undefined;
    return new ModelProviderError(`anthropic request failed with HTTP ${e.status}${apiMessage ? `: ${snippet(apiMessage)}` : ""}`, { ...c, status: e.status, retryAfterMs });
  }
  if (err instanceof Error && body !== undefined && typeof body === "object" && body !== null) {
    const c = classifyStreamErrorType(body.error?.type ?? body.type, apiMessage ?? "");
    return new ModelProviderError(`anthropic reported an error${apiMessage ? `: ${snippet(apiMessage)}` : ""}`, c);
  }
  return null;
}

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  readonly #apiKey: string;
  /** `baseUrl` is an optional custom endpoint (proxy / gateway); it must already be validated (see endpoint.ts). */
  constructor(opts: { apiKey: string; model: string; baseUrl?: string }) {
    // Default path stays exactly as before. With a custom endpoint the SDK's own node-fetch would FOLLOW redirects and
    // forward x-api-key to the target, so route through the global fetch with redirect:"error".
    this.client = new Anthropic(opts.baseUrl ? { apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: noRedirectFetch } : { apiKey: opts.apiKey });
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    const system = req.cacheSystem === false
      ? req.system
      : [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }];
    try {
      const stream = this.client.messages.stream(
        { model: req.model ?? this.model, max_tokens: req.maxTokens, system, messages: req.messages },
        { signal },
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
