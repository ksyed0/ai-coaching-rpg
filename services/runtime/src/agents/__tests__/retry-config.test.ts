import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS } from "@acr/adapters";
import { MockModelProvider, ModelProviderError } from "@acr/adapters";
import { retryCapMs, withModelRetry, MAX_MODEL_RETRIES, MAX_RETRY_BASE_MS, MIN_RETRY_BASE_MS, parseModelRetry, parseRetryEnv } from "../retry-config.js";

describe("retry config defaults and bounds", () => {
  it("default to 2 retries and a 500 ms base (the adapters' constants), within 0..5 and 100..10000", () => {
    expect([DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS]).toEqual([2, 500]);
    expect([MAX_MODEL_RETRIES, MIN_RETRY_BASE_MS, MAX_RETRY_BASE_MS]).toEqual([5, 100, 10_000]);
  });
});

describe("parseRetryEnv", () => {
  const spec = { name: "MODEL_MAX_RETRIES", min: 0, max: 5, fallback: 2 };
  it.each([["0", 0], ["5", 5], ["3", 3], ["  4  ", 4], ["\t1\n", 1], ["002", 2]])("accepts %j as %i", (raw, value) => {
    expect(parseRetryEnv(spec, raw)).toEqual({ ok: true, value });
  });
  it.each([[undefined], [""], ["   "], ["\n"]])("uses the default for %j", (raw) => {
    expect(parseRetryEnv(spec, raw)).toEqual({ ok: true, value: 2 });
  });
  it.each([["-1"], ["+1"], ["1.5"], ["1e1"], ["0x2"], ["two"], ["NaN"], ["3 retries"], ["١"], ["1,0"]])("rejects %j as invalid", (raw) => {
    const r = parseRetryEnv(spec, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("MODEL_MAX_RETRIES"); expect(r.error).toContain("0 to 5"); }
  });
  it.each([["6"], ["100"], ["99999999999999999999"]])("rejects %j as out of range, naming the range", (raw) => {
    const r = parseRetryEnv(spec, raw);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error).toContain("MODEL_MAX_RETRIES"); expect(r.error).toContain("0 to 5"); }
  });
  it("sanitizes and truncates the offending value", () => {
    const r = parseRetryEnv(spec, "x".repeat(300) + "\u001b[31m\nSECRET");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.length).toBeLessThan(200); expect(r.error).not.toMatch(/SECRET|\u001b|\n/); }
  });
});

describe("parseModelRetry", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseModelRetry({})).toEqual({ ok: true, maxRetries: 2, baseMs: 500 });
  });
  it("reads both variables, accepting the boundaries", () => {
    expect(parseModelRetry({ MODEL_MAX_RETRIES: "0", MODEL_RETRY_BASE_MS: "100" })).toEqual({ ok: true, maxRetries: 0, baseMs: 100 });
    expect(parseModelRetry({ MODEL_MAX_RETRIES: "5", MODEL_RETRY_BASE_MS: "10000" })).toEqual({ ok: true, maxRetries: 5, baseMs: 10_000 });
  });
  it("reports every invalid variable, naming each with its range", () => {
    const r = parseModelRetry({ MODEL_MAX_RETRIES: "9", MODEL_RETRY_BASE_MS: "50" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(2);
      expect(r.errors[0]).toMatch(/MODEL_MAX_RETRIES.*0 to 5/);
      expect(r.errors[1]).toMatch(/MODEL_RETRY_BASE_MS.*100 to 10000/);
    }
  });
  it("treats blank values as unset", () => {
    expect(parseModelRetry({ MODEL_MAX_RETRIES: " ", MODEL_RETRY_BASE_MS: "" })).toEqual({ ok: true, maxRetries: 2, baseMs: 500 });
  });
});

describe("retryCapMs and withModelRetry", () => {
  it("the cap is max(4 s, base): a larger MODEL_RETRY_BASE_MS is not silently clamped", () => {
    expect([retryCapMs(100), retryCapMs(500), retryCapMs(4_000), retryCapMs(8_000), retryCapMs(10_000)]).toEqual([4_000, 4_000, 4_000, 8_000, 10_000]);
  });
  it("with a base of 8 s the first wait is at least 6 s (it would be at most 5 s under a fixed 4 s cap)", async () => {
    vi.useFakeTimers();
    try {
      const inner = new MockModelProvider([new ModelProviderError("busy", { kind: "overloaded", transient: true, status: 503 }), "ok"]);
      const p = withModelRetry(inner, { maxRetries: 1, baseMs: 8_000 }, "NPC");
      const done = (async () => { for await (const _ of p.stream({ system: "", messages: [], maxTokens: 1 })) void _; })();
      await vi.advanceTimersByTimeAsync(5_999);
      expect(inner.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_001);
      await done;
      expect(inner.calls).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});
