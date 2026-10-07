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
