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
