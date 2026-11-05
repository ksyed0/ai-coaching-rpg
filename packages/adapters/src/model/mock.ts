import type { ChatRequest, ModelProvider } from "./types.js";

/**
 * One scripted call: a reply string, a function of the request, or a FAILURE. To drive error handling in tests put an
 * `Error` (typically a `ModelProviderError`) in the script: the call throws it on the first read, before any chunk. For a
 * failure after some output use `{ text, thenFail }`: the words of `text` are yielded and then `thenFail` is thrown.
 * Every call, failing or not, is recorded in `calls` and consumes one script entry.
 */
type Scripted = string | ((req: ChatRequest) => string) | Error | { text: string; thenFail: Error };

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  readonly calls: ChatRequest[] = [];
  defaultReply = "[mock reply]";
  private queue: Scripted[];
  constructor(script: Scripted[] = []) { this.queue = [...script]; }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    const failure = typeof next === "object" && next !== null ? next.thenFail : undefined;
    const text = next === undefined ? this.defaultReply : typeof next === "function" ? next(req) : typeof next === "object" ? next.text : next;
    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      yield i < words.length - 1 ? `${words[i]} ` : words[i];
    }
    if (failure) throw failure;
  }
}
