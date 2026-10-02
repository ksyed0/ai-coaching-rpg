import { describe, it } from "vitest";
import { AnthropicModelProvider } from "../anthropic.js";
import { modelProviderContract } from "../contract.js";
import { liveTestsEnabled } from "../live-gate.js";

const key = process.env.ANTHROPIC_API_KEY;
if (liveTestsEnabled(process.env) && key) {
  modelProviderContract(() => new AnthropicModelProvider({ apiKey: key, model: process.env.NPC_MODEL ?? "claude-sonnet-4-5" }));
} else {
  describe.skip("AnthropicModelProvider live contract (set RUN_LIVE_MODEL_TESTS=1 and ANTHROPIC_API_KEY to run)", () => { it("skipped", () => {}); });
}
