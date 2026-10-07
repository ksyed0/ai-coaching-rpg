import { link, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, reduce, reduceReplay, type SessionEvent, type SessionState } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { JsonlEventLog, MemoryEventLog } from "../event-log.js";
import { SessionLock } from "../log-files.js";
import { SessionEngine } from "../session-engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const friday = path.join(here, "../../../../../scenarios/friday-escalation");
const T0 = 1_000_000;
let scenario: Scenario;
let dir: string;
type Proto = { datasync: () => Promise<void>; write: (...a: unknown[]) => Promise<{ bytesWritten: number }> };
let proto: Proto; let origSync: Proto["datasync"]; let origWrite: Proto["write"];
beforeEach(async () => {
  scenario = await loadScenario(friday);
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-failstop-"));
  const fh = await open(path.join(dir, "probe"), "w");
  proto = Object.getPrototypeOf(fh) as Proto;
  await fh.close();
  origSync = proto.datasync; origWrite = proto.write;
});
afterEach(async () => { proto.datasync = origSync; proto.write = origWrite; SessionLock.testHooks = {}; await rm(dir, { recursive: true, force: true }); });

const fileEvents = async (file: string): Promise<SessionEvent[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
const fold = (events: SessionEvent[]): SessionState => events.reduce((s, e) => reduce(s, e), initialState());

async function running(): Promise<{ engine: SessionEngine; log: JsonlEventLog; clock: FakeClock }> {
  const log = new JsonlEventLog("x", dir);
  const clock = new FakeClock(T0);
  const engine = new SessionEngine({ scenario, log, clock });
  await engine.start({});
  return { engine, log, clock };
}

/** After a failure: nothing else is appended, whatever the engine is asked to do (probe 1 kept appending scene.exited every tick). */
async function assertFailStopped(engine: SessionEngine, clock: FakeClock, file: string): Promise<void> {
  const before = await readFile(file);
  expect(engine.failed).not.toBeNull();
  await expect(engine.say("delivery_lead", "again")).rejects.toMatchObject({ code: "log_failed" });
  await expect(engine.command({ command: "advance" })).rejects.toMatchObject({ code: "log_failed" });
  await expect(engine.alert("x")).rejects.toMatchObject({ code: "log_failed" });
  clock.advance(60 * 60_000);
  for (let i = 0; i < 5; i++) await engine.tick().catch(() => undefined);
  expect((await readFile(file)).equals(before)).toBe(true);
}

/** The restart resumes exactly what the file holds (an unconfirmed event, if it reached the disk, included). */
async function restartMatchesFile(file: string): Promise<void> {
  const held = await fileEvents(file);
  const e2 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir), clock: new FakeClock(T0 + 3_600_000) });
  const out = await e2.restore();
  expect(out.kind).toBe("running");
  expect(e2.state).toEqual(fold(held));
}

