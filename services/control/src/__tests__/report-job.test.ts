import { cp, mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadScenario } from "@acr/script";
import { openFacilitatorReview } from "@acr/runtime/moderation";
import { listDraftCandidates } from "@acr/runtime/reports";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { makeDraftDir } from "../../../runtime/src/review/__tests__/fixtures.js";
import { CHILD_ENV_ALLOWLIST } from "../child-env.js";
import { loadControlConfig, REPO_ROOT, type ControlConfig } from "../config.js";
import { buildEvalChildEnv, nodeEvalSpawn, type EvalSpawnFn } from "../eval-child.js";
import { MAX_TIMER_MS, ReportJobService } from "../report-job.js";
import type { SetTimer } from "../supervisor.js";

const SCENARIO = "friday-escalation";
const EVALUATOR = path.join(REPO_ROOT, "services", "runtime", "src", "evaluator", "main.ts");

/** A scripted stand-in for the evaluate child: scripted stdout, stderr and an exit. */
class FakeEvalChild {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];
  /** Exit when signalled (as the real CLI does on SIGTERM: exit code 130). */
  exitOnKill = true;
  private exitFns: ((code: number | null, signal: string | null) => void)[] = [];
  private exited = false;
  kill(sig: NodeJS.Signals): void {
    this.signals.push(sig);
    if (this.exitOnKill) this.exit(130);
  }
  onExit(cb: (code: number | null, signal: string | null) => void): void { this.exitFns.push(cb); }
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    for (const f of this.exitFns) f(code, signal);
  }
}

let draftRoot: string;
let draftDir: string;
let id: string;
let templateLog: string;
let otherLog: string;
const OTHER = "s-other-session";

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
  const logs = await mkdtemp(path.join(os.tmpdir(), "acr-rj-logs-"));
  templateLog = await endedLog(id, logs);
  otherLog = await endedLog(OTHER, logs);
});
afterAll(async () => {
  await rm(draftRoot, { recursive: true, force: true });
  await rm(path.dirname(templateLog), { recursive: true, force: true });
});

let dataDir: string;
let config: ControlConfig;
let children: FakeEvalChild[];
let calls: Parameters<EvalSpawnFn>[0][];
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let ended: Map<string, boolean>;
let onSpawn: ((c: FakeEvalChild) => void) | undefined;
const services: ReportJobService[] = [];

const spawn: EvalSpawnFn = (o) => {
  calls.push(o);
  const c = new FakeEvalChild();
  children.push(c);
  const hook = onSpawn;
  if (hook) queueMicrotask(() => hook(c));
  return c;
};
const setTimer: SetTimer = (fn, ms) => {
  const t = { fn, ms, cancelled: false };
  timers.push(t);
  return () => { t.cancelled = true; };
};
const sessions = { get: (sid: string) => (ended.has(sid) ? { scenarioId: SCENARIO, ended: ended.get(sid)! } : undefined) };
const PARENT = { PATH: "/bin", EVAL_TIMEOUT_MS: "1000", NPC_REPLY_TIMEOUT_MS: "500", LAUNCHER_TOKEN: "x".repeat(40), NODE_OPTIONS: "--inspect", NODE_ENV: "test" };

function make(o: { onDone?: (id: string, outputDir: string, by: string) => Promise<void>; now?: () => number } = {}): ReportJobService {
  const svc = new ReportJobService({ config, sessions, spawn, parentEnv: PARENT, now: o.now ?? (() => 1_700_000_000_000), setTimer, ...(o.onDone ? { onDone: o.onDone } : {}) });
  services.push(svc);
  return svc;
}

/** What the real CLI prints on stdout with `--json -` after it wrote the reports (pretty-printed, several lines). */
const jsonFor = (dir: string, modelCalls = 7): string =>
  `${JSON.stringify({ ok: true, session: id, dir, files: ["index.md"], modelCalls, participants: [], group: { status: "ok" }, failures: [] }, null, 2)}\n`;

