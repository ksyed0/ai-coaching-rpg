import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import type { Channel, SessionEvent } from "@acr/events";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster } from "../game-master.js";
import { stampNonce } from "../../demo/harness.js";
import { gmUnits } from "../../host/voice.js";
import { SessionHost } from "../../host/session-host.js";

// US-0070 (Task 8, AC-0400, spec 7.5, overview C7): the Game Master counts voice TURNS, not segments. A closed voice turn is one unit, a
// typed or AI line one unit each, an open turn none, and no evaluation runs while a turn is open. After a restart (no turn boundaries
// known for the lines before it) each run of consecutive voice lines counts one: fewer evaluations, never more.
const V = (seq: number) => ({ seq, channel: "voice" as Channel });
const T = (seq: number) => ({ seq, channel: "text" as Channel });

describe("gmUnits (US-0070)", () => {
  it("counts text lines one each", () => {
    expect(gmUnits([T(1), T(2), T(3)], [])).toBe(3);
    expect(gmUnits([], [])).toBe(0);
  });

  it("six voice segments in one closed turn count one", () => {
    expect(gmUnits([V(1), V(2), V(3), V(4), V(5), V(6)], [6], 0)).toBe(1);
  });

  it("two closed turns count two", () => {
    expect(gmUnits([V(1), V(2), V(3), V(4)], [2, 4], 0)).toBe(2);
  });

  it("an open turn counts zero", () => {
    expect(gmUnits([V(1), V(2)], [], 0)).toBe(0);
    expect(gmUnits([V(1), V(2), V(3)], [2], 0)).toBe(1); // V(3) is in the turn still open
  });

  it("NPC lines inside a voice turn count one each and do not split the turn", () => {
    expect(gmUnits([V(1), T(2), V(3), T(4), V(5)], [5], 0)).toBe(3);
  });

  it("a boundary past a turn's last line still closes only that turn; boundaries with no line in this scene count nothing", () => {
    expect(gmUnits([V(5), V(6)], [2, 9, 12], 0)).toBe(1);
  });

  it("with no boundaries consecutive voice runs count one each (the lines before a restart)", () => {
    expect(gmUnits([V(1), V(2), T(3), V(4), V(5), V(6), T(7), V(8)], [])).toBe(5);
  });

  it("lines up to knownFrom count by runs, later ones by turns, and the count never falls as boundaries arrive", () => {
    const lines = [V(1), V(2), T(3), V(4)];
    expect(gmUnits(lines, [], 4)).toBe(3);
    const more = [...lines, V(5), V(6)];
    expect(gmUnits(more, [], 4)).toBe(3); // the new turn is open
    expect(gmUnits(more, [6], 4)).toBe(4); // closed: one more
    expect(gmUnits([...more, V(7)], [6], 4)).toBe(4);
  });

  it("the count only rises while lines and boundaries are added in order (monotone)", () => {
    const lines: { seq: number; channel: Channel }[] = [];
    const ends: number[] = [];
    let last = 0;
    for (let seq = 1; seq <= 60; seq++) {
      lines.push((seq * 7) % 3 === 0 ? T(seq) : V(seq));
      if (seq % 5 === 0) ends.push(seq);
      const n = gmUnits(lines, ends, 20);
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });
});

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let log: MemoryEventLog;
beforeEach(async () => {
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log, clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
});

describe("GameMaster with units and hold (US-0070)", () => {
  it("with everyN 3, nine voice segments in three turns cause one evaluation, not three (spec 7.5)", async () => {
    const provider = new MockModelProvider();
    const ends: number[] = [];
    const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 3, reask: false, units: (l) => gmUnits(l, ends, 0) });
    for (let t = 0; t < 3; t++) {
      for (let s = 0; s < 3; s++) { await engine.say("host", `turn ${t} segment ${s}`, "voice"); await gm.tick(); }
      ends.push(engine.state.lastSeq);
      await gm.tick();
    }
    expect(provider.calls).toHaveLength(1);
  });

  it("the same nine segments without units would cause three (the default counts lines)", async () => {
    const provider = new MockModelProvider();
    const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 3, reask: false });
    for (let i = 0; i < 9; i++) { await engine.say("host", `segment ${i}`, "voice"); await gm.tick(); }
    expect(provider.calls).toHaveLength(3);
  });

  it("no evaluation while hold() is true, and the next tick after release evaluates", async () => {
    const provider = new MockModelProvider();
    let hold = true;
    const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 1, reask: false, hold: () => hold });
    await engine.say("host", "hello");
    await gm.tick();
    await gm.tick();
    expect(provider.calls).toHaveLength(0);
    expect(await gm.finalEvaluation()).toBe(false);
    hold = false;
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
  });

  it("hold does not stop engine.tick: a time box still exits the scene", async () => {
    const clock = new FakeClock(0);
    const eng = new SessionEngine({ scenario: await loadScenario(fixture), log: new MemoryEventLog("t"), clock });
    await eng.start({ host: "p1" });
    const gm = new GameMaster({ engine: eng, provider: new MockModelProvider(), everyNUtterances: 1, hold: () => true });
    clock.advance(3 * 60_000);
    await gm.tick();
    expect(eng.state.currentScene?.id).toBe("s2_close");
  });

  it("finalEvaluation counts units too", async () => {
    const provider = new MockModelProvider();
    const ends: number[] = [];
    const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 1, reask: false, units: (l) => gmUnits(l, ends, 0) });
    await engine.say("host", "typed", "text");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
    await engine.say("host", "open voice", "voice");
    expect(await gm.finalEvaluation()).toBe(false); // the voice turn is still open: nothing new counts
    ends.push(engine.state.lastSeq);
    expect(await gm.finalEvaluation()).toBe(true);
    expect(provider.calls).toHaveLength(2);
  });
});

