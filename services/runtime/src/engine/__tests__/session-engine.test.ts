import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "@acr/script";
import { SessionEngine, EngineError } from "../session-engine.js";
import { MemoryEventLog, JsonlEventLog } from "../event-log.js";
import { FakeClock, SystemClock } from "../clock.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

let scenario: Scenario;
let clock: FakeClock;
let engine: SessionEngine;
let log: MemoryEventLog;

beforeEach(async () => {
  scenario = await loadScenario(fixture);
  clock = new FakeClock(1_000_000);
  log = new MemoryEventLog("sess-1");
  engine = new SessionEngine({ scenario, log, clock });
  await engine.start({ host: "participant-1" });
});

describe("SessionEngine", () => {
  it("starts and enters the first scene", () => {
    expect(engine.state.status).toBe("running");
    expect(engine.state.currentScene?.id).toBe("s1_open");
    expect(engine.state.roles.host).toEqual({ kind: "player", participantId: "participant-1" });
    expect(engine.state.roles.guest).toEqual({ kind: "npc" });
  });

  it("records an utterance", async () => {
    const e = await engine.say("host", "hello");
    expect(e.type).toBe("utterance");
    expect(engine.state.transcript.at(-1)?.text).toBe("hello");
  });

  it("rejects utterances while paused and does not log them", async () => {
    await engine.command({ command: "pause" });
    const before = (await log.all()).length;
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "paused" });
    expect(engine.state.transcript).toHaveLength(0);
    expect(await log.all()).toHaveLength(before);
    expect((await log.all()).some((e) => e.type === "utterance")).toBe(false);
    await engine.command({ command: "resume" });
    await engine.say("host", "y");
    expect(engine.state.transcript).toHaveLength(1);
  });

  it("rejects a role that is not in the current scene", async () => {
    await engine.command({ command: "advance" });
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    scenario.script.scenes[1].participants = ["host"]; // guest no longer in s2
    await expect(engine.say("guest", "x")).rejects.toBeInstanceOf(EngineError);
  });

  it("fires a timed inject on tick and never twice", async () => {
    clock.advance(61_000);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    expect(engine.state.npcs.guest.goals).toContain("Leave early");
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("exits a scene on its time box and enters the next", async () => {
    clock.advance(120_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.sceneHistory.map((s) => s.id)).toEqual(["s1_open", "s2_close"]);
  });

  it("exits a scene on a GM verdict", async () => {
    await engine.recordGmVerdict("both parties have said hello", true, "both greeted");
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("ends the session after the last scene", async () => {
    clock.advance(120_000); await engine.tick();
    clock.advance(60_000); await engine.tick();
    expect(engine.state.status).toBe("ended");
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "ended" });
  });

  it("fires a manual inject on facilitator command", async () => {
    await engine.command({ command: "fire_inject", injectId: "late_inject" });
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("notifies subscribers of every event", async () => {
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    await engine.say("host", "a");
    expect(seen).toEqual(["utterance"]);
  });

  it("stamps every event with monotonic seq from 1, ts and sessionId", async () => {
    await engine.say("host", "a");
    const events = await log.all();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === "sess-1" && e.ts === 1_000_000)).toBe(true);
  });

  it("unsubscribe stops notifications", async () => {
    const seen: string[] = [];
    const off = engine.subscribe((e) => seen.push(e.type));
    off();
    await engine.say("host", "a");
    expect(seen).toEqual([]);
  });

  it("rejects unknown roles and unknown injects", async () => {
    await expect(engine.say("nobody", "x")).rejects.toMatchObject({ code: "unknown_role" });
    await expect(engine.command({ command: "fire_inject", injectId: "nope" })).rejects.toMatchObject({ code: "unknown_inject" });
    await expect(engine.updateNpc("host", { goals: [] })).rejects.toMatchObject({ code: "unknown_role" });
  });

  it("updates an NPC and applies set_npc_stance", async () => {
    await engine.updateNpc("guest", { released: ["fact"] });
    expect(engine.state.npcs.guest.released).toContain("fact");
    await engine.command({ command: "set_npc_stance", roleId: "guest", goals: ["Be curt"] });
    expect(engine.state.npcs.guest.goals).toEqual(["Be curt"]);
  });

  it("does not tick while paused and rejects commands after end", async () => {
    await engine.command({ command: "pause" });
    clock.advance(500_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
    await engine.command({ command: "resume" });
    clock.advance(120_000); await engine.tick();
    clock.advance(60_000); await engine.tick();
    await expect(engine.command({ command: "pause" })).rejects.toMatchObject({ code: "ended" });
    expect(engine.currentScene()).toBeNull();
  });

  describe("inject timing (R14)", () => {
    it("never fires an inject whose at_minute is past the time box, even on a late tick", async () => {
      scenario.script.scenes[0].injects![0].at_minute = 3; // time box is 2
      clock.advance(10 * 60_000); // first tick long after the time box
      await engine.tick();
      expect(engine.state.injectsFired).toEqual([]);
      expect(engine.state.currentScene?.id).toBe("s2_close");
      clock.advance(60_000); await engine.tick(); // s2 exits -> session ends
      expect(engine.state.injectsFired).toEqual([]);
    });

    it("does not fire a scene's injects after that scene has exited", async () => {
      clock.advance(30_000); // before inject at minute 1
      await engine.command({ command: "advance" });
      await engine.tick();
      expect(engine.state.currentScene?.id).toBe("s2_close");
      clock.advance(5 * 60_000);
      await engine.tick();
      expect(engine.state.injectsFired).toEqual([]);
    });

    it("fires an inject at exactly the time-box minute once, and the scene still exits", async () => {
      scenario.script.scenes[0].injects![0].at_minute = 2;
      clock.advance(120_000);
      await engine.tick();
      const events = await log.all();
      const fired = events.filter((e) => e.type === "inject.fired");
      expect(fired).toHaveLength(1);
      expect(engine.state.injectsFired).toEqual(["late_inject"]);
      expect(engine.state.currentScene?.id).toBe("s2_close");
      const types = events.map((e) => e.type);
      expect(types.indexOf("inject.fired")).toBeLessThan(types.indexOf("scene.exited"));
    });
  });
});

describe("clocks", () => {
  it("SystemClock returns epoch ms", () => {
    expect(Math.abs(new SystemClock().now() - Date.now())).toBeLessThan(1000);
  });
});

describe("JsonlEventLog", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-log-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("appends one JSON line per event and reads them back", async () => {
    const jl = new JsonlEventLog("s-9", path.join(dir, "nested"));
    expect(await jl.all()).toEqual([]);
    const e1 = await jl.append({ type: "session.ended", reason: "script_complete" }, 5);
    const e2 = await jl.append({ type: "session.ended", reason: "script_complete" }, 6);
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    const all = await jl.all();
    expect(all).toEqual([e1, e2]);
    const raw = await readFile(path.join(dir, "nested", "s-9.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("drives an engine end to end", async () => {
    const sc = await loadScenario(fixture);
    const e = new SessionEngine({ scenario: sc, log: new JsonlEventLog("s-10", dir), clock: new FakeClock(1) });
    await e.start({ host: "p1" });
    await e.say("host", "hi");
    expect((await new JsonlEventLog("s-10", dir).all()).map((x) => x.type)).toContain("utterance");
  });
});
