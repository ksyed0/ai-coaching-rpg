import { describe, expect, it } from "vitest";
import { selectModelProvider } from "../select.js";

describe("selectModelProvider", () => {
  it("defaults to the mock provider", () => {
    expect(selectModelProvider({}, "npc").name).toBe("mock");
  });
  it("selects anthropic when configured with a key", () => {
    expect(selectModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }, "gm").name).toBe("anthropic");
  });
  it("throws without a key for anthropic", () => {
    expect(() => selectModelProvider({ MODEL_PROVIDER: "anthropic" }, "npc")).toThrow(/ANTHROPIC_API_KEY/);
  });
  it("throws for an unknown provider", () => {
    expect(() => selectModelProvider({ MODEL_PROVIDER: "nope" }, "npc")).toThrow(/unknown MODEL_PROVIDER/);
  });
  it("falls back to the default model when NPC_MODEL / GM_MODEL are blank or unset", () => {
    const model = (env: Record<string, string>, role: "npc" | "gm") => (selectModelProvider({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k", ...env }, role) as unknown as { model: string }).model;
    expect(model({ NPC_MODEL: "" }, "npc")).toBe("claude-sonnet-4-5");
    expect(model({ GM_MODEL: "" }, "gm")).toBe("claude-sonnet-4-5");
    expect(model({}, "npc")).toBe("claude-sonnet-4-5");
    expect(model({ NPC_MODEL: "custom-model" }, "npc")).toBe("custom-model");
  });
});
