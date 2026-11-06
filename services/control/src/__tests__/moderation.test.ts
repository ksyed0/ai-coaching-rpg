import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadScenario } from "@acr/script";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { writeJoinCodesFile } from "../../../runtime/src/engine/join-code-file.js";
import { JoinCodes } from "../../../runtime/src/engine/join-codes.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { fixedClock, makeDraftDir } from "../../../runtime/src/review/__tests__/fixtures.js";
import { readReview, withReviewLock } from "../../../runtime/src/review/review-log.js";
import { loadReview } from "../../../runtime/src/review/store.js";
import { REPO_ROOT, type ControlConfig } from "../config.js";
import type { EvalSpawnFn } from "../eval-child.js";
import { ModerationService } from "../moderation.js";
import { ReportJobService } from "../report-job.js";
import type { SetTimer } from "../supervisor.js";

const SCENARIO = "friday-escalation";

class FakeEvalChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  private exitFns: ((code: number | null, signal: string | null) => void)[] = [];
  private exited = false;
  kill(): void { this.exit(130); }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitFns.push(cb); }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    for (const f of this.exitFns) f(code, null);
  }
}

let draftRoot: string;
let draftDir: string;
let id: string;
let templateLog: string;

async function endedLog(sessionId: string, dir: string): Promise<string> {
  const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", SCENARIO));
  const log = new JsonlEventLog(sessionId, dir, { sync: false });
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
  const assign = Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`]));
  await engine.start(assign, {});
  await engine.endNow({ actor: "facilitator" });
  await log.close?.();
  return log.file;
}

beforeAll(async () => {
  ({ root: draftRoot, dir: draftDir } = await makeDraftDir());
  id = path.basename(draftDir);
  templateLog = await endedLog(id, await mkdtemp(path.join(os.tmpdir(), "acr-mod-logs-")));
});
afterAll(async () => {
  await rm(draftRoot, { recursive: true, force: true });
  await rm(path.dirname(templateLog), { recursive: true, force: true });
});

let dataDir: string;
let config: ControlConfig;
let ended: Map<string, boolean>;
let children: FakeEvalChild[];
let sleeps: number[];
let jobs: ReportJobService;
let svc: ModerationService;
/** Every outcome any test saw, for the leak check at the end. */
const seen: unknown[] = [];

const spawn: EvalSpawnFn = () => { const c = new FakeEvalChild(); children.push(c); return c; };
const setTimer: SetTimer = () => () => {};
const rec = async <T>(p: Promise<T>): Promise<T> => { const v = await p; seen.push(v); return v; };
const logFile = () => path.join(config.sessionsDir, `${id}.jsonl`);
const placeDraft = async (name = id): Promise<string> => {
  const out = path.join(config.reportsDir, name);
  await cp(draftDir, out, { recursive: true });
  return out;
};
const opened = async (): Promise<string> => {
  const dir = await placeDraft();
  const o = await rec(svc.open(id, "priya"));
  expect(o).toEqual({ status: 200, value: { subjects: 3 } });
  return dir;
};
const shown = (c: unknown): string => (c === null ? "na" : String(c));
/** The first criterion of alice and its level as `expect` spells it. */
const firstCriterion = async (): Promise<{ criterion: string; expect: string }> => {
  const v = await rec(svc.subject(id, "alice"));
  if (v.status !== 200) throw new Error("no subject view");
  const c = v.value.criteria[0]!;
  return { criterion: c.id, expect: shown(c.current) };
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-mod-"));
  config = {
    dataDir, sessionsDir: path.join(dataDir, "sessions"), reportsDir: path.join(dataDir, "reports"),
    scenariosDir: path.join(REPO_ROOT, "scenarios"), evaluateMarginMs: 500,
  } as ControlConfig;
  await mkdir(config.sessionsDir, { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });
  await cp(templateLog, logFile());
  ended = new Map([[id, true]]);
  children = [];
  sleeps = [];
  const sessions = { get: (sid: string) => (ended.has(sid) ? { scenarioId: SCENARIO, ended: ended.get(sid)! } : undefined) };
  jobs = new ReportJobService({ config, sessions, spawn, setTimer, parentEnv: { PATH: "/bin" }, now: () => 1_700_000_000_000 });
  svc = new ModerationService({
    config, jobs, secrets: [], now: fixedClock(1_900_000_000_000),
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5,
  });
});
afterEach(async () => {
  await jobs.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

describe("ModerationService, part A", () => {
  it("the actor is <cleaned name>-console and the event passes loadReview", async () => {
    const dir = await opened();
    const { criterion, expect: cur } = await firstCriterion();
    const level = cur === "2" ? 3 : 2;
    const o = await rec(svc.edit(id, "alice", { criterion, level, reason: "Seen in the second scene.", expect: cur as "1" }, "priya"));
    expect(o).toEqual({ status: 200, value: undefined });
    const { events } = await readReview(dir);
    expect(events[0]!.actor).toEqual({ kind: "facilitator", by: "priya-console" });
    expect(events.at(-1)!.actor).toEqual({ kind: "facilitator", by: "priya-console" });
    expect(events.at(-1)!.type).toBe("score.edited");
    await expect(loadReview(dir)).resolves.toBeTruthy();
    // accept, comment and edit-summary write the same author
    expect(await rec(svc.accept(id, "bob", { summary: true }, "priya_2"))).toEqual({ status: 200, value: undefined });
    expect(await rec(svc.comment(id, "alice", { text: "Ask about the handover.", criterion }, "priya"))).toEqual({ status: 200, value: undefined });
    expect(await rec(svc.editSummary(id, "alice", { reason: "Tighter.", strengths: ["Kept calm."] }, "priya"))).toEqual({ status: 200, value: undefined });
    const after = (await readReview(dir)).events;
    expect(after.slice(-3).map((e) => e.actor)).toEqual([
      { kind: "facilitator", by: "priya_2-console" }, { kind: "facilitator", by: "priya-console" }, { kind: "facilitator", by: "priya-console" },
    ]);
    await expect(loadReview(dir)).resolves.toBeTruthy();
  });

  it("a name with a space or over 56 characters is 400 invalid", async () => {
    await placeDraft();
    const bad = ["pri ya", "a".repeat(57), "", "priya/x", 7 as unknown as string];
    for (const name of bad) expect(await rec(svc.open(id, name))).toEqual({ status: 400, code: "invalid" });
    expect(await rec(svc.open(id, "a".repeat(56)))).toEqual({ status: 200, value: { subjects: 3 } });
    const { criterion, expect: cur } = await firstCriterion();
    for (const name of bad) {
      expect(await rec(svc.edit(id, "alice", { criterion, level: 2, reason: "r", expect: cur as "1" }, name))).toEqual({ status: 400, code: "invalid" });
      expect(await rec(svc.accept(id, "alice", { criterion }, name))).toEqual({ status: 400, code: "invalid" });
      expect(await rec(svc.comment(id, "alice", { text: "t" }, name))).toEqual({ status: 400, code: "invalid" });
      expect(await rec(svc.editSummary(id, "alice", { reason: "r", strengths: ["s"] }, name))).toEqual({ status: 400, code: "invalid" });
    }
  });

  it("edit with a stale expect is 409 stale and keeps the log bytes", async () => {
    const dir = await opened();
    const { criterion, expect: cur } = await firstCriterion();
    const before = await readFile(path.join(dir, "review.jsonl"));
    const wrong = cur === "4" ? "1" : "4";
    const o = await rec(svc.edit(id, "alice", { criterion, level: 3, reason: "r", expect: wrong }, "priya"));
    expect(o).toEqual({ status: 409, code: "stale" });
    expect(await readFile(path.join(dir, "review.jsonl"))).toEqual(before);
    // edit without expect is refused in the service as well
    const none = await rec(svc.edit(id, "alice", { criterion, level: 3, reason: "r" } as never, "priya"));
    expect(none).toEqual({ status: 400, code: "invalid" });
    expect(await readFile(path.join(dir, "review.jsonl"))).toEqual(before);
  });

  it("a busy lock is retried 5 times with the injected sleep, then 503 busy", async () => {
    const dir = await opened();
    const { criterion } = await firstCriterion();
    const before = await readFile(path.join(dir, "review.jsonl"));
    const o = await withReviewLock(dir, () => rec(svc.accept(id, "alice", { criterion }, "priya")));
    expect(o).toMatchObject({ status: 503, code: "busy" });
    expect((o as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(sleeps).toEqual([100, 200, 400, 800]);
    expect(await readFile(path.join(dir, "review.jsonl"))).toEqual(before);
    // free again: the same call goes through
    expect(await rec(svc.accept(id, "alice", { criterion }, "priya"))).toEqual({ status: 200, value: undefined });
  });

  it("a corrupt log is 503 unavailable, not 500", async () => {
    const dir = await opened();
    const { criterion, expect: cur } = await firstCriterion();
    await writeFile(path.join(dir, "review.jsonl"), "not json\n");
    expect(await rec(svc.subject(id, "alice"))).toEqual({ status: 503, code: "unavailable" });
    expect(await rec(svc.edit(id, "alice", { criterion, level: 2, reason: "r", expect: cur as "1" }, "priya"))).toEqual({ status: 503, code: "unavailable" });
    expect(await rec(svc.accept(id, "alice", { criterion }, "priya"))).toEqual({ status: 503, code: "unavailable" });
    expect(await rec(svc.open(id, "priya"))).toEqual({ status: 503, code: "unavailable" });
    expect(await rec(svc.overview(id))).toEqual({ status: 503, code: "unavailable" });
  });

  it("a valid review.opened followed by a bad line is 503 unavailable for subject and edit", async () => {
    const dir = await opened();
    const { criterion, expect: cur } = await firstCriterion();
    await appendFile(path.join(dir, "review.jsonl"), "{ not json\n");
    expect(await rec(svc.subject(id, "alice"))).toEqual({ status: 503, code: "unavailable" });
    expect(await rec(svc.edit(id, "alice", { criterion, level: 2, reason: "r", expect: cur as "1" }, "priya"))).toEqual({ status: 503, code: "unavailable" });
  });

  it("a symbolic link as the session log is 404, never followed", async () => {
    await opened();
    const real = path.join(dataDir, "real.jsonl");
    await cp(logFile(), real);
    await unlink(logFile());
    await symlink(real, logFile());
    expect(await rec(svc.overview(id))).toEqual({ status: 404 });
    expect(await rec(svc.subject(id, "alice"))).toEqual({ status: 404 });
    expect(await rec(svc.open(id, "priya"))).toEqual({ status: 404 });
  });

  it("the in_review summary is null when the registry does not know the session", async () => {
    await opened();
    ended.delete(id);
    const o = await rec(svc.overview(id));
    expect(o).toMatchObject({ status: 200, value: { stage: "in_review", summary: null } });
  });

  it("open reads the session log and the codes record and returns the subject count", async () => {
    const { codes } = JoinCodes.issue(["alice", "bob"], { sessionId: id, scenarioSha256: "c".repeat(64) });
    writeJoinCodesFile(config.sessionsDir, id, codes);
    const dir = await placeDraft();
    expect(await rec(svc.open(id, "priya"))).toEqual({ status: 200, value: { subjects: 3 } });
    const first = (await readReview(dir)).events[0]! as unknown as {
      type: string; session: { logSha256: string | null }; scenario: { sha256: string | null }; codes: { sessionId: string } | null;
    };
    expect(first.type).toBe("review.opened");
    expect(first.session.logSha256).toBe(createHash("sha256").update(await readFile(logFile(), "utf8")).digest("hex"));
    expect(first.codes?.sessionId).toBe(id);
    expect(first.scenario.sha256).toBe("c".repeat(64));
    // already open: nothing left to open
    expect(await rec(svc.open(id, "priya"))).toMatchObject({ status: 409 });
  });

  it("an unknown session is 404, and so is an unknown subject", async () => {
    await opened();
    expect(await rec(svc.overview("s-no-such-session"))).toEqual({ status: 404 });
    expect(await rec(svc.overview("../etc"))).toEqual({ status: 404 });
    expect(await rec(svc.subject("s-no-such-session", "alice"))).toEqual({ status: 404 });
    expect(await rec(svc.open("s-no-such-session", "priya"))).toEqual({ status: 404 });
    expect(await rec(svc.subject(id, "zed"))).toEqual({ status: 404 });
    expect(await rec(svc.accept(id, "zed", { summary: true }, "priya"))).toEqual({ status: 404 });
  });

  it("overview is not_evaluated with no candidate, evaluating while the job runs, ready_to_open for a complete unopened draft, in_review once opened, orphan true for a broken candidate, and carries summary and subjects only in_review", async () => {
    const stageOf = async () => {
      const o = await rec(svc.overview(id));
      if (o.status !== 200) throw new Error(`overview ${o.status}`);
      return o.value;
    };
    ended.set(id, false);
    let v = await stageOf();
    expect(v).toMatchObject({ stage: "not_ended", orphan: false, summary: null, subjects: [] });
    ended.set(id, true);

    v = await stageOf();
    expect(v).toMatchObject({ stage: "not_evaluated", orphan: false, summary: null, subjects: [], job: { state: "idle" } });

    const upTo = v.confirm!.upTo;
    expect(await jobs.start(id, { confirmedCalls: upTo, by: "priya-console" })).toMatchObject({ status: 200 });
    v = await stageOf();
    expect(v).toMatchObject({ stage: "evaluating", confirm: null, summary: null, subjects: [], job: { state: "running" } });
    children[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 20));
    v = await stageOf();
    expect(v).toMatchObject({ stage: "failed", confirm: { upTo }, summary: null, subjects: [], job: { state: "failed" } });

    await placeDraft();
    v = await stageOf();
    expect(v).toMatchObject({ stage: "ready_to_open", confirm: null, summary: null, subjects: [] });

    expect(await rec(svc.open(id, "priya"))).toEqual({ status: 200, value: { subjects: 3 } });
    v = await stageOf();
    expect(v.stage).toBe("in_review");
    expect(v.confirm).toBeNull();
    expect(v.summary).not.toBeNull();
    expect(v.summary).toMatchObject({ npcReplies: expect.any(Number), scenesEndedByGm: expect.any(Number) });
    expect(v.subjects.map((s) => s.id).sort()).toEqual(["alice", "bob", "group"]);
    expect(v.orphan).toBe(false);

    // a broken sibling folder is an orphan
    await mkdir(path.join(config.reportsDir, `${id}-2`));
    await writeFile(path.join(config.reportsDir, `${id}-2`, "alice.json"), "{");
    v = await stageOf();
    expect(v).toMatchObject({ stage: "in_review", orphan: true });
  });

  it("while the automatic open after a run is still in flight the overview reads evaluating, not ready_to_open; once it settles, in_review", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let opening = false;
    let svc2: ModerationService | undefined;
    const sessions = { get: (sid: string) => (ended.has(sid) ? { scenarioId: SCENARIO, ended: ended.get(sid)! } : undefined) };
    const jobs2 = new ReportJobService({
      config, sessions, spawn, setTimer, parentEnv: { PATH: "/bin" }, now: () => 1_700_000_000_000,
      onDone: async (sid, _out, by) => { opening = true; await gate; await svc2!.open(sid, by); },
    });
    svc2 = new ModerationService({ config, jobs: jobs2, secrets: [], now: fixedClock(1_900_000_000_000), sleep: async () => {}, random: () => 0.5 });
    try {
      const pre = await jobs2.preflight(id);
      if (!pre.ok) throw new Error("preflight");
      expect(await jobs2.start(id, { confirmedCalls: pre.upTo, by: "priya" })).toMatchObject({ status: 200 });
      const out = await placeDraft();
      children.at(-1)!.stdout.write(`${JSON.stringify({ ok: true, dir: out, modelCalls: 5 })}\n`);
      children.at(-1)!.exit(0);
      await vi.waitFor(() => expect(opening).toBe(true));
      expect(jobs2.status(id).state).toBe("done");
      expect(await rec(svc2.overview(id))).toMatchObject({ status: 200, value: { stage: "evaluating", confirm: null } });
      release();
      await vi.waitFor(async () => expect(await svc2!.overview(id)).toMatchObject({ status: 200, value: { stage: "in_review" } }));
    } finally {
      release();
      await jobs2.shutdown();
    }
  });

  it("an orphan alone still reads not_evaluated, with orphan true", async () => {
    await mkdir(path.join(config.reportsDir, id));
    await writeFile(path.join(config.reportsDir, id, "alice.json"), "{");
    const o = await rec(svc.overview(id));
    expect(o).toMatchObject({ status: 200, value: { stage: "not_evaluated", orphan: true, summary: null, subjects: [] } });
  });

  it("overview.confirm.upTo equals the bound only in not_evaluated and failed-without-draft", async () => {
    const pre = await jobs.preflight(id);
    if (!pre.ok) throw new Error("preflight");
    const o = await rec(svc.overview(id));
    expect(o).toMatchObject({ status: 200, value: { stage: "not_evaluated", confirm: { upTo: pre.upTo } } });
    expect(await jobs.start(id, { confirmedCalls: pre.upTo, by: "priya-console" })).toMatchObject({ status: 200 });
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "evaluating", confirm: null } });
    children[0]!.exit(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "failed", confirm: { upTo: pre.upTo } } });
    // an orphan folder left behind: no bound (the folder must be removed by hand first)
    await mkdir(path.join(config.reportsDir, `${id}-2`));
    await writeFile(path.join(config.reportsDir, `${id}-2`, "alice.json"), "{");
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "failed", orphan: true, confirm: null } });
    await rm(path.join(config.reportsDir, `${id}-2`), { recursive: true });
    ended.set(id, false);
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "not_ended", confirm: null } });
    ended.set(id, true);
    await placeDraft();
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "ready_to_open", confirm: null } });
    await svc.open(id, "priya");
    expect(await rec(svc.overview(id))).toMatchObject({ status: 200, value: { stage: "in_review", confirm: null } });
  });

  it("records a blocked release (with detail) and a finished job (with an outputDir) for the leak sweep", async () => {
    const pre = await jobs.preflight(id);
    if (!pre.ok) throw new Error("preflight");
    expect(await jobs.start(id, { confirmedCalls: pre.upTo, by: "priya-console" })).toMatchObject({ status: 200 });
    const out = await placeDraft();
    children.at(-1)!.stdout.write(`${JSON.stringify({ ok: true, dir: out, modelCalls: 5 })}\n`);
    children.at(-1)!.exit(0);
    await vi.waitFor(() => expect(jobs.status(id).state).toBe("done"));
    expect(await rec(svc.open(id, "priya"))).toEqual({ status: 200, value: { subjects: 3 } });
    const blocked = await rec(svc.release(id, { subjects: ["alice", "bob"] }, "priya"));
    expect(blocked).toMatchObject({ status: 409, code: "blocked", detail: expect.any(Array) });
    const done = await rec(Promise.resolve(jobs.status(id)));
    expect(done.outputDir).not.toBeNull();
  });

  it("no outcome field contains a path separator or a review-layer message", () => {
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); }
    };
    seen.forEach(walk);
    expect(seen.length).toBeGreaterThan(40);
    expect(strings.length).toBeGreaterThan(100);
    const REVIEW_TEXT = [/moderate/i, /pnpm/, /--[a-z]/, /nothing was changed/, /try again/i, /unknown (subject|criterion)/, /is currently/, /another/i, /\block/i, /cannot be read/, /not valid/];
    for (const s of strings) {
      expect(s, s).not.toMatch(/[/\\]/);
      for (const re of REVIEW_TEXT) expect(s, s).not.toMatch(re);
    }
  });
});
