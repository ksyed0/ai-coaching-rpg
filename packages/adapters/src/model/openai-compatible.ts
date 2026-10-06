import { parseBaseUrl, type EndpointPolicy } from "./endpoint.js";
import { ModelProviderError, classifyHttpStatus, isPermanentQuotaText, classifyInBandError, classifyNetworkError, parseRetryAfter } from "./errors.js";
import type { ChatRequest, ModelProvider } from "./types.js";

/** Any OpenAI-style `POST {base}/chat/completions` server: OpenRouter, Ollama, LM Studio, vLLM, llama.cpp. */
export type OpenAICompatibleName = "openrouter" | "local";

const VARIABLES: Record<OpenAICompatibleName, { key: string; url: string; policy: EndpointPolicy }> = {
  openrouter: { key: "OPENROUTER_API_KEY", url: "OPENROUTER_BASE_URL", policy: "https-or-loopback-http" },
  local: { key: "LOCAL_API_KEY", url: "LOCAL_BASE_URL", policy: "http-or-https" },
};

const MAX_ERROR_BODY_BYTES = 8 * 1024; // read at most this much of an error response
const ERROR_SNIPPET_CHARS = 300;
const MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MiB cap for the non-streaming fallback
const MAX_LINE_CHARS = 1024 * 1024; // a single SSE line longer than this is a broken or hostile server

/** Replaces control characters, collapses whitespace and truncates; never returns more than `max` chars plus an ellipsis. */
export function sanitizeSnippet(text: string, max = ERROR_SNIPPET_CHARS): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

