import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import { loadScenario, type NpcRole, type Scenario } from "@acr/script";
import { FakeClock } from "../clock.js";
import { MemoryEventLog } from "../event-log.js";
import { SessionEngine, describeRepair } from "../session-engine.js";

// US-0034: the engine side of a Game Master release suggestion (gm.fact_earned) and of the opt-in GM_AUTO_RELEASE.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const FACT = "Sam is leaving the company next month";

async function scenarioWith(earned: Record<string, string> | undefined, hidden?: string[]): Promise<Scenario> {
  const sc = await loadScenario(fixture);
  const guest = sc.roles["guest"] as NpcRole;
  if (hidden) guest.hidden = hidden;
  if (earned) guest.earned_when = earned;
  return sc;
}

let log: MemoryEventLog; let engine: SessionEngine;
beforeEach(async () => {
  log = new MemoryEventLog("s");
  engine = new SessionEngine({ scenario: await scenarioWith({ "1": "a player asks whether Sam is staying" }), log, clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
});
const ofType = async (t: string) => (await log.all()).filter((e) => e.type === t);

describe("SessionEngine.recordFactEarned", () => {
  it("records one text-free gm.fact_earned and remembers it for the session", async () => {
    expect(await engine.recordFactEarned("guest", 1, "they asked", { via: "strict" })).toBe("suggested");
    const [e] = await ofType("gm.fact_earned");
    expect(e).toMatchObject({ type: "gm.fact_earned", sceneId: "s1_open", roleId: "guest", fact: 1, reasoning: "they asked", via: "strict" });
    expect(e).not.toHaveProperty("autoRelease");
    expect(JSON.stringify(await log.all())).not.toContain(FACT); // the fact text is in no event: nothing was released
    expect(engine.state.factsEarned).toEqual({ guest: [1] });
    expect(engine.state.npcs["guest"]!.released).toEqual([]); // suggest-only: nothing is released
  });

  it("never repeats a suggestion, in this scene or a later one", async () => {
    await engine.recordFactEarned("guest", 1, "r");
    expect(await engine.recordFactEarned("guest", 1, "again")).toBeNull();
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.currentScene()!.id).toBe("s2_close");
    expect(await engine.recordFactEarned("guest", 1, "later")).toBeNull();
    expect(await ofType("gm.fact_earned")).toHaveLength(1);
  });

  it("appends nothing for a fact that is already released, has no earned_when, does not exist, or for a role that is not an AI character in the scene", async () => {
    const n0 = (await log.all()).length;
    expect(await engine.recordFactEarned("host", 1, "r")).toBeNull(); // a player role
    expect(await engine.recordFactEarned("nobody", 1, "r")).toBeNull();
    expect(await engine.recordFactEarned("__proto__", 1, "r")).toBeNull();
    expect(await engine.recordFactEarned("guest", 2, "r")).toBeNull(); // no such fact
    expect(await engine.recordFactEarned("guest", 0, "r")).toBeNull();
    expect(await engine.recordFactEarned("guest", 1.5, "r")).toBeNull();
    expect((await log.all()).length).toBe(n0);
    await engine.command({ command: "release_hidden", roleId: "guest", fact: 1 });
    const n1 = (await log.all()).length;
    expect(await engine.recordFactEarned("guest", 1, "r")).toBeNull(); // already released by the facilitator
    expect((await log.all()).length).toBe(n1);
  });

  it("appends nothing for a fact without an earned_when condition", async () => {
    const l = new MemoryEventLog("t");
    const e = new SessionEngine({ scenario: await scenarioWith({ "2": "c" }, [FACT, "second fact"]), log: l, clock: new FakeClock(0) });
    await e.start({ host: "p1" });
    expect(await e.recordFactEarned("guest", 1, "r")).toBeNull();
    expect(await e.recordFactEarned("guest", 2, "r")).toBe("suggested");
  });

  it("refuses a stale scene, an ended session and a scene the character is not in", async () => {
    expect(await engine.recordFactEarned("guest", 1, "r", { expectSceneId: "s2_close" })).toBeNull();
    const sc = await scenarioWith({ "1": "c" });
    sc.script.scenes[0]!.participants = ["host"];
    const l = new MemoryEventLog("u");
    const e = new SessionEngine({ scenario: sc, log: l, clock: new FakeClock(0) });
    await e.start({ host: "p1" });
    expect(await e.recordFactEarned("guest", 1, "r")).toBeNull();
    await engine.command({ command: "advance" }); await engine.tick();
    await engine.command({ command: "advance" }); await engine.tick();
    expect(engine.state.status).toBe("ended");
    expect(await engine.recordFactEarned("guest", 1, "r")).toBeNull();
  });

  it("with autoRelease records the Game Master action, then the facilitator-only npc.updated with the text, and no facilitator.command", async () => {
    expect(await engine.recordFactEarned("guest", 1, "earned", { autoRelease: true })).toBe("released");
    const all = await log.all();
    const at = all.findIndex((e) => e.type === "gm.fact_earned");
    expect(all[at]).toMatchObject({ roleId: "guest", fact: 1, autoRelease: true });
    expect(JSON.stringify(all[at])).not.toContain(FACT);
    expect(all[at + 1]).toMatchObject({ type: "npc.updated", roleId: "guest", released: [FACT] });
    expect(all.some((e) => e.type === "facilitator.command")).toBe(false);
    expect(engine.state.npcs["guest"]!.released).toEqual([FACT]);
    expect(engine.state.factsEarned).toEqual({ guest: [1] });
    await expect(engine.command({ command: "release_hidden", roleId: "guest", fact: 1 })).rejects.toMatchObject({ code: "already_released" });
  });

  it("is recorded while paused (a verdict that was in flight), like a gm.decision", async () => {
    await engine.command({ command: "pause" });
    expect(await engine.recordFactEarned("guest", 1, "r")).toBe("suggested");
  });
});

describe("restore after a crash inside a Game Master auto-release", () => {
  it("completes the release (repair gm_release) and a second restart finds nothing to do", async () => {
    await engine.recordFactEarned("guest", 1, "r", { autoRelease: true });
    const all = await log.all();
    const cut = all.slice(0, all.findIndex((e) => e.type === "gm.fact_earned") + 1); // the npc.updated never reached the disk
    const l2 = new MemoryEventLog("s");
    for (const e of cut) { const { seq: _s, ts, sessionId: _i, ...body } = e; void _s; void _i; await l2.append(body as never, ts); }
    const sc = await scenarioWith({ "1": "a player asks whether Sam is staying" });
    const e2 = new SessionEngine({ scenario: sc, log: l2, clock: new FakeClock(10_000) });
    const out = await e2.restore();
    expect(out.kind).toBe("running");
    if (out.kind !== "running") return;
    expect(out.info.repairs).toEqual([{ kind: "gm_release", roleId: "guest", fact: 1 }]);
    expect(describeRepair(out.info.repairs[0]!)).toBe("released hidden fact 1 of guest (Game Master auto-release)");
    await e2.markResumed(out.info);
    expect(e2.state.npcs["guest"]!.released).toEqual([FACT]);
    const folded = (await l2.all()).reduce((s, e) => reduce(s, e), initialState());
    expect(e2.state).toEqual(folded);
    const e3 = new SessionEngine({ scenario: sc, log: l2, clock: new FakeClock(20_000) });
    const again = await e3.restore();
    expect(again.kind === "running" && again.info.repairs).toEqual([]);
  });

  it("a suggestion (no auto-release) survives a restart and is not repeated", async () => {
    await engine.recordFactEarned("guest", 1, "r");
    const e2 = new SessionEngine({ scenario: await scenarioWith({ "1": "a player asks whether Sam is staying" }), log, clock: new FakeClock(10_000) });
    const out = await e2.restore();
    expect(out.kind === "running" && out.info.repairs).toEqual([]);
    expect(e2.state.factsEarned).toEqual({ guest: [1] });
    expect(await e2.recordFactEarned("guest", 1, "again")).toBeNull();
  });

  it("counts a gm.fact_earned as the scene's last Game Master record (the evaluation cadence resumes after it)", async () => {
    await engine.say("host", "hi");
    await engine.recordFactEarned("guest", 1, "r");
    const e2 = new SessionEngine({ scenario: await scenarioWith({ "1": "a player asks whether Sam is staying" }), log, clock: new FakeClock(10_000) });
    const out = await e2.restore();
    const last = (await log.all()).at(-1) as SessionEvent;
    expect(out.kind === "running" && out.info.lastGmSeq).toBe(last.seq);
  });
});
