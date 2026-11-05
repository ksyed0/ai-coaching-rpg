import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider, ModelProviderError, withRetry, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster } from "../game-master.js";
import { stampNonce } from "../../demo/harness.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let log: MemoryEventLog;

beforeEach(async () => {
  vi.useFakeTimers();
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log, clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
});
afterEach(() => { vi.useRealTimers(); });

const events = async (type: string) => (await log.all()).filter((e) => e.type === type);
const overloaded = () => new ModelProviderError("Service temporarily overloaded", { kind: "overloaded", transient: true, status: 503 });
const VERDICT = '{"verdict": true, "reasoning": "greeted"}';
async function tickAfter(gm: GameMaster, ms: number) {
  const p = gm.tick();
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe("GameMaster with retried model errors", () => {
  it("transient errors then a verdict: the verdict is recorded once and there is no alert", async () => {
    const inner = new MockModelProvider([overloaded(), overloaded(), VERDICT]);
    const gm = new GameMaster({ engine, provider: stampNonce(withRetry(inner, { random: () => 0.5 })), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 1_500);
    expect(inner.calls).toHaveLength(3);
    expect(await events("gm.decision")).toEqual([expect.objectContaining({ verdict: true })]);
    expect(await events("facilitator.alert")).toEqual([]);
  });

  it("exhausted retries: no verdict and one warning alert with the attempt count, kind and condition", async () => {
    const inner = new MockModelProvider([overloaded(), overloaded(), overloaded(), VERDICT]);
    const gm = new GameMaster({ engine, provider: stampNonce(withRetry(inner, { random: () => 0.5 })), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 1_500);
    expect(inner.calls).toHaveLength(3);
    expect(await events("gm.decision")).toHaveLength(0);
    expect(await events("facilitator.alert")).toEqual([
      expect.objectContaining({ level: "warning", message: expect.stringMatching(/^GM: model error after 3 attempts \(overloaded\) for ".+": Service temporarily overloaded$/) }),
    ]);
  });

  it("a permanent error is not retried (attempts 1)", async () => {
    const inner = new MockModelProvider([new ModelProviderError("HTTP 401", { kind: "auth", transient: false, status: 401 }), VERDICT]);
    const gm = new GameMaster({ engine, provider: stampNonce(withRetry(inner, { random: () => 0.5 })), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 0);
    expect(inner.calls).toHaveLength(1);
    expect((await events("facilitator.alert"))[0]).toMatchObject({ message: expect.stringMatching(/^GM: model error after 1 attempt \(auth\) for ".+": HTTP 401$/) });
  });

  it("an untyped error keeps the old wording", async () => {
    const gm = new GameMaster({ engine, provider: stampNonce(new MockModelProvider([new Error("boom")])), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 0);
    expect((await events("facilitator.alert"))[0]).toMatchObject({ message: expect.stringMatching(/^GM: model error for ".+": boom$/) });
  });

  it("the wait is bounded: at most 1 + maxRetries attempts and no timer left behind once the evaluation is over", async () => {
    const inner = new MockModelProvider(Array.from({ length: 10 }, overloaded));
    const gm = new GameMaster({ engine, provider: stampNonce(withRetry(inner, { maxRetries: 2, baseMs: 500, capMs: 4_000, random: () => 1 })), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 1_875 + 625); // worst case (+25% jitter): 625 + 1250
    expect(inner.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a verdict that arrives after retries for a scene that has since changed is dropped (stale guard unchanged)", async () => {
    let n = 0;
    const provider = { name: "p", async *stream() {
      if (n++ === 0) throw overloaded();
      await engine.command({ command: "advance" }); await engine.tick();
      yield VERDICT;
    } };
    const gm = new GameMaster({ engine, provider: stampNonce(withRetry(provider, { random: () => 0.5 })), everyNUtterances: 1 });
    await engine.say("host", "hello");
    await tickAfter(gm, 500);
    expect(await events("gm.decision")).toHaveLength(0);
  });

  describe("the Game Master's own deadline", () => {
    const deadlineAlert = /^GM: model call exceeded its deadline of 1000 ms for ".+"$/;

    it("a stalled call is aborted at the deadline: no verdict, an alert, no timer left behind, and the next tick evaluates again", async () => {
      let calls = 0; let sawAbort = false;
      const provider: ModelProvider = { name: "p", async *stream(_r: ChatRequest, signal?: AbortSignal) {
        calls++;
        if (calls === 1) { await new Promise<void>((r) => signal?.addEventListener("abort", () => { sawAbort = true; r(); })); return; }
        yield VERDICT;
      } };
      const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 1, evaluationTimeoutMs: 1_000 });
      await engine.say("host", "hello");
      const t = gm.tick();
      await vi.advanceTimersByTimeAsync(999);
      expect(await events("facilitator.alert")).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await t;
      expect(sawAbort).toBe(true);
      expect(await events("gm.decision")).toHaveLength(0);
      expect(await events("facilitator.alert")).toEqual([expect.objectContaining({ level: "warning", message: expect.stringMatching(deadlineAlert) })]);
      expect(vi.getTimerCount()).toBe(0);
      await engine.say("guest", "hi");
      await gm.tick(); // the in-flight guard was released
      expect(calls).toBe(2);
      expect(await events("gm.decision")).toHaveLength(1);
    });
    it("also ends when the provider ignores the abort and never answers", async () => {
      const never: ModelProvider = { name: "never", async *stream() { await new Promise<void>(() => {}); } };
      const gm = new GameMaster({ engine, provider: stampNonce(never), everyNUtterances: 1, evaluationTimeoutMs: 1_000 });
      await engine.say("host", "hello");
      await tickAfter(gm, 1_000);
      expect((await events("facilitator.alert"))[0]).toMatchObject({ message: expect.stringMatching(deadlineAlert) });
      expect(vi.getTimerCount()).toBe(0);
    });
    it("retries stop at the deadline (no extra attempt) and the alert names the attempts and the last error", async () => {
      const inner = new MockModelProvider([overloaded(), overloaded(), overloaded(), VERDICT]);
      const gm = new GameMaster({ engine, provider: stampNonce(withRetry(inner, { random: () => 0.5 })), everyNUtterances: 1, evaluationTimeoutMs: 800 });
      await engine.say("host", "hello");
      await tickAfter(gm, 800);
      expect(inner.calls).toHaveLength(2);
      expect((await events("facilitator.alert"))[0]).toMatchObject({ message: expect.stringMatching(/^GM: model call exceeded its deadline of 800 ms for ".+" \(2 attempts made; last error: overloaded\)$/) });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(inner.calls).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    });
    it("a verdict inside the deadline clears its timer", async () => {
      const gm = new GameMaster({ engine, provider: stampNonce(new MockModelProvider([VERDICT])), everyNUtterances: 1, evaluationTimeoutMs: 1_000 });
      await engine.say("host", "hello");
      await tickAfter(gm, 0);
      expect(await events("gm.decision")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
