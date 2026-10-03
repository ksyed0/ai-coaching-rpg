import Anthropic from "@anthropic-ai/sdk";
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

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  /** `baseUrl` is an optional custom endpoint (proxy / gateway); it must already be validated (see endpoint.ts). */
  constructor(opts: { apiKey: string; model: string; baseUrl?: string }) {
    // Default path stays exactly as before. With a custom endpoint the SDK's own node-fetch would FOLLOW redirects and
    // forward x-api-key to the target, so route through the global fetch with redirect:"error".
    this.client = new Anthropic(opts.baseUrl ? { apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: noRedirectFetch } : { apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    const system = req.cacheSystem === false
      ? req.system
      : [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }];
    const stream = this.client.messages.stream(
      { model: req.model ?? this.model, max_tokens: req.maxTokens, system, messages: req.messages },
      { signal },
    );
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
  }
}
