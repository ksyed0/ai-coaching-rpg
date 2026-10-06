import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, readFile, writeFile, appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "@acr/script";
import { initialState, reduce, activeElapsedMs } from "@acr/events";
import { SessionEngine, EngineError } from "../session-engine.js";
import { MemoryEventLog, JsonlEventLog } from "../event-log.js";
import { FakeClock, SystemClock } from "../clock.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

let scenario: Scenario;
let clock: FakeClock;
let engine: SessionEngine;
let log: MemoryEventLog;

beforeEach(async () => {
  scenario = await loadScenario(fixture);
  clock = new FakeClock(1_000_000);
  log = new MemoryEventLog("sess-1");
  engine = new SessionEngine({ scenario, log, clock });
  await engine.start({ host: "participant-1" });
});

describe("SessionEngine", () => {
  it("starts and enters the first scene", () => {
    expect(engine.state.status).toBe("running");
    expect(engine.state.currentScene?.id).toBe("s1_open");
    expect(engine.state.roles.host).toEqual({ kind: "player", participantId: "participant-1" });
    expect(engine.state.roles.guest).toEqual({ kind: "npc" });
  });

  it("records an utterance", async () => {
    const e = await engine.say("host", "hello");
    expect(e.type).toBe("utterance");
    expect(engine.state.transcript.at(-1)?.text).toBe("hello");
  });

  it("rejects utterances while paused and does not log them", async () => {
    await engine.command({ command: "pause" });
    const before = (await log.all()).length;
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "paused" });
    expect(engine.state.transcript).toHaveLength(0);
    expect(await log.all()).toHaveLength(before);
    expect((await log.all()).some((e) => e.type === "utterance")).toBe(false);
    await engine.command({ command: "resume" });
    await engine.say("host", "y");
    expect(engine.state.transcript).toHaveLength(1);
  });

  it("rejects a role that is not in the current scene", async () => {
    await engine.command({ command: "advance" });
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    scenario.script.scenes[1].participants = ["host"]; // guest no longer in s2
    await expect(engine.say("guest", "x")).rejects.toBeInstanceOf(EngineError);
  });

  it("fires a timed inject on tick and never twice", async () => {
    clock.advance(61_000);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    expect(engine.state.npcs.guest.goals).toContain("Leave early");
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("exits a scene on its time box and enters the next", async () => {
    clock.advance(120_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.sceneHistory.map((s) => s.id)).toEqual(["s1_open", "s2_close"]);
  });

  it("exits a scene on a GM verdict", async () => {
    await engine.recordGmVerdict("both parties have said hello", true, "both greeted");
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("ends the session after the last scene", async () => {
    clock.advance(120_000); await engine.tick();
    clock.advance(60_000); await engine.tick();
    expect(engine.state.status).toBe("ended");
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "ended" });
  });

  it("fires a manual inject on facilitator command", async () => {
    await engine.command({ command: "fire_inject", injectId: "late_inject" });
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("notifies subscribers of every event", async () => {
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    await engine.say("host", "a");
    expect(seen).toEqual(["utterance"]);
  });

  it("stamps every event with monotonic seq from 1, ts and sessionId", async () => {
    await engine.say("host", "a");
    const events = await log.all();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === "sess-1" && e.ts === 1_000_000)).toBe(true);
  });

  it("unsubscribe stops notifications", async () => {
    const seen: string[] = [];
    const off = engine.subscribe((e) => seen.push(e.type));
    off();
    await engine.say("host", "a");
    expect(seen).toEqual([]);
  });

  it("rejects unknown roles and unknown injects", async () => {
    await expect(engine.say("nobody", "x")).rejects.toMatchObject({ code: "unknown_role" });
    await expect(engine.command({ command: "fire_inject", injectId: "nope" })).rejects.toMatchObject({ code: "unknown_inject" });
    await expect(engine.updateNpc("host", { goals: [] })).rejects.toMatchObject({ code: "unknown_role" });
  });

  it("updates an NPC and applies set_npc_stance", async () => {
    await engine.updateNpc("guest", { released: ["fact"] });
    expect(engine.state.npcs.guest.released).toContain("fact");
    await engine.command({ command: "set_npc_stance", roleId: "guest", goals: ["Be curt"] });
    expect(engine.state.npcs.guest.goals).toEqual(["Be curt"]);
  });

  it("does not tick while paused and rejects commands after end", async () => {
    await engine.command({ command: "pause" });
    clock.advance(500_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
    await engine.command({ command: "resume" });
    clock.advance(120_000); await engine.tick();
    clock.advance(60_000); await engine.tick();
    await expect(engine.command({ command: "pause" })).rejects.toMatchObject({ code: "ended" });
    expect(engine.currentScene()).toBeNull();
  });

  describe("inject timing (R14)", () => {
    it("never fires an inject whose at_minute is past the time box, even on a late tick", async () => {
      scenario.script.scenes[0].injects![0].at_minute = 3; // time box is 2
      clock.advance(10 * 60_000); // first tick long after the time box
      await engine.tick();
      expect(engine.state.injectsFired).toEqual([]);
      expect(engine.state.currentScene?.id).toBe("s2_close");
      clock.advance(60_000); await engine.tick(); // s2 exits -> session ends
      expect(engine.state.injectsFired).toEqual([]);
    });

    it("does not fire a scene's injects after that scene has exited", async () => {
      clock.advance(30_000); // before inject at minute 1
      await engine.command({ command: "advance" });
      await engine.tick();
      expect(engine.state.currentScene?.id).toBe("s2_close");
      clock.advance(5 * 60_000);
      await engine.tick();
      expect(engine.state.injectsFired).toEqual([]);
    });

    it("fires an inject at exactly the time-box minute once, and the scene still exits", async () => {
      scenario.script.scenes[0].injects![0].at_minute = 2;
      clock.advance(120_000);
      await engine.tick();
      const events = await log.all();
      const fired = events.filter((e) => e.type === "inject.fired");
      expect(fired).toHaveLength(1);
      expect(engine.state.injectsFired).toEqual(["late_inject"]);
      expect(engine.state.currentScene?.id).toBe("s2_close");
      const types = events.map((e) => e.type);
      expect(types.indexOf("inject.fired")).toBeLessThan(types.indexOf("scene.exited"));
    });
  });
});

describe("clocks", () => {
  it("SystemClock returns epoch ms", () => {
    expect(Math.abs(new SystemClock().now() - Date.now())).toBeLessThan(1000);
  });
});

describe("JsonlEventLog", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-log-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("appends one JSON line per event and reads them back", async () => {
    const jl = new JsonlEventLog("s-9", path.join(dir, "nested"));
    expect(await jl.all()).toEqual([]);
    const e1 = await jl.append({ type: "session.ended", reason: "script_complete" }, 5);
    const e2 = await jl.append({ type: "session.ended", reason: "script_complete" }, 6);
    expect([e1.seq, e2.seq]).toEqual([1, 2]);
    const all = await jl.all();
    expect(all).toEqual([e1, e2]);
    const raw = await readFile(path.join(dir, "nested", "s-9.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });

  it("drives an engine end to end", async () => {
    const sc = await loadScenario(fixture);
    const e = new SessionEngine({ scenario: sc, log: new JsonlEventLog("s-10", dir), clock: new FakeClock(1) });
    await e.start({ host: "p1" });
    await e.say("host", "hi");
    expect((await new JsonlEventLog("s-10", dir).all()).map((x) => x.type)).toContain("utterance");
  });
});

describe("serialization", () => {
  it("two overlapping ticks fire a due inject exactly once", async () => {
    clock.advance(61_000);
    await Promise.all([engine.tick(), engine.tick()]);
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    expect((await log.all()).filter((e) => e.type === "inject.fired")).toHaveLength(1);
  });

  it("say issued right after pause (not awaited) is rejected and not logged", async () => {
    const before = (await log.all()).length;
    const p = engine.command({ command: "pause" });
    const s = engine.say("host", "x");
    await expect(s).rejects.toMatchObject({ code: "paused" });
    await p;
    expect(await log.all()).toHaveLength(before + 1);
  });

  it("two overlapping updateNpc patches both land", async () => {
    await Promise.all([engine.updateNpc("guest", { goals: ["g1"] }), engine.updateNpc("guest", { knowledge: ["k1"] })]);
    expect(engine.state.npcs.guest.goals).toEqual(["g1"]);
    expect(engine.state.npcs.guest.knowledge).toEqual(["k1"]);
  });

  it("a failed op does not poison the chain", async () => {
    await expect(engine.say("nobody", "x")).rejects.toBeInstanceOf(EngineError);
    await expect(engine.say("host", "ok")).resolves.toBeTruthy();
  });

  it("notifies subscribers in seq order", async () => {
    const seqs: number[] = [];
    engine.subscribe((e) => seqs.push(e.seq));
    await Promise.all([engine.say("host", "a"), engine.say("host", "b"), engine.say("host", "c")]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });
});

describe("command validation", () => {
  it("rejected commands append nothing", async () => {
    const n = (await log.all()).length;
    await expect(engine.command({ command: "fire_inject", injectId: "nope" })).rejects.toMatchObject({ code: "unknown_inject" });
    await expect(engine.command({ command: "set_npc_stance", roleId: "ghost", goals: [] })).rejects.toMatchObject({ code: "unknown_role" });
    await expect(engine.command({ command: "whisper", roleId: "ghost", text: "hi" })).rejects.toMatchObject({ code: "unknown_role" });
    expect(await log.all()).toHaveLength(n);
  });

  it("M2: a whisper to an NPC role is rejected (nobody could ever see it) and appends nothing", async () => {
    const n = (await log.all()).length;
    await expect(engine.command({ command: "whisper", roleId: "guest", text: "psst" })).rejects.toMatchObject({ name: "EngineError", code: "npc_role" });
    expect(await log.all()).toHaveLength(n);
    await engine.command({ command: "whisper", roleId: "host", text: "psst" });
    expect(await log.all()).toHaveLength(n + 1);
  });
});

describe("state is a projection of the log", () => {
  it("replaying the log reproduces advanceRequested and gmVerdicts", async () => {
    await engine.recordGmVerdict("both parties have said hello", false, "not yet");
    await engine.command({ command: "advance" });
    expect(engine.state.advanceRequested).toBe(true);
    expect(engine.state.gmVerdicts).toEqual({ "both parties have said hello": false });
    let replayed = initialState();
    for (const e of await log.all()) replayed = reduce(replayed, e);
    expect(replayed.advanceRequested).toBe(true);
    expect(replayed.gmVerdicts).toEqual(engine.state.gmVerdicts);
    expect(replayed).toEqual(engine.state);
  });

  it("a fresh engine over the same state would still exit on a recorded advance", async () => {
    await engine.command({ command: "advance" });
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.advanceRequested).toBe(false);
  });
});

describe("JsonlEventLog hardening", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-log2-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const body = { type: "session.ended", reason: "script_complete" } as const;

  it("concurrent appends yield seq 1..N in file order", async () => {
    const jl = new JsonlEventLog("c1", dir);
    const res = await Promise.all(Array.from({ length: 25 }, () => jl.append(body, 1)));
    expect(res.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const raw = (await readFile(path.join(dir, "c1.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).seq);
    expect(raw).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("MemoryEventLog concurrent appends keep seq order", async () => {
    const m = new MemoryEventLog("m");
    await Promise.all([m.append(body, 1), m.append(body, 1), m.append(body, 1)]);
    expect((await m.all()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("reopening continues the seq", async () => {
    await new JsonlEventLog("r1", dir).append(body, 1);
    await new JsonlEventLog("r1", dir).append(body, 2);
    const e3 = await new JsonlEventLog("r1", dir).append(body, 3);
    expect(e3.seq).toBe(3);
    expect((await new JsonlEventLog("r1", dir).all()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("a failed write leaves no seq gap", async () => {
    await mkdir(path.join(dir, "f1.jsonl")); // a directory where the file should be
    const jl = new JsonlEventLog("f1", dir);
    await expect(jl.append(body, 1)).rejects.toBeTruthy();
    await rm(path.join(dir, "f1.jsonl"), { recursive: true });
    const e = await jl.append(body, 2);
    expect(e.seq).toBe(1);
  });

  it("all() returns [] only for ENOENT; other I/O errors propagate", async () => {
    expect(await new JsonlEventLog("none", dir).all()).toEqual([]);
    await mkdir(path.join(dir, "d1.jsonl"));
    await expect(new JsonlEventLog("d1", dir).all()).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("ignores a truncated final line but rejects a malformed middle line", async () => {
    const good = JSON.stringify({ ...body, seq: 1, ts: 1, sessionId: "t1" });
    await writeFile(path.join(dir, "t1.jsonl"), good + "\n" + '{"type":"sess', "utf8");
    expect(await new JsonlEventLog("t1", dir).all()).toHaveLength(1);
    await writeFile(path.join(dir, "t2.jsonl"), good + "\n{bad\n" + good + "\n", "utf8");
    await expect(new JsonlEventLog("t2", dir).all()).rejects.toThrow(/t2\.jsonl.*line 2/);
  });

  it("rejects unsafe session ids", () => {
    expect(() => new JsonlEventLog("../x", dir)).toThrow();
    expect(() => new JsonlEventLog("a/b", dir)).toThrow();
    expect(() => new JsonlEventLog("", dir)).toThrow();
  });

  const ev = (seq: number) => JSON.stringify({ ...body, seq, ts: seq, sessionId: "tr" });

  it("repairs a truncated tail before appending (a), keeps appending (b), reopens at right seq (c)", async () => {
    const file = path.join(dir, "tr.jsonl");
    await writeFile(file, ev(1) + "\n" + ev(2) + "\n" + '{"garbage', "utf8");
    const jl = new JsonlEventLog("tr", dir);
    const e3 = await jl.append(body, 3);
    expect(e3.seq).toBe(3);
    expect((await jl.all()).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(await readFile(file, "utf8")).not.toContain("garbage");
    await jl.append(body, 4);
    expect((await jl.all()).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const reopened = new JsonlEventLog("tr", dir);
    expect((await reopened.append(body, 5)).seq).toBe(5);
    expect((await reopened.all()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("repairs a valid last line that lacks a trailing newline", async () => {
    await writeFile(path.join(dir, "tr.jsonl"), ev(1) + "\n" + ev(2), "utf8");
    const jl = new JsonlEventLog("tr", dir);
    await jl.append(body, 3);
    expect((await jl.all()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("re-scans after a failed write so a partial line cannot merge with the next event", async () => {
    const file = path.join(dir, "tr.jsonl");
    const jl = new JsonlEventLog("tr", dir);
    await jl.append(body, 1);
    await appendFile(file, '{"partial', "utf8"); // simulate a partial write left behind
    (jl as unknown as { seq: number | null }).seq = null; // state after a failed append
    await jl.append(body, 2);
    expect((await jl.all()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("still throws a clear error for a malformed non-final line (d)", async () => {
    await writeFile(path.join(dir, "tr.jsonl"), ev(1) + "\n{bad\n" + ev(3) + "\n", "utf8");
    const jl = new JsonlEventLog("tr", dir);
    await expect(jl.append(body, 4)).rejects.toThrow(/tr\.jsonl at line 2/);
    await expect(jl.all()).rejects.toThrow(/tr\.jsonl at line 2/);
  });
});

describe("BUG-0005: pause freezes the scene clock", () => {
  const minute = 60_000;
  it("a pause with a pending inject and a running time box: nothing fires, resume keeps the remaining time exactly", async () => {
    clock.advance(30_000);
    await engine.command({ command: "pause" });
    clock.advance(10 * minute);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual([]);
    expect(engine.state.currentScene?.id).toBe("s1_open");
    expect(activeElapsedMs(engine.state, clock.now())).toBe(30_000);
    await engine.command({ command: "resume" });
    expect(activeElapsedMs(engine.state, clock.now())).toBe(30_000);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual([]); // the inject is due at 1:00 of active time, 30 s remain
    clock.advance(29_999); await engine.tick();
    expect(engine.state.injectsFired).toEqual([]);
    clock.advance(1); await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    clock.advance(minute - 1); await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
    clock.advance(1); await engine.tick(); // 2:00 active: time box ends
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("does not fire every overdue inject at once nor end the scene on /resume", async () => {
    await engine.command({ command: "pause" });
    clock.advance(10 * minute);
    await engine.command({ command: "resume" });
    await engine.tick();
    expect(engine.state.injectsFired).toEqual([]);
    expect(engine.state.currentScene?.id).toBe("s1_open");
  });

  it("repeated pause/resume accumulates paused time; a double pause or double resume changes nothing", async () => {
    clock.advance(10_000);
    await engine.command({ command: "pause" });
    clock.advance(5 * minute);
    await engine.command({ command: "pause" }); // already paused: pause time is still measured from the first pause
    clock.advance(minute);
    await engine.command({ command: "resume" });
    clock.advance(10_000);
    await engine.command({ command: "resume" }); // not paused: no effect
    clock.advance(10_000);
    await engine.command({ command: "pause" });
    clock.advance(2 * minute);
    await engine.command({ command: "resume" });
    expect(activeElapsedMs(engine.state, clock.now())).toBe(30_000);
    clock.advance(30_000); await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("pause before the first inject, immediately after the scene starts", async () => {
    await engine.command({ command: "pause" });
    clock.advance(minute);
    await engine.command({ command: "resume" });
    clock.advance(59_999); await engine.tick();
    expect(engine.state.injectsFired).toEqual([]);
    clock.advance(1); await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("a pending facilitator advance waits for resume, then takes effect", async () => {
    await engine.command({ command: "advance" });
    await engine.command({ command: "pause" });
    clock.advance(minute); await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
    await engine.command({ command: "resume" });
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("the new scene after an advance starts with a fresh clock", async () => {
    await engine.command({ command: "pause" });
    clock.advance(minute);
    await engine.command({ command: "resume" });
    await engine.command({ command: "advance" });
    clock.advance(5_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.currentScene?.pausedMs).toBe(0);
    expect(activeElapsedMs(engine.state, clock.now())).toBe(0);
    clock.advance(59_999); await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    clock.advance(1); await engine.tick();
    expect(engine.state.status).toBe("ended");
  });

  it("the remaining time is derivable from the LOGGED events alone (replay from a JsonlEventLog file)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-bug5-"));
    try {
      const jl = new JsonlEventLog("s-replay", dir);
      const eng = new SessionEngine({ scenario, log: jl, clock });
      await eng.start({ host: "participant-1" });
      clock.advance(20_000);
      await eng.command({ command: "pause" });
      clock.advance(3 * minute);
      await eng.command({ command: "resume" });
      clock.advance(5_000);
      let replay = initialState();
      for (const e of await new JsonlEventLog("s-replay", dir).all()) replay = reduce(replay, e);
      expect(activeElapsedMs(replay, clock.now())).toBe(25_000);
      expect(activeElapsedMs(replay, clock.now())).toBe(activeElapsedMs(eng.state, clock.now()));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  describe("release_hidden (US-0016)", () => {
    const FACT = "Sam is leaving the company next month";
    it("records a text-free command and then the fact in a facilitator-only npc.updated", async () => {
      await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
      const events = await log.all();
      const cmd = events.find((e) => e.type === "facilitator.command" && e.command === "release_hidden")!;
      expect(cmd).toMatchObject({ roleId: "guest", fact: 1 });
      expect(JSON.stringify(cmd)).not.toContain(FACT);
      const upd = events.at(-1)!;
      expect(upd).toMatchObject({ type: "npc.updated", roleId: "guest", released: [FACT] });
      expect(upd.seq).toBe(cmd.seq + 1);
      expect(engine.state.npcs.guest!.released).toEqual([FACT]);
      expect(engine.state.npcs.guest!.goals).toEqual(["Be welcomed"]);
    });

    it("is an error to release the same fact twice, and appends nothing", async () => {
      await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
      const n = (await log.all()).length;
      await expect(engine.command({ command: "release_hidden", roleId: "guest", fact: 1 })).rejects.toMatchObject({ code: "already_released" });
      expect(await log.all()).toHaveLength(n);
    });

    it.each([[0], [2], [-1], [1.5], [51], [Number.NaN]])("refuses fact number %s (unknown_fact)", async (fact) => {
      const n = (await log.all()).length;
      await expect(engine.command({ command: "release_hidden", roleId: "guest", fact })).rejects.toMatchObject({ code: "unknown_fact" });
      expect(await log.all()).toHaveLength(n);
    });

    it("refuses a player role, an unknown role and prototype keys as role ids", async () => {
      const n = (await log.all()).length;
      await expect(engine.command({ command: "release_hidden", roleId: "host", fact: 1 })).rejects.toMatchObject({ code: "npc_role" });
      await expect(engine.command({ command: "release_hidden", roleId: "ghost", fact: 1 })).rejects.toMatchObject({ code: "unknown_role" });
      for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
        await expect(engine.command({ command: "release_hidden", roleId: k, fact: 1 })).rejects.toMatchObject({ code: "unknown_role" });
        await expect(engine.command({ command: "whisper", roleId: k, text: "x" })).rejects.toMatchObject({ code: "unknown_role" });
        await expect(engine.command({ command: "set_npc_stance", roleId: k, goals: [] })).rejects.toMatchObject({ code: "unknown_role" });
      }
      expect(await log.all()).toHaveLength(n);
    });

    it("works while paused (it takes effect on the next turn)", async () => {
      await engine.command({ command: "pause" });
      await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
      expect(engine.state.paused).toBe(true);
      expect(engine.state.npcs.guest!.released).toEqual([FACT]);
    });

    it("keeps the released fact when an inject later updates the character", async () => {
      await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
      clock.advance(61_000);
      await engine.tick();
      expect(engine.state.npcs.guest!.goals).toContain("Leave early");
      expect(engine.state.npcs.guest!.released).toEqual([FACT]);
    });

    it("honours expectSceneId like every command", async () => {
      await expect(engine.command({ command: "release_hidden", roleId: "guest", fact: 1 }, { expectSceneId: "s2_close" })).rejects.toMatchObject({ code: "stale_scene" });
      expect(engine.state.npcs.guest!.released).toEqual([]);
    });

    it("a second concurrent release of the same fact loses with already_released", async () => {
      const results = await Promise.allSettled([
        engine.command({ command: "release_hidden", roleId: "guest", fact: 1 }),
        engine.command({ command: "release_hidden", roleId: "guest", fact: 1 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "already_released" });
      expect(engine.state.npcs.guest!.released).toEqual([FACT]);
    });

    it("replaying the log gives the same released facts", async () => {
      await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
      let s = initialState();
      for (const e of await log.all()) s = reduce(s, e);
      expect(s.npcs.guest!.released).toEqual([FACT]);
    });
  });
});
