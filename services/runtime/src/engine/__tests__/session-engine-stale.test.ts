import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { SessionEngine, EngineError } from "../session-engine.js";
import { MemoryEventLog } from "../event-log.js";
import { FakeClock } from "../clock.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let log: MemoryEventLog;
beforeEach(async () => {
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log, clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
});
const count = () => engine.state.lastSeq;

describe("expectSceneId guard", () => {
  it("say with the current scene id succeeds", async () => {
    await expect(engine.say("host", "hi", "text", { expectSceneId: "s1_open" })).resolves.toMatchObject({ type: "utterance" });
  });

  it("say with a stale scene id throws stale_scene and appends nothing", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    const before = count();
    await expect(engine.say("guest", "hi", "text", { expectSceneId: "s1_open" })).rejects.toMatchObject({ code: "stale_scene" });
    expect(count()).toBe(before);
  });

  it("alert with the current scene id appends an alert", async () => {
    const e = await engine.alert("hey", "warning", { expectSceneId: "s1_open" });
    expect(e).toMatchObject({ type: "facilitator.alert", message: "hey" });
  });

  it("alert with a stale scene id is a silent no-op", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    const before = count();
    expect(await engine.alert("hey", "warning", { expectSceneId: "s1_open" })).toBeNull();
    expect(count()).toBe(before);
  });

  it("alert after the session has ended appends nothing", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    const before = count();
    expect(await engine.alert("late")).toBeNull();
    expect(count()).toBe(before);
    expect(EngineError).toBeDefined();
  });
});
