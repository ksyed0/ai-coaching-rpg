import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModelProvider } from "../anthropic.js";
import { startFakeServer } from "./fake-openai-server.js";

// Real SDK (not mocked): a custom ANTHROPIC_BASE_URL must never forward x-api-key to a redirect target.
const KEY = "sk-ant-TEST-NEVER-LOG-12345";
const REQ = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8 };
const proxy = await startFakeServer({ kind: "redirect", location: "" });
const target = await startFakeServer();
afterAll(async () => { await proxy.close(); await target.close(); });

describe("AnthropicModelProvider with a custom base URL", () => {
  it("refuses redirects: the target sees no request and the error leaks no URL or key", async () => {
    proxy.mode = { kind: "redirect", location: `${target.url}/v1/messages?k=${KEY}` };
    const p = new AnthropicModelProvider({ apiKey: KEY, model: "m", baseUrl: proxy.url.replace(/\/v1$/, "") });
    let err: unknown;
    try { for await (const _ of p.stream(REQ)) void _; } catch (e) { err = e; }
    expect(err).toBeTruthy();
    const text = `${(err as Error).message} ${String((err as { cause?: unknown }).cause ?? "")}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(target.host);
    expect(target.requests).toHaveLength(0);
  }, 20_000);

  it("still streams normally through the wrapped fetch", async () => {
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    proxy.mode = { kind: "raw", chunks: [
      ev("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "m", usage: { input_tokens: 1, output_tokens: 1 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi " } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "there" } }),
      ev("content_block_stop", { index: 0 }),
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      ev("message_stop", {}),
    ] };
    const p = new AnthropicModelProvider({ apiKey: KEY, model: "m", baseUrl: proxy.url.replace(/\/v1$/, "") });
    let out = "";
    for await (const c of p.stream(REQ)) out += c;
    expect(out).toBe("Hi there");
  });
});
