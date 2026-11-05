import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadScenario, type Scenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { SessionHost } from "../session-host.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const COND = "both parties have said hello";

/** A first life of the session, then a "restart": a new engine and host on the same log, restored and marked resumed. */
async function restartAfter(first: (engine: SessionEngine, host: SessionHost) => Promise<void>, o: { npc?: string[]; gm?: string[]; gmEveryN?: number } = {}) {
  const scenario: Scenario = await loadScenario(fixture);
  const log = new MemoryEventLog("s");
  const clock = new FakeClock(1_000);
  const e1 = new SessionEngine({ scenario, log, clock });
  const h1 = new SessionHost({ scenario, engine: e1, npcProvider: new MockModelProvider(["first life"]), gmProvider: new MockModelProvider(), clock, gmEveryN: o.gmEveryN });
  h1.join("host", "p1");
  await h1.start();
  await first(e1, h1);
  await h1.idle();
  const engine = new SessionEngine({ scenario, log, clock });
  const npc = new MockModelProvider(o.npc ?? ["answered after the restart"]);
  const gm = new MockModelProvider(o.gm ?? []);
  const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: gm, clock, gmEveryN: o.gmEveryN });
  const out = await engine.restore();
  if (out.kind !== "running") throw new Error(`expected a running session, got ${out.kind}`);
  await engine.markResumed(out.info);
  host.resumeFrom(out.info);
  return { engine, host, npc, gm, log, info: out.info };
}

describe("SessionHost after a restart (US-0018)", () => {
  it("is started (no second session.started), paused, and its roles are claimable again", async () => {
    const { engine, host, log } = await restartAfter(async () => {});
    expect(engine.state.paused).toBe(true);
    await host.start();
    expect((await log.all()).filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(host.assignments).toEqual({});
    expect(host.join("host", "someone-new").brief).toMatch(/hosting/);
  });

  it("answers the one unanswered player line exactly once, on /resume, with an info alert", async () => {
    const { engine, host, npc, log } = await restartAfter(async (e1) => { await e1.say("host", "Is anyone there?"); });
    expect(host.pendingAnswerScene).toBe("s1_open");
    await host.idle();
    expect(npc.calls).toHaveLength(0); // nothing before /resume
    await host.command({ command: "resume" });
    await host.idle();
    expect(npc.calls).toHaveLength(1);
    expect(engine.state.transcript.map((u) => `${u.roleId}:${u.text}`)).toEqual(["host:Is anyone there?", "guest:answered after the restart"]);
    const alerts = (await log.all()).filter((e): e is Extract<SessionEvent, { type: "facilitator.alert" }> => e.type === "facilitator.alert");
    expect(alerts.map((a) => a.message)).toContainEqual("answering the last player line from before the restart");
    await host.command({ command: "pause" });
    await host.command({ command: "resume" });
    await host.idle();
    expect(npc.calls).toHaveLength(1); // never answered twice
    expect(host.pendingAnswerScene).toBeNull();
  });

  it("answers nothing when the last line was already answered, or the facilitator moved to another scene first", async () => {
    const answered = await restartAfter(async (e1, h1) => { await h1.onPlayerUtterance("host", "hi"); await h1.idle(); void e1; });
    expect(answered.info.pendingLine).toBe(false);
    await answered.host.command({ command: "resume" });
    await answered.host.idle();
    expect(answered.npc.calls).toHaveLength(0);

    const moved = await restartAfter(async (e1) => { await e1.say("host", "unanswered"); });
    await moved.host.command({ command: "advance" }); // while paused: the scene moves on at the first tick after /resume
    await moved.host.command({ command: "resume" });
    await moved.host.idle();
    expect(moved.engine.state.currentScene?.id).toBe("s2_close");
    expect(moved.npc.calls).toHaveLength(0);
  });

  it("the Game Master continues from the log: an evaluation lost in the crash runs again at the next cadence tick, a finished one does not repeat", async () => {
    // Three lines, then the GM judged (decision recorded): after the restart it waits for 3 NEW lines.
    const done = await restartAfter(async (e1) => {
      for (const t of ["a", "b"]) await e1.say("host", t);
      await e1.say("guest", "c");
      await e1.recordGmVerdict(COND, false, "not yet");
    }, { gm: ['{"reasoning": "r", "verdict": false}'] });
    await done.host.command({ command: "resume" });
    await done.host.idle();
    expect(done.gm.calls).toHaveLength(0);

    // Three lines and NO decision (the evaluation was in flight when the server died): judged right after /resume.
    const lost = await restartAfter(async (e1) => {
      for (const t of ["a", "b"]) await e1.say("host", t);
      await e1.say("guest", "c");
    }, { gm: ['{"reasoning": "both said hello", "verdict": true}'] });
    await lost.host.command({ command: "resume" });
    await lost.host.idle();
    expect(lost.gm.calls.length).toBeGreaterThan(0); // (the unstamped mock reply is re-asked once: the nonce rule)
  });

  it("players see that the session came back paused; a rejoining player gets its visible history in the snapshot (AC-0057)", async () => {
    const { host, log } = await restartAfter(async (e1) => { await e1.say("host", "my earlier line"); });
    const resumed = (await log.all()).find((e) => e.type === "session.resumed")!;
    expect(host.viewFor("host", resumed)).toEqual(resumed);
    const alert = (await log.all()).find((e) => e.type === "facilitator.alert")!;
    expect(host.viewFor("host", alert)).toBeNull();
    const snap = host.snapshotFor("host");
    expect(snap.paused).toBe(true);
    expect(snap.transcript.map((u) => u.text)).toEqual(["my earlier line"]);
    expect(snap.npcs).toEqual({});
  });
});
