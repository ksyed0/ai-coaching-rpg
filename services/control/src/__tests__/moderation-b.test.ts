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
  const logDir = await mkdtemp(path.join(os.tmpdir(), "acr-modb-logs-"));
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
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-modb-"));
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

describe("ModerationService, part B", () => {
  it("release with an empty list or an unsafe id is 400 invalid and writes nothing", async () => {
    const before = await reviewBytes();
    expect(await release([])).toEqual({ status: 400, code: "invalid" });
    expect(await release(["../x"])).toEqual({ status: 400, code: "invalid" });
    expect(await svc.release(id, { all: true } as never, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.release(id, { subjects: Array.from({ length: 51 }, (_, i) => `s${i}`) }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await reviewBytes()).toEqual(before);
  });

  it("release with an open item is 409 blocked with data.blocked ids and nothing written", async () => {
    await ready("bob");
    const before = await reviewBytes();
    expect(await release(["alice", "bob"])).toEqual({ status: 409, code: "blocked", detail: ["alice"] });
    expect(await reviewBytes()).toEqual(before);
  });

  it("release answers released and groupTableStale; an unknown subject is 404; released twice is 409 not_editable", async () => {
    await ready("alice");
    expect(await release(["nobody"])).toEqual({ status: 404, code: "unknown_subject" });
    expect(await release(["alice"])).toEqual({ status: 200, value: { released: ["alice"], groupTableStale: false } });
    expect(await release(["alice"])).toEqual({ status: 409, code: "not_editable" });
  });

  it("the author suffix -console is on every part B event, and a bad name is 400 invalid", async () => {
    await ready("alice");
    await ready("group");
    expect(await release(["alice", "group"])).toMatchObject({ status: 200 });
    expect(await svc.amend(id, "alice", { reason: "fix" }, "priya")).toEqual({ status: 200, value: undefined });
    expect(await svc.withdraw(id, "alice", { reason: "gone" }, "priya_2")).toMatchObject({ status: 200 });
    expect(await svc.export(id, { subject: "group", audience: "facilitator" }, "priya")).toMatchObject({ status: 200 });
    const run = makeRunner(config.reportsDir);
    expect((await run(["respond", id, "--role", "bob", "--text", "no", "--dispute", "--by", "kamal"])).code).toBeDefined();
    const events = (await readReview(dir)).events;
    const types = ["report.released", "report.amended", "report.withdrawn", "report.exported"];
    const part = events.filter((e) => types.includes(e.type));
    expect(part.map((e) => e.type)).toEqual(types);
    expect(part.map((e) => (e.actor as { by: string }).by)).toEqual(["priya-console", "priya-console", "priya_2-console", "priya-console"]);
    const before = await reviewBytes();
    for (const name of ["pri ya", "a".repeat(57), "", 7 as unknown as string]) {
      expect(await svc.release(id, { subjects: ["bob"] }, name)).toEqual({ status: 400, code: "invalid" });
      expect(await svc.amend(id, "group", { reason: "r" }, name)).toEqual({ status: 400, code: "invalid" });
      expect(await svc.withdraw(id, "group", { reason: "r" }, name)).toEqual({ status: 400, code: "invalid" });
      expect(await svc.resolve(id, { seq: 1, outcome: "upheld", reason: "r" }, name)).toEqual({ status: 400, code: "invalid" });
      expect(await svc.export(id, { subject: "group", audience: "facilitator" }, name)).toEqual({ status: 400, code: "invalid" });
    }
    expect(await reviewBytes()).toEqual(before);
  });

  it("amend and withdraw need a reason; withdraw reports groupTableStale", async () => {
    await ready("alice");
    await ready("group");
    await release(["alice", "group"]);
    expect(await svc.amend(id, "alice", { reason: "" }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.withdraw(id, "alice", {} as never, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.withdraw(id, "nobody", { reason: "x" }, "priya")).toEqual({ status: 404, code: "unknown_subject" });
    expect(await svc.withdraw(id, "alice", { reason: "gone" }, "priya")).toEqual({ status: 200, value: { groupTableStale: true } });
  });

  it("resolve: amended before an amend is 409 needs_amend; declined closes the dispute; a missing response is 409 refused", async () => {
    await ready("alice");
    await release(["alice"]);
    const run = makeRunner(config.reportsDir);
    expect((await run(["respond", id, "--role", "alice", "--text", "I disagree", "--dispute", "--by", "kamal"])).code).toBe(0);
    const seq = (await readReview(dir)).events.at(-1)!.seq;
    const before = await reviewBytes();
    expect(await svc.resolve(id, { seq, outcome: "amended", reason: "changed" }, "priya")).toEqual({ status: 409, code: "needs_amend" });
    expect(await svc.resolve(id, { seq: seq + 50, outcome: "upheld", reason: "r" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await svc.resolve(id, { seq: 0, outcome: "upheld", reason: "r" }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.resolve(id, { seq, outcome: "nope" as never, reason: "r" }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await reviewBytes()).toEqual(before);
    expect(await svc.resolve(id, { seq, outcome: "declined", reason: "the evidence stands" }, "priya")).toEqual({ status: 200, value: undefined });
    expect((await readReview(dir)).events.at(-1)).toMatchObject({ type: "dispute.resolved", response: seq, outcome: "declined" });
  });

  it("export of a draft is 409 not_released and writes nothing; an amending subject is 409 not_released for the facilitator", async () => {
    const before = await reviewBytes();
    expect(await svc.export(id, { subject: "alice", audience: "facilitator" }, "priya")).toEqual({ status: 409, code: "not_released" });
    expect(await reviewBytes()).toEqual(before);
    await ready("alice");
    await release(["alice"]);
    await svc.amend(id, "alice", { reason: "fix" }, "priya");
    const mid = await reviewBytes();
    expect(await svc.export(id, { subject: "alice", audience: "facilitator" }, "priya")).toEqual({ status: 409, code: "not_released" });
    expect(await reviewBytes()).toEqual(mid);
  });

  it("export returns {fileName, markdown}, writes the event first and nothing to the reports folder", async () => {
    await ready("alice");
    await release(["alice"]);
    const listing = async () => (await import("node:fs/promises")).readdir(dir);
    const names = (await listing()).sort();
    const o = await svc.export(id, { subject: "alice", audience: "participant:alice" }, "priya");
    expect(o).toMatchObject({ status: 200, value: { fileName: "report-alice.md" } });
    expect(Object.keys((o as { value: object }).value).sort()).toEqual(["fileName", "markdown"]);
    expect((await listing()).sort()).toEqual(names);
    expect((await readReview(dir)).events.at(-1)).toMatchObject({ type: "report.exported", destination: "console-download", subject: "alice" });
    expect(await svc.export(id, { subject: "alice", audience: "participant:bob" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await svc.export(id, { subject: "alice", audience: "hr" as never }, "priya")).toEqual({ status: 400, code: "invalid" });
    expect(await svc.export(id, { subject: "../x", audience: "facilitator" }, "priya")).toEqual({ status: 400, code: "invalid" });
  });

  it("a participant:alice export of group holds no bob individual results; the facilitator export of the same subject does", async () => {
    for (const s of ["alice", "bob", "group"]) await ready(s);
    expect(await release(["alice", "bob", "group"])).toMatchObject({ status: 200 });
    const fac = await svc.export(id, { subject: "group", audience: "facilitator" }, "priya");
    const part = await svc.export(id, { subject: "group", audience: "participant:alice" }, "priya");
    if (fac.status !== 200 || part.status !== 200) throw new Error("exports");
    // bob's column of the coverage table (his individual results) is facilitator-only; the quote he spoke in the evidence stays
    expect(fac.value.markdown).toContain("| `bob` |");
    expect(fac.value.markdown).toContain("2.5 - Proficient");
    expect(part.value.markdown).not.toContain("| `bob` |");
    expect(part.value.markdown).not.toContain("2.5 - Proficient");
  });

  it("a superseded review is 409 superseded for a write, and a participant export of it is 409 refused", async () => {
    await ready("alice");
    await release(["alice"]);
    const run = makeRunner(config.reportsDir);
    // a second evaluation of the same session instance, superseding the first
    const dir2 = path.join(config.reportsDir, `${id}-2`);
    await cp(draftDir, dir2, { recursive: true });
    const sup = await run(["supersede", id, `${id}-2`, "--by", "kamal"]);
    expect(sup.code, sup.err).toBe(0);
    // the race: the service chose the old folder as live before the supersede landed
    const raced = svc as unknown as { liveReview: (s: string) => Promise<string> };
    raced.liveReview = async () => dir;
    const before = await reviewBytes();
    expect(await svc.amend(id, "alice", { reason: "late" }, "priya")).toEqual({ status: 409, code: "superseded" });
    expect(await svc.export(id, { subject: "alice", audience: "participant:alice" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await reviewBytes()).toEqual(before);
  });
});
