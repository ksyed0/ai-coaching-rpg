import { describe, expect, it, beforeEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { NpcAgent } from "../npc-agent.js";
import { DEFAULT_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_REPLY_TIMEOUT_MS } from "../timeouts.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let guest: NpcRole;

beforeEach(async () => {
  const scenario = await loadScenario(fixture);
  guest = scenario.roles.guest as NpcRole;
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
  await engine.say("host", "Hello Sam");
});

const alertsOf = () => { const a: string[] = []; engine.subscribe((e) => { if (e.type === "facilitator.alert") a.push(e.message); }); return a; };

describe("NpcAgent", () => {
  it("defaults to a 10 s first-token timeout and a 20 s reply deadline", () => {
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider() });
    expect(agent.timeouts).toEqual({ firstTokenMs: 10_000, replyMs: 20_000 });
    expect(agent.timeouts).toEqual({ firstTokenMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS, replyMs: DEFAULT_REPLY_TIMEOUT_MS });
  });

  it("falls back at exactly the default first-token timeout, not before (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const hang: ModelProvider = { name: "hang", async *stream(_req: ChatRequest, signal?: AbortSignal) { await new Promise<void>((r) => signal?.addEventListener("abort", () => r())); } };
      const alerts = alertsOf();
      let done = false;
      const p = new NpcAgent({ role: guest, engine, provider: hang }).respond().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(alerts[0]).toMatch(/guest.*no first token/);
      expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
    } finally { vi.useRealTimers(); }
  });

  it("emits one utterance with the streamed reply", async () => {
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["Hi there, good to see you"]) });
    const e = await agent.respond();
    expect(e?.type).toBe("utterance");
    expect(engine.state.transcript.at(-1)).toMatchObject({ roleId: "guest", text: "Hi there, good to see you" });
  });

  it("uses the fallback line and alerts the facilitator on an empty reply", async () => {
    const alerts = alertsOf();
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider([""]) });
    await agent.respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
    expect(alerts[0]).toMatch(/guest.*empty reply/);
  });

  it("treats a whitespace-only reply as empty", async () => {
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["   \n"]) });
    await agent.respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
  });

  it("uses the fallback line when the first token does not arrive in time", async () => {
    const slow: ModelProvider = { name: "slow", async *stream(_req: ChatRequest, signal?: AbortSignal) {
      await new Promise((r) => setTimeout(r, 50)); if (signal?.aborted) return; yield "late"; } };
    const alerts = alertsOf();
    const agent = new NpcAgent({ role: guest, engine, provider: slow, firstTokenTimeoutMs: 10 });
    await agent.respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
    expect(alerts[0]).toMatch(/guest.*no first token/);
  });

  it("aborts the underlying model call when the first-token timeout fires", async () => {
    let aborted = false;
    const hang: ModelProvider = { name: "hang", async *stream(_req: ChatRequest, signal?: AbortSignal) {
      await new Promise<void>((r) => signal?.addEventListener("abort", () => { aborted = true; r(); })); } };
    const agent = new NpcAgent({ role: guest, engine, provider: hang, firstTokenTimeoutMs: 5 });
    await agent.respond();
    expect(aborted).toBe(true);
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
  });

  it("surfaces a stream error as an alert plus the fallback line, never an empty utterance", async () => {
    const boom: ModelProvider = { name: "boom", async *stream() { throw new Error("upstream 500"); } };
    const alerts = alertsOf();
    await new NpcAgent({ role: guest, engine, provider: boom }).respond();
    expect(alerts[0]).toMatch(/guest.*upstream 500/);
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
  });

  it("falls back when the stream fails after the first token (no partial utterance)", async () => {
    const half: ModelProvider = { name: "half", async *stream() { yield "Well, I"; throw new Error("connection reset"); } };
    await new NpcAgent({ role: guest, engine, provider: half }).respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
  });

  it("returns null and says nothing while paused", async () => {
    await engine.command({ command: "pause" });
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["x"]) });
    expect(await agent.respond()).toBeNull();
    expect(engine.state.transcript).toHaveLength(1);
  });

  it("returns null when the NPC is not in the current scene", async () => {
    const outsider: NpcRole = { ...guest, id: "nobody" };
    expect(await new NpcAgent({ role: outsider, engine, provider: new MockModelProvider(["x"]) }).respond()).toBeNull();
  });

  it("drops the reply (returns null, no crash) if the session is paused while the model is thinking", async () => {
    const provider: ModelProvider = { name: "p", async *stream() { await engine.command({ command: "pause" }); yield "too late"; } };
    expect(await new NpcAgent({ role: guest, engine, provider }).respond()).toBeNull();
    expect(engine.state.transcript).toHaveLength(1);
  });

  it("drops a reply generated in scene A when the scene switched to B (NPC in both) during the stream", async () => {
    const provider: ModelProvider = { name: "p", async *stream() {
      await engine.command({ command: "advance" }); await engine.tick();
      yield "stale reply"; } };
    const before = engine.state.transcript.length;
    expect(await new NpcAgent({ role: guest, engine, provider }).respond()).toBeNull();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.transcript).toHaveLength(before);
  });

  it("drops the fallback line and its alert too when the scene switched during a timeout", async () => {
    const alerts = alertsOf();
    const provider: ModelProvider = { name: "p", async *stream(_r: ChatRequest, signal?: AbortSignal) {
      await engine.command({ command: "advance" }); await engine.tick();
      await new Promise<void>((r) => signal?.addEventListener("abort", () => r())); } };
    const before = engine.state.transcript.length;
    expect(await new NpcAgent({ role: guest, engine, provider, firstTokenTimeoutMs: 5 }).respond()).toBeNull();
    expect(engine.state.transcript).toHaveLength(before);
    expect(alerts).toHaveLength(0);
  });
  it("R21: aborts and falls back when the stream stalls after the first token (overall reply deadline)", async () => {
    let aborted = false;
    const stall: ModelProvider = { name: "stall", async *stream(_req: ChatRequest, signal?: AbortSignal) {
      yield "Well, I";
      await new Promise<void>((r) => signal?.addEventListener("abort", () => { aborted = true; r(); })); } };
    const alerts = alertsOf();
    const before = engine.state.transcript.length;
    await new NpcAgent({ role: guest, engine, provider: stall, replyTimeoutMs: 20 }).respond();
    expect(aborted).toBe(true);
    expect(engine.state.transcript).toHaveLength(before + 1);
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
    expect(alerts[0]).toMatch(/guest.*reply did not finish/);
  });

  it("R21: a stalled reply that outlives a scene change is dropped silently", async () => {
    const alerts = alertsOf();
    const stall: ModelProvider = { name: "stall", async *stream(_r: ChatRequest, signal?: AbortSignal) {
      yield "Well";
      await engine.command({ command: "advance" }); await engine.tick();
      await new Promise<void>((r) => signal?.addEventListener("abort", () => r())); } };
    const before = engine.state.transcript.length;
    expect(await new NpcAgent({ role: guest, engine, provider: stall, replyTimeoutMs: 20 }).respond()).toBeNull();
    expect(engine.state.transcript).toHaveLength(before);
    expect(alerts).toHaveLength(0);
  });
});

describe("NpcAgent fallback marker (R44)", () => {
  it("sets fallback: true on the fallback utterance only", async () => {
    const seen: any[] = [];
    engine.subscribe((e) => { if (e.type === "utterance" && e.roleId === "guest") seen.push(e); });
    await new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["a real reply", ""]) }).respond();
    await engine.say("host", "again");
    await new NpcAgent({ role: guest, engine, provider: new MockModelProvider([""]) }).respond();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toHaveProperty("fallback");
    expect(seen[1]).toMatchObject({ text: guest.fallback_line, fallback: true });
  });
  it("a model that says the fallback text itself gets no marker", async () => {
    const seen: any[] = [];
    engine.subscribe((e) => { if (e.type === "utterance" && e.roleId === "guest") seen.push(e); });
    await new NpcAgent({ role: guest, engine, provider: new MockModelProvider([guest.fallback_line]) }).respond();
    expect(seen[0]).not.toHaveProperty("fallback");
  });
});