describe("C1: the log is fail-stop", () => {
  it("a failed fdatasync (probe 1): the call fails, the engine refuses everything after, nothing more is appended, and the restart resumes what the file holds", async () => {
    const { engine, log, clock } = await running();
    let failNext = true;
    proto.datasync = function (this: unknown) { if (failNext) { failNext = false; return Promise.reject(Object.assign(new Error("EIO"), { code: "EIO" })); } return origSync.call(this); };
    await expect(engine.say("delivery_lead", "hello")).rejects.toMatchObject({ code: "log_failed", message: expect.stringMatching(/EIO while writing.*Restart it: the session resumes from its log/) });
    expect(log.failure).toMatch(/EIO/);
    await assertFailStopped(engine, clock, log.file);
    // The unsynced line did reach the file: it is replayed on resume (documented: an event may be on disk that no client saw).
    expect((await fileEvents(log.file)).at(-1)).toMatchObject({ type: "utterance", text: "hello" });
    await restartMatchesFile(log.file);
  });

  it("a write that fails after the JSON but before its newline: fail-stop; the restart keeps the complete line (it gets its newline)", async () => {
    const { engine, log, clock } = await running();
    let failNext = true;
    proto.write = async function (this: unknown, ...a: unknown[]) {
      if (failNext && Buffer.isBuffer(a[0]) && (a[0] as Buffer).toString().includes("half written")) {
        failNext = false;
        const buf = a[0] as Buffer;
        await origWrite.call(this, buf, 0, buf.length - 1); // everything but the newline
        throw Object.assign(new Error("EIO"), { code: "EIO" });
      }
      return origWrite.apply(this, a);
    };
    await expect(engine.say("delivery_lead", "half written")).rejects.toMatchObject({ code: "log_failed" });
    await assertFailStopped(engine, clock, log.file);
    proto.write = origWrite;
    const e2 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir), clock: new FakeClock(T0 + 1) });
    const out = await e2.restore();
    expect(out.kind).toBe("running");
    expect(e2.state.transcript.at(-1)?.text).toBe("half written");
    if (out.kind === "running") await e2.markResumed(out.info);
    expect((await readFile(log.file, "utf8")).split("\n").filter(Boolean).every((l) => JSON.parse(l))).toBe(true); // the newline was added
    await restartMatchesFile(log.file);
  });

  it("a full disk (ENOSPC, nothing written): fail-stop, and the restart resumes the last good state", async () => {
    const { engine, log, clock } = await running();
    const good = await fileEvents(log.file);
    proto.write = () => Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
    await expect(engine.say("delivery_lead", "lost")).rejects.toMatchObject({ code: "log_failed", message: expect.stringMatching(/ENOSPC/) });
    await assertFailStopped(engine, clock, log.file);
    proto.write = origWrite;
    expect(await fileEvents(log.file)).toEqual(good);
    await restartMatchesFile(log.file);
  });

  it("a log that returns an event the state cannot take: the engine halts instead of diverging", async () => {
    const log = new MemoryEventLog("m");
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(T0) });
    await engine.start({});
    const reasons: string[] = [];
    engine.onFailure((r) => reasons.push(r));
    const append = log.append.bind(log);
    log.append = async (b, ts) => ({ ...(await append(b, ts)), seq: 999 });
    await expect(engine.alert("x")).rejects.toMatchObject({ code: "log_failed" });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/state rejected event 999/);
    await expect(engine.alert("y")).rejects.toMatchObject({ code: "log_failed" });
  });

  it("M1: a lock lost while the bytes were written: the event is on disk but nothing follows it", async () => {
    let calls = 0; let lose = false;
    const log = new JsonlEventLog("x", dir, { guard: () => { calls++; if (lose && calls % 3 === 0) throw new Error("taken over"); } });
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(T0) });
    await engine.start({});
    calls = 0; lose = true; // the third guard call of the next append (after the sync) finds the lock gone
    await expect(engine.alert("written, then the lock was gone")).rejects.toMatchObject({ code: "log_failed" });
    expect((await fileEvents(log.file)).at(-1)).toMatchObject({ type: "facilitator.alert", message: "written, then the lock was gone" });
    await expect(engine.alert("never")).rejects.toMatchObject({ code: "log_failed" });
    expect((await fileEvents(log.file)).some((e) => e.type === "facilitator.alert" && e.message === "never")).toBe(false);
  });
});

/** Cuts the log right after the first event that matches `at` (as a crash between the appends of one operation would). */
async function cutAfter(build: (e: SessionEngine, c: FakeClock) => Promise<void>, at: (e: SessionEvent) => boolean): Promise<{ log: JsonlEventLog; kept: SessionEvent[] }> {
  const clock = new FakeClock(T0);
  const e1 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir, { sync: false }), clock });
  await build(e1, clock);
  const file = path.join(dir, "x.jsonl");
  const all = await fileEvents(file);
  const i = all.findIndex(at);
  expect(i).toBeGreaterThanOrEqual(0);
  const kept = all.slice(0, i + 1);
  await writeFile(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { log: new JsonlEventLog("x", dir, { sync: false }), kept };
}

async function resume(log: JsonlEventLog) {
  const engine = new SessionEngine({ scenario, log, clock: new FakeClock(T0 + 60_000) });
  const out = await engine.restore();
  if (out.kind !== "running") throw new Error(`expected running, got ${out.kind}`);
  const notes = await engine.markResumed(out.info);
  // Idempotent: a second restart of the repaired log finds nothing left to complete.
  const again = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir, { sync: false }), clock: new FakeClock(T0 + 120_000) });
  const out2 = await again.restore();
  expect(out2.kind === "running" && out2.info.repairs).toEqual([]);
  expect(again.state).toEqual(engine.state);
  return { engine, notes, info: out.info };
}

