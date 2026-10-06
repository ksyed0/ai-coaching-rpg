import { afterAll, describe, expect, it } from "vitest";
import { AnthropicModelProvider } from "../anthropic.js";
import { ModelProviderError } from "../errors.js";
import { withRetry } from "../retry.js";
import type { ModelProvider } from "../types.js";
import { startFakeServer } from "./fake-openai-server.js";

// The REAL SDK against in-process loopback servers (no mock, no internet): the failures the SDK actually produces.
const KEY = "sk-ant-TEST-NEVER-LOG-12345";
const REQ = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8 };
const srv = await startFakeServer();
const target = await startFakeServer();
afterAll(async () => { await srv.close(); await target.close(); });
const base = (s: { url: string }) => s.url.replace(/\/v1$/, "");
const make = (baseUrl = base(srv), sdkRetries = false) => new AnthropicModelProvider({ apiKey: KEY, model: "m", baseUrl, sdkRetries });
const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
async function failure(p: ModelProvider): Promise<ModelProviderError> {
  try { for await (const _ of p.stream(REQ)) void _; } catch (e) { expect(e).toBeInstanceOf(ModelProviderError); return e as ModelProviderError; }
  throw new Error("expected a failure");
}
const expectClean = (e: Error) => { expect(e.message).not.toContain(KEY); expect(e.message).not.toMatch(/https?:|127\.0\.0\.1/); };

describe("real SDK: in-stream error events", () => {
  const sseError = (type: string, message: string) => `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
  it("overloaded_error is a transient 'overloaded' error (not a network error)", async () => {
    srv.mode = { kind: "raw", chunks: [ev("message_start", { message: { id: "m", type: "message", role: "assistant", content: [], model: "m", usage: { input_tokens: 1, output_tokens: 1 } } }), sseError("overloaded_error", "Overloaded")] };
    const e = await failure(make());
    expect(e).toMatchObject({ kind: "overloaded", transient: true, message: "anthropic reported an error: Overloaded" });
  });
  it.each([["invalid_request_error", "bad_request"], ["authentication_error", "auth"]] as const)("%s is permanent", async (type, kind) => {
    srv.mode = { kind: "raw", chunks: [sseError(type, `nope ${KEY}`)] };
    const e = await failure(make());
    expect(e).toMatchObject({ kind, transient: false });
    expectClean(e);
  });
});

describe("real SDK: custom endpoint connection failures", () => {
  it("a socket reset is a transient network error", async () => {
    srv.mode = { kind: "reset" };
    expect(await failure(make())).toMatchObject({ kind: "network", transient: true });
  });
  it("an unreachable port (connection refused) is a transient network error", async () => {
    const dead = await startFakeServer(); const url = base(dead); await dead.close();
    const e = await failure(make(url));
    expect(e).toMatchObject({ kind: "network", transient: true });
    expectClean(e);
  });
  it("BUG-0002: a refused connection is reported as a connection error, never as a refused redirect", async () => {
    const dead = await startFakeServer(); const url = base(dead); await dead.close();
    const e = await failure(make(url));
    expect((e as Error).message).toBe("anthropic request failed: connection error");
    expect((e as Error).message).not.toMatch(/redirect/i);
    expect(`${(e as { cause?: unknown }).cause ?? ""}`).not.toMatch(/redirect/i);
  });
  it("a redirect is a permanent, clearly worded error: no URL, and the target receives no request", async () => {
    srv.mode = { kind: "redirect", location: `${target.url}/v1/messages?k=${KEY}` };
    const e = await failure(make());
    expect(e).toMatchObject({ kind: "network", transient: false, message: "anthropic request failed: redirects are refused" });
    expectClean(e);
    expect(target.requests).toHaveLength(0);
  });
});

describe("real SDK retries are left to the wrapper", () => {
  it("a 529 yields exactly 1 + maxRetries requests when the SDK's own retries are off", async () => {
    srv.requests.length = 0;
    srv.mode = { kind: "error", status: 529, body: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) };
    const e = await failure(withRetry(make(), { maxRetries: 2, sleep: async () => {}, random: () => 0.5 }));
    expect(e).toMatchObject({ kind: "overloaded", transient: true, status: 529, attempts: 3 });
    expect(srv.requests).toHaveLength(3);
  });
});
