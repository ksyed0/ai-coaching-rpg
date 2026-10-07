import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { SessionStoreError, openSession, parseLockStaleMs, parseStartMode, type OpenedSession } from "../session-store.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const T0 = 2_000_000;
let scenario: Scenario;
let dir: string;
const open: OpenedSession[] = [];
beforeEach(async () => { scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-store-")); });
afterEach(async () => { for (const o of open.splice(0)) await o.close(); await rm(dir, { recursive: true, force: true }); });
const now = () => new Date("2031-02-03T04:05:06Z");
const openIt = async (mode: "resume" | "fresh", clock = new FakeClock(T0), extra: Partial<Parameters<typeof openSession>[0]> = {}) => {
  const o = await openSession({ scenario, sessionId: "s", dataDir: dir, clock, mode, now, ...extra });
  open.push(o);
  return o;
};
const crash = async (o: OpenedSession) => { o.lock.abandon(); await o.log.close(); open.splice(open.indexOf(o), 1); };
const logFile = () => path.join(dir, "s.jsonl");

describe("config parsing", () => {
  it("SESSION_START: resume by default, fresh on request, anything else refused without echoing it", () => {
    expect(parseStartMode(undefined)).toEqual({ ok: true, mode: "resume" });
    expect(parseStartMode(" Fresh ")).toEqual({ ok: true, mode: "fresh" });
    expect(parseStartMode("resume")).toEqual({ ok: true, mode: "resume" });
    const bad = parseStartMode("restart-secret");
    expect(bad).toEqual({ ok: false, error: "SESSION_START must be resume or fresh" });
  });
  it("SESSION_LOCK_STALE_MS: 10000 to 600000, default 30000", () => {
    expect(parseLockStaleMs(undefined)).toEqual({ ok: true, staleMs: 30_000 });
    expect(parseLockStaleMs("10000")).toEqual({ ok: true, staleMs: 10_000 });
    for (const v of ["9999", "5000", "600001", "1e4", "-5", "abc", "5000.5"]) expect(parseLockStaleMs(v)).toMatchObject({ ok: false, error: expect.stringContaining("SESSION_LOCK_STALE_MS") });
  });
});

describe("openSession", () => {
  it("a new session: no log yet, the lock is held, nothing else on disk until the session starts", async () => {
    const o = await openIt("resume");
    expect(o.outcome).toBe("new");
    expect(await readdir(dir)).toEqual(["s.lock"]);
    await o.engine.start({ host: "p" });
    expect((await readdir(dir)).sort()).toEqual(["s.jsonl", "s.lock"]);
  });

  it("resume (default): a running session comes back PAUSED from its log, with the resume events appended", async () => {
    const clock = new FakeClock(T0);
    const a = await openIt("resume", clock);
    await a.engine.start({ host: "p" });
    await a.engine.say("host", "hello");
    await crash(a);
    const b = await openIt("resume", new FakeClock(T0 + 90_000));
    expect(b.outcome).toBe("resumed");
    expect(b.resume).toMatchObject({ sceneId: "s1_open", pendingLine: true, format: 1 });
    expect(b.engine.state.paused).toBe(true);
    const types = (await b.log.all()).map((e) => e.type);
    expect(types.slice(-2)).toEqual(["session.resumed", "facilitator.alert"]);
    expect(await readdir(dir)).not.toContain("s.20310203T040506Z.jsonl");
  });

  it("resume: an ENDED session's log is moved aside and a fresh session starts", async () => {
    const a = await openIt("resume");
    await a.engine.start({ host: "p" });
    await a.engine.command({ command: "advance" }); await a.engine.tick();
    await a.engine.command({ command: "advance" }); await a.engine.tick();
    expect(a.engine.state.status).toBe("ended");
    const before = await readFile(logFile());
    await a.close(); open.pop();
    const b = await openIt("resume");
    expect(b).toMatchObject({ outcome: "rotated", rotatedBecause: "ended" });
    expect(path.basename(b.rotatedTo!)).toBe("s.20310203T040506Z.jsonl");
    expect((await readFile(b.rotatedTo!)).equals(before)).toBe(true);
    await b.engine.start({ host: "p" });
    expect((await b.log.all())[0]).toMatchObject({ seq: 1, type: "session.started" });
  });

  it("fresh: a running session's log is moved aside, byte for byte, and a new session starts at seq 1 (AC-0058)", async () => {
    const a = await openIt("resume");
    await a.engine.start({ host: "p" });
    const before = await readFile(logFile());
    await crash(a);
    const b = await openIt("fresh");
    expect(b).toMatchObject({ outcome: "rotated", rotatedBecause: "fresh" });
    expect((await readFile(b.rotatedTo!)).equals(before)).toBe(true);
    expect(await readdir(dir)).not.toContain("s.jsonl");
    await b.engine.start({ host: "p" });
    expect((await b.log.all())[0]!.seq).toBe(1);
  });

  it("refuses a corrupt log (beyond a cut-off last line), says how to start fresh, changes nothing and releases the lock", async () => {
    await writeFile(logFile(), '{"seq":1}\n{broken\n{"seq":3}\n');
    const before = await readFile(logFile(), "utf8");
    const err = await openIt("resume").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "resume_refused", message: expect.stringMatching(/cannot resume.*SESSION_START=fresh/) });
    expect(await readFile(logFile(), "utf8")).toBe(before);
    expect(await readdir(dir)).toEqual(["s.jsonl"]); // no lock left behind
  });

  it("refuses a log of another scenario", async () => {
    const a = await openIt("resume");
    await a.engine.start({ host: "p" });
    await crash(a);
    const changed = { ...scenario, meta: { ...scenario.meta, title: `${scenario.meta.title} (edited)` } };
    await expect(openSession({ scenario: changed, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: "resume" })).rejects.toMatchObject({ code: "resume_refused", message: expect.stringMatching(/sha256 differs/) });
  });

  it("refuses a second process while the first holds the lock (and fresh cannot rotate it away under the holder)", async () => {
    const a = await openIt("resume");
    await a.engine.start({ host: "p" });
    await expect(openSession({ scenario, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: "fresh", lock: { hostname: "other", now: () => 0 } })).rejects.toMatchObject({ code: "lock" }); // a fixed clock: the live lock can never look stale
    expect(await readdir(dir)).toContain("s.jsonl");
    await a.engine.say("host", "still mine");
  });

  it("an engine whose lock was lost stops appending", async () => {
    const a = await openIt("resume");
    await a.engine.start({ host: "p" });
    await rm(path.join(dir, "s.lock"));
    await expect(a.engine.say("host", "x")).rejects.toMatchObject({ code: "log_failed", message: expect.stringMatching(/session lock was lost/) });
    expect(a.engine.failed).toMatch(/lock was lost/);
    await expect(a.engine.alert("anything")).rejects.toMatchObject({ code: "log_failed" }); // fail-stop: nothing more is accepted
  });

  it("a symlink at the log path is refused and not followed", async () => {
    if (process.platform === "win32") return;
    const { symlink } = await import("node:fs/promises");
    await writeFile(path.join(dir, "elsewhere"), "x\n");
    await symlink(path.join(dir, "elsewhere"), logFile());
    await expect(openIt("resume")).rejects.toMatchObject({ code: "resume_refused", message: expect.stringMatching(/symbolic link/) });
  });

  it("a lock it cannot create (an I/O error) is reported with its code", async () => {
    await writeFile(path.join(dir, "notadir"), "x");
    await expect(openSession({ scenario, sessionId: "s", dataDir: path.join(dir, "notadir"), clock: new FakeClock(T0), mode: "resume" })).rejects.toMatchObject({ code: "io" });
  });
});