describe("I1: a crash between the appends of one operation is completed on resume (and logged)", () => {
  it("cut after scene.exited (probe 2): the next scene is entered, paused", async () => {
    const { log } = await cutAfter(async (e) => { await e.start({}); await e.command({ command: "advance" }); await e.tick(); }, (e) => e.type === "scene.exited");
    const { engine, notes } = await resume(log);
    expect(notes.repairs).toEqual(["entered scene s2_client_call"]);
    expect(engine.state.currentScene?.id).toBe("s2_client_call");
    expect(engine.state.paused).toBe(true);
    await engine.command({ command: "resume" });
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s3_internal_wrap");
    const alert = (await log.all()).find((e) => e.type === "facilitator.alert" && /now completes what the crash cut short: entered scene s2_client_call/.test(e.message));
    expect(alert).toBeTruthy();
  });

  it("cut after the LAST scene.exited: the session is ended", async () => {
    const { log } = await cutAfter(async (e) => {
      await e.start({});
      for (let i = 0; i < 3; i++) { await e.command({ command: "advance" }); await e.tick(); }
    }, (e) => e.type === "scene.exited" && e.sceneId === "s3_internal_wrap");
    const e1 = new SessionEngine({ scenario, log, clock: new FakeClock(T0 + 60_000) });
    const r1 = await e1.restore();
    if (r1.kind !== "running") throw new Error("not running");
    expect((await e1.markResumed(r1.info)).repairs).toEqual(["ended the session (the last scene had ended)"]);
    expect(e1.state.status).toBe("ended");
    const endAlert = (await log.all()).filter((e) => e.type === "facilitator.alert").at(-1) as Extract<SessionEvent, { type: "facilitator.alert" }>;
    expect(endAlert.message).toMatch(/session ends now/);
    expect(endAlert.message).not.toMatch(/paused|\/resume/);
    const e2 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir, { sync: false }), clock: new FakeClock(T0 + 60_000) });
    const out = await e2.restore();
    expect(out.kind).toBe("ended");
    expect((await fileEvents(path.join(dir, "x.jsonl"))).at(-1)).toMatchObject({ type: "session.ended", reason: "script_complete" });
  });

  it("cut right after session.started: the AI characters are set up and the first scene entered with its opening inject", async () => {
    const { log } = await cutAfter(async (e) => { await e.start({}); }, (e) => e.type === "session.started");
    const { engine, notes } = await resume(log);
    expect(notes.repairs).toEqual(["set up AI character client_sponsor", "entered scene s1_huddle"]);
    expect(engine.state.npcs.client_sponsor?.goals.length).toBeGreaterThan(0);
    expect(engine.state.currentScene?.id).toBe("s1_huddle");
    expect(engine.state.injectsFired).toEqual(["email_from_priya"]);
  });

  it("cut after scene.entered, before its opening inject: the opening inject fires", async () => {
    const { log } = await cutAfter(async (e) => { await e.start({}); }, (e) => e.type === "scene.entered");
    const { engine, notes } = await resume(log);
    expect(notes.repairs).toEqual(["fired the opening inject of s1_huddle"]);
    expect(engine.state.injectsFired).toEqual(["email_from_priya"]);
  });

  it("cut after inject.fired, before its AI character update: the update is re-derived from the scenario", async () => {
    const { log, kept } = await cutAfter(async (e, c) => {
      await e.start({}); await e.command({ command: "advance" }); await e.tick();
      c.advance(7 * 60_000); await e.tick();
    }, (e) => e.type === "inject.fired" && e.injectId === "cfo_pressure");
    const live = fold(kept);
    expect(live.npcs.client_sponsor!.goals).not.toContain("Get a yes on this call");
    const { engine, notes } = await resume(log);
    expect(notes.repairs).toEqual(["applied inject cfo_pressure to client_sponsor"]);
    expect(engine.state.npcs.client_sponsor!.goals).toEqual([...live.npcs.client_sponsor!.goals, "Get a yes on this call"]);
  });
});

