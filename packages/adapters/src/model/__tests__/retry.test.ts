import { describe, expect, it, vi } from "vitest";
import { MockModelProvider } from "../mock.js";
import { ModelProviderError } from "../errors.js";
import { DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS, DEFAULT_MODEL_RETRY_CAP_MS, RetryingModelProvider, withRetry } from "../retry.js";
import type { ChatRequest, ModelProvider } from "../types.js";
import { modelProviderContract } from "../contract.js";

const REQ: ChatRequest = { system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 8 };
const transient = (over: Partial<ConstructorParameters<typeof ModelProviderError>[1]> = {}) =>
  new ModelProviderError("mock overloaded", { kind: "overloaded", transient: true, status: 503, ...over });
const permanent = () => new ModelProviderError("mock auth", { kind: "auth", transient: false, status: 401 });

/** Fake sleeper: records the delays and resolves at once. */
function sleeper() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}
const midpoint = () => 0.5; // jitter factor 1.0 exactly
async function collect(p: ModelProvider, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const c of p.stream(REQ, signal)) out.push(c);
  return out;
}
async function failure(p: ModelProvider, signal?: AbortSignal): Promise<unknown> {
  try { await collect(p, signal); } catch (e) { return e; }
  throw new Error("expected a failure");
}

modelProviderContract(() => withRetry(new MockModelProvider([(req) => (req.maxTokens >= 1000 ? Array.from({ length: 500 }, (_, i) => i + 1).join(" ") : "OK")]), { sleep: async () => {} }), {
  make: () => withRetry(new MockModelProvider([permanent()]), { sleep: async () => {} }), kind: "auth", transient: false,
});

describe("defaults", () => {
  it("are 2 retries, 500 ms base and a 4000 ms cap", () => {
    expect([DEFAULT_MODEL_MAX_RETRIES, DEFAULT_MODEL_RETRY_BASE_MS, DEFAULT_MODEL_RETRY_CAP_MS]).toEqual([2, 500, 4000]);
  });
});