/** The child writes a real draft into the reports dir, prints its JSON and exits 0. */
const succeed = (name = id, modelCalls = 7) => async (c: FakeEvalChild) => {
  const out = path.join(config.reportsDir, name);
  await cp(draftDir, out, { recursive: true });
  c.stderr.write("evaluating alice\n");
  c.stdout.write(jsonFor(out, modelCalls));
  c.exit(0);
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "acr-rj-"));
  config = {
    dataDir, sessionsDir: path.join(dataDir, "sessions"), reportsDir: path.join(dataDir, "reports"),
    scenariosDir: path.join(REPO_ROOT, "scenarios"), evaluateMarginMs: 500,
  } as ControlConfig;
  await mkdir(config.sessionsDir, { recursive: true });
  await mkdir(config.reportsDir, { recursive: true });
  await cp(templateLog, path.join(config.sessionsDir, `${id}.jsonl`));
  await cp(otherLog, path.join(config.sessionsDir, `${OTHER}.jsonl`));
  children = []; calls = []; timers = []; onSpawn = undefined;
  ended = new Map([[id, true], [OTHER, true]]);
});
afterEach(async () => {
  for (const s of services.splice(0)) await s.shutdown();
  await rm(dataDir, { recursive: true, force: true });
});

/** Mode and text from ONE open handle, so the check and the read cannot see two different files. */
async function snapshot(file: string): Promise<{ mode: number; text: string }> {
  const fh = await open(file, "r");
  try {
    const st = await fh.stat();
    return { mode: st.mode & 0o777, text: await fh.readFile("utf8") };
  } finally {
    await fh.close();
  }
}

