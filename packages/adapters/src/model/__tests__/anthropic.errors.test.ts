import { beforeEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { stream: streamMock }; } }));

import { AnthropicModelProvider } from "../anthropic.js";
import { ModelProviderError } from "../errors.js";

const KEY = "sk-ant-TEST-NEVER-LOG";
// Stand-ins named like the SDK's classes (the seam classifies by status and class name).
class APIError extends Error {
  constructor(readonly status: number | undefined, readonly error: object | undefined, message: string, readonly headers?: Record<string, string>) { super(message); }
}
class APIConnectionError extends APIError { constructor(readonly cause?: Error) { super(undefined, undefined, "Connection error."); } }
class APIConnectionTimeoutError extends APIConnectionError {}
class APIUserAbortError extends APIError { constructor() { super(undefined, undefined, "Request was aborted."); } }

const REQ = { system: "s", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 8 };
const failWith = (err: unknown, chunks: string[] = []) => streamMock.mockImplementation(async function* () {
  for (const text of chunks) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
  throw err;
});
async function run(signal?: AbortSignal): Promise<{ seen: string[]; error: unknown }> {
  const seen: string[] = [];
  try { for await (const c of new AnthropicModelProvider({ apiKey: KEY, model: "m" }).stream(REQ, signal)) seen.push(c); }
  catch (error) { return { seen, error }; }
  return { seen, error: undefined };
}

beforeEach(() => streamMock.mockReset());

describe("AnthropicModelProvider error classification", () => {
  it.each([
    [429, "rate_limited", true], [500, "server_error", true], [502, "server_error", true], [503, "overloaded", true], [504, "server_error", true],
    [529, "overloaded", true], [400, "bad_request", false], [401, "auth", false], [403, "auth", false], [404, "not_found", false], [422, "bad_request", false],
  ] as const)("status %i -> %s (transient %s)", async (status, kind, transient) => {
    failWith(new APIError(status, { type: "error", error: { type: "x", message: `bad ${KEY}\nline` } }, `${status} raw`));
    const { error } = await run();
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind, transient, status, message: `anthropic request failed with HTTP ${status}: bad [redacted] line` });
  });
  it("reads Retry-After from the SDK's lower-cased headers, only for transient statuses", async () => {
    failWith(new APIError(429, undefined, "429", { "retry-after": "3" }));
    expect((await run()).error).toMatchObject({ kind: "rate_limited", retryAfterMs: 3000 });
    failWith(new APIError(401, undefined, "401", { "retry-after": "3" }));
    expect(((await run()).error as ModelProviderError).retryAfterMs).toBeUndefined();
  });
  it("a connection error is a transient network error; a timeout is a transient timeout", async () => {
    failWith(new APIConnectionError(new Error("connect ECONNREFUSED 10.0.0.1:443")));
    const a = (await run()).error as ModelProviderError;
    expect(a).toMatchObject({ kind: "network", transient: true, message: "anthropic request failed: connection error" });
    expect(a.message).not.toMatch(/10\.0\.0\.1/);
    failWith(new APIConnectionTimeoutError());
    expect((await run()).error).toMatchObject({ kind: "timeout", transient: true });
  });
  it("a refused redirect (custom endpoint) is a permanent network error", async () => {
    failWith(new APIConnectionError(new Error("request to the custom Anthropic endpoint failed (redirects are refused)")));
    expect((await run()).error).toMatchObject({ kind: "network", transient: false });
  });
  it("an in-stream error event without a status is classified by its type", async () => {
    for (const [type, kind, transient] of [["overloaded_error", "overloaded", true], ["rate_limit_error", "rate_limited", true], ["api_error", "server_error", true], ["invalid_request_error", "bad_request", false], ["authentication_error", "auth", false]] as const) {
      failWith(new APIError(undefined, { type: "error", error: { type, message: "Overloaded" } }, "x"));
      expect((await run()).error).toMatchObject({ kind, transient, message: "anthropic reported an error: Overloaded" });
    }
    failWith(new APIError(undefined, { type: "error", error: { type: "mystery", message: "try again later" } }, "x"));
    expect((await run()).error).toMatchObject({ kind: "overloaded", transient: true });
    failWith(new APIError(undefined, { type: "error", error: { type: "mystery", message: "weird" } }, "x"));
    expect((await run()).error).toMatchObject({ kind: "unknown", transient: false });
  });
  it("an error after text was yielded is still classified (the retry wrapper decides)", async () => {
    failWith(new APIError(529, undefined, "529"), ["Hel"]);
    const { seen, error } = await run();
    expect(seen).toEqual(["Hel"]);
    expect(error).toMatchObject({ kind: "overloaded", transient: true });
  });
  it("the caller's abort is never classified (APIUserAbortError, or any error while the signal is aborted)", async () => {
    const abort = new APIUserAbortError();
    failWith(abort);
    expect((await run()).error).toBe(abort);
    const ac = new AbortController(); ac.abort();
    const other = new APIConnectionError();
    failWith(other);
    expect((await run(ac.signal)).error).toBe(other);
  });
  it("unrelated errors (not SDK API errors) pass through unchanged", async () => {
    const boom = new TypeError("bug");
    failWith(boom);
    expect((await run()).error).toBe(boom);
  });
  it("a bare string/null throw passes through", async () => {
    failWith("weird");
    expect((await run()).error).toBe("weird");
  });
});
