import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster } from "../game-master.js";
import { buildGmRequest, parseGmVerdict } from "../gm-prompt.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let clock: FakeClock; let log: MemoryEventLog;

beforeEach(async () => {
  clock = new FakeClock(0);
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log, clock });
  await engine.start({ host: "p1" });
});

const events = async (type: string) => (await log.all()).filter((e) => e.type === type);

/** A provider whose reply is held until release() is called. */
function slowProvider(reply: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: ChatRequest[] = [];
  const provider: ModelProvider = {
    name: "slow",
    async *stream(req) { calls.push(req); await gate; yield reply; },
  };
  return { provider, release, calls };
}

describe("parseGmVerdict", () => {
  it("reads a JSON object even when wrapped in prose or fences", () => {
    expect(parseGmVerdict('Sure:\n```json\n{"verdict": true, "reasoning": "both said hi"}\n```')).toEqual({ verdict: true, reasoning: "both said hi" });
    expect(parseGmVerdict("not json")).toBeNull();
  });

  it("rejects malformed replies and never returns a truthy verdict from them", () => {
    for (const bad of ["", "{}", '{"reasoning": "x"}', '{"verdict": "true"}', '{"verdict": 1}', '{"verdict": null}', '{"verdict": true', "[true]", "true", '{"verdict": true} and {"verdict": false}']) {
      expect(parseGmVerdict(bad)).toBeNull();
    }
  });

  it("defaults reasoning to an empty string when missing or not a string", () => {
    expect(parseGmVerdict('{"verdict": false}')).toEqual({ verdict: false, reasoning: "" });
    expect(parseGmVerdict('{"verdict": false, "reasoning": 5}')).toEqual({ verdict: false, reasoning: "" });
  });
});

describe("buildGmRequest", () => {
  it("contains scene data, the condition and role ids, but no participant names", async () => {
    const e2 = new SessionEngine({ scenario: await loadScenario(fixture), log: new MemoryEventLog("n"), clock: new FakeClock(0) });
    await e2.start({ host: "Alice Wonderland", guest: "Bob Builder" });
    await e2.say("host", "hello"); await e2.say("guest", "hi");
    const req = buildGmRequest({ scene: e2.currentScene()!, condition: "both parties have said hello", state: e2.state });
    const all = req.system + JSON.stringify(req.messages);
    expect(all).toContain("both parties have said hello");
    expect(all).toContain("[host]: hello");
    expect(all).toContain("[guest]: hi");
    expect(all).toContain("Exchange greetings");
    expect(all).not.toMatch(/Alice|Bob|Wonderland|Builder/);
  });

  it("only includes the current scene's dialogue", async () => {
    await engine.say("host", "scene one line");
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.say("host", "scene two line");
    const req = buildGmRequest({ scene: engine.currentScene()!, condition: "c", state: engine.state });
    const all = JSON.stringify(req.messages);
    expect(all).toContain("scene two line");
    expect(all).not.toContain("scene one line");
  });

  it("says so when there is no dialogue yet", () => {
    const req = buildGmRequest({ scene: engine.currentScene()!, condition: "c", state: engine.state });
    expect(JSON.stringify(req.messages)).toContain("(no dialogue yet)");
  });
});

