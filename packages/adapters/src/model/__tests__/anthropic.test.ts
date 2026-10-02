import { describe, it } from "vitest";
import { AnthropicModelProvider } from "../anthropic.js";
import { modelProviderContract } from "../contract.js";

const key = process.env.ANTHROPIC_API_KEY;
if (key) {
  modelProviderContract(() => new AnthropicModelProvider({ apiKey: key, model: process.env.NPC_MODEL ?? "claude-sonnet-4-5" }));
} else {
  describe.skip("AnthropicModelProvider (set ANTHROPIC_API_KEY to run)", () => { it("skipped", () => {}); });
}
