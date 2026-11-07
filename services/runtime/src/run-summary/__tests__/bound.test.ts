import type { SessionEvent } from "@acr/events";
import { loadRubrics, loadScenario, type Scenario } from "@acr/script";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../engine/clock.js";
import { JsonlEventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { readSessionLog } from "../../evaluator/log-reader.js";
import { REPO_ROOT } from "../../main.js";
import { evaluationCallBound, runSummaryFromLog } from "../index.js";

const SCENARIO_DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation");
let scenario: Scenario;
let dir: string;
let n = 0;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-runsummary-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function engineLog(aiRoles?: string[]): Promise<{ file: string; events: SessionEvent[] }> {
  const log = new JsonlEventLog(`s-run-${++n}`, dir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, aiRoles ? { aiRoles } : {});
  await engine.say("delivery_lead", "hello");
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  return { file: log.file, events: await readSessionLog(log.file) };
}

describe("evaluationCallBound", () => {
  it("evaluationCallBound is 2×(humans+1) for a 3-human scenario with a group rubric and excludes AI-filled roles", async () => {
    const { rubrics } = await loadRubrics(SCENARIO_DIR, scenario);
    expect(rubrics.some((r) => r.scope === "group" && r.criteria.length > 0)).toBe(true);
    const humans = await engineLog();
    expect(evaluationCallBound(humans.events, scenario, rubrics)).toBe(2 * (3 + 1));
    expect(evaluationCallBound(humans.events, scenario)).toBe(8); // rubrics unknown: the group call is assumed
    const withAi = await engineLog(["tech_lead"]);
    expect(evaluationCallBound(withAi.events, scenario, rubrics)).toBe(2 * (2 + 1));
  });
  it("adds no group call when no group rubric has criteria", async () => {
    const { events } = await engineLog();
    const { rubrics } = await loadRubrics(SCENARIO_DIR, scenario);
    expect(evaluationCallBound(events, scenario, rubrics.filter((r) => r.scope === "individual"))).toBe(2 * 3);
  });
});

describe("runSummaryFromLog", () => {
  it("runSummaryFromLog returns null for a missing log", async () => {
    expect(await runSummaryFromLog(path.join(dir, "nope.jsonl"), SCENARIO_DIR, [])).toBeNull();
  });
  it("returns null for a missing scenario directory", async () => {
    const { file } = await engineLog();
    expect(await runSummaryFromLog(file, path.join(dir, "no-scenario"), [])).toBeNull();
  });
  it("reads a recorded log into a summary", async () => {
    const { file } = await engineLog();
    expect(await runSummaryFromLog(file, SCENARIO_DIR, [])).toMatchObject({ scenesEndedByGm: 0, fallbackReplies: 0, npcReplies: 0 });
  });
});