describe("ReportJobService", () => {
  it("start spawns node --import tsx <abs evaluator/main.ts> <abs log> --scenario <abs dir> --out <reportsDir> --json - with cwd the repo root", async () => {
    const svc = make();
    const r = await svc.start(id, { confirmedCalls: 8, by: "kamal-console" });
    expect(r).toMatchObject({ status: 200, value: { state: "running", startedAt: 1_700_000_000_000, outputDir: null, modelCalls: null } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual([
      process.execPath, "--import", "tsx", EVALUATOR, path.join(config.sessionsDir, `${id}.jsonl`),
      "--scenario", path.join(REPO_ROOT, "scenarios", SCENARIO), "--out", config.reportsDir, "--json", "-",
    ]);
    for (const a of [EVALUATOR, calls[0]!.argv[4]!, calls[0]!.argv[6]!, calls[0]!.argv[8]!]) expect(path.isAbsolute(a)).toBe(true);
    expect(calls[0]!.cwd).toBe(REPO_ROOT);
    expect(calls[0]!.env).toEqual(buildEvalChildEnv(PARENT, config));
    expect(calls[0]!.env.NO_DOTENV).toBe("1");
  });

  it("a second start is already_running; another session's start is too_many_running", async () => {
    const svc = make();
    const [a, b] = await Promise.all([svc.start(id, { confirmedCalls: 8, by: "k" }), svc.start(id, { confirmedCalls: 8, by: "k" })]);
    expect(a.status).toBe(200);
    expect(b).toEqual({ status: 409, code: "already_running" });
    expect(await svc.start(OTHER, { confirmedCalls: 8, by: "k" })).toEqual({ status: 409, code: "too_many_running" });
    expect(calls).toHaveLength(1);
  });

  it("a session that has any complete candidate (draft or review) is already_evaluated and spawns nothing", async () => {
    await cp(draftDir, path.join(config.reportsDir, `${id}-2`), { recursive: true });
    const svc = make();
    expect(await svc.preflight(id)).toEqual({ ok: false, code: "already_evaluated" });
    expect(await svc.start(id, { confirmedCalls: 8, by: "k" })).toEqual({ status: 409, code: "already_evaluated" });
    expect(calls).toHaveLength(0);
  });

  it("a session not ended is not_ended", async () => {
    ended.set(id, false);
    const svc = make();
    expect(await svc.preflight(id)).toEqual({ ok: false, code: "not_ended" });
    expect(await svc.start(id, { confirmedCalls: 8, by: "k" })).toEqual({ status: 409, code: "not_ended" });
    // listed as ended but the log does not end with session.ended: still not_ended
    ended.set(id, true);
    await writeFile(path.join(config.sessionsDir, `${id}.jsonl`), "");
    expect(await svc.preflight(id)).toEqual({ ok: false, code: "not_ended" });
    expect(await svc.start("s-unknown", { confirmedCalls: 8, by: "k" })).toEqual({ status: 404 });
    expect(calls).toHaveLength(0);
  });

  it("confirmedCalls different from the bound is confirm_mismatch", async () => {
    const svc = make();
    expect(await svc.preflight(id)).toEqual({ ok: true, upTo: 8 });
    expect(await svc.start(id, { confirmedCalls: 7, by: "k" })).toEqual({ status: 409, code: "confirm_mismatch" });
    expect(await svc.start(id, { confirmedCalls: 8.5, by: "k" })).toEqual({ status: 409, code: "confirm_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("outputDir is the relative name from the multi-line JSON on stdout parsed after exit, and must be a candidate name", async () => {
    const svc = make();
    onSpawn = (c) => { void succeed(`${id}-2`, 6)(c); };
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    await vi.waitFor(() => expect(svc.status(id).state).toBe("done"));
    expect(svc.status(id)).toMatchObject({ state: "done", outputDir: `${id}-2`, modelCalls: 6 });

    // a dir outside the reports folder, not a candidate of this session, a missing candidate or unparseable output is refused
    const outside = ["/etc", path.join(config.reportsDir, "other-session"), path.join(config.reportsDir, `${id}-9`), "not json"];
    for (const bad of outside) {
      await rm(config.reportsDir, { recursive: true, force: true });
      await mkdir(config.reportsDir);
      onSpawn = (c) => { c.stdout.write(bad === "not json" ? "{ not json" : jsonFor(bad)); c.exit(0); };
      const done = vi.fn(async () => {});
      const s = make({ onDone: done });
      await s.start(id, { confirmedCalls: 8, by: "k" });
      await vi.waitFor(() => expect(s.status(id).state).toBe("failed"));
      expect(s.status(id), bad).toMatchObject({ reason: "error", outputDir: null });
      expect(done).not.toHaveBeenCalled();
    }
  });

  it("progress keeps only lines matching the allowlist (evaluating <safe-id>, evaluation finished) at most 50, and drops a line with a path or provider text", async () => {
    const svc = make();
    let child!: FakeEvalChild;
    onSpawn = (c) => { child = c; };
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    await vi.waitFor(() => expect(child).toBeDefined());
    child.stderr.write("NOTICE: this sends the session transcript (what every participant and AI character said) to the configured model provider (anthropic, https://api.example) and may cost money.\n");
    child.stderr.write("warning: /Users/someone/scenarios/x/rubrics/a.yaml is odd\n");
    child.stderr.write("evaluating /etc/passwd\nevaluating alice\nerror: the model provider is not usable: 401 invalid x-api-key sk-ant-123\n");
    child.stderr.write("evalu"); // a line split across chunks
    child.stderr.write("ating bob\n");
    await vi.waitFor(() => expect(svc.status(id).progress).toEqual(["sending the transcript to the configured model provider", "evaluating alice", "evaluating bob"]));
    for (let i = 0; i < 60; i++) child.stderr.write(`evaluating r${i}\n`);
    child.stderr.write("evaluating the team\n");
    child.stderr.write(`reports written to ${path.join(config.reportsDir, id)} (index.md links them all)\n`);
    await vi.waitFor(() => expect(svc.status(id).progress.at(-1)).toBe("evaluation finished"));
    const p = svc.status(id).progress;
    expect(p.length).toBe(50);
    expect(p.at(-2)).toBe("evaluating the team");
    for (const l of p) {
      expect(l).not.toMatch(/[/\\]/);
      expect(l).not.toMatch(/sk-|api-key|https?:/);
    }
  });

  it("buildEvalChildEnv holds no variable outside the allowlist and no NODE_OPTIONS", () => {
    const env = buildEvalChildEnv({
      PATH: "/bin", HOME: "/home/x", NODE_ENV: "production", NODE_OPTIONS: "--require /tmp/evil.js", MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "k", EVAL_MODEL: "m", NPC_MODEL: "n", GM_TRACE: "1", LAUNCHER_TOKEN: "t", FACILITATOR_SECRET: "s", INIT_CWD: "/tmp",
      NO_DOTENV: "0", AWS_SECRET_ACCESS_KEY: "z",
    }, config);
    const a = CHILD_ENV_ALLOWLIST;
    for (const k of Object.keys(env)) {
      const ok = k === "NO_DOTENV" || (a.names as readonly string[]).includes(k) || a.prefixes.some((p) => k.startsWith(p));
      expect(ok, k).toBe(true);
    }
    for (const bad of ["HOME", "NODE_OPTIONS", "GM_TRACE", "LAUNCHER_TOKEN", "FACILITATOR_SECRET", "INIT_CWD", "AWS_SECRET_ACCESS_KEY"]) expect(env[bad], bad).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/bin", NODE_ENV: "production", ANTHROPIC_API_KEY: "k", EVAL_MODEL: "m", NPC_MODEL: "n", NO_DOTENV: "1" });
  });

  it("cancel signals the child; the state is failed/cancelled", async () => {
    const svc = make();
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    const r = await svc.cancel(id);
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(r).toMatchObject({ status: 200, value: { state: "failed", reason: "cancelled" } });
    expect(svc.status(id)).toMatchObject({ state: "failed", reason: "cancelled" });
    expect(await svc.cancel("s-unknown")).toEqual({ status: 404 });
    // the next start may run again (nothing was written)
    expect((await svc.start(id, { confirmedCalls: 8, by: "k" })).status).toBe(200);
  });

  it("the timeout (bound × EVAL_TIMEOUT_MS + margin, injected clock) kills the child; failed/timeout", async () => {
    const svc = make();
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    const t = timers.find((x) => x.ms === 8 * 1000 + 500);
    expect(t).toBeDefined();
    children[0]!.exitOnKill = false;
    t!.fn();
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(svc.status(id)).toMatchObject({ state: "failed", reason: "timeout" });
    // a child that ignores SIGTERM is force-killed after the grace
    const grace = timers.filter((x) => x !== t && !x.cancelled).at(-1)!;
    grace.fn();
    expect(children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    children[0]!.exit(null, "SIGKILL");
    expect(svc.status(id)).toMatchObject({ state: "failed", reason: "timeout" });
  });

  it("a cancel or shutdown after the child exited, before finish() completes, does not relabel the run", async () => {
    const done = vi.fn(async () => {});
    const svc = make({ onDone: done });
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    const child = children[0]!;
    const out = path.join(config.reportsDir, id);
    await cp(draftDir, out, { recursive: true });
    child.stdout.write(jsonFor(out));
    child.exit(0); // finish() is now awaiting the folder check
    const r = await svc.cancel(id);
    expect(r).toMatchObject({ status: 200, value: { state: "running" } });
    const closing = svc.shutdown();
    expect(child.signals).toEqual([]);
    await closing;
    await vi.waitFor(() => expect(svc.status(id).state).toBe("done"));
    expect(svc.status(id)).toMatchObject({ state: "done", outputDir: id });
    expect(svc.status(id).reason).toBeUndefined();
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("the overall timeout clamps EVAL_TIMEOUT_MS to 500..600000, takes the max with NPC_REPLY_TIMEOUT_MS and stays below 2^31-1", async () => {
    const cases: [Record<string, string>, number][] = [
      [{ EVAL_TIMEOUT_MS: "5", NPC_REPLY_TIMEOUT_MS: "500" }, 8 * 500 + 500], // below the range: 500
      [{ EVAL_TIMEOUT_MS: "99999999999" }, 8 * 600_000 + 500], // above: 600000
      [{ EVAL_TIMEOUT_MS: "1000", NPC_REPLY_TIMEOUT_MS: "5000" }, 8 * 5000 + 500], // the NPC reply timeout wins
      [{}, 8 * 180_000 + 500], // both unset: the evaluator's default
      [{ EVAL_TIMEOUT_MS: "abc", NPC_REPLY_TIMEOUT_MS: "x" }, 8 * 180_000 + 500],
    ];
    for (const [env, expected] of cases) {
      timers = [];
      children = [];
      const svc = new ReportJobService({ config, sessions, spawn, parentEnv: { PATH: "/bin", ...env }, setTimer, now: () => 1 });
      services.push(svc);
      await svc.start(id, { confirmedCalls: 8, by: "k" });
      expect(timers[0]!.ms, JSON.stringify(env)).toBe(expected);
      await svc.shutdown();
    }
    // the cap: a margin that would overflow setTimeout is cut to 2^31-1
    timers = [];
    const svc = new ReportJobService({ config: { ...config, evaluateMarginMs: 2 ** 31 } as ControlConfig, sessions, spawn, parentEnv: { PATH: "/bin", EVAL_TIMEOUT_MS: "600000" }, setTimer, now: () => 1 });
    services.push(svc);
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    expect(timers[0]!.ms).toBe(MAX_TIMER_MS);
  });

  it("a persist failure logs one fixed line without a path", async () => {
    const blocker = path.join(dataDir, "blocker");
    await writeFile(blocker, "x"); // a file where the data folder should be: mkdir fails
    const lines: string[] = [];
    const svc = new ReportJobService({
      config: { ...config, dataDir: path.join(blocker, "sub") } as ControlConfig, sessions, spawn, parentEnv: PARENT, setTimer, now: () => 1, log: (m) => lines.push(m),
    });
    services.push(svc);
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).toBe("report job state could not be saved");
      expect(l).not.toContain(dataDir);
    }
  });

  it("a dir with .. in the child's JSON is refused even when it resolves to a candidate", async () => {
    onSpawn = async (c) => {
      const out = path.join(config.reportsDir, id);
      await cp(draftDir, out, { recursive: true });
      c.stdout.write(jsonFor(`${config.reportsDir}${path.sep}other${path.sep}..${path.sep}${id}`));
      c.exit(0);
    };
    const done = vi.fn(async () => {});
    const svc = make({ onDone: done });
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    await vi.waitFor(() => expect(svc.status(id).state).toBe("failed"));
    expect(svc.status(id)).toMatchObject({ reason: "error", outputDir: null });
    expect(done).not.toHaveBeenCalled();
  });

  it("a folder with a review that is incomplete is already_evaluated", async () => {
    const out = path.join(config.reportsDir, id);
    await cp(draftDir, out, { recursive: true });
    const sessionLogText = await readFile(path.join(config.sessionsDir, `${id}.jsonl`), "utf8");
    await openFacilitatorReview({ dir: out, by: "kamal-console", now: () => 1_900_000_000_000, sessionLogText, codesDir: config.sessionsDir });
    await unlink(path.join(out, "group.json"));
    const found = (await listDraftCandidates(config.reportsDir, id))[0]!;
    expect(found).toMatchObject({ hasReview: true, complete: false });
    const svc = make();
    expect(await svc.preflight(id)).toEqual({ ok: false, code: "already_evaluated" });
    expect(await svc.start(id, { confirmedCalls: 8, by: "k" })).toEqual({ status: 409, code: "already_evaluated" });
    expect(calls).toHaveLength(0);
  });

  it("on exit 0 onDone is called once with outputDir and by; if onDone throws the state is done and the overview reads ready_to_open", async () => {
    const done = vi.fn(async () => { throw new Error("open failed"); });
    const svc = make({ onDone: done });
    onSpawn = (c) => { void succeed()(c); };
    await svc.start(id, { confirmedCalls: 8, by: "priya" }); // the job carries the BARE typed name; `-console` is appended once, in moderation
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(done).toHaveBeenCalledWith(id, id, "priya");
    expect(svc.status(id)).toMatchObject({ state: "done", outputDir: id, modelCalls: 7 });
    // ready_to_open: a complete draft without a review, and no orphan
    expect(await listDraftCandidates(config.reportsDir, id)).toEqual([expect.objectContaining({ name: id, complete: true, hasReview: false })]);
    expect(await svc.orphan(id)).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("isActive holds from the spawn until onDone settles, though the job already reads done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const done = vi.fn(() => gate);
    const svc = make({ onDone: done });
    expect(svc.isActive(id)).toBe(false);
    onSpawn = (c) => { void succeed()(c); };
    await svc.start(id, { confirmedCalls: 8, by: "priya" });
    expect(svc.isActive(id)).toBe(true);
    expect(svc.isActive(OTHER)).toBe(false);
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(svc.status(id).state).toBe("done");
    expect(svc.isActive(id)).toBe(true);
    release();
    await vi.waitFor(() => expect(svc.isActive(id)).toBe(false));
  });

  it("a persisted running state (report-jobs.json, 0600, atomic, with outputDir and modelCalls) becomes failed/interrupted on construction", async () => {
    const file = path.join(dataDir, "report-jobs.json");
    const svc = make();
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    const first = await snapshot(file);
    const saved = JSON.parse(first.text) as Record<string, unknown>;
    expect(saved[id]).toEqual({ state: "running", startedAt: 1_700_000_000_000, outputDir: null, modelCalls: null });
    expect(first.mode).toBe(0o600);
    expect((await readdir(dataDir)).filter((n) => n.includes(".tmp"))).toEqual([]);

    // a restart: the persisted running job is interrupted
    const after = make();
    expect(after.status(id)).toMatchObject({ state: "failed", reason: "interrupted", startedAt: 1_700_000_000_000, outputDir: null, modelCalls: null });
    const second = await snapshot(file);
    expect(JSON.parse(second.text)[id]).toMatchObject({ state: "failed", reason: "interrupted" });
    expect(second.mode).toBe(0o600);

    // a done job keeps its outputDir and modelCalls across a restart; junk entries are dropped
    await writeFile(file, JSON.stringify({ [id]: { state: "done", startedAt: 5, outputDir: id, modelCalls: 3 }, "../x": { state: "running" }, [OTHER]: { state: "weird" } }));
    const again = make();
    expect(again.status(id)).toMatchObject({ state: "done", outputDir: id, modelCalls: 3, startedAt: 5 });
    expect(again.status(OTHER)).toMatchObject({ state: "idle" });
    // an unreadable file is an empty state
    await writeFile(file, "not json");
    expect(make().status(id).state).toBe("idle");
  });

  it("shutdown kills a running child", async () => {
    const svc = make();
    await svc.start(id, { confirmedCalls: 8, by: "k" });
    await svc.shutdown();
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
    expect(svc.status(id)).toMatchObject({ state: "failed", reason: "interrupted" });
    await svc.shutdown(); // safe twice
    expect(children[0]!.signals).toEqual(["SIGTERM"]);
  });

  it("a late complete draft after interruption reads as ready_to_open, not orphan", async () => {
    await writeFile(path.join(dataDir, "report-jobs.json"), JSON.stringify({ [id]: { state: "running", startedAt: 1, outputDir: null, modelCalls: null } }));
    const svc = make();
    expect(svc.status(id)).toMatchObject({ state: "failed", reason: "interrupted" });
    await cp(draftDir, path.join(config.reportsDir, id), { recursive: true }); // the child outlived the hard kill and wrote its draft
    expect(await svc.orphan(id)).toBe(false);
    expect(await listDraftCandidates(config.reportsDir, id)).toEqual([expect.objectContaining({ complete: true, hasReview: false })]);
    expect(await svc.preflight(id)).toEqual({ ok: false, code: "already_evaluated" });
  });

  it("orphan(id) is true for a candidate whose drafts do not load", async () => {
    const svc = make();
    expect(await svc.orphan(id)).toBe(false);
    const broken = path.join(config.reportsDir, id);
    await cp(draftDir, broken, { recursive: true });
    await unlink(path.join(broken, "group.json"));
    expect(await svc.orphan(id)).toBe(true);
    // never reused: it is not an evaluated session, a new run writes a fresh folder
    expect(await svc.preflight(id)).toEqual({ ok: true, upTo: 8 });
    expect(await svc.orphan("s-unknown")).toBe(false);
  });

  it("start is 409 orphan while an orphan folder is left, even with the right confirmedCalls, and spawns nothing", async () => {
    const svc = make();
    const broken = path.join(config.reportsDir, id);
    await cp(draftDir, broken, { recursive: true });
    await unlink(path.join(broken, "group.json"));
    expect(await svc.start(id, { confirmedCalls: 8, by: "k" })).toEqual({ status: 409, code: "orphan" });
    expect(calls).toHaveLength(0);
    expect(svc.status(id).state).toBe("idle");
    expect(await readdir(config.reportsDir)).toEqual([id]); // no `<id>-2` beside it
    // once it is removed by hand, the run may start
    await rm(broken, { recursive: true });
    expect(await svc.start(id, { confirmedCalls: 8, by: "k" })).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
  });
});

describe("evaluate settings and the real spawn", () => {
  it("REPORT_EVALUATE_MARGIN_MS defaults to 120000 and is a whole number from 0 to 3600000", () => {
    const base = { LAUNCHER_TOKEN: "t".repeat(40), CONTROL_DATA_DIR: "/data/control" };
    expect(loadControlConfig(base).evaluateMarginMs).toBe(120_000);
    expect(loadControlConfig({ ...base, REPORT_EVALUATE_MARGIN_MS: "0" }).evaluateMarginMs).toBe(0);
    for (const bad of ["-1", "3600001", "1e3", ""]) {
      expect(() => loadControlConfig({ ...base, REPORT_EVALUATE_MARGIN_MS: bad })).toThrow(/REPORT_EVALUATE_MARGIN_MS must be a whole number from 0 to 3600000/);
    }
  });

  it("nodeEvalSpawn runs argv with exactly the given env and reports the exit after the output is drained", async () => {
    const c = nodeEvalSpawn({
      argv: [process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env).sort())); process.stderr.write('evaluating alice\\n'); process.exit(3)"],
      cwd: REPO_ROOT, env: { ONLY: "1" },
    });
    let out = "", err = "";
    c.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    c.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    const code = await new Promise<number | null>((r) => c.onExit((x) => r(x)));
    expect(code).toBe(3);
    expect((JSON.parse(out) as string[]).filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["ONLY"]);
    expect(err).toBe("evaluating alice\n");
    const late = await new Promise<number | null>((r) => c.onExit((x) => r(x)));
    expect(late).toBe(3);
    c.kill("SIGTERM"); // already gone: no throw
  });

  it("nodeEvalSpawn reports a failed spawn as an exit", async () => {
    const c = nodeEvalSpawn({ argv: [path.join(REPO_ROOT, "no-such-program")], cwd: REPO_ROOT, env: {} });
    expect(await new Promise<[number | null, string | null]>((r) => c.onExit((a, b) => r([a, b])))).toEqual([null, null]);
    expect(() => nodeEvalSpawn({ argv: [], cwd: REPO_ROOT, env: {} })).toThrow();
  });
});
