import { describe, expect, it } from "vitest";
import { DEFAULT_TURN_SETTINGS, TurnPolicy, type PolicyEvent } from "../turn-policy.js";

const S = DEFAULT_TURN_SETTINGS;
const ME = "bot-a";

function make(roleId = ME) {
  const clock = { t: 1_000_000 };
  const p = new TurnPolicy({ roleId, settings: S, now: () => clock.t });
  return { p, clock, adv: (ms: number) => { clock.t += ms; } };
}
/** A policy that is started, in scene s1 with the bot a participant. */
function inScene(roleId = ME) {
  const m = make(roleId);
  m.p.observe({ kind: "started" });
  m.p.observe({ kind: "scene", sceneId: "s1", participants: [roleId, "npc", "human"] });
  return m;
}
const human = (): PolicyEvent => ({ kind: "line", roleId: "human", ai: false });
const npc = (): PolicyEvent => ({ kind: "line", roleId: "npc", ai: false });

describe("TurnPolicy reply", () => {
  it("a human line makes a reply due after 6 s, not before", () => {
    const { p, adv } = inScene();
    p.observe(human());
    adv(S.settleMs - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).toEqual({ trigger: "reply" });
  });

  it("a second NPC line inside the settle window moves the due time", () => {
    const { p, adv } = inScene();
    p.observe(human());
    adv(4_000);
    p.observe(npc());
    adv(4_000);
    expect(p.due()).toBeNull();
    adv(2_000);
    expect(p.due()).toEqual({ trigger: "reply" });
  });

  it("an AI player line (another bot) never makes a reply due", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "line", roleId: "bot-b", ai: true });
    adv(10 * S.nudgeMs);
    expect(p.due()).toBeNull();
    expect(p.wakeAt()).toBeNull();
  });

  it("the bot's own line never makes a reply due", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "line", roleId: ME, ai: true });
    p.observe({ kind: "line", roleId: ME, ai: false });
    adv(10 * S.nudgeMs);
    expect(p.due()).toBeNull();
  });

  it("a replayed human line never makes a reply due and moves nothing", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    adv(1_000);
    p.observe({ kind: "line", roleId: "human", ai: false, replayed: true });
    adv(S.settleMs);
    expect(p.due()).toBeNull();
    // the quiet clock still counts from the scene start, not from the replayed line
    adv(S.nudgeMs - S.settleMs - 1_000);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });

  it("the 15 s gap after its own line holds a reply back", () => {
    const { p, adv } = inScene();
    p.observe(human());
    adv(S.settleMs);
    const t = p.begin("reply")!;
    p.finish(t, true);
    p.observe(human());
    adv(S.settleMs);
    expect(p.due()).toBeNull();
    adv(S.minGapMs - S.settleMs - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).toEqual({ trigger: "reply" });
  });

  it("after 10 spoken lines in a scene nothing is due until the next scene", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    for (let i = 0; i < S.linesPerScene; i++) {
      p.observe(human());
      adv(S.minGapMs);
      const t = p.begin("reply")!;
      expect(t).not.toBeNull();
      p.finish(t, true);
    }
    expect(p.linesThisScene).toBe(10);
    p.observe(human());
    adv(10 * S.nudgeMs);
    expect(p.due()).toBeNull();
    expect(p.wakeAt()).toBeNull();
    p.observe({ kind: "scene", sceneId: "s2", participants: [ME, "human"] });
    expect(p.linesThisScene).toBe(0);
    p.observe(human());
    adv(S.settleMs);
    expect(p.due()).toEqual({ trigger: "reply" });
  });

  it("a skipped reply (spoke false) consumes the pending reply and does not spin", () => {
    const { p, adv } = inScene();
    p.observe(human());
    adv(S.settleMs);
    const t = p.begin("reply")!;
    p.finish(t, false);
    expect(p.inFlight).toBe(false);
    expect(p.due()).toBeNull();
    expect(p.linesThisScene).toBe(0);
  });
});

