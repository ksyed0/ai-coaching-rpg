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
});