describe("M5: replay is linear", () => {
  it("reduceReplay appends in place (the transcript array is never copied) and agrees with reduce", () => {
    const head: SessionEvent[] = [
      { seq: 1, ts: 1, sessionId: "x", type: "session.started", scenarioId: "a", version: "1", roles: { p: { kind: "player" } } },
      { seq: 2, ts: 1, sessionId: "x", type: "scene.entered", sceneId: "s", participants: ["p"] },
    ];
    const N = 200_000;
    let s = head.reduce(reduceReplay, initialState());
    const transcript = s.transcript;
    for (let i = 0; i < N; i++) s = reduceReplay(s, { seq: 3 + i, ts: 1, sessionId: "x", type: "utterance", roleId: "p", text: "hi", channel: "text" });
    expect(s.transcript).toBe(transcript); // one array for the whole replay: O(1) per event, not O(n)
    expect(s.transcript).toHaveLength(N);
    const small = [...head, ...Array.from({ length: 50 }, (_, i): SessionEvent => (i % 5 === 0
      ? { seq: 3 + i, ts: 1, sessionId: "x", type: "inject.fired", injectId: `i${i}`, sceneId: "s", to: ["p"], content: "c" }
      : { seq: 3 + i, ts: 1, sessionId: "x", type: "utterance", roleId: "p", text: `t${i}`, channel: "text" }))];
    expect(small.reduce(reduceReplay, initialState())).toEqual(fold(small));
    expect(() => reduceReplay(initialState(), { seq: 5, ts: 1, sessionId: "x", type: "utterance", roleId: "p", text: "x", channel: "text" })).toThrow(/out of order/);
  });

  it("restores a 100k-utterance log", async () => {
    const lines: string[] = [];
    const ev = (e: Record<string, unknown>) => lines.push(JSON.stringify({ ...e, seq: lines.length + 1, ts: T0, sessionId: "x" }));
    const { scenarioHash } = await import("../scenario-hash.js");
    ev({ type: "session.started", scenarioId: scenario.meta.id, version: scenario.meta.version, logFormat: 1, scenarioHash: scenarioHash(scenario), roles: Object.fromEntries(Object.values(scenario.roles).map((r) => [r.id, { kind: r.type === "npc" ? "npc" : "player" }])) });
    for (const r of Object.values(scenario.roles)) if (r.type === "npc") ev({ type: "npc.updated", roleId: r.id, goals: [], knowledge: [], released: [] });
    ev({ type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead", "tech_lead", "account_manager"] });
    ev({ type: "inject.fired", injectId: "email_from_priya", sceneId: "s1_huddle", to: ["delivery_lead"], content: "c" });
    for (let i = 0; i < 100_000; i++) ev({ type: "utterance", roleId: "delivery_lead", text: `line ${i}`, channel: "text" });
    await writeFile(path.join(dir, "x.jsonl"), lines.join("\n") + "\n");
    const e = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir), clock: new FakeClock(T0) });
    const out = await e.restore();
    expect(out.kind).toBe("running");
    expect(e.state.transcript).toHaveLength(100_000);
  }, 30_000);
});

describe("M2: a takeover race never makes a live holder declare its lock lost", () => {
  it("starter B moves A's fresh lock aside for an instant (it judged the OLD lock stale) and puts it back: A keeps its lock", async () => {
    // A stale lock, as a crashed server left it.
    const lockFile = path.join(dir, "s.lock");
    await writeFile(lockFile, JSON.stringify({ pid: 1, host: "gone" }));
    const old = await stat(lockFile);
    const t = (Date.now() - 120_000) / 1000;
    const { utimes } = await import("node:fs/promises");
    await utimes(lockFile, t, t);
    const a = SessionLock.acquire(dir, "s"); // A takes the stale lock over and holds a fresh one
    try {
      let check: Promise<void> | null = null;
      // B judged the OLD file stale before A replaced it; B's rename now moves A's lock aside. While it is aside, A checks its lock.
      SessionLock.testHooks.afterRename = () => { check = a.assertHeld(); };
      const removeIfSame = (SessionLock as unknown as { removeIfSame(f: string, id: { dev: number; ino: number }): boolean }).removeIfSame;
      expect(removeIfSame(path.resolve(lockFile), { dev: old.dev, ino: old.ino })).toBe(false); // not the judged file: put back
      SessionLock.testHooks = {};
      await expect(check).resolves.toBeUndefined();
      expect(a.lost).toBe(false);
      await a.assertHeld();
    } finally { a.release(); }
  });
});

