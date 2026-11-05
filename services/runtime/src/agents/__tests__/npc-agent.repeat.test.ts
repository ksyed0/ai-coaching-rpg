import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole } from "@acr/script";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { NpcAgent, REPEAT_REASK } from "../npc-agent.js";

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
/** Returns the given replies in order (the last one repeats); records every request. */
const seq = (...replies: string[]): ModelProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return { name: "seq", calls, async *stream(req: ChatRequest) { calls.push(req); yield replies[Math.min(calls.length - 1, replies.length - 1)]!; } };
};
const speak = async (p: ModelProvider, o: { replyTimeoutMs?: number; firstTokenTimeoutMs?: number } = {}) => {
  const e = await new NpcAgent({ role: guest, engine, provider: p, ...o }).respond();
  await engine.say("host", "And then?");
  return e;
};
const said = () => engine.state.transcript.filter((u) => u.roleId === "guest").map((u) => u.text);

describe("NpcAgent repetition guard", () => {
  it("does nothing the first time, and a different reply is spoken with no re-ask", async () => {
    const p = seq("Fine.", "Something else.");
    await speak(p); await speak(p);
    expect(p.calls).toHaveLength(2);
    expect(said()).toEqual(["Fine.", "Something else."]);
  });

  it("asks once more (with the extra system line) when the reply equals an earlier one, and speaks the new reply", async () => {
    const alerts = alertsOf();
    const p = seq("I am keeping the 45k.", "I am keeping the 45k.", "Then let us talk about the payment terms.");
    await speak(p);
    await speak(p);
    expect(p.calls).toHaveLength(3);
    expect(p.calls[1]!.system).not.toContain(REPEAT_REASK);
    expect(p.calls[2]!.system.endsWith(REPEAT_REASK)).toBe(true);
    expect(p.calls[2]!.system.startsWith(p.calls[1]!.system)).toBe(true);
    expect(said()).toEqual(["I am keeping the 45k.", "Then let us talk about the payment terms."]);
    expect(alerts).toEqual([]);
  });

  it("compares ignoring case, spacing and punctuation, and against the last 3 own replies only", async () => {
    const p = seq("One.", "Two.", "Three.", "Four.", "  ONE!! ", "never used");
    for (let i = 0; i < 4; i++) await speak(p);
    expect(p.calls).toHaveLength(4);
    await speak(p); // "ONE" is older than the last 3 (Two, Three, Four): not a repeat
    expect(p.calls).toHaveLength(5);
    expect(said().at(-1)).toBe("ONE!!");
    const q = seq("Hello there.", "hello,   THERE", "hello there");
    await speak(q); await speak(q);
    expect(q.calls).toHaveLength(3); // the second reply repeated "Hello there." -> re-asked once
  });

  it("accepts a second identical reply and raises ONE warning alert; never asks a third time", async () => {
    const alerts = alertsOf();
    const p = seq("Same line.");
    await speak(p);
    const e = await speak(p);
    expect(p.calls).toHaveLength(3);
    expect(e).toMatchObject({ type: "utterance", text: "Same line." });
    expect(said()).toEqual(["Same line.", "Same line."]);
    expect(alerts).toEqual(["character guest repeated an earlier reply verbatim"]);
  });

  it("keeps the first reply (with the warning) when the re-ask fails or is empty, and never uses the fallback line for it", async () => {
    const alerts = alertsOf();
    let n = 0;
    const flaky: ModelProvider = { name: "f", async *stream() { n++; if (n === 3) throw new Error("boom"); if (n === 5) { yield ""; return; } yield "Again and again."; } };
    await speak(flaky);
    await speak(flaky);
    await speak(flaky);
    expect(said()).toEqual(["Again and again.", "Again and again.", "Again and again."]);
    expect(alerts.filter((a) => a.includes("repeated an earlier reply"))).toHaveLength(2);
    expect(alerts.some((a) => a.includes("fallback"))).toBe(false);
  });

  it("the re-ask stays inside the same reply deadline: a stalled second call ends at the deadline with the first reply spoken", async () => {
    vi.useFakeTimers();
    try {
      const alerts = alertsOf();
      let calls = 0;
      const stall: ModelProvider = {
        name: "s",
        async *stream(_r, signal?: AbortSignal) { calls++; if (calls >= 3) { await new Promise<void>((r) => signal?.addEventListener("abort", () => r())); return; } yield "Repeated."; },
      };
      const agent = new NpcAgent({ role: guest, engine, provider: stall, firstTokenTimeoutMs: 5_000, replyTimeoutMs: 8_000 });
      await agent.respond(); await engine.say("host", "next");
      let done = false;
      const p = agent.respond().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await p;
      expect(calls).toBe(3); // the first character reply, the repeated one, then one re-ask that stalled
      expect(said().at(-1)).toBe("Repeated.");
      expect(alerts).toEqual(["character guest repeated an earlier reply verbatim"]);
    } finally { vi.useRealTimers(); }
  });
});
