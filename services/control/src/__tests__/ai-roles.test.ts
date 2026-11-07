import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadScenario } from "@acr/script";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { aiRolesFor } from "../ai-roles.js";
import { REPO_ROOT } from "../config.js";
import { SessionList } from "../session-list.js";
import { sid } from "./fake-child.js";

/** US-0060 (slice 2c-4, Task 3): the AI roles of a session, from its real log, real scenario folder and real session list (no fakes for the reader). */
const SCENARIOS = path.join(REPO_ROOT, "scenarios");
const SCENARIO = "friday-escalation";
const ID = sid(7);
let root: string;
let config: { sessionsDir: string; scenariosDir: string };
let list: SessionList;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "acr-ctl-airoles-"));
  config = { sessionsDir: path.join(root, "sessions"), scenariosDir: SCENARIOS };
  mkdirSync(config.sessionsDir, { recursive: true, mode: 0o700 });
  list = new SessionList(path.join(root, "sessions.json"));
  list.upsert({ sessionId: ID, scenarioId: SCENARIO, status: "ended" });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const logFile = (): string => path.join(config.sessionsDir, `${ID}.jsonl`);
/** A real ended session log written by the engine, with `aiRoles` recorded in its session.started. */
async function endedLog(aiRoles: string[]): Promise<void> {
  const scenario = await loadScenario(path.join(SCENARIOS, SCENARIO));
  const log = new JsonlEventLog(ID, config.sessionsDir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  await engine.start(Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`])), { aiRoles });
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  expect(log.file).toBe(logFile());
}

describe("aiRolesFor", () => {
  it("returns the roles for a valid ended session", async () => {
    await endedLog(["tech_lead"]);
    expect(await aiRolesFor(config, list, ID)).toEqual(["tech_lead"]);
  });
  it("returns null for a missing log", async () => {
    expect(await aiRolesFor(config, list, ID)).toBeNull();
  });
  it("returns null for an empty log", async () => {
    writeFileSync(logFile(), "");
    expect(await aiRolesFor(config, list, ID)).toBeNull();
  });
  it("returns null for a log with two session.started", async () => {
    await endedLog(["tech_lead"]);
    const lines = readFileSync(logFile(), "utf8").split("\n").filter(Boolean);
    const started = JSON.parse(lines[0]!) as Record<string, unknown>;
    writeFileSync(logFile(), [...lines, JSON.stringify({ ...started, seq: lines.length + 1 })].join("\n") + "\n");
    expect(await aiRolesFor(config, list, ID)).toBeNull();
  });
  it("returns null for a missing scenario folder", async () => {
    await endedLog(["tech_lead"]);
    expect(await aiRolesFor({ ...config, scenariosDir: path.join(root, "no-scenarios") }, list, ID)).toBeNull();
  });
  it("returns null for a corrupt sessions.json", async () => {
    await endedLog(["tech_lead"]);
    writeFileSync(path.join(root, "sessions.json"), "not json\n");
    expect(await aiRolesFor(config, list, ID)).toBeNull();
  });
  it("returns null for an invalid session id", async () => {
    await endedLog(["tech_lead"]);
    for (const bad of ["../x", "", `${ID}/../${ID}`, "a".repeat(65)]) expect(await aiRolesFor(config, list, bad)).toBeNull();
  });
  it("returns null for a session that is not in the session list", async () => {
    await endedLog(["tech_lead"]);
    list.remove(ID);
    expect(await aiRolesFor(config, list, ID)).toBeNull();
  });
});