describe("M7: a log or lock with extra hard links is refused", () => {
  it("log", async () => {
    await writeFile(path.join(dir, "x.jsonl"), "");
    await link(path.join(dir, "x.jsonl"), path.join(dir, "other"));
    await expect(new JsonlEventLog("x", dir).all()).rejects.toThrow(/other hard links/);
    await expect(new JsonlEventLog("x", dir).append({ type: "session.ended", reason: "script_complete" }, 1)).rejects.toThrow(/other hard links/);
  });
  it("lock", async () => {
    await writeFile(path.join(dir, "s.lock"), "{}");
    await link(path.join(dir, "s.lock"), path.join(dir, "other"));
    expect(() => SessionLock.acquire(dir, "s")).toThrow(/other hard links/);
  });
});

describe("Minor 5/7: ownership and interrupted rotations", () => {
  it("a PRE-EXISTING log owned by another user is refused with an actionable message; a log this open creates is not checked", async () => {
    if (typeof process.getuid !== "function") return;
    const statProto = proto as unknown as { stat: (...a: unknown[]) => Promise<{ uid: number }> };
    const origStat = statProto.stat;
    statProto.stat = async function (this: unknown, ...a: unknown[]) { const st = await origStat.apply(this, a); return Object.assign(st, { uid: process.getuid!() + 1 }); };
    try {
      const fresh = new JsonlEventLog("new", dir);
      expect((await fresh.append({ type: "session.ended", reason: "script_complete" }, 1)).seq).toBe(1); // created by this open: ours
      await fresh.close();
      await expect(new JsonlEventLog("new", dir).append({ type: "session.ended", reason: "script_complete" }, 2)).rejects.toThrow(/belongs to another user; chown it to the server's user/);
      await expect(new JsonlEventLog("new", dir).all()).rejects.toThrow(/belongs to another user/);
    } finally { statProto.stat = origStat; }
  });

  it("a crash between a rotation's link and unlink: the next start finishes the rotation (the data stays under the rotated name)", async () => {
    const { openSession } = await import("../session-store.js");
    const file = path.join(dir, "x.jsonl");
    await writeFile(file, "", { mode: 0o600 });
    const e1 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir, { sync: false }), clock: new FakeClock(T0) });
    await e1.start({});
    const before = await readFile(file);
    await link(file, path.join(dir, "x.20300101T000000Z.jsonl")); // the link happened, the unlink did not
    const o = await openSession({ scenario, sessionId: "x", dataDir: dir, clock: new FakeClock(T0), mode: "fresh" });
    try {
      expect(o.notes.join("\n")).toMatch(/interrupted rotation was finished.*x\.20300101T000000Z\.jsonl/);
      expect(o.outcome).toBe("new");
      expect((await readFile(path.join(dir, "x.20300101T000000Z.jsonl"))).equals(before)).toBe(true);
      await o.engine.start({});
      expect((await o.log.all())[0]!.seq).toBe(1);
    } finally { await o.close(); }
  });

  it("an unrelated extra hard link is NOT treated as a rotation: the log is refused, naming the likely cause", async () => {
    const { openSession } = await import("../session-store.js");
    const file = path.join(dir, "x.jsonl");
    const e1 = new SessionEngine({ scenario, log: new JsonlEventLog("x", dir, { sync: false }), clock: new FakeClock(T0) });
    await e1.start({});
    await link(file, path.join(dir, "elsewhere.jsonl"));
    await expect(openSession({ scenario, sessionId: "x", dataDir: dir, clock: new FakeClock(T0), mode: "resume" })).rejects.toThrow(/other hard links \(a rotation interrupted/);
  });
});