describe("TurnPolicy nudge", () => {
  it("a nudge is due after 90 s of quiet only while a human is connected", () => {
    const { p, adv } = inScene();
    adv(S.nudgeMs);
    expect(p.due()).toBeNull();
    p.observe({ kind: "humans", connected: true });
    expect(p.due()).toBeNull(); // the quiet clock restarts when the human becomes ready
    adv(S.nudgeMs);
    expect(p.due()).toEqual({ trigger: "nudge" });
    p.observe({ kind: "humans", connected: false });
    expect(p.due()).toBeNull();
  });

  it("a line inside the quiet spell moves the nudge", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    adv(S.nudgeMs - 1);
    p.observe({ kind: "line", roleId: "bot-b", ai: true });
    adv(S.nudgeMs - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });

  it("no nudge with humans connected false, and none before the start", () => {
    const m = make();
    m.p.observe({ kind: "humans", connected: true });
    m.p.observe({ kind: "scene", sceneId: "s1", participants: [ME] });
    m.adv(10 * S.nudgeMs);
    expect(m.p.due()).toBeNull();
    expect(m.p.begin("prompt")).toBeNull();
    const n = inScene();
    n.adv(10 * S.nudgeMs);
    expect(n.p.due()).toBeNull();
    expect(n.p.wakeAt()).toBeNull();
  });

  it("a pending reply blocks the nudge, and a skipped nudge restarts the quiet clock", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    adv(S.nudgeMs - 1_000);
    p.observe(human());
    adv(S.settleMs);
    expect(p.due()).toEqual({ trigger: "reply" });
    p.finish(p.begin("reply")!, true);
    adv(S.nudgeMs);
    const t = p.begin("nudge")!;
    p.finish(t, false);
    expect(p.due()).toBeNull();
    adv(S.nudgeMs);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });
});

describe("TurnPolicy scene, pause, end, reset", () => {
  it("not started, and a scene without the bot, are not active", () => {
    const a = make();
    a.p.observe({ kind: "scene", sceneId: "s1", participants: [ME] });
    a.p.observe(human());
    a.adv(S.settleMs);
    expect(a.p.due()).toBeNull();
    expect(a.p.begin("prompt")).toBeNull();

    const b = make();
    b.p.observe({ kind: "started" });
    b.p.observe({ kind: "scene", sceneId: "s1", participants: ["npc", "human"] });
    b.p.observe({ kind: "humans", connected: true });
    b.p.observe(human());
    b.adv(S.settleMs);
    expect(b.p.due()).toBeNull();
    expect(b.p.begin("prompt")).toBeNull();
    // joining a later scene does not resurrect a reply from the earlier one
    b.p.observe({ kind: "scene", sceneId: "s2", participants: [ME] });
    b.adv(S.settleMs);
    expect(b.p.due()).toBeNull();
  });

  it("pause, scene change, end and reset make an in-flight ticket stale (isCurrent false)", () => {
    const events: Array<[string, (p: TurnPolicy) => void]> = [
      ["pause", (p) => p.observe({ kind: "paused" })],
      ["scene", (p) => p.observe({ kind: "scene", sceneId: "s2", participants: [ME] })],
      ["end", (p) => p.observe({ kind: "ended" })],
      ["reset", (p) => p.reset()],
    ];
    for (const [name, act] of events) {
      const { p } = inScene();
      const t = p.begin("prompt")!;
      expect(p.isCurrent(t), name).toBe(true);
      act(p);
      expect(p.isCurrent(t), name).toBe(false);
      expect(p.inFlight, name).toBe(false);
    }
  });

  it("a stale ticket finishing with spoke true changes nothing", () => {
    const { p, adv } = inScene();
    p.observe(human());
    adv(S.settleMs);
    const t = p.begin("reply")!;
    p.observe({ kind: "paused" });
    p.observe({ kind: "resumed" });
    p.observe(human());
    const t2 = p.begin("prompt")!; // a new turn is in flight
    p.finish(t, true);
    expect(p.linesThisScene).toBe(0);
    expect(p.inFlight).toBe(true); // the stale finish did not free the new turn
    expect(p.isCurrent(t2)).toBe(true);
    p.finish(t2, false);
    adv(S.settleMs);
    expect(p.due()).toEqual({ trigger: "reply" }); // pending untouched by the stale finish, and no gap was recorded
  });

  it("a ticket finishing twice counts once", () => {
    const { p } = inScene();
    const t = p.begin("prompt")!;
    p.finish(t, true);
    p.finish(t, true);
    expect(p.linesThisScene).toBe(1);
  });

  it("begin refuses while a turn is in flight", () => {
    const { p } = inScene();
    expect(p.begin("prompt")).not.toBeNull();
    expect(p.begin("prompt")).toBeNull();
    expect(p.begin("reply")).toBeNull();
  });

  it("after resume the nudge counts from the resume and the earlier reply trigger is gone", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    p.observe(human());
    p.observe({ kind: "paused" });
    adv(10 * S.nudgeMs);
    expect(p.due()).toBeNull();
    p.observe({ kind: "resumed" });
    adv(S.settleMs);
    expect(p.due()).toBeNull(); // no reply from before the pause
    adv(S.nudgeMs - S.settleMs - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });

  it("ended and reset stop everything; a new start after reset begins clean", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    p.observe(human());
    p.observe({ kind: "ended" });
    adv(10 * S.nudgeMs);
    expect(p.due()).toBeNull();
    expect(p.begin("prompt")).toBeNull();
    p.reset();
    p.observe({ kind: "started" });
    p.observe({ kind: "scene", sceneId: "s1", participants: [ME] });
    p.observe({ kind: "humans", connected: true });
    expect(p.due()).toBeNull();
    adv(S.nudgeMs);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });
});

