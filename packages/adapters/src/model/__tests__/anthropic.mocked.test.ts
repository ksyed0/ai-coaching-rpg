import { beforeEach, describe, expect, it, vi } from "vitest";

const streamMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class { messages = { stream: streamMock }; },
}));

import { AnthropicModelProvider } from "../anthropic.js";

async function* events() {
  yield { type: "message_start" };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } };
  yield { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } };
  yield { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } };
}

describe("AnthropicModelProvider (SDK mocked)", () => {
  beforeEach(() => { streamMock.mockReset(); streamMock.mockImplementation(() => events()); });

  it("yields only text deltas and caches the system prompt by default", async () => {
    const p = new AnthropicModelProvider({ apiKey: "k", model: "m1" });
    let out = "";
    for await (const c of p.stream({ system: "sys", messages: [{ role: "user", content: "hi" }], maxTokens: 5 })) out += c;
    expect(out).toBe("Hello");
    const [params] = streamMock.mock.calls[0]!;
    expect(params.model).toBe("m1");
    expect(params.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
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
});
