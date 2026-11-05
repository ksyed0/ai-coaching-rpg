import { describe, expect, it } from "vitest";
import { liveTestsEnabled } from "../live-gate.js";

describe("liveTestsEnabled", () => {
  it("is off with a key but no flag", () => {
    expect(liveTestsEnabled({ ANTHROPIC_API_KEY: "dummy" })).toBe(false);
  });
  it("is off with the flag but no key", () => {
    expect(liveTestsEnabled({ RUN_LIVE_MODEL_TESTS: "1" })).toBe(false);
  });
  it("is off when the flag is not exactly 1", () => {
    expect(liveTestsEnabled({ RUN_LIVE_MODEL_TESTS: "true", ANTHROPIC_API_KEY: "dummy" })).toBe(false);
  });
  it("is on with both", () => {
    expect(liveTestsEnabled({ RUN_LIVE_MODEL_TESTS: "1", ANTHROPIC_API_KEY: "dummy" })).toBe(true);
  });
});
