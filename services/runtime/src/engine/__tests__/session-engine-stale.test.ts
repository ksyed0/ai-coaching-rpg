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

describe("recordGmVerdict expectSceneId guard (R18)", () => {
  const COND = "both parties have said hello";
  it("records with the current scene id and returns true", async () => {
    expect(await engine.recordGmVerdict(COND, true, "ok", { expectSceneId: "s1_open" })).toBe(true);
    expect(engine.state.gmVerdicts[COND]).toBe(true);
  });

  it("records without expectSceneId (back-compat) and returns true", async () => {
    expect(await engine.recordGmVerdict(COND, false, "no")).toBe(true);
  });

  it("returns false and appends nothing for a stale scene id", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    const before = count();
    expect(await engine.recordGmVerdict(COND, true, "stale", { expectSceneId: "s1_open" })).toBe(false);
    expect(count()).toBe(before);
    expect(engine.state.gmVerdicts).toEqual({});
  });

  it("returns false after the session has ended", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    const before = count();
    expect(await engine.recordGmVerdict(COND, true, "late")).toBe(false);
    expect(count()).toBe(before);
  });
});

describe("command expectSceneId guard (R43)", () => {
  it("advance with the current scene id works and with none behaves as before", async () => {
    await engine.command({ command: "advance" }, { expectSceneId: "s1_open" }); await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
  });
  it("advance with a stale scene id throws stale_scene and appends nothing (the next scene is not skipped)", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    const before = count();
    await expect(engine.command({ command: "advance" }, { expectSceneId: "s1_open" })).rejects.toMatchObject({ code: "stale_scene" });
    expect(count()).toBe(before);
    expect(engine.state.advanceRequested).toBe(false);
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });
  it("is checked after the session ended as `ended` first", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.command({ command: "advance" }); await engine.tick();
    await expect(engine.command({ command: "advance" }, { expectSceneId: "s2_close" })).rejects.toMatchObject({ code: "ended" });
  });
});

describe("fallback flag on say (R44)", () => {
  it("marks the utterance only when asked, and the transcript is unchanged either way", async () => {
    const plain = await engine.say("host", "hi");
    const flagged = await engine.say("guest", "canned", "text", { fallback: true });
    expect(plain).not.toHaveProperty("fallback");
    expect(flagged).toMatchObject({ type: "utterance", fallback: true });
    expect(engine.state.transcript.map((t) => Object.keys(t).sort().join())).toEqual(Array(2).fill("channel,roleId,sceneId,seq,text,ts"));
  });
});

describe("the scene-id guard cannot be probed by a role outside the scene (R45)", () => {
  it("a player outside the current scene gets not_in_scene for a correct AND an incorrect guard", async () => {
    const scenario = await loadScenario(fixture);
    scenario.script.scenes[1]!.participants = ["guest"]; // the host is not in scene two
    const eng = new SessionEngine({ scenario, log: new MemoryEventLog("probe"), clock: new FakeClock(0) });
    await eng.start({ host: "p1" });
    await eng.command({ command: "advance" }); await eng.tick();
    expect(eng.state.currentScene?.id).toBe("s2_close");
    const before = eng.state.lastSeq;
    for (const guess of ["s2_close", "s1_open", "nonsense"]) {
      await expect(eng.say("host", "hi", "text", { expectSceneId: guess })).rejects.toMatchObject({ code: "not_in_scene" });
    }
    expect(eng.state.lastSeq).toBe(before);
  });
  it("a role that IS in the scene still gets stale_scene for a wrong guard", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    await expect(engine.say("host", "hi", "text", { expectSceneId: "s1_open" })).rejects.toMatchObject({ code: "stale_scene" });
  });
});

describe("recordGmNoVerdict (US-0025)", () => {
  const COND = "both parties have said hello";
  it("appends gm.no_verdict for the current scene, and a decision records its via", async () => {
    expect(await engine.recordGmNoVerdict(COND, "no_json", 2, { expectSceneId: "s1_open" })).toBe(true);
    expect(await engine.recordGmVerdict(COND, false, "no", { via: "reask" })).toBe(true);
    const last = engine.state.lastSeq;
    expect(last).toBeGreaterThan(0);
  });
  it("appends nothing for a stale scene or after the end", async () => {
    await engine.command({ command: "advance" }); await engine.tick();
    const before = count();
    expect(await engine.recordGmNoVerdict(COND, "empty", 1, { expectSceneId: "s1_open" })).toBe(false);
    expect(count()).toBe(before);
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    expect(await engine.recordGmNoVerdict(COND, "empty", 1)).toBe(false);
  });
});
