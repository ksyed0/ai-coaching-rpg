export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatRequest = { system: string; messages: ChatMessage[]; maxTokens: number; model?: string; cacheSystem?: boolean;
  /**
   * US-0019: with `cacheSystem`, the length (in UTF-16 units) of the system prompt's STABLE prefix: the part that stays byte-identical across a
   * character's turns and updates. A provider with explicit prompt caching (Anthropic) puts its cache breakpoint at the end of that prefix, so a
   * change after it (goals, the scene, the last lines) does not invalidate the cached part. Unset, 0, or not inside the prompt: the whole system
   * prompt is cached as before. Providers without explicit caching ignore it (OpenAI-compatible local servers reuse an identical prefix on their own).
   */
  cachePrefixChars?: number;
  /** Sampling temperature; providers send it only when set. */ temperature?: number };
export interface ModelProvider {
  readonly name: string;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string>;
}
