import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScenario } from "@acr/script";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { fixedClock, makeDraftDir, makeRunner } from "../../../runtime/src/review/__tests__/fixtures.js";
import { readReview } from "../../../runtime/src/review/review-log.js";
import { REPO_ROOT, type ControlConfig } from "../config.js";
import { ModerationService } from "../moderation.js";
import { ReportJobService } from "../report-job.js";

const SCENARIO = "friday-escalation";

let draftRoot: string;
let draftDir: string;
let id: string;
let templateLog: string;

beforeAll(async () => {
  ({ root: draftRoot, dir: draftDir } = await makeDraftDir());
  id = path.basename(draftDir);
  const logDir = await mkdtemp(path.join(os.tmpdir(), "acr-modhide-logs-"));
  const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", SCENARIO));
  const log = new JsonlEventLog(id, logDir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, {});
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  templateLog = log.file;
});
afterAll(async () => {
  await rm(draftRoot, { recursive: true, force: true });
  await rm(path.dirname(templateLog), { recursive: true, force: true });
});

let dataDir: string;
let config: ControlConfig;
let jobs: ReportJobService;
let svc: ModerationService;
let dir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-modhide-"));
  config = {
    dataDir, sessionsDir: path.join(dataDir, "sessions"), reportsDir: path.join(dataDir, "reports"),
    scenariosDir: path.join(REPO_ROOT, "scenarios"), evaluateMarginMs: 500,
  } as ControlConfig;
  await mkdir(config.sessionsDir, { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });
  await cp(templateLog, path.join(config.sessionsDir, `${id}.jsonl`));
  const sessions = { get: (sid: string) => (sid === id ? { scenarioId: SCENARIO, ended: true } : undefined) };
  jobs = new ReportJobService({
    config, sessions, spawn: () => { throw new Error("no spawn"); }, setTimer: () => () => {}, parentEnv: { PATH: "/bin" }, now: () => 1_700_000_000_000,
  });
  svc = new ModerationService({ config, jobs, secrets: [], now: fixedClock(1_900_000_000_000), sleep: async () => {}, random: () => 0.5 });
  dir = path.join(config.reportsDir, id);
  await cp(draftDir, dir, { recursive: true });
  expect(await svc.open(id, "priya")).toEqual({ status: 200, value: { subjects: 3 } });
});
afterEach(async () => {
  await jobs.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

const reviewBytes = (): Promise<Buffer> => readFile(path.join(dir, "review.jsonl"));
/** Accepts every open criterion and a stale summary of a subject, through the service. */
async function ready(subject: string): Promise<void> {
  const v = await svc.subject(id, subject);
  if (v.status !== 200) throw new Error("no subject view");
  for (const c of v.value.criteria.filter((x) => x.status === "needs_review")) {
    expect(await svc.accept(id, subject, { criterion: c.id }, "priya")).toEqual({ status: 200, value: undefined });
  }
  const st = await svc.overview(id);
  if (st.status === 200 && st.value.subjects.find((s) => s.id === subject)?.summaryStale)
    expect(await svc.accept(id, subject, { summary: true }, "priya")).toEqual({ status: 200, value: undefined });
}
const release = (subjects: string[]) => svc.release(id, { subjects }, "priya");

describe("ModerationService.hide", () => {
  async function respond(): Promise<number> {
    await ready("alice");
    await release(["alice"]);
    const run = makeRunner(config.reportsDir);
    expect((await run(["respond", id, "--role", "alice", "--text", "I disagree", "--by", "kamal"])).code).toBe(0);
    return (await readReview(dir)).events.at(-1)!.seq;
  }

  it("hides a response: one response.hidden event under the -console name; a second hide and a missing response are 409 refused", async () => {
    const seq = await respond();
    expect(await svc.hide(id, { seq, reason: "contains a phone number" }, "priya")).toEqual({ status: 200, value: undefined });
    expect((await readReview(dir)).events.at(-1)).toMatchObject({
      type: "response.hidden", response: seq, reason: "contains a phone number", actor: { by: "priya-console" },
    });
    const before = await reviewBytes();
    expect(await svc.hide(id, { seq, reason: "again" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await svc.hide(id, { seq: seq + 50, reason: "r" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await reviewBytes()).toEqual(before);
  });

  it("a bad seq, a missing reason or a bad name is 400 invalid and writes nothing", async () => {
    const seq = await respond();
    const before = await reviewBytes();
    expect(await svc.hide(id, { seq: 0, reason: "r" }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.hide(id, { seq: 1.5, reason: "r" }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.hide(id, { seq } as never, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.hide(id, { seq, reason: "r" }, "pri ya")).toEqual({ status: 400, code: "invalid" });
    expect(await reviewBytes()).toEqual(before);
  });

  it("a superseded review is 409 superseded", async () => {
    const seq = await respond();
    const run = makeRunner(config.reportsDir);
    const dir2 = path.join(config.reportsDir, `${id}-2`);
    await cp(draftDir, dir2, { recursive: true });
    expect((await run(["supersede", id, `${id}-2`, "--by", "kamal"])).code).toBe(0);
    (svc as unknown as { liveReview: (s: string) => Promise<string> }).liveReview = async () => dir;
    const before = await reviewBytes();
    expect(await svc.hide(id, { seq, reason: "late" }, "priya")).toEqual({ status: 409, code: "superseded" });
    expect(await reviewBytes()).toEqual(before);
  });
});
