import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ModelProvider } from "./types.js";

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  /** `baseUrl` is an optional custom endpoint (proxy / gateway); it must already be validated (see endpoint.ts). */
  constructor(opts: { apiKey: string; model: string; baseUrl?: string }) {
    this.client = new Anthropic(opts.baseUrl ? { apiKey: opts.apiKey, baseURL: opts.baseUrl } : { apiKey: opts.apiKey });
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