describe("TurnPolicy held and prompt", () => {
  it("while held, neither reply nor nudge is due and begin(reply) is null, but begin(prompt) works", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    p.observe(human());
    adv(S.nudgeMs);
    expect(p.due()).toEqual({ trigger: "reply" });
    p.setHeld(true);
    expect(p.due()).toBeNull();
    expect(p.wakeAt()).toBeNull();
    expect(p.begin("reply")).toBeNull();
    expect(p.begin("nudge")).toBeNull();
    const t = p.begin("prompt");
    expect(t).not.toBeNull();
    p.finish(t!, true);
    p.setHeld(false);
    expect(p.inFlight).toBe(false);
  });

  it("begin(prompt) ignores the gap, the cap and the nudge but not pause or not-in-scene", () => {
    const { p } = inScene();
    for (let i = 0; i < S.linesPerScene + 2; i++) {
      const t = p.begin("prompt");
      expect(t).not.toBeNull(); // no gap between them, and past the cap
      p.finish(t!, true);
    }
    expect(p.begin("prompt")?.trigger).toBe("prompt");
    p.observe({ kind: "paused" });
    expect(p.begin("prompt")).toBeNull();
    p.observe({ kind: "resumed" });
    expect(p.begin("prompt")).not.toBeNull();
    const other = make();
    other.p.observe({ kind: "started" });
    other.p.observe({ kind: "scene", sceneId: "s", participants: ["x"] });
    expect(other.p.begin("prompt")).toBeNull();
  });

  it("a prompted line counts toward linesThisScene and starts the gap", () => {
    const { p, adv } = inScene();
    p.finish(p.begin("prompt")!, true);
    expect(p.linesThisScene).toBe(1);
    p.observe(human());
    adv(S.settleMs);
    expect(p.due()).toBeNull(); // gap
    adv(S.minGapMs);
    expect(p.due()).toEqual({ trigger: "reply" });
  });
});

