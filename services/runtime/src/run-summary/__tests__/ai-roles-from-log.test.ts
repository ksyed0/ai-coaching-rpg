import { loadScenario } from "@acr/script";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../engine/clock.js";
import { JsonlEventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { REPO_ROOT } from "../../main.js";
import { aiRolesFromLog } from "../index.js";

const SCENARIO_DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation");
let scenario: Awaited<ReturnType<typeof loadScenario>>;
let dir: string;
beforeAll(async () => { scenario = await loadScenario(SCENARIO_DIR); });
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-airoleslog-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function engineLog(aiRoles?: string[]): Promise<string> {
  const log = new JsonlEventLog("s-ai-roles-log", dir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, aiRoles ? { aiRoles } : {});
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  return log.file;
}

/** Rewrites the log's lines through `edit` (one parsed event per line). */
async function rewrite(file: string, edit: (events: Record<string, unknown>[]) => Record<string, unknown>[]): Promise<void> {
  const events = (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  await writeFile(file, edit(events).map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("aiRolesFromLog", () => {
  it("returns the AI roles of a log with aiRoles", async () => {
    expect(await aiRolesFromLog(await engineLog(["tech_lead", "account_manager"]), SCENARIO_DIR)).toEqual(["account_manager", "tech_lead"]);
  });
  it("returns [] when the log records none", async () => {
    expect(await aiRolesFromLog(await engineLog(), SCENARIO_DIR)).toEqual([]);
  });
  it("returns null for an inconsistent record (aiRoles naming a non-player role)", async () => {
    const file = await engineLog(["tech_lead"]);
    await rewrite(file, (es) => es.map((e) => (e.type === "session.started" ? { ...e, aiRoles: ["client_sponsor"] } : e)));
    expect(await aiRolesFromLog(file, SCENARIO_DIR)).toBeNull();
  });
  it("returns null for two session.started events", async () => {
    const file = await engineLog(["tech_lead"]);
    await rewrite(file, (es) => {
      const st = es.find((e) => e.type === "session.started")!;
      const last = es[es.length - 1]!;
      return [...es, { ...st, seq: (last.seq as number) + 1 }];
    });
    expect(await aiRolesFromLog(file, SCENARIO_DIR)).toBeNull();
  });
  it("returns null when the log file is missing", async () => {
    expect(await aiRolesFromLog(path.join(dir, "nope.jsonl"), SCENARIO_DIR)).toBeNull();
  });
  it("returns null when the scenario dir is missing", async () => {
    expect(await aiRolesFromLog(await engineLog(["tech_lead"]), path.join(dir, "nope"))).toBeNull();
  });
});
