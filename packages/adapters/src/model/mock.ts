import type { ChatRequest, ModelProvider } from "./types.js";

type Scripted = string | ((req: ChatRequest) => string);

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  readonly calls: ChatRequest[] = [];
  defaultReply = "[mock reply]";
  private queue: Scripted[];
  constructor(script: Scripted[] = []) { this.queue = [...script]; }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    const next = this.queue.shift();
    const text = next === undefined ? this.defaultReply : typeof next === "function" ? next(req) : next;
    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      yield i < words.length - 1 ? `${words[i]} ` : words[i];
    }
  }
}
