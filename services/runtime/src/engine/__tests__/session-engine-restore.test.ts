import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeElapsedMs, LOG_FORMAT, type SessionEvent } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { JsonlEventLog, MemoryEventLog, type EventLog } from "../event-log.js";
import { RestoreError, SessionEngine, type RestoreOutcome } from "../session-engine.js";
import { canonicalJson, scenarioHash } from "../scenario-hash.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const MIN = 60_000;
const T0 = 1_000_000;

let scenario: Scenario;
let dir: string;
beforeEach(async () => { scenario = await loadScenario(fixture); dir = await mkdtemp(path.join(os.tmpdir(), "acr-restore-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** Deterministic PRNG (mulberry32): the property test is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random facilitator commands, utterances, verdicts, NPC updates, alerts and clock moves (including backwards) against a live engine. */
async function randomSession(engine: SessionEngine, clock: FakeClock, seed: number, steps: number): Promise<void> {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  await engine.start({ host: "p1" });
  for (let i = 0; i < steps && engine.state.status === "running"; i++) {
    const op = Math.floor(r() * 12);
    try {
      if (op === 0) await engine.say("host", `line ${i}`);
      else if (op === 1) await engine.say("guest", `npc ${i}`, "text", { expectSceneId: engine.state.currentScene?.id });
      else if (op === 2) await engine.command({ command: "pause" });
      else if (op === 3) await engine.command({ command: "resume" });
      else if (op === 4) await engine.command({ command: pick(["advance", "pause", "resume"] as const) });
      else if (op === 5) await engine.command({ command: "whisper", roleId: "host", text: `w${i}` });
      else if (op === 6) await engine.recordGmVerdict("both parties have said hello", r() < 0.3, "why");
      else if (op === 7) await engine.updateNpc("guest", { goals: [`g${i}`] });
      else if (op === 8) await engine.alert(`a${i}`, pick(["info", "warning"] as const));
      else if (op === 11) await engine.command({ command: "release_hidden", roleId: "guest", fact: pick([1, 1, 2] as const) }); // 2 does not exist: refused
      else if (op === 9) { clock.advance(Math.floor(r() * 50_000) - 5_000); await engine.tick(); } // sometimes backwards
      else { clock.advance(Math.floor(r() * 3 * MIN)); await engine.tick(); }
    } catch { /* refusals (paused, not_in_scene, ended) are part of the property: they append nothing */ }
  }
}

describe("restore: replay equals live state (property)", () => {
  for (const kind of ["memory", "jsonl"] as const) {
    it(`for 40 random sessions on a ${kind} log, restore() rebuilds exactly the live state`, async () => {
      for (let seed = 1; seed <= 40; seed++) {
        const clock = new FakeClock(T0);
        const mk = (): EventLog => (kind === "memory" ? new MemoryEventLog("prop") : new JsonlEventLog(`prop${seed}`, dir, { sync: false }));
        const log = mk();
        const live = new SessionEngine({ scenario, log, clock });
        await randomSession(live, clock, seed, 60);
        const again = new SessionEngine({ scenario, log, clock: new FakeClock(T0) });
        const out = await again.restore();
        if (live.state.status === "ended") expect(out.kind, `seed ${seed}`).toBe("ended");
        else {
          expect(out.kind, `seed ${seed}`).toBe("running");
          expect(again.state, `seed ${seed}`).toEqual(live.state);
        }
        const events = await log.all();
        for (let i = 1; i < events.length; i++) expect(events[i]!.ts, `seed ${seed}: ts never goes back`).toBeGreaterThanOrEqual(events[i - 1]!.ts);
        await log.close?.();
      }
    }, 60_000); // 40 sessions: under a second normally, but no time limit is part of the property
  }
});

async function liveOn(log: EventLog, clock = new FakeClock(T0)) {
  const engine = new SessionEngine({ scenario, log, clock });
  await engine.start({ host: "p1" });
  return { engine, clock };
}

const restoreOf = async (log: EventLog, clock = new FakeClock(T0)): Promise<{ engine: SessionEngine; out: RestoreOutcome }> => {
  const engine = new SessionEngine({ scenario, log, clock });
  return { engine, out: await engine.restore() };
};

describe("restore outcomes", () => {
  it("an empty log is 'empty' and changes nothing", async () => {
    const { engine, out } = await restoreOf(new MemoryEventLog("e"));
    expect(out).toEqual({ kind: "empty" });
    expect(engine.state.status).toBe("idle");
  });

  it("an ended session is 'ended' and its state is not adopted", async () => {
    const log = new MemoryEventLog("x");
    const { engine } = await liveOn(log);
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    const r = await restoreOf(log);
    expect(r.out).toEqual({ kind: "ended", events: (await log.all()).length });
    expect(r.engine.state.status).toBe("idle");
  });

  it("new logs carry log format 1 and the scenario's sha256", async () => {
    const log = new MemoryEventLog("f");
    await liveOn(log);
    const first = (await log.all())[0]!;
    expect(first).toMatchObject({ type: "session.started", logFormat: LOG_FORMAT, scenarioHash: scenarioHash(scenario) });
    expect(scenarioHash(scenario)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("restore() only runs on a fresh engine, and start() refuses a restored one", async () => {
    const log = new MemoryEventLog("f");
    const { engine } = await liveOn(log);
    await expect(engine.restore()).rejects.toMatchObject({ code: "log_not_empty" });
    const r = await restoreOf(log);
    await expect(r.engine.start({})).rejects.toMatchObject({ code: "log_not_empty" });
  });
});

/** A log whose events are given as bodies (seq, ts and session id added). */
async function logOf(bodies: Record<string, unknown>[], id = "l"): Promise<MemoryEventLog> {
  const log = new MemoryEventLog(id);
  let ts = T0;
  for (const b of bodies) await log.append(b as never, ts++);
  return log;
}
const startedBody = (over: Record<string, unknown> = {}) => ({
  type: "session.started", scenarioId: scenario.meta.id, version: scenario.meta.version,
  roles: { host: { kind: "player", participantId: "p" }, guest: { kind: "npc" } }, logFormat: 1, scenarioHash: scenarioHash(scenario), ...over,
});
const entered = { type: "scene.entered", sceneId: "s1_open", participants: ["host", "guest"] };

describe("restore refuses what it cannot trust (fail closed, nothing appended)", () => {
  const refuses = async (bodies: Record<string, unknown>[], code: RestoreError["code"], msg: RegExp) => {
    const log = await logOf(bodies);
    const n = (await log.all()).length;
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(T0) });
    const err = await engine.restore().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err).toMatchObject({ code, message: expect.stringMatching(msg) });
    expect((await log.all()).length).toBe(n);
    expect(engine.state.status).toBe("idle");
  };

  it("a log that does not begin with session.started", () => refuses([entered], "not_a_session", /does not begin with session.started/));
  it("another scenario id", () => refuses([startedBody({ scenarioId: "other" }), entered], "scenario_mismatch", /different scenario/));
  it("another scenario version", () => refuses([startedBody({ version: "9.9" }), entered], "scenario_mismatch", /different scenario/));
  it("changed scenario files (format 1 hash)", () => refuses([startedBody({ scenarioHash: "0".repeat(64) }), entered], "scenario_mismatch", /sha256 differs/));
  it("a newer log format", () => refuses([startedBody({ logFormat: 2 }), entered], "log_format", /format 2, newer/));
  it.each([[-1], [1.5], ["1"]])("a format that is not a whole number (%j)", (f) => refuses([startedBody({ logFormat: f }), entered], "log_format", /not a whole number/));
  it("roles that do not match the scenario", () => refuses([startedBody({ roles: { host: { kind: "player" } } }), entered], "scenario_mismatch", /roles/));
  it("a role of the wrong kind", () => refuses([startedBody({ roles: { host: { kind: "npc" }, guest: { kind: "npc" } } }), entered], "scenario_mismatch", /roles/));
  it("a scene the scenario does not have", () => refuses([startedBody(), { ...entered, sceneId: "nope" }], "scenario_mismatch", /scene the scenario does not have/));
  it("a second session.started", () => refuses([startedBody(), entered, startedBody()], "invalid_log", /second session.started/));
});

describe("format 0 logs (written before US-0018)", () => {
  it("resume on a matching scenario id and version, and say so", async () => {
    const { logFormat: _f, scenarioHash: _h, ...v0 } = startedBody();
    void _f; void _h;
    const log = await logOf([v0, entered, { type: "utterance", roleId: "host", text: "hi", channel: "text" }]);
    const clock = new FakeClock(T0 + 10_000);
    const { engine, out } = await restoreOf(log, clock);
    expect(out).toMatchObject({ kind: "running", info: { format: 0, sceneId: "s1_open", pendingLine: true } });
    if (out.kind !== "running") return;
    await engine.markResumed(out.info);
    const alert = (await log.all()).find((e) => e.type === "facilitator.alert") as Extract<SessionEvent, { type: "facilitator.alert" }>;
    expect(alert.message).toMatch(/predates log format 1/);
    expect(alert.message).toMatch(/set up AI character guest/); // this hand-made log never initialised the AI character: completed
  });
});

describe("resume: paused, downtime counted as paused time, no overdue timer", () => {
  it("comes back paused with the remaining time it had; an inject due during the downtime fires at its ACTIVE minute, once", async () => {
    const log = new JsonlEventLog("t", dir, { sync: false });
    const { engine: live, clock } = await liveOn(log);
    clock.advance(40_000); await live.tick(); // 40 s of the 2 min time box used; the inject is due at 1:00
    await live.say("host", "before the crash");
    await log.close();
    // The server is down for 10 minutes (far past the inject and the time box).
    const clock2 = new FakeClock(clock.now() + 10 * MIN);
    const log2 = new JsonlEventLog("t", dir, { sync: false });
    const { engine, out } = await restoreOf(log2, clock2);
    expect(out.kind).toBe("running");
    if (out.kind !== "running") return;
    expect(out.info).toMatchObject({ wasPaused: false, sceneId: "s1_open", lastGmSeq: null, pendingLine: true, partialTailBytes: 0 });
    await engine.markResumed(out.info);
    expect(engine.state.paused).toBe(true);
    expect(activeElapsedMs(engine.state, clock2.now())).toBe(40_000);
    await engine.tick(); // paused: nothing
    expect(engine.state.injectsFired).toEqual([]);
    clock2.advance(5_000);
    await engine.command({ command: "resume" });
    expect(activeElapsedMs(engine.state, clock2.now())).toBe(40_000);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual([]); // nothing overdue fires on /resume
    expect(engine.state.currentScene?.id).toBe("s1_open"); // and the scene does not end on its time box
    clock2.advance(19_999); await engine.tick();
    expect(engine.state.injectsFired).toEqual([]);
    clock2.advance(1); await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    clock2.advance(MIN); await engine.tick(); await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    expect(engine.state.currentScene?.id).toBe("s2_close"); // 2:00 of active time
    const events = await log2.all();
    const resumed = events.find((e) => e.type === "session.resumed")!;
    expect(resumed).toMatchObject({ downFromTs: T0 + 40_000 });
    const alert = events.find((e) => e.type === "facilitator.alert")!;
    expect(alert).toMatchObject({ level: "warning", message: expect.stringMatching(/600 s after the last recorded event.*paused: \/resume to continue \(the last player line is then answered\)/) });
    await log2.close();
  });

  it("a session that was already paused keeps its own pause start", async () => {
    const log = new MemoryEventLog("p");
    const { engine: live, clock } = await liveOn(log);
    clock.advance(30_000); await live.command({ command: "pause" });
    clock.advance(20_000); await live.alert("x");
    const clock2 = new FakeClock(clock.now() + 5 * MIN);
    const { engine, out } = await restoreOf(log, clock2);
    if (out.kind !== "running") throw new Error("not running");
    expect(out.info.wasPaused).toBe(true);
    await engine.markResumed(out.info);
    expect(engine.state.pausedSince).toBe(T0 + 30_000);
    await engine.command({ command: "resume" });
    expect(activeElapsedMs(engine.state, clock2.now())).toBe(30_000);
  });

  it("a wall clock that went BACKWARDS across the restart: no ts goes back, no negative paused or active time", async () => {
    const log = new MemoryEventLog("b");
    const { engine: live, clock } = await liveOn(log);
    clock.advance(30_000); await live.say("host", "x");
    const clock2 = new FakeClock(T0 - 3_600_000); // an hour earlier than the session start
    const { engine, out } = await restoreOf(log, clock2);
    if (out.kind !== "running") throw new Error("not running");
    await engine.markResumed(out.info);
    await engine.command({ command: "resume" });
    const events = await log.all();
    for (let i = 1; i < events.length; i++) expect(events[i]!.ts).toBeGreaterThanOrEqual(events[i - 1]!.ts);
    expect(engine.state.currentScene!.pausedMs).toBe(0);
    expect(activeElapsedMs(engine.state, events.at(-1)!.ts)).toBe(30_000); // the engine reads time as max(clock, last ts)
    expect(activeElapsedMs(engine.state, clock2.now())).toBe(0); // and a raw earlier clock never gives a negative value
    const alert = events.find((e) => e.type === "facilitator.alert") as Extract<SessionEvent, { type: "facilitator.alert" }>;
    expect(alert.message).toMatch(/clock is 3630 s BEHIND the last recorded event \(it moved backwards\), so the downtime is unknown and counted as 0 s/);
    clock2.advance(3_600_000 + 60_000); await engine.tick(); // the clock catches up to 30 s after the last event: 60 s active, the inject is due
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });
});

describe("what restore() reports for the host", () => {
  it("pendingLine: the scene's last line is a player's and an AI character is present", async () => {
    const log = new MemoryEventLog("q");
    const { engine } = await liveOn(log);
    await engine.say("host", "hello?");
    expect((await restoreOf(log)).out).toMatchObject({ kind: "running", info: { pendingLine: true } });
    await engine.say("guest", "hello!");
    expect((await restoreOf(log)).out).toMatchObject({ kind: "running", info: { pendingLine: false } });
    await engine.command({ command: "advance" }); await engine.tick(); // scene 2: no line yet
    expect((await restoreOf(log)).out).toMatchObject({ kind: "running", info: { pendingLine: false, sceneId: "s2_close" } });
  });

  it("lastGmSeq: the last decision of the CURRENT scene only", async () => {
    const log = new MemoryEventLog("g");
    const { engine } = await liveOn(log);
    await engine.say("host", "a");
    await engine.recordGmVerdict("both parties have said hello", false, "no");
    const seq = engine.state.lastSeq;
    await engine.say("host", "b");
    expect((await restoreOf(log)).out).toMatchObject({ kind: "running", info: { lastGmSeq: seq } });
    await engine.command({ command: "advance" }); await engine.tick();
    expect((await restoreOf(log)).out).toMatchObject({ kind: "running", info: { lastGmSeq: null } });
  });

  it("partialTailBytes reports a cut-off last line, which the first append then cuts", async () => {
    const log = new JsonlEventLog("cut", dir, { sync: false });
    await liveOn(log);
    await log.close();
    const file = path.join(dir, "cut.jsonl");
    await writeFile(file, (await readFile(file, "utf8")) + '{"seq":99,"ty', "utf8");
    const log2 = new JsonlEventLog("cut", dir, { sync: false });
    const { engine, out } = await restoreOf(log2);
    expect(out).toMatchObject({ kind: "running", info: { partialTailBytes: 13 } });
    if (out.kind !== "running") return;
    await engine.markResumed(out.info);
    const text = await readFile(file, "utf8");
    expect(text).not.toContain('"ty\n');
    expect(text.endsWith("\n")).toBe(true);
    expect((await log2.all()).map((e) => e.seq)).toEqual(Array.from({ length: engine.state.lastSeq }, (_, i) => i + 1));
    expect((await log2.all()).at(-1)).toMatchObject({ type: "facilitator.alert", message: expect.stringMatching(/cut-off last line \(13 bytes/) });
    await log2.close();
  });
});

describe("scenario hash", () => {
  it("is independent of key order and sensitive to content", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe('{"a":[2,{"d":3}],"b":1}');
    const copy = JSON.parse(JSON.stringify(scenario)) as Scenario;
    expect(scenarioHash(copy)).toBe(scenarioHash(scenario));
    copy.meta.title += "!";
    expect(scenarioHash(copy)).not.toBe(scenarioHash(scenario));
  });
});

describe("released hidden facts across a restart (US-0016 + US-0018)", () => {
  const HIDDEN = "Sam is leaving the company next month";

  it("a released fact is still released after the restart; an unreleased one stays absent from state and from the player's snapshot", async () => {
    const { MockModelProvider } = await import("@acr/adapters");
    const { SessionHost } = await import("../../host/session-host.js");
    const { buildNpcRequest, SHARE_SECTION } = await import("../../agents/npc-prompt.js");
    const unreleased = new MemoryEventLog("u");
    const { engine: u1 } = await liveOn(unreleased);
    await u1.say("host", "hi");
    const released = new MemoryEventLog("r");
    const { engine: r1 } = await liveOn(released);
    await r1.say("host", "hi");
    await r1.command({ command: "release_hidden", roleId: "guest", fact: 1 });

    for (const [log, want] of [[released, true], [unreleased, false]] as const) {
      const { engine, out } = await restoreOf(log);
      if (out.kind !== "running") throw new Error("not running");
      await engine.markResumed(out.info);
      expect(engine.state.npcs.guest!.released.includes(HIDDEN)).toBe(want);
      const req = buildNpcRequest({ role: scenario.roles.guest as never, scene: engine.currentScene()!, state: engine.state, peers: [], allowSilence: false });
      const prompt = req.system + JSON.stringify(req.messages);
      expect(prompt.includes(SHARE_SECTION)).toBe(want);
      expect(prompt.includes(HIDDEN)).toBe(want);
      const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock: new FakeClock(T0) });
      host.resumeFrom(out.info);
      const snap = host.snapshotFor("host");
      expect(JSON.stringify(snap)).not.toContain(HIDDEN); // a rejoining player never gets hidden-fact text
      for (const e of await log.all()) expect(JSON.stringify(host.viewFor("host", e) ?? "")).not.toContain(HIDDEN);
    }
  });

  it("a crash between the release command and its npc.updated leaves a harmless orphan command; a retried release is accepted", async () => {
    const log = new MemoryEventLog("o");
    const { engine: live } = await liveOn(log);
    // The crash happened after the facilitator.command append and before the npc.updated append.
    await log.append({ type: "facilitator.command", command: "release_hidden", roleId: "guest", fact: 1 } as never, T0 + 1);
    void live;
    const { engine, out } = await restoreOf(log);
    if (out.kind !== "running") throw new Error("not running");
    expect(engine.state.npcs.guest!.released).toEqual([]);
    await engine.markResumed(out.info);
    await engine.command({ command: "resume" });
    await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
    expect(engine.state.npcs.guest!.released).toEqual([HIDDEN]);
    await expect(engine.command({ command: "release_hidden", roleId: "guest", fact: 1 })).rejects.toMatchObject({ code: "already_released" });
    const again = await restoreOf(log);
    expect(again.engine.state).toEqual(engine.state);
  });
});