describe("GameMaster", () => {
  it("does not call the model until N utterances have accumulated", async () => {
    const provider = new MockModelProvider();
    const gm = new GameMaster({ engine, provider, everyNUtterances: 2 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(provider.calls).toHaveLength(0);
    await engine.say("guest", "hi");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].system).toContain("both parties have said hello");
  });

  it("exits the scene when the model returns a true verdict", async () => {
    const provider = new MockModelProvider(['{"verdict": true, "reasoning": "greeted"}']);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    const decision = (await log.all()).find((e) => e.type === "gm.decision");
    expect(decision).toMatchObject({ verdict: true, reasoning: "greeted" });
  });

  it("stays in the scene on a false verdict and on unparseable output", async () => {
    const provider = new MockModelProvider(['{"verdict": false, "reasoning": "only one greeted"}', "garbage"]);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    await engine.say("host", "hello again"); await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
  });

  it("fires timed injects and time-box exits through engine.tick, and never fires an inject after its scene exits", async () => {
    const gm = new GameMaster({ engine, provider: new MockModelProvider() });
    clock.advance(120_000);
    await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    clock.advance(10_000);
    await gm.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("never fires an inject after the scene exits, nor one scheduled past the time box (GM-level, Review Focus 5)", async () => {
    const scenario = await loadScenario(fixture);
    scenario.script.scenes[0].injects!.push({ id: "past_box", at_minute: 5, to: ["guest"], content: "too late" });
    const c = new FakeClock(0); const l = new MemoryEventLog("t");
    const eng = new SessionEngine({ scenario, log: l, clock: c });
    await eng.start({ host: "p1" });
    const gm = new GameMaster({ engine: eng, provider: new MockModelProvider() });
    for (let i = 0; i < 20; i++) { c.advance(10_000); await gm.tick(); }
    const fired = (await l.all()).filter((e) => e.type === "inject.fired").map((e) => (e as { injectId: string }).injectId);
    expect(fired).toEqual(["late_inject"]);
    expect(eng.state.status).toBe("ended"); // both scenes timed out; ticks continued after the exits
  });

  it("drops a verdict computed against a scene that changed during the model call (R18)", async () => {
    const { provider, release } = slowProvider('{"verdict": true, "reasoning": "stale"}');
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    const ticking = gm.tick();
    await new Promise((r) => setTimeout(r, 0));
    await engine.command({ command: "advance" }); await engine.tick(); // scene moves to s2_close
    expect(engine.state.currentScene?.id).toBe("s2_close");
    release();
    await ticking;
    expect(await events("gm.decision")).toHaveLength(0);
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect((await events("scene.exited")).map((e) => (e as { sceneId: string }).sceneId)).toEqual(["s1_open"]);
  });

  it("does not start an overlapping evaluation while one is in flight (R19)", async () => {
    const { provider, release, calls } = slowProvider('{"verdict": true, "reasoning": "greeted"}');
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    const t1 = gm.tick();
    await new Promise((r) => setTimeout(r, 0));
    const t2 = gm.tick();
    await t2; // second tick returns without waiting on the model
    expect(calls).toHaveLength(1);
    release();
    await t1;
    expect(calls).toHaveLength(1);
    expect(await events("gm.decision")).toHaveLength(1);
    expect(await events("scene.exited")).toHaveLength(1);
    // a later tick evaluates again once new utterances arrive
    await gm.tick();
    expect(calls).toHaveLength(1);
  });

  it("an overlapping tick still runs engine.tick for timers and injects (R19)", async () => {
    const { provider, release } = slowProvider('{"verdict": false, "reasoning": "no"}');
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    const t1 = gm.tick();
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(70_000);
    await gm.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    release(); await t1;
  });

  it("a model error yields no decision, raises a warning alert, and does not throw", async () => {
    const provider: ModelProvider = { name: "bad", async *stream() { throw new Error("boom"); } };
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await expect(gm.tick()).resolves.toBeUndefined();
    expect(await events("gm.decision")).toHaveLength(0);
    expect(await events("facilitator.alert")).toEqual([expect.objectContaining({ level: "warning", message: expect.stringContaining("boom") })]);
    expect(engine.state.currentScene?.id).toBe("s1_open");
  });

  it("an empty reply yields no decision and an info alert", async () => {
    const provider: ModelProvider = { name: "empty", async *stream() { /* nothing */ } };
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(await events("gm.decision")).toHaveLength(0);
    expect(await events("facilitator.alert")).toHaveLength(1);
  });

  it("unparseable JSON yields no decision (even a truthy-looking one) and an alert", async () => {
    const provider = new MockModelProvider(['{"verdict": "true"}']);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(await events("gm.decision")).toHaveLength(0);
    expect(await events("facilitator.alert")).toHaveLength(1);
    expect(engine.state.currentScene?.id).toBe("s1_open");
  });

  it("does nothing while paused", async () => {
    const provider = new MockModelProvider();
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await engine.command({ command: "pause" });
    await gm.tick();
    expect(provider.calls).toHaveLength(0);
  });

  it("resets its utterance counter on a new scene", async () => {
    const provider = new MockModelProvider(['{"verdict": false, "reasoning": "no"}']);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    expect(provider.calls).toHaveLength(1);
    await engine.command({ command: "advance" }); await gm.tick(); // s2 has no gm_detects
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
  });
});
