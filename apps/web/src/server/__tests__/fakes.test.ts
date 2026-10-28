import { describe, expect, it } from "vitest";
import { until } from "./fakes";

describe("until", () => {
  it("resolves once the condition holds", async () => {
    let n = 0;
    await until(() => ++n >= 3);
    expect(n).toBe(3);
  });

  it("gives up with a clear message instead of hanging until the test timeout", async () => {
    await expect(until(() => false, { what: "the stream to end", limitMs: 20 })).rejects.toThrow("until: gave up waiting for the stream to end");
  });
});
