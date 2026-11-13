import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../../runtime/src/review/__tests__/fixtures.js";
import { REPO_ROOT, type ControlConfig } from "../config.js";
import { AI_ROLES_MAX, ModerationService } from "../moderation.js";
import { ReportJobService } from "../report-job.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

// US-0068 (TC-0158, TC-0161): the in_review overview carries the session's AI roles, read through the injected lookup (main.ts wires
// control's `aiRolesFor`), so the console can show an "AI player, not scored" row. Anything unknown or malformed omits the field.
let world: ReportWorld;
let dataDir: string;
let config: ControlConfig;
let jobs: ReportJobService;

const make = (aiRoles?: (id: string) => Promise<string[] | null>): ModerationService =>
  new ModerationService({ config, jobs, secrets: [], now: fixedClock(1_900_000_000_000), sleep: async () => {}, random: () => 0.5, ...(aiRoles ? { aiRoles } : {}) });

const overviewOf = async (svc: ModerationService) => {
  const o = await svc.overview(world.sessionId);
  if (o.status !== 200) throw new Error(`overview ${o.status}`);
  expect(o.value.stage).toBe("in_review");
  return o.value;
};

beforeEach(async () => {
  world = await makeReportWorld({ aiRoles: ["ai1"] });
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-mod-ai-overview-"));
  config = {
    dataDir, sessionsDir: path.join(dataDir, "sessions"), reportsDir: world.root,
    scenariosDir: path.join(REPO_ROOT, "scenarios"), evaluateMarginMs: 500,
  } as ControlConfig;
  await mkdir(config.sessionsDir, { recursive: true });
  await writeFile(path.join(config.sessionsDir, `${world.sessionId}.jsonl`), "");
  jobs = new ReportJobService({
    config, sessions: { get: () => undefined }, spawn: () => { throw new Error("no spawn"); }, setTimer: () => () => {},
    parentEnv: { PATH: "/bin" }, now: () => 1_700_000_000_000,
  });
});
afterEach(async () => {
  await jobs.shutdown();
  await rm(dataDir, { recursive: true, force: true });
  await world.cleanup();
});

describe("test_moderation_overview_aiRoles (US-0068)", () => {
  it("in_review carries aiRoles from the injected lookup, in the order it returns, and passes the session id", async () => {
    const lookup = vi.fn(async (_id: string) => ["tech_lead", "ai1"]);
    const v = await overviewOf(make(lookup));
    expect(v.aiRoles).toEqual(["tech_lead", "ai1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(world.sessionId);
    // the rest of the overview is unchanged
    expect(v.subjects.map((s) => s.id)).toEqual(expect.arrayContaining(["alice", "bob", "group"]));
  });

  it("an empty list is carried as an empty list", async () => {
    const v = await overviewOf(make(async () => []));
    expect(v.aiRoles).toEqual([]);
  });

  it("a lookup answering null, one that throws, one that rejects and no lookup at all each leave the field out", async () => {
    const lookups: (((id: string) => Promise<string[] | null>) | undefined)[] = [
      async () => null,
      () => { throw new Error("sync boom"); },
      async () => { throw new Error("async boom"); },
      undefined,
    ];
    for (const l of lookups) {
      const v = await overviewOf(make(l));
      expect(Object.prototype.hasOwnProperty.call(v, "aiRoles")).toBe(false);
      expect(v.subjects.length).toBeGreaterThan(0);
    }
  });

  it("a malformed answer omits the field: not an array, a non-string, an unsafe id, a duplicate, too many", async () => {
    const tooMany = Array.from({ length: AI_ROLES_MAX + 1 }, (_, i) => `r${i}`);
    const bad: unknown[] = [
      "ai1", { 0: "ai1" }, 7, ["ai1", 2], ["ai1", null], ["../x"], ["a b"], [""], ["ai1", "ai1"], tooMany, ["x".repeat(65)],
    ];
    for (const answer of bad) {
      const v = await overviewOf(make(async () => answer as string[]));
      expect(Object.prototype.hasOwnProperty.call(v, "aiRoles"), JSON.stringify(answer).slice(0, 60)).toBe(false);
    }
    // the boundary: exactly AI_ROLES_MAX safe, distinct ids are carried
    const max = tooMany.slice(0, AI_ROLES_MAX);
    expect((await overviewOf(make(async () => max))).aiRoles).toEqual(max);
  });

  it("the carried list is a copy, not the lookup's own array", async () => {
    const mine = ["ai1"];
    const v = await overviewOf(make(async () => mine));
    mine.push("tech_lead");
    expect(v.aiRoles).toEqual(["ai1"]);
  });
});