describe("SessionHost restore counts units (US-0070)", () => {
  async function life(scenario: Scenario) {
    const log2 = new MemoryEventLog("r");
    const clock = new FakeClock(1_000);
    const e1 = new SessionEngine({ scenario, log: log2, clock });
    await e1.start({ host: "p1" });
    // Six voice segments, a Game Master decision, then two more segments: one run of voice lines after a restart.
    for (let i = 0; i < 6; i++) await e1.say("host", `segment ${i}`, "voice");
    const gm1 = new GameMaster({ engine: e1, provider: stampNonce(new MockModelProvider()), everyNUtterances: 1, reask: false });
    await gm1.tick();
    for (let i = 6; i < 8; i++) await e1.say("host", `segment ${i}`, "voice");
    const all = await log2.all();
    expect(all.some((e: SessionEvent) => e.type === "gm.no_verdict")).toBe(true);
    return { log2, clock };
  }

  it("restore uses units, so a restart does not count six segments as six evaluated lines", async () => {
    const scenario = await loadScenario(fixture);
    const { log2, clock } = await life(scenario);
    const eng = new SessionEngine({ scenario, log: log2, clock });
    const host = new SessionHost({ scenario, engine: eng, npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock, gmEveryN: 3, voice: { enabled: true, turnEndMs: 800 } });
    const out = await eng.restore();
    if (out.kind !== "running") throw new Error(out.kind);
    await eng.markResumed(out.info);
    host.resumeFrom(out.info);
    const gm = (host as unknown as { gm: { evaluatedCount: number } }).gm;
    expect(gm.evaluatedCount).toBe(1); // the run of six before the decision is one unit
  });

  it("a text-only session restores the line count unchanged", async () => {
    const scenario = await loadScenario(fixture);
    const { log2, clock } = await life(scenario);
    const eng = new SessionEngine({ scenario, log: log2, clock });
    const host = new SessionHost({ scenario, engine: eng, npcProvider: new MockModelProvider(), gmProvider: new MockModelProvider(), clock, gmEveryN: 3 });
    const out = await eng.restore();
    if (out.kind !== "running") throw new Error(out.kind);
    host.resumeFrom(out.info);
    expect((host as unknown as { gm: { evaluatedCount: number } }).gm.evaluatedCount).toBe(6);
  });
});
