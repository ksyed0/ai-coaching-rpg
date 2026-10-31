import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { SessionEngine } from "../session-engine.js";
import { MemoryEventLog } from "../event-log.js";
import { FakeClock } from "../clock.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

describe("SessionEngine.start on a non-empty log", () => {
  it("fails with a readable log_not_empty error and appends nothing", async () => {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    await log.append({ type: "facilitator.alert", level: "info", message: "old run" }, 0);
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
    await expect(engine.start({})).rejects.toMatchObject({ name: "EngineError", code: "log_not_empty" });
    expect(await log.all()).toHaveLength(1);
    expect(engine.state.status).toBe("idle");
  });
});

describe("SessionEngine.start interrupted after session.started (BUG-0015)", () => {
  // A throw with code "closed" refuses only that append (the log layer's contract); anything else would fail-stop the engine.
  const refuse = () => Object.assign(new Error("closed"), { code: "closed" });

  async function interrupted(failOnAppend: number) {
    const scenario = await loadScenario(fixture);
    const log = new MemoryEventLog("s");
    const real = log.append.bind(log);
    let n = 0;
    let armed = true;
    log.append = (body, ts) => {
      n++;
      if (armed && n === failOnAppend) { armed = false; return Promise.reject(refuse()); }
      return real(body, ts);
    };
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(0) });
    return { engine, log };
  }

  it("a second start finishes the opening instead of answering log_not_empty", async () => {
    const { engine, log } = await interrupted(2); // append 1 is session.started
    await expect(engine.start({})).rejects.toMatchObject({ code: "closed" });
    expect(engine.startIncomplete).toBe(true);
    expect((await log.all()).map((e) => e.type)).toEqual(["session.started"]);
    await engine.start({});
    expect(engine.startIncomplete).toBe(false);
    expect(engine.state.currentScene).not.toBeNull();
    const types = (await log.all()).map((e) => e.type);
    expect(types.filter((t) => t === "session.started")).toHaveLength(1);
    expect(types).toContain("scene.entered");
  });

  it("every cut point finishes to the same log as an uninterrupted start", async () => {
    const whole = await interrupted(0);
    await whole.engine.start({});
    const expected = (await whole.log.all()).map((e) => e.type);
    for (let at = 2; at <= expected.length; at++) {
      const { engine, log } = await interrupted(at);
      await expect(engine.start({})).rejects.toBeDefined();
      await engine.start({});
      expect((await log.all()).map((e) => e.type), `cut at append ${at}`).toEqual(expected);
    }
  });

  it("a finished start still refuses a repeat (log_not_empty)", async () => {
    const { engine } = await interrupted(0);
    await engine.start({});
    await expect(engine.start({})).rejects.toMatchObject({ code: "log_not_empty" });
  });
});