describe("RetryingModelProvider", () => {
  it("keeps the provider name and passes req and signal through unchanged", async () => {
    const inner = new MockModelProvider(["fine"]);
    const spy = vi.spyOn(inner, "stream");
    const w = new RetryingModelProvider(inner, { sleep: async () => {} });
    expect(w.name).toBe("mock");
    const ac = new AbortController();
    expect(await collect(w, ac.signal)).toEqual(["fine"]);
    expect(spy).toHaveBeenCalledWith(REQ, ac.signal);
  });
  it("withRetry returns a wrapper with the same behaviour", async () => {
    expect(withRetry(new MockModelProvider(["x"]))).toBeInstanceOf(RetryingModelProvider);
  });

  it("succeeds on the first attempt without sleeping or logging", async () => {
    const s = sleeper(); const onRetry = vi.fn();
    const inner = new MockModelProvider(["all good"]);
    expect((await collect(new RetryingModelProvider(inner, { sleep: s.sleep, onRetry }))).join("")).toBe("all good");
    expect(s.delays).toEqual([]); expect(onRetry).not.toHaveBeenCalled(); expect(inner.calls).toHaveLength(1);
  });
  it("retries transient failures with exponential backoff and succeeds (exact attempts and delays)", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([transient(), transient(), "third time lucky"]);
    const out = await collect(new RetryingModelProvider(inner, { sleep: s.sleep, random: midpoint }));
    expect(out.join("")).toBe("third time lucky");
    expect(inner.calls).toHaveLength(3);
    expect(s.delays).toEqual([500, 1000]);
  });
  it("caps the backoff at capMs", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([transient(), transient(), transient(), transient(), "ok"]);
    await collect(new RetryingModelProvider(inner, { maxRetries: 4, baseMs: 1000, capMs: 2500, sleep: s.sleep, random: midpoint }));
    expect(s.delays).toEqual([1000, 2000, 2500, 2500]);
  });
  it("applies +/-25% jitter, within bounds at both extremes", async () => {
    for (const [random, expected] of [[0, 375], [0.999999, 625]] as const) {
      const s = sleeper();
      await collect(new RetryingModelProvider(new MockModelProvider([transient(), "ok"]), { sleep: s.sleep, random: () => random }));
      expect(s.delays[0]).toBeGreaterThanOrEqual(375); expect(s.delays[0]).toBeLessThanOrEqual(625);
      expect(Math.abs(s.delays[0]! - expected)).toBeLessThanOrEqual(1);
    }
  });
  it("honors Retry-After (capped at retryAfterCapMs, never below the backoff)", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([transient({ retryAfterMs: 3000 }), transient({ retryAfterMs: 60_000 }), transient({ retryAfterMs: 10 }), "ok"]);
    await collect(new RetryingModelProvider(inner, { maxRetries: 3, sleep: s.sleep, random: midpoint, retryAfterCapMs: 5000 }));
    expect(s.delays).toEqual([3000, 5000, 2000]);
  });
  it("does not retry a permanent error: attempts = 1, kind/status kept", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([permanent(), "never"]);
    const e = await failure(new RetryingModelProvider(inner, { sleep: s.sleep }));
    expect(e).toBeInstanceOf(ModelProviderError);
    expect(e).toMatchObject({ kind: "auth", transient: false, status: 401, attempts: 1, message: "mock auth" });
    expect(inner.calls).toHaveLength(1); expect(s.delays).toEqual([]);
  });
  it("lets a non-typed error through untouched, with no retry", async () => {
    const boom = new Error("boom");
    const inner = new MockModelProvider([boom]);
    expect(await failure(new RetryingModelProvider(inner, { sleep: async () => {} }))).toBe(boom);
    expect(inner.calls).toHaveLength(1);
  });
  it("gives up after 1 + maxRetries attempts with a ModelProviderError carrying attempts and the original kind", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([transient({ retryAfterMs: 1 }), transient(), transient(), "unused"]);
    const e = await failure(new RetryingModelProvider(inner, { sleep: s.sleep, random: midpoint })) as ModelProviderError;
    expect(e).toBeInstanceOf(ModelProviderError);
    expect(e).toMatchObject({ kind: "overloaded", transient: true, status: 503, attempts: 3, message: "mock overloaded" });
    expect(inner.calls).toHaveLength(3); expect(s.delays).toHaveLength(2);
  });
  it("maxRetries 0 disables retrying (one attempt, attempts = 1)", async () => {
    const s = sleeper();
    const inner = new MockModelProvider([transient(), "unused"]);
    const e = await failure(new RetryingModelProvider(inner, { maxRetries: 0, sleep: s.sleep }));
    expect(e).toMatchObject({ kind: "overloaded", attempts: 1 });
    expect(inner.calls).toHaveLength(1); expect(s.delays).toEqual([]);
  });
  it("reports elapsedMs from the injected clock", async () => {
    let t = 1000;
    const inner = new MockModelProvider([transient(), transient()]);
    const e = await failure(new RetryingModelProvider(inner, { maxRetries: 1, now: () => t, sleep: async (ms) => { t += ms; }, random: midpoint })) as ModelProviderError;
    expect(e.elapsedMs).toBe(500);
  });
  it("rejects invalid options", () => {
    const p = new MockModelProvider();
    expect(() => new RetryingModelProvider(p, { maxRetries: -1 })).toThrow(/maxRetries/);
    expect(() => new RetryingModelProvider(p, { maxRetries: 1.5 })).toThrow(/maxRetries/);
    expect(() => new RetryingModelProvider(p, { baseMs: 0 })).toThrow(/baseMs/);
    expect(() => new RetryingModelProvider(p, { capMs: -5 })).toThrow(/capMs/);
  });

  it("logs the first retry of a call once through onRetry (no secrets: kind, status, attempt, delay)", async () => {
    const onRetry = vi.fn();
    await collect(new RetryingModelProvider(new MockModelProvider([transient(), transient(), "ok"]), { sleep: async () => {}, random: midpoint, onRetry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, kind: "overloaded", status: 503, delayMs: 500 });
  });
  it("a throwing onRetry never breaks the call", async () => {
    const w = new RetryingModelProvider(new MockModelProvider([transient(), "ok"]), { sleep: async () => {}, onRetry: () => { throw new Error("log failed"); } });
    expect((await collect(w)).join("")).toBe("ok");
  });

  describe("never splices output", () => {
    it("does not retry once a chunk was yielded: the error propagates unchanged and nothing is duplicated", async () => {
      const err = transient();
      const inner = new MockModelProvider([{ text: "half a", thenFail: err }, "full reply"]);
      const seen: string[] = [];
      let thrown: unknown;
      try { for await (const c of new RetryingModelProvider(inner, { sleep: async () => { throw new Error("must not sleep"); } }).stream(REQ)) seen.push(c); } catch (e) { thrown = e; }
      expect(seen).toEqual(["half ", "a"]);
      expect(thrown).toBe(err);
      expect((thrown as ModelProviderError).attempts).toBeUndefined();
      expect(inner.calls).toHaveLength(1);
    });
    it("retries when the failed attempt yielded nothing, then streams only the successful attempt", async () => {
      const inner = new MockModelProvider([transient(), "clean reply"]);
      expect(await collect(new RetryingModelProvider(inner, { sleep: async () => {} }))).toEqual(["clean ", "reply"]);
    });
  });

  describe("abort", () => {
    it("an abort during the backoff sleep stops at once, propagates the abort and makes no further attempt", async () => {
      const ac = new AbortController();
      const inner = new MockModelProvider([transient(), "never"]);
      const hang = (_ms: number) => new Promise<void>(() => { /* a sleeper that ignores the signal: the wrapper must still stop */ });
      const w = new RetryingModelProvider(inner, { sleep: hang });
      const pending = failure(w, ac.signal);
      await vi.waitFor(() => expect(inner.calls).toHaveLength(1));
      ac.abort();
      const e = await pending;
      expect(e).toBe(ac.signal.reason);
      expect(e).not.toBeInstanceOf(ModelProviderError);
      expect(inner.calls).toHaveLength(1);
    });
    it("the default sleep is abortable and uses real (fake-timer) delays", async () => {
      vi.useFakeTimers();
      try {
        const ac = new AbortController();
        const inner = new MockModelProvider([transient(), "ok"]);
        const w = new RetryingModelProvider(inner, { random: midpoint });
        const pending = failure(w, ac.signal);
        await vi.advanceTimersByTimeAsync(499);
        expect(inner.calls).toHaveLength(1);
        ac.abort();
        expect(await pending).toBe(ac.signal.reason);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(5000);
        expect(inner.calls).toHaveLength(1);
      } finally { vi.useRealTimers(); }
    });
    it("the default sleep completes after the delay and the retry runs", async () => {
      vi.useFakeTimers();
      try {
        const inner = new MockModelProvider([transient(), "ok"]);
        const p = collect(new RetryingModelProvider(inner, { random: midpoint }));
        await vi.advanceTimersByTimeAsync(500);
        expect((await p).join("")).toBe("ok");
      } finally { vi.useRealTimers(); }
    });
    it("an abort before the first attempt throws the abort error and never calls the provider", async () => {
      const ac = new AbortController(); ac.abort();
      const inner = new MockModelProvider(["x"]);
      expect(await failure(new RetryingModelProvider(inner, { sleep: async () => {} }), ac.signal)).toBe(ac.signal.reason);
      expect(inner.calls).toHaveLength(0);
    });
    it("an abort error thrown by the provider is passed through, not retried or classified", async () => {
      const ac = new AbortController();
      const abortErr = new DOMException("aborted", "AbortError");
      const inner: ModelProvider = { name: "x", async *stream() { ac.abort(); throw abortErr; } };
      expect(await failure(new RetryingModelProvider(inner, { sleep: async () => {} }), ac.signal)).toBe(abortErr);
    });
    it("a transient error whose signal aborted meanwhile is not retried and keeps its identity", async () => {
      const ac = new AbortController();
      const err = transient();
      const inner: ModelProvider = { name: "x", async *stream() { ac.abort(); throw err; } };
      expect(await failure(new RetryingModelProvider(inner, { sleep: async () => {} }), ac.signal)).toBe(err);
    });
  });

  it("concurrent calls are independent (no shared retry state)", async () => {
    const s = sleeper();
    // call A: fails once; call B: fails twice; each is routed by the request text.
    const failuresLeft: Record<string, number> = { a: 1, b: 2 };
    const inner: ModelProvider = { name: "x", async *stream(req) {
      const k = req.messages[0]!.content;
      if (failuresLeft[k]! > 0) { failuresLeft[k]!--; throw transient(); }
      yield `ok-${k}`;
    } };
    const w = new RetryingModelProvider(inner, { sleep: s.sleep, random: midpoint });
    const run = async (k: string) => { const out: string[] = []; for await (const c of w.stream({ ...REQ, messages: [{ role: "user", content: k }] })) out.push(c); return out.join(""); };
    expect(await Promise.all([run("a"), run("b")])).toEqual(["ok-a", "ok-b"]);
    expect([...s.delays].sort((a, b) => a - b)).toEqual([500, 500, 1000]);
  });
});
