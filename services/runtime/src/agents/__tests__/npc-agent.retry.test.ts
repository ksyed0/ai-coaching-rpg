import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole } from "@acr/script";
import { MockModelProvider, ModelProviderError, withRetry, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { NpcAgent } from "../npc-agent.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let guest: NpcRole; let alerts: string[]; let spoken: { text: string; fallback?: boolean }[];

beforeEach(async () => {
  vi.useFakeTimers();
  const scenario = await loadScenario(fixture);
  guest = scenario.roles.guest as NpcRole;
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
  await engine.say("host", "Hello Sam");
  alerts = []; spoken = [];
  engine.subscribe((e) => {
    if (e.type === "facilitator.alert") alerts.push(e.message);
    if (e.type === "utterance") spoken.push(e);
  });
});
afterEach(() => { vi.useRealTimers(); });

const overloaded = () => new ModelProviderError("Upstream error from Nvidia: Service temporarily overloaded", { kind: "overloaded", transient: true, status: 503 });
const auth = () => new ModelProviderError("local request failed with HTTP 401", { kind: "auth", transient: false, status: 401 });
const retrying = (inner: ModelProvider) => withRetry(inner, { random: () => 0.5 }); // real (fake-timer) sleeps: 500 ms, then 1000 ms
const lastSpoken = () => spoken.at(-1);
/** Runs respond() while advancing the fake clock by `ms`, then returns its result. */
async function respondAfter(agent: NpcAgent, ms: number) {
  const p = agent.respond();
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}

describe("NpcAgent with retried model errors", () => {
  it("transient errors then success: exactly one generated utterance, no fallback marker, no alert", async () => {
    const inner = new MockModelProvider([overloaded(), overloaded(), "Great to be here, thanks"]);
    const before = engine.state.transcript.length;
    const e = await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(inner) }), 1_500);
    expect(inner.calls).toHaveLength(3);
    expect(e).toMatchObject({ type: "utterance", text: "Great to be here, thanks" });
    expect((e as { fallback?: boolean }).fallback).toBeUndefined();
    expect(engine.state.transcript).toHaveLength(before + 1);
    expect(alerts).toEqual([]);
  });

  it("exhausted retries: the marked fallback line plus an alert with the attempt count and kind, still ending with 'used fallback line'", async () => {
    const inner = new MockModelProvider([overloaded(), overloaded(), overloaded(), "never used"]);
    const before = engine.state.transcript.length;
    await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(inner) }), 1_500);
    expect(inner.calls).toHaveLength(3);
    expect(alerts).toEqual(["NPC guest: model error after 3 attempts (overloaded): Upstream error from Nvidia: Service temporarily overloaded; used fallback line"]);
    expect(engine.state.transcript).toHaveLength(before + 1);
    expect(lastSpoken()).toMatchObject({ text: guest.fallback_line, fallback: true });
  });

  it("a permanent error falls back at once with attempts 1 and no retry", async () => {
    const inner = new MockModelProvider([auth(), "never used"]);
    const e = await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(inner) }), 0);
    expect(inner.calls).toHaveLength(1);
    expect(alerts).toEqual(["NPC guest: model error after 1 attempt (auth): local request failed with HTTP 401; used fallback line"]);
    expect(e).toMatchObject({ text: guest.fallback_line, fallback: true });
    expect(vi.getTimerCount()).toBe(0); // no backoff timer left behind
  });

  it("an untyped error keeps the old wording (no kind, no attempts)", async () => {
    await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(new MockModelProvider([new Error("boom")])) }), 0);
    expect(alerts).toEqual(["NPC guest: model error: boom; used fallback line"]);
  });

  it("a typed error without the wrapper reports the kind but no attempts", async () => {
    await respondAfter(new NpcAgent({ role: guest, engine, provider: new MockModelProvider([overloaded()]) }), 0);
    expect(alerts[0]).toMatch(/^NPC guest: model error \(overloaded\): .*; used fallback line$/);
  });

  it("retries never outlive the first-token deadline: it fires during the backoff, no extra attempt is made", async () => {
    const inner = new MockModelProvider([overloaded(), overloaded(), overloaded(), "never"]);
    const agent = new NpcAgent({ role: guest, engine, provider: retrying(inner), firstTokenTimeoutMs: 800, replyTimeoutMs: 5_000 });
    await respondAfter(agent, 800);
    expect(inner.calls).toHaveLength(2); // attempt 1 at 0 ms, attempt 2 at 500 ms; the 1000 ms backoff was cut at 800 ms
    expect(alerts).toEqual(["NPC guest: no first token within timeout; used fallback line"]);
    expect(lastSpoken()).toMatchObject({ text: guest.fallback_line, fallback: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inner.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a stalled attempt still hits the first-token timeout", async () => {
    let calls = 0;
    const stall: ModelProvider = { name: "stall", async *stream(_r: ChatRequest, signal?: AbortSignal) { calls++; await new Promise<void>((r) => signal?.addEventListener("abort", () => r())); } };
    await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(stall), firstTokenTimeoutMs: 3_000 }), 3_000);
    expect(calls).toBe(1);
    expect(alerts).toEqual(["NPC guest: no first token within timeout; used fallback line"]);
  });

  it("a failure after the first token is NOT retried: the fallback replaces the partial reply, once", async () => {
    const inner = new MockModelProvider([{ text: "Well I think", thenFail: overloaded() }, "second attempt"]);
    const before = engine.state.transcript.length;
    await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(inner) }), 5_000);
    expect(inner.calls).toHaveLength(1);
    expect(engine.state.transcript).toHaveLength(before + 1);
    expect(lastSpoken()).toMatchObject({ text: guest.fallback_line, fallback: true });
    expect(alerts[0]).toMatch(/^NPC guest: model error \(overloaded\): .*; used fallback line$/);
  });

  it("a reply that arrives after retries but after the scene changed is dropped like any stale reply", async () => {
    let n = 0;
    const provider: ModelProvider = { name: "p", async *stream() {
      if (n++ === 0) throw overloaded();
      await engine.command({ command: "advance" }); await engine.tick();
      yield "stale after retry";
    } };
    const before = engine.state.transcript.length;
    expect(await respondAfter(new NpcAgent({ role: guest, engine, provider: retrying(provider) }), 500)).toBeNull();
    expect(n).toBe(2);
    expect(engine.state.transcript).toHaveLength(before);
    expect(alerts).toEqual([]);
  });

  it("a pause during the backoff drops the late reply (no utterance, no alert)", async () => {
    const inner = new MockModelProvider([overloaded(), "late reply"]);
    const agent = new NpcAgent({ role: guest, engine, provider: retrying(inner) });
    const p = agent.respond();
    await vi.advanceTimersByTimeAsync(100);
    await engine.command({ command: "pause" });
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBeNull();
    expect(alerts).toEqual([]);
    expect(engine.state.transcript.filter((u) => u.roleId === "guest")).toHaveLength(0);
  });
});
