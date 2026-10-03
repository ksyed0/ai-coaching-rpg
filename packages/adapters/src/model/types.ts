export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatRequest = { system: string; messages: ChatMessage[]; maxTokens: number; model?: string; cacheSystem?: boolean };
export interface ModelProvider {
  readonly name: string;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string>;
}