const isText = (v: unknown): boolean => typeof v === "string" && v.length > 0;
/** True when a delta/message carries thinking text. Only the fact is kept: the text itself is never stored, yielded or put in an error. */
const hasReasoning = (o: { reasoning_content?: unknown; reasoning?: unknown } | undefined): boolean => isText(o?.reasoning_content) || isText(o?.reasoning);

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly name: OpenAICompatibleName;
  private readonly endpoint: string;
  private readonly model: string;
  // True private field: the key is invisible to JSON.stringify, util.inspect and property enumeration.
  readonly #apiKey: string | undefined;

  constructor(opts: { name: OpenAICompatibleName; baseUrl: string; model: string; apiKey?: string }) {
    const vars = VARIABLES[opts.name];
    this.name = opts.name;
    this.endpoint = `${parseBaseUrl(opts.baseUrl, vars.url, vars.policy)}/chat/completions`;
    if (!opts.model || opts.model.trim() === "") throw new Error(`${opts.name}: a model id is required`);
    this.model = opts.model;
    const key = opts.apiKey?.trim();
    // A key that is not a plain header token would make the HTTP stack throw an error that may echo the value.
    if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error(`${vars.key} contains whitespace or non-ASCII characters`);
    this.#apiKey = key || undefined;
  }

  private redact(text: string): string {
    const key = this.#apiKey;
    return key ? text.split(key).join("[redacted]") : text;
  }

  private snippet(text: string): string { return sanitizeSnippet(this.redact(text)); }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    // req.cacheSystem is ignored on purpose: prompt caching is an Anthropic-specific feature (cache_control blocks) and
    // OpenAI-compatible servers have no portable equivalent; sending the field could make a strict server reject the request.
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    const body = JSON.stringify({
      model: req.model ?? this.model,
      // An empty system message is omitted: some local chat templates mishandle it.
      messages: req.system ? [{ role: "system", content: req.system }, ...req.messages] : req.messages,
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      stream: true,
    });

    let res: Response;
    try {
      // redirect:"error": a redirect must never carry the Authorization header to another origin.
      res = await fetch(this.endpoint, { method: "POST", headers, body, signal, redirect: "error" });
    } catch (err) {
      if (signal?.aborted) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : "error");
      throw new ModelProviderError(`${this.name} request failed: ${this.snippet(String(detail))}`, classifyNetworkError(err));
    }

    if (!res.ok) {
      const text = await this.readCapped(res, MAX_ERROR_BODY_BYTES, false).catch(() => "");
      // A 429 that says the quota or billing limit is used up is permanent: waiting cannot fix it.
      const c = res.status === 429 && isPermanentQuotaText(text) ? { kind: "rate_limited" as const, transient: false } : classifyHttpStatus(res.status);
      throw new ModelProviderError(`${this.name} request failed with HTTP ${res.status}${text ? `: ${this.snippet(text)}` : ""}`, {
        ...c, status: res.status, retryAfterMs: c.transient ? parseRetryAfter(res.headers.get("retry-after")) : undefined,
      });
    }

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("application/json")) {
      // Some local servers ignore stream:true and answer with one JSON object.
      const text = await this.readCapped(res, MAX_JSON_BODY_BYTES, true);
      const content = this.contentOfJson(text);
      if (content) yield content;
      return;
    }
    if (!type.includes("text/event-stream") || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`${this.name} returned an unexpected response (content-type ${JSON.stringify(sanitizeSnippet(type, 60))}); expected text/event-stream`);
    }
    yield* this.parseSse(res.body, signal);
  }

  /**
   * A reasoning model (Qwen3, DeepSeek-R1, gpt-oss ...) that spends its whole max_tokens thinking returns the thinking in
   * `reasoning_content` or `reasoning`, no `content`, and usually finish_reason "length". That is a budget problem, not an
   * empty answer: report it as its own transient kind. The thinking text is never part of the message.
   */
  private reasoningBudgetError(): ModelProviderError {
    return new ModelProviderError(
      `${this.name}: the model used its whole token budget thinking and gave no answer; raise NPC_MAX_TOKENS (AI characters) or GM_MAX_TOKENS (Game Master), and raise NPC_FIRST_TOKEN_TIMEOUT_MS and NPC_REPLY_TIMEOUT_MS with it`,
      { kind: "reasoning_budget", transient: true },
    );
  }

  /**
   * The error for a reply with no answer text, or null when it is a plain empty reply. Reasoning only (or an empty answer cut off by
   * finish_reason "length") is a budget problem; reasoning only after a normal stop is not, so no budget advice is given for it.
   */
  private noAnswerError(sawReasoning: boolean, finish: string | undefined): ModelProviderError | null {
    if (finish === undefined || finish === "length") return sawReasoning || finish === "length" ? this.reasoningBudgetError() : null;
    if (sawReasoning) return new ModelProviderError(`${this.name}: the model returned only reasoning and no answer`, { kind: "unknown", transient: false });
    return null;
  }

  /** One body read; a failure that is not the caller's own abort is a (usually transient) network error, with a sanitized message. */
  private async readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, signal?: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
    try { return await reader.read(); }
    catch (err) {
      if (signal?.aborted) throw err;
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const detail = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : "error");
      throw new ModelProviderError(`${this.name} stream failed: ${this.snippet(String(detail))}`, classifyNetworkError(err));
    }
  }

  /** Reads up to `max` bytes then cancels the body. `strict` = throw when the body is bigger than `max`. */
  private async readCapped(res: Response, max: number, strict: boolean): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > max) {
          if (strict) throw new Error(`${this.name} response body exceeds ${max} bytes`);
          text += decoder.decode(value.subarray(0, value.byteLength - (received - max)), { stream: true });
          break;
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private contentOfJson(text: string): string {
    let obj: unknown;
    try { obj = JSON.parse(text); }
    catch { throw new Error(`${this.name} returned malformed JSON`); }
    this.throwIfErrorObject(obj);
    const choice = (obj as { choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
    const message = choice?.message;
    const content = message?.content;
    if (typeof content === "string" && content.length > 0) return content;
    const err = this.noAnswerError(hasReasoning(message), typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined);
    if (err) throw err;
    return "";
  }

  private throwIfErrorObject(obj: unknown): void {
    const err = (obj as { error?: unknown } | null)?.error;
    if (err === undefined || err === null) return;
    const message = typeof err === "string" ? err : (err as { message?: unknown }).message;
    throw new ModelProviderError(`${this.name} reported an error${typeof message === "string" && message ? `: ${this.snippet(message)}` : ""}`, classifyInBandError(err));
  }

  /**
   * Manual Server-Sent-Events parsing. Each `data:` line is handled as one event (OpenAI-style servers send one JSON
   * object per line), which also tolerates a server that omits the blank separator line. Chunks may split anywhere:
   * lines are buffered across reads and bytes go through one streaming TextDecoder so a split UTF-8 character survives.
   * Not supported (OpenAI-style servers only): multi-line `data:` events (joined with newlines per the SSE spec) and
   * `delta.content` given as an array of parts; such content is skipped.
   */
  private async *parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let sawReasoning = false; // a boolean only: the thinking text is dropped as it arrives (bounded memory)
    let sawContent = false;
    let finish: string | undefined; // the last non-null finish_reason
    const handle = (line: string): { done: boolean; text?: string } => {
      if (line === "" || line.startsWith(":")) return { done: false }; // blank separator or comment/keepalive
      if (!line.startsWith("data:")) return { done: false }; // event:, id:, retry: carry nothing we need
      const data = line.slice(5).replace(/^ /, "");
      if (data.trim() === "[DONE]") return { done: true };
      let obj: unknown;
      try { obj = JSON.parse(data); }
      catch { throw new Error(`${this.name} sent a malformed stream event`); }
      this.throwIfErrorObject(obj);
      const choices = (obj as { choices?: unknown })?.choices;
      const first = Array.isArray(choices) ? (choices[0] as { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: unknown } | undefined) : undefined;
      const delta = first?.delta;
      if (typeof first?.finish_reason === "string") finish = first.finish_reason;
      if (hasReasoning(delta)) sawReasoning = true;
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) { sawContent = true; return { done: false, text: content }; }
      return { done: false };
    };
    try {
      for (;;) {
        if (signal?.aborted) return;
        const { done, value } = await this.readChunk(reader, signal);
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        // Split only when a terminator arrived in the NEW text: a line trickling in tiny chunks is then not re-scanned
        // on every read (linear, not quadratic), and the pending partial line is capped.
        if (!/[\r\n]/.test(text)) {
          if (buffer.length > MAX_LINE_CHARS) throw new Error(`${this.name} sent an oversized stream line`);
          continue;
        }
        const lines = buffer.split(/\r\n|\n|\r/);
        buffer = lines.pop() ?? "";
        if (buffer.length > MAX_LINE_CHARS) throw new Error(`${this.name} sent an oversized stream line`);
        for (const line of lines) {
          const r = handle(line);
          if (r.done) { if (!sawContent) { const e = this.noAnswerError(sawReasoning, finish); if (e) throw e; } return; }
          if (r.text !== undefined) {
            yield r.text;
            if (signal?.aborted) return;
          }
        }
      }
      // The stream ended without [DONE]: treat as the end, but still process an unterminated final line.
      buffer += decoder.decode();
      if (buffer) {
        const r = handle(buffer);
        if (r.text !== undefined) yield r.text;
      }
      if (!sawContent) { const e = this.noAnswerError(sawReasoning, finish); if (e) throw e; }
    } finally {
      // Cancelling the reader closes the connection, so the server stops generating.
      await reader.cancel().catch(() => {});
    }
  }
}
