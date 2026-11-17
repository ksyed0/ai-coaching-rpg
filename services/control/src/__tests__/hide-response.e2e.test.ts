import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadScenario } from "@acr/script";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectSecrets } from "@acr/runtime/reports";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { fixedClock, makeDraftDir } from "../../../runtime/src/review/__tests__/fixtures.js";
import { readReview } from "../../../runtime/src/review/review-log.js";
import { REPO_ROOT, type ControlConfig } from "../config.js";
import { ModerationService } from "../moderation.js";
import { createParticipantWriteService, WRITE_LINK_FULL, WRITE_TOO_MANY, type ParticipantWriteService } from "../participant-writes.js";
import { ReportAccessStore } from "../report-access.js";
import { ReportJobService } from "../report-job.js";
import { createReportService, type ReportService } from "../reports.js";

/**
 * US-0069 end to end: a participant posts a response through the report link, the facilitator hides it through the moderation service,
 * and the canary text reaches no participant page, no participant export and no facilitator export (the facilitator one taken after an
 * amend and a second release). The log keeps the text, and hiding never refunds either response cap.
 */
const SCENARIO = "friday-escalation";
const CANARY = "CANARY-7f3a-hidden-response-text";
const MIN = 60_000;

let draftRoot: string;
let draftDir: string;
let id: string;
let templateLog: string;

beforeAll(async () => {
  ({ root: draftRoot, dir: draftDir } = await makeDraftDir());
  id = path.basename(draftDir);
  const logDir = await mkdtemp(path.join(os.tmpdir(), "acr-hide-e2e-logs-"));
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
let store: ReportAccessStore;
let writes: ParticipantWriteService;
let reports: ReportService;
let dir: string;
let clock: { t: number };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-hide-e2e-"));
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
  clock = { t: 1_800_000_000_000 };
  store = new ReportAccessStore({ file: path.join(dataDir, "report-access.json"), days: 90, now: () => clock.t });
  writes = createParticipantWriteService({ config, store, secrets: [], now: () => clock.t, sleep: async () => {}, random: () => 0.5 });
  reports = createReportService({ config, store, secrets: collectSecrets({}), now: () => clock.t, aiRoles: async () => [] });
  dir = path.join(config.reportsDir, id);
  await cp(draftDir, dir, { recursive: true });
  expect(await svc.open(id, "priya")).toEqual({ status: 200, value: { subjects: 3 } });
});
afterEach(async () => {
  await jobs.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

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
const releaseAlice = async (): Promise<void> => {
  await ready("alice");
  expect(await svc.release(id, { subjects: ["alice"] }, "priya")).toMatchObject({ status: 200 });
};
const link = async (): Promise<string> => (await store.issue(id, "alice")).credential.id;
const reissue = async (): Promise<string> => (await store.reissue(id, "alice")).credential.id;
const post = async (cred: string, text: string) => {
  clock.t += MIN; // stay under the 20-per-10-minutes throttle
  return writes.respond(id, cred, { text });
};
const added = async () => (await readReview(dir)).events.filter((e) => e.type === "response.added");
const hidden = async () => (await readReview(dir)).events.filter((e) => e.type === "response.hidden");
const log = async (): Promise<string> => readFile(path.join(dir, "review.jsonl"), "utf8");
const participantRead = async (cred: string): Promise<string> => JSON.stringify(await reports.read(id, cred));
const exported = async (audience: "facilitator" | `participant:${string}`): Promise<string> => {
  const r = await svc.export(id, { subject: "alice", audience }, "priya");
  if (r.status !== 200) throw new Error(`export refused: ${JSON.stringify(r)}`);
  return r.value.markdown;
};

describe("US-0069 hide a participant response, end to end", () => {
  it("a hidden response reaches no participant page and no export, even a facilitator export after an amend and a second release; the log keeps it", async () => {
    await releaseAlice();
    const cred = await link();
    expect(await post(cred, CANARY)).toEqual({ status: 200, wrote: true });
    const seq = (await added())[0]!.seq;

    // Control: before the hide the participant readers DO show the text, so the absence below is not vacuous.
    expect(await participantRead(cred)).toContain(CANARY);
    expect(await exported("participant:alice")).toContain(CANARY);

    expect(await svc.hide(id, { seq, reason: "names a colleague" }, "priya")).toEqual({ status: 200, value: undefined });
    expect(await participantRead(cred)).not.toContain(CANARY);
    expect(await exported("participant:alice")).not.toContain(CANARY);
    expect(await exported("facilitator")).not.toContain(CANARY);

    // The Opus review's C1 path: amend, then a second release, then the facilitator export (read from the frozen snapshot).
    expect(await svc.amend(id, "alice", { reason: "re-check after the hide" }, "priya")).toEqual({ status: 200, value: undefined });
    await releaseAlice();
    expect(await participantRead(cred)).not.toContain(CANARY);
    expect(await exported("participant:alice")).not.toContain(CANARY);
    expect(await exported("facilitator")).not.toContain(CANARY);

    // The audit log keeps the text and holds exactly one hide with who and why.
    expect(await log()).toContain(CANARY);
    expect((await added())[0]).toMatchObject({ seq, text: CANARY });
    const h = await hidden();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ response: seq, reason: "names a colleague", actor: { by: "priya-console" } });

    // A second hide is refused and writes nothing; so is a response that does not exist.
    const before = await log();
    expect(await svc.hide(id, { seq, reason: "again" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await svc.hide(id, { seq: seq + 500, reason: "r" }, "priya")).toEqual({ status: 409, code: "refused" });
    expect(await log()).toEqual(before);
  });

  it("control: the same flow without a hide DOES put the response in the facilitator export after an amend and a second release", async () => {
    await releaseAlice();
    const cred = await link();
    expect(await post(cred, CANARY)).toEqual({ status: 200, wrote: true });
    expect(await svc.amend(id, "alice", { reason: "re-check" }, "priya")).toEqual({ status: 200, value: undefined });
    await releaseAlice();
    expect(await exported("facilitator")).toContain(CANARY);
  });

  it("hiding never refunds either cap: 25 per link, then 50 per role, hidden responses still counted", async () => {
    await releaseAlice();
    const first = await link();
    for (let i = 0; i < 25; i++) expect(await post(first, `first-${i}`)).toEqual({ status: 200, wrote: true });
    const seqs = (await added()).map((e) => e.seq);
    expect(await svc.hide(id, { seq: seqs[0]!, reason: "r1" }, "priya")).toEqual({ status: 200, value: undefined });
    // 24 visible responses on the link, yet the 26th is refused: the per-link cap counts every response.added.
    expect(await post(first, "first-25")).toEqual({ status: 409, code: "link_full", message: WRITE_LINK_FULL });

    const second = await reissue();
    for (let i = 0; i < 25; i++) expect(await post(second, `second-${i}`)).toEqual({ status: 200, wrote: true });
    const seqs2 = (await added()).map((e) => e.seq);
    expect(seqs2).toHaveLength(50);
    expect(await svc.hide(id, { seq: seqs2[30]!, reason: "r2" }, "priya")).toEqual({ status: 200, value: undefined });
    // 48 visible responses of the role, yet a fresh link is refused too_many: the per-role cap counts hidden ones too.
    const third = await reissue();
    expect(await post(third, "third-0")).toEqual({ status: 409, code: "too_many", message: WRITE_TOO_MANY });
    expect(await added()).toHaveLength(50);
    expect(await hidden()).toHaveLength(2);
  });
});
