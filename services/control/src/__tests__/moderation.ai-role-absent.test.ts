import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../../../runtime/src/review/__tests__/fixtures.js";
import { REPO_ROOT, type ControlConfig } from "../config.js";
import { ModerationService } from "../moderation.js";
import { ReportJobService } from "../report-job.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

// AC-0321 (negative check): an AI role is never a review subject, so the console's subject list and export menu, which read the
// moderation overview, can never offer one. The evaluator writes no report for an AI role; this pins that on the control side.
let world: ReportWorld;
let dataDir: string;
let jobs: ReportJobService;
let svc: ModerationService;

beforeEach(async () => {
  world = await makeReportWorld({ aiRoles: ["ai1"] });
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-mod-ai-"));
  const config = {
    dataDir, sessionsDir: path.join(dataDir, "sessions"), reportsDir: world.root,
    scenariosDir: path.join(REPO_ROOT, "scenarios"), evaluateMarginMs: 500,
  } as ControlConfig;
  await mkdir(config.sessionsDir, { recursive: true });
  // the service only needs the session log to exist to know the session; the review folder is already open and released
  await writeFile(path.join(config.sessionsDir, `${world.sessionId}.jsonl`), "");
  const sessions = { get: () => undefined };
  jobs = new ReportJobService({
    config, sessions, spawn: () => { throw new Error("no spawn"); }, setTimer: () => () => {}, parentEnv: { PATH: "/bin" }, now: () => 1_700_000_000_000,
  });
  svc = new ModerationService({ config, jobs, secrets: [], now: fixedClock(1_900_000_000_000), sleep: async () => {}, random: () => 0.5 });
});
afterEach(async () => {
  await jobs.shutdown();
  await rm(dataDir, { recursive: true, force: true });
  await world.cleanup();
});

describe("AI roles are never report subjects (control)", () => {
  it("the moderation overview has no ai1 subject", async () => {
    const o = await svc.overview(world.sessionId);
    if (o.status !== 200) throw new Error(`overview ${o.status}`);
    expect(o.value.stage).toBe("in_review");
    const ids = o.value.subjects.map((s) => s.id);
    // non-vacuous: the human subjects and the group are listed
    expect(ids).toEqual(expect.arrayContaining(["alice", "bob", "group"]));
    expect(ids).not.toContain("ai1");
  });

  it("exporting ai1 is refused", async () => {
    // non-vacuous: a human subject exports fine in the same world, so the refusal below is about ai1 alone
    expect(await svc.export(world.sessionId, { subject: "alice", audience: "facilitator" }, "priya")).toMatchObject({ status: 200 });
    expect(await svc.export(world.sessionId, { subject: "ai1", audience: "facilitator" }, "priya")).toEqual({ status: 404, code: "unknown_subject" });
  });
});