describe("openSession with join codes (US-0033)", () => {
  const withCodes = (mode: "resume" | "fresh", clock = new FakeClock(T0)) => openIt(mode, clock, { joinCodes: true });

  it("test_openSession_new_session_issues_one_code_per_player_role_and_persists_only_hashes", async () => {
    const o = await withCodes("resume");
    expect(o.joinCodes).toBeDefined();
    const issued = o.joinCodes!.issued!;
    expect(Object.keys(issued)).toEqual(["host"]);
    expect(o.joinCodes!.codes.verify("host", issued.host)).toBe(true);
    expect(o.joinCodes!.codes.verify("guest", issued.host)).toBe(false); // an AI character has no code
    expect((await readdir(dir)).sort()).toEqual(["s.codes.json", "s.lock"]);
    expect(await readFile(path.join(dir, "s.codes.json"), "utf8")).not.toContain(issued.host!.replace(/-/g, ""));
  });

  it("test_openSession_restart_keeps_the_codes_that_were_handed_out_and_does_not_show_them_again", async () => {
    const a = await withCodes("resume");
    const code = a.joinCodes!.issued!.host!;
    await a.engine.start({ host: "p" });
    await crash(a);
    const b = await withCodes("resume", new FakeClock(T0 + 60_000));
    expect(b.outcome).toBe("resumed");
    expect(b.joinCodes!.issued).toBeNull();
    expect(b.joinCodes!.codes.verify("host", code)).toBe(true);
    expect(b.notes.join("\n")).not.toMatch(/new join codes/);
    // nothing about codes reached the log
    expect(await readFile(logFile(), "utf8")).not.toContain(code.replace(/-/g, ""));
  });

  it("test_openSession_restart_on_an_empty_log_issues_and_shows_new_codes_review_I1", async () => {
    const a = await withCodes("resume");
    const code = a.joinCodes!.issued!.host!;
    await crash(a); // nothing happened in the session: there is nothing the old codes must keep open
    const b = await withCodes("resume");
    expect(b.outcome).toBe("new");
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.joinCodes!.codes.verify("host", code)).toBe(false);
    expect(b.joinCodes!.codes.verify("host", b.joinCodes!.issued!.host)).toBe(true);
  });

  it("test_openSession_a_played_log_moved_aside_by_hand_does_not_keep_the_old_codes_review_M1", async () => {
    const a = await withCodes("resume");
    const code = a.joinCodes!.issued!.host!;
    await a.engine.start({ host: "p" });
    await crash(a);
    const { rename } = await import("node:fs/promises");
    await rename(logFile(), path.join(dir, "s.by-hand.jsonl"));
    const b = await withCodes("resume");
    expect(b.outcome).toBe("new");
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.joinCodes!.codes.verify("host", code)).toBe(false);
  });

  it("test_openSession_discardIssuedCodes_removes_codes_this_start_issued_and_keeps_kept_ones", async () => {
    const a = await withCodes("resume");
    expect(a.discardIssuedCodes()).toBe(true);
    expect(await readdir(dir)).not.toContain("s.codes.json");
    await crash(a);
    const b = await withCodes("resume"); // issues again (no file)
    const code = b.joinCodes!.issued!.host!;
    await b.engine.start({ host: "p" });
    await crash(b);
    const c = await withCodes("resume");
    expect(c.joinCodes!.issued).toBeNull();
    expect(c.discardIssuedCodes()).toBe(true); // kept codes were handed out earlier: never removed
    expect(await readdir(dir)).toContain("s.codes.json");
    expect(c.joinCodes!.codes.verify("host", code)).toBe(true);
  });

  it("test_openSession_sweeps_stale_codes_temp_files_and_nothing_else_review_M5", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    for (const f of ["s.codes.json.0123456789ab.tmp", "s.codes.json.ffffffffffff.tmp"]) await writeFile(path.join(dir, f), "half", { mode: 0o600 });
    for (const f of ["s.codes.json.keep", "t.codes.json.0123456789ab.tmp", "s.codes.json.xyz.tmp"]) await writeFile(path.join(dir, f), "other", { mode: 0o600 });
    await withCodes("resume");
    expect((await readdir(dir)).sort()).toEqual(["s.codes.json", "s.codes.json.keep", "s.codes.json.xyz.tmp", "s.lock", "t.codes.json.0123456789ab.tmp"]);
  });

  it("test_openSession_fresh_and_ended_sessions_get_new_codes_and_the_old_ones_stop_working", async () => {
    const a = await withCodes("resume");
    const first = a.joinCodes!.issued!.host!;
    await a.engine.start({ host: "p" });
    await crash(a);
    const b = await withCodes("fresh");
    expect(b.outcome).toBe("rotated");
    const second = b.joinCodes!.issued!.host!;
    expect(b.joinCodes!.codes.verify("host", first)).toBe(false);
    await b.engine.start({ host: "p" });
    await b.engine.command({ command: "advance" }); await b.engine.tick();
    await b.engine.command({ command: "advance" }); await b.engine.tick();
    await b.close(); open.splice(open.indexOf(b), 1);
    const c = await withCodes("resume");
    expect(c).toMatchObject({ outcome: "rotated", rotatedBecause: "ended" });
    expect(c.joinCodes!.issued).not.toBeNull();
    expect(c.joinCodes!.codes.verify("host", second)).toBe(false);
  });

  it("test_openSession_resume_with_missing_codes_file_issues_new_codes_with_a_warning", async () => {
    const a = await withCodes("resume");
    const old = a.joinCodes!.issued!.host!;
    await a.engine.start({ host: "p" });
    await crash(a);
    await rm(path.join(dir, "s.codes.json"));
    const b = await withCodes("resume");
    expect(b.outcome).toBe("resumed");
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.joinCodes!.codes.verify("host", old)).toBe(false);
    expect(b.notes.join("\n")).toMatch(/new join codes were issued/);
    expect(b.notes.join("\n")).not.toContain(b.joinCodes!.issued!.host!);
  });

  it("test_openSession_codes_for_another_scenario_are_replaced", async () => {
    const a = await withCodes("resume");
    const old = a.joinCodes!.issued!.host!;
    await crash(a);
    await rm(logFile(), { force: true });
    const changed = { ...scenario, meta: { ...scenario.meta, title: `${scenario.meta.title} (edited)` } };
    const b = await openSession({ scenario: changed, sessionId: "s", dataDir: dir, clock: new FakeClock(T0), mode: "resume", now, joinCodes: true });
    open.push(b);
    expect(b.joinCodes!.issued).not.toBeNull();
    expect(b.joinCodes!.codes.verify("host", old)).toBe(false);
  });

  it("test_openSession_malformed_codes_file_refuses_the_start_and_changes_nothing", async () => {
    const a = await withCodes("resume");
    await a.engine.start({ host: "p" });
    await crash(a);
    await writeFile(path.join(dir, "s.codes.json"), "{ not json", { mode: 0o600 });
    const logBefore = await readFile(logFile());
    const err = await withCodes("resume").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SessionStoreError);
    expect(err).toMatchObject({ code: "join_codes", message: expect.stringMatching(/join codes file.*move s\.codes\.json aside/) });
    expect((await readFile(logFile())).equals(logBefore)).toBe(true);
    expect(await readFile(path.join(dir, "s.codes.json"), "utf8")).toBe("{ not json");
    expect((await readdir(dir)).sort()).toEqual(["s.codes.json", "s.jsonl"]); // no lock left behind
  });

  it("test_openSession_without_the_option_writes_no_codes_file", async () => {
    const o = await openIt("resume");
    expect(o.joinCodes).toBeUndefined();
    expect(await readdir(dir)).toEqual(["s.lock"]);
  });
});
