import { beforeEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
const ctorMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { stream: streamMock }; constructor(opts: unknown) { ctorMock(opts); } },
}));

import { AnthropicModelProvider } from "../anthropic.js";

async function* events() {
  yield { type: "message_start" };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
  yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
}

describe("AnthropicModelProvider (SDK mocked)", () => {
  beforeEach(() => { ctorMock.mockReset(); streamMock.mockReset(); streamMock.mockImplementation(() => events()); });

  it("yields only text deltas and caches the system prompt by default", async () => {
    const p = new AnthropicModelProvider({ apiKey: "k", model: "m1" });
    let out = "";
    for await (const c of p.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 5 })) out += c;
    expect(out).toBe("Hello");
    const [params] = streamMock.mock.calls[0]!;
    expect(params.model).toBe("m1");
    expect(params.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
  });

  it("passes `temperature` only when the request sets it", async () => {
    const p = new AnthropicModelProvider({ apiKey: "k", model: "m1" });
    for await (const _ of p.stream({ system: "s", messages: [], maxTokens: 5, temperature: 0.4 })) void _;
    for await (const _ of p.stream({ system: "s", messages: [], maxTokens: 5, temperature: 0 })) void _;
    for await (const _ of p.stream({ system: "s", messages: [], maxTokens: 5 })) void _;
    expect(streamMock.mock.calls[0]![0].temperature).toBe(0.4);
    expect(streamMock.mock.calls[1]![0].temperature).toBe(0);
    expect("temperature" in streamMock.mock.calls[2]![0]).toBe(false);
  });

  it("passes a plain system string and model override when cacheSystem is false", async () => {
    const p = new AnthropicModelProvider({ apiKey: "k", model: "m1" });
    const ac = new AbortController();
    for await (const _ of p.stream({ system: "sys", messages: [], maxTokens: 5, cacheSystem: false, model: "m2" }, ac.signal)) void _;
    const [params, opts] = streamMock.mock.calls[0]!;
    expect(params.system).toBe("sys");
    expect(params.model).toBe("m2");
    expect(opts.signal).toBe(ac.signal);
  });

  it("passes only the apiKey to the SDK by default (existing behavior)", () => {
    new AnthropicModelProvider({ apiKey: "k", model: "m1" });
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "k" });
  });

  it("passes a custom endpoint as the SDK baseURL", () => {
    new AnthropicModelProvider({ apiKey: "k", model: "m1", baseUrl: "https://proxy.example/anthropic" });
    expect(ctorMock).toHaveBeenCalledWith({ apiKey: "k", baseURL: "https://proxy.example/anthropic", fetch: expect.any(Function) });
  });
});