describe("TurnPolicy wakeAt", () => {
  it("wakeAt is the settle deadline, then the gap deadline", () => {
    const { p, clock, adv } = inScene();
    p.finish(p.begin("prompt")!, true);
    const spokeAt = clock.t;
    adv(1_000);
    p.observe(human());
    const lineAt = clock.t;
    // the gap (15 s after the prompt) is later than the settle (6 s after the line)
    expect(p.wakeAt()).toBe(spokeAt + S.minGapMs);
    adv(20_000);
    p.observe(human());
    expect(p.wakeAt()).toBe(clock.t + S.settleMs); // now the settle is the later one
    expect(lineAt).toBeLessThan(clock.t);
  });

  it("wakeAt is never earlier than now unless due, and due() flips exactly at it", () => {
    const { p, clock, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    expect(p.wakeAt()).toBe(clock.t + S.nudgeMs);
    p.observe(human());
    const w = p.wakeAt()!;
    expect(w).toBeGreaterThan(clock.t);
    expect(p.due()).toBeNull();
    adv(w - clock.t - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).not.toBeNull();
    expect(p.wakeAt()!).toBeLessThanOrEqual(clock.t);
    adv(5_000);
    expect(p.wakeAt()!).toBeLessThanOrEqual(clock.t); // still due: a past value, not null
  });

  it("wakeAt is null with nothing pending and no human, while in flight, and when inactive", () => {
    const { p } = inScene();
    expect(p.wakeAt()).toBeNull();
    p.observe({ kind: "humans", connected: true });
    expect(p.wakeAt()).not.toBeNull();
    const t = p.begin("prompt")!;
    expect(p.wakeAt()).toBeNull();
    p.finish(t, false);
    p.observe({ kind: "paused" });
    expect(p.wakeAt()).toBeNull();
  });
});

describe("TurnPolicy replay seeding", () => {
  const own = (): PolicyEvent => ({ kind: "line", roleId: ME, ai: true, replayed: true });

  it("a rejoin that replays 4 own lines leaves linesThisScene 4 and the gap holds", () => {
    const m = make();
    m.p.observe({ kind: "started" });
    m.p.observe({ kind: "scene", sceneId: "s1", participants: [ME, "human"] });
    for (let i = 0; i < 4; i++) m.p.observe(own());
    expect(m.p.linesThisScene).toBe(4);
    m.p.observe(human());
    m.adv(S.settleMs);
    expect(m.p.due()).toBeNull();
    m.adv(S.minGapMs - S.settleMs);
    expect(m.p.due()).toEqual({ trigger: "reply" });
  });

  it("a replay of 10 own lines means nothing is due until the next scene", () => {
    const m = make();
    m.p.observe({ kind: "started" });
    m.p.observe({ kind: "scene", sceneId: "s1", participants: [ME, "human"] });
    m.p.observe({ kind: "humans", connected: true });
    for (let i = 0; i < 10; i++) m.p.observe(own());
    m.p.observe(human());
    m.adv(10 * S.nudgeMs);
    expect(m.p.due()).toBeNull();
    expect(m.p.wakeAt()).toBeNull();
    m.p.observe({ kind: "scene", sceneId: "s2", participants: [ME, "human"] });
    m.p.observe(human());
    m.adv(S.settleMs);
    expect(m.p.due()).toEqual({ trigger: "reply" });
  });

  it("replayed lines of another role or a human seed nothing, and neither do own lines before any scene", () => {
    const m = make();
    m.p.observe({ kind: "started" });
    m.p.observe(own());
    m.p.observe({ kind: "scene", sceneId: "s1", participants: [ME, "human"] });
    expect(m.p.linesThisScene).toBe(0);
    m.p.observe({ kind: "line", roleId: "bot-b", ai: true, replayed: true });
    m.p.observe({ kind: "line", roleId: "human", ai: false, replayed: true });
    m.p.observe({ kind: "line", roleId: "npc", ai: false, replayed: true });
    expect(m.p.linesThisScene).toBe(0);
    m.p.observe(human());
    m.adv(S.settleMs);
    expect(m.p.due()).toEqual({ trigger: "reply" }); // no gap was seeded
  });

  it("own replayed lines in a scene the bot is not in seed nothing", () => {
    const m = make();
    m.p.observe({ kind: "started" });
    m.p.observe({ kind: "scene", sceneId: "s1", participants: ["human"] });
    m.p.observe(own());
    expect(m.p.linesThisScene).toBe(0);
  });
});

describe("TurnPolicy simulation", () => {
  /** A fake room: bots A and B plus NPC lines. Steps the clock to each wake time. After a bot line, an NPC line follows
   *  while `npcBudget` lasts. Records every bot turn that began although the only line since the bot's own last turn
   *  came from an AI player (a bot triggered by a bot). */
  function room(npcBudget: number, humans: boolean) {
    const clock = { t: 5_000_000 };
    const ids = ["bot-a", "bot-b"];
    const bots = ids.map((id) => new TurnPolicy({ roleId: id, settings: S, now: () => clock.t }));
    const spoken = [0, 0];
    const sawNonAi = [false, false]; // a human/NPC line since this bot's last turn
    const botTriggered: number[] = [];
    const emit = (e: PolicyEvent) => {
      for (const b of bots) b.observe(e);
      if (e.kind === "line" && !e.ai) sawNonAi.fill(true);
    };
    emit({ kind: "started" });
    emit({ kind: "scene", sceneId: "s1", participants: [...ids, "npc", "human"] });
    emit({ kind: "humans", connected: humans });
    emit({ kind: "line", roleId: "human", ai: false });
    let npc = npcBudget;
    for (let guard = 0; guard < 500; guard++) {
      const wakes = bots.map((b) => b.wakeAt()).filter((w): w is number => w !== null);
      if (wakes.length === 0) break;
      clock.t = Math.max(clock.t, Math.min(...wakes));
      const i = bots.findIndex((b) => b.due() !== null);
      if (i < 0) continue;
      const bot = bots[i]!;
      const d = bot.due()!;
      if (d.trigger === "reply" && !sawNonAi[i]) botTriggered.push(i);
      sawNonAi[i] = false;
      bot.finish(bot.begin(d.trigger)!, true);
      spoken[i]! += 1;
      emit({ kind: "line", roleId: ids[i]!, ai: true });
      if (npc > 0) { npc -= 1; clock.t += 1_000; emit({ kind: "line", roleId: "npc", ai: false }); }
    }
    return { bots, spoken, botTriggered };
  }

  it("two bots and NPCs reach the scene cap and stop, never triggered by each other", () => {
    const { bots, spoken, botTriggered } = room(Infinity, false);
    expect(spoken).toEqual([S.linesPerScene, S.linesPerScene]);
    expect(bots.map((b) => b.linesThisScene)).toEqual([10, 10]);
    expect(botTriggered).toEqual([]);
    expect(bots.map((b) => b.wakeAt())).toEqual([null, null]);
    expect(bots.map((b) => b.due())).toEqual([null, null]);
  });

  it("an NPC that answers only once, with no humans connected, lets the bots speak three lines in all and stop", () => {
    // human line -> A and B pending; A speaks; NPC answers once -> A pending again; B speaks; A speaks; then silence
    const { spoken, botTriggered, bots } = room(1, false);
    expect(spoken).toEqual([2, 1]);
    expect(botTriggered).toEqual([]);
    expect(bots.map((b) => b.wakeAt())).toEqual([null, null]);
  });

  it("two bots alone (no NPC, no human) speak exactly once each after one human line", () => {
    const { spoken, botTriggered, bots } = room(0, false);
    expect(spoken).toEqual([1, 1]);
    expect(botTriggered).toEqual([]);
    expect(bots.map((b) => b.wakeAt())).toEqual([null, null]);
  });
});

describe("TurnPolicy humans and the quiet clock", () => {
  it("humans becoming ready at t makes the nudge due at t + nudgeMs, not before", () => {
    const { p, adv } = inScene();
    adv(500_000);
    p.observe({ kind: "humans", connected: true });
    adv(S.nudgeMs - 1);
    expect(p.due()).toBeNull();
    adv(1);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });

  it("a repeated humans true does not move the nudge", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    adv(S.nudgeMs - 1_000);
    p.observe({ kind: "humans", connected: true });
    adv(1_000);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });

  it("a flap (false, then true) restarts the quiet clock", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "humans", connected: true });
    adv(S.nudgeMs - 1_000);
    p.observe({ kind: "humans", connected: false });
    p.observe({ kind: "humans", connected: true });
    adv(1_000);
    expect(p.due()).toBeNull();
    adv(S.nudgeMs - 1_000);
    expect(p.due()).toEqual({ trigger: "nudge" });
  });
});
