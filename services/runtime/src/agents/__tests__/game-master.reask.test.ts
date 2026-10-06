import { beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider, ModelProviderError, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster, type GmTraceRecord } from "../game-master.js";
import { buildGmReaskRequest, buildGmRequest, GM_REASK_INSTRUCTION } from "../gm-prompt.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let log: MemoryEventLog;
beforeEach(async () => {
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log, clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
});
const events = async (type: string) => (await log.all()).filter((e) => e.type === type);
const GOOD = '{"reasoning": "greeted", "verdict": true}';

describe("the Game Master re-ask (GM_REASK)", () => {
  it("a fenced reply is read tolerantly: no re-ask, via tolerant", async () => {
    const p = new MockModelProvider(["Sure:\n```json\n" + GOOD + "\n```"]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(1);
    expect(await events("gm.decision")).toEqual([expect.objectContaining({ verdict: true, via: "tolerant" })]);
  });

  it("a malformed reply is re-asked ONCE with the bad reply echoed back, and the answer is recorded via reask", async () => {
    const p = new MockModelProvider(["I cannot decide.", GOOD]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(2);
    const second = p.calls[1]!;
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second.messages[1]!.content).toBe("I cannot decide.");
    expect(second.messages[2]!.content).toBe(GM_REASK_INSTRUCTION);
    expect(second.system).toBe(p.calls[0]!.system);
    expect(await events("gm.decision")).toEqual([expect.objectContaining({ verdict: true, via: "reask" })]);
    expect(await events("gm.no_verdict")).toHaveLength(0);
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("two bad replies record gm.no_verdict with the last reason and 2 attempts; there is never a third call", async () => {
    const p = new MockModelProvider(["no idea", '{"reasoning": "cut off']);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(2);
    expect(await events("gm.no_verdict")).toEqual([expect.objectContaining({ reason: "truncated", attempts: 2 })]);
    expect(await events("gm.decision")).toHaveLength(0);
  });

  it("GM_REASK off: one call, gm.no_verdict with 1 attempt", async () => {
    const p = new MockModelProvider(["no idea", GOOD]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1, reask: false });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(1);
    expect(await events("gm.no_verdict")).toEqual([expect.objectContaining({ reason: "no_json", attempts: 1 })]);
  });

  it("an empty reply is re-asked by appending the instruction to the user turn (no empty assistant turn)", async () => {
    const p = new MockModelProvider(["", GOOD]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    const second = p.calls[1]!;
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]!.role).toBe("user");
    expect(second.messages[0]!.content).toContain("<dialogue>");
    expect(second.messages[0]!.content).toContain(GM_REASK_INSTRUCTION);
    expect(await events("gm.decision")).toEqual([expect.objectContaining({ via: "reask" })]);
  });

  it("a reasoning-budget error counts as a parse failure and is re-asked; two of them give reasoning_only", async () => {
    const budget = () => new ModelProviderError("empty reply", { kind: "reasoning_budget", transient: true });
    const p = new MockModelProvider([budget(), budget()]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(2);
    expect(await events("gm.no_verdict")).toEqual([expect.objectContaining({ reason: "reasoning_only", attempts: 2 })]);
    expect(await events("facilitator.alert")).toHaveLength(0);
  });

  it("another model error is NOT re-asked: one warning alert, no gm.no_verdict", async () => {
    const p = new MockModelProvider([new ModelProviderError("down", { kind: "server_error", transient: true })]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(p.calls).toHaveLength(1);
    expect(await events("gm.no_verdict")).toHaveLength(0);
    expect(await events("facilitator.alert")).toEqual([expect.objectContaining({ level: "warning", message: expect.stringContaining("server_error") })]);
  });

  it("a model error on the re-ask itself is a warning alert (no gm.no_verdict)", async () => {
    const p = new MockModelProvider(["garbage", new ModelProviderError("down", { kind: "network", transient: true })]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(await events("gm.no_verdict")).toHaveLength(0);
    expect(await events("facilitator.alert")).toHaveLength(1);
  });

  it("the re-ask runs inside the SAME deadline: a re-ask cut by the deadline raises the deadline alert and nothing else", async () => {
    let n = 0;
    const provider: ModelProvider = {
      name: "slow-reask",
      async *stream(_req: ChatRequest, signal?: AbortSignal) {
        if (n++ === 0) { yield "garbage"; return; }
        await new Promise<void>((resolve) => { signal?.addEventListener("abort", () => resolve(), { once: true }); });
      },
    };
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1, evaluationTimeoutMs: 50 });
    await engine.say("host", "hello"); await gm.tick();
    expect(n).toBe(2);
    expect(await events("facilitator.alert")).toEqual([expect.objectContaining({ level: "warning", message: expect.stringContaining("deadline of 50 ms") })]);
    expect(await events("gm.no_verdict")).toHaveLength(0);
  });

  it("a scene that moved on during the re-ask records nothing (stale)", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const provider: ModelProvider = { name: "p", async *stream() { if (n++ === 0) { yield "garbage"; return; } await gate; yield "still garbage"; } };
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    const ticking = gm.tick();
    await new Promise((r) => setTimeout(r, 0));
    await engine.command({ command: "advance" }); await engine.tick();
    release(); await ticking;
    expect(await events("gm.no_verdict")).toHaveLength(0);
  });

  it("records every raw reply in the trace with how it was read, and a throwing trace never affects the session", async () => {
    const recs: GmTraceRecord[] = [];
    const p = new MockModelProvider(["nope", GOOD]);
    const gm = new GameMaster({ engine, provider: p, everyNUtterances: 1, trace: (r) => recs.push(r) });
    await engine.say("host", "hello"); await gm.tick();
    expect(recs).toEqual([
      expect.objectContaining({ attempt: 1, raw: "nope", sceneId: "s1_open", parse: { ok: false, reason: "no_json" }, seq: expect.any(Number) }),
      expect.objectContaining({ attempt: 2, raw: GOOD, parse: { ok: true, verdict: true, via: "reask" } }),
    ]);
    const errors: unknown[] = [];
    const eng2 = new SessionEngine({ scenario: await loadScenario(fixture), log: new MemoryEventLog("t"), clock: new FakeClock(0) });
    await eng2.start({ host: "p1" });
    const gm2 = new GameMaster({ engine: eng2, provider: new MockModelProvider([GOOD]), everyNUtterances: 1, trace: () => { throw new Error("trace down"); }, onError: (e) => errors.push(e) });
    await eng2.say("host", "hello"); await gm2.tick();
    expect(eng2.state.currentScene?.id).toBe("s2_close");
    expect(errors).toHaveLength(1);
  });
});

describe("the Game Master prompt (US-0025)", () => {
  it("judges only the condition: the goal is labelled as background, and the reasoning comes before the verdict", () => {
    const req = buildGmRequest({ scene: engine.currentScene()!, condition: "both parties have said hello", state: engine.state });
    expect(req.system).toContain('Judge ONLY this condition, and nothing else: "both parties have said hello"');
    expect(req.system).toMatch(/NOT part of the condition/);
    expect(req.system.indexOf('"reasoning"')).toBeLessThan(req.system.indexOf('"verdict"'));
    expect(req.system).toMatch(/Silence is not agreement/);
    expect(req.system).toMatch(/only proposed/);
  });
  it("buildGmReaskRequest caps the echoed reply and leaves the first turn unchanged", () => {
    const base = buildGmRequest({ scene: engine.currentScene()!, condition: "c", state: engine.state });
    const r = buildGmReaskRequest(base, "x".repeat(10_000));
    expect(r.messages[0]).toEqual(base.messages[0]);
    expect(r.messages[1]!.content.length).toBe(1_500);
  });
});
