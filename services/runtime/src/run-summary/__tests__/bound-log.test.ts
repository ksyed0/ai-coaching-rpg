import { loadScenario, type Scenario } from "@acr/script";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../engine/clock.js";
import { JsonlEventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { REPO_ROOT } from "../../main.js";
import { evaluationCallBoundFromLog } from "../index.js";

const SCENARIO_DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation");
let scenario: Scenario;
let dir: string;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-boundlog-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function engineLog(aiRoles?: string[]): Promise<string> {
  const log = new JsonlEventLog("s-bound-log", dir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, aiRoles ? { aiRoles } : {});
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  return log.file;
}

describe("evaluationCallBoundFromLog", () => {
  it("reads the log, scenario and rubrics and counts the group call", async () => {
    expect(await evaluationCallBoundFromLog(await engineLog(), SCENARIO_DIR)).toBe(8);
  });
  it("excludes AI-filled roles", async () => {
    expect(await evaluationCallBoundFromLog(await engineLog(["tech_lead"]), SCENARIO_DIR)).toBe(6);
  });
  it("is null for a missing log, a missing scenario or invalid rubrics", async () => {
    const file = await engineLog();
    expect(await evaluationCallBoundFromLog(path.join(dir, "nope.jsonl"), SCENARIO_DIR)).toBeNull();
    expect(await evaluationCallBoundFromLog(file, path.join(dir, "nope"))).toBeNull();
    const copy = path.join(dir, "scen");
    await cp(SCENARIO_DIR, copy, { recursive: true });
    await writeFile(path.join(copy, "rubrics", "group_collaboration_v1.yaml"), "id: [unclosed\n");
    expect(await evaluationCallBoundFromLog(file, copy)).toBeNull();
  });
});
