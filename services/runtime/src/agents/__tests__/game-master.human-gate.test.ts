import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenario, type NpcRole } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster, GM_HUMAN_LINE_ALERT } from "../game-master.js";
import { stampNonce } from "../../demo/harness.js";
import { earnedCheckOf } from "../gm-prompt.js";

// US-0081 (AC-0474 to AC-0477, TC-0254 to TC-0257): the Game Master judges no exit condition (and no earned_when) of a scene until a HUMAN
// player seat has spoken in it, when the session has at least one human seat. Time box and facilitator advance are unchanged.
const here = path.dirname(fileURLToPath(import.meta.url));
const FRIDAY = path.join(here, "../../../../../scenarios/friday-escalation");
const MINIMAL = path.join(here, "../../../../../packages/script/src/__tests__/fixtures/minimal");
const TRUE = '{"reasoning": "met", "verdict": true}';

/** Friday escalation, scene 1 (delivery_lead, tech_lead, account_manager), with the given AI roles. */
async function friday(aiRoles: string[]) {
  const log = new MemoryEventLog("s");
  const clock = new FakeClock(0);
  const engine = new SessionEngine({ scenario: await loadScenario(FRIDAY), log, clock });
  await engine.start({ delivery_lead: "p1", tech_lead: "p2", account_manager: "p3" }, aiRoles.length > 0 ? { aiRoles } : undefined);
  const provider = new MockModelProvider();
  provider.defaultReply = TRUE;
  const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 2, reask: false });
  const alerts = async () => (await log.all()).filter((e) => e.type === "facilitator.alert" && (e as { message?: string }).message === GM_HUMAN_LINE_ALERT);
  return { engine, provider, gm, clock, log, alerts };
}

describe("GameMaster human-line gate (US-0081)", () => {
  it("test_game_master_ai_only_dialogue_is_never_judged_and_never_ends_the_scene", async () => {
    const { engine, provider, gm } = await friday(["delivery_lead", "tech_lead"]);
    const scene = engine.currentScene()!.id;
    for (let i = 0; i < 12; i++) { await engine.say(i % 2 ? "tech_lead" : "delivery_lead", `AI line ${i}`); await gm.tick(); }
    expect(await gm.finalEvaluation()).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(engine.state.currentScene?.id).toBe(scene);
    expect(Object.keys(engine.state.gmVerdicts)).toEqual([]);
  });

  it("test_game_master_first_human_line_opens_the_gate_at_once", async () => {
    const { engine, provider, gm } = await friday(["delivery_lead", "tech_lead"]);
    const scene = engine.currentScene()!.id;
    for (let i = 0; i < 4; i++) { await engine.say("tech_lead", `AI line ${i}`); await gm.tick(); }
    expect(provider.calls).toHaveLength(0);
    await engine.say("account_manager", "I think we should phase it after go-live.");
    await gm.tick(); // the lines held back count: the cadence is already due
    expect(provider.calls).toHaveLength(1);
    await gm.tick();
    expect(engine.state.currentScene?.id).not.toBe(scene); // the true verdict ended the scene
  });

  it("test_game_master_held_gate_raises_one_facilitator_alert_per_scene", async () => {
    const { engine, gm, alerts } = await friday(["delivery_lead", "tech_lead"]);
    for (let i = 0; i < 8; i++) { await engine.say("delivery_lead", `AI line ${i}`); await gm.tick(); }
    const got = await alerts();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ level: "info" });
  });

  it("test_game_master_no_alert_when_a_human_spoke_first", async () => {
    const { engine, provider, gm, alerts } = await friday(["delivery_lead", "tech_lead"]);
    await engine.say("account_manager", "Let us agree a position.");
    await engine.say("tech_lead", "Agreed.");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
    expect(await alerts()).toHaveLength(0);
  });

  it("test_game_master_session_without_a_human_seat_is_not_gated", async () => {
    const { engine, provider, gm } = await friday(["delivery_lead", "tech_lead", "account_manager"]);
    await engine.say("delivery_lead", "a");
    await engine.say("tech_lead", "b");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
  });

  it("test_game_master_session_without_ai_roles_judges_player_lines_as_before", async () => {
    const { engine, provider, gm } = await friday([]);
    await engine.say("delivery_lead", "a");
    await engine.say("tech_lead", "b");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
  });

  it("test_game_master_time_box_still_ends_a_gated_scene", async () => {
    const { engine, gm, clock } = await friday(["delivery_lead", "tech_lead"]);
    const scene = engine.currentScene()!;
    await engine.say("tech_lead", "AI only");
    clock.advance((scene.time_box_minutes + 1) * 60_000);
    await gm.tick();
    expect(engine.state.currentScene?.id).not.toBe(scene.id);
  });
});

/** Routes exit-condition and earned_when prompts apart (same idea as game-master.fact.test.ts). */
class Routed implements ModelProvider {
  readonly name = "routed";
  readonly kinds: ("exit" | "fact")[] = [];
  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.kinds.push(earnedCheckOf(req) ? "fact" : "exit");
    yield '{"reasoning": "no", "verdict": false}';
  }
}

describe("GameMaster earned_when behind the same gate (US-0081)", () => {
  it("test_game_master_ai_character_lines_alone_judge_no_earned_when_and_no_exit", async () => {
    const sc = await loadScenario(MINIMAL);
    const guest = sc.roles["guest"] as NpcRole;
    guest.hidden = ["Sam is leaving the company next month"];
    guest.earned_when = { "1": "a player asks whether Sam plans to stay" };
    const engine = new SessionEngine({ scenario: sc, log: new MemoryEventLog("m"), clock: new FakeClock(0) });
    await engine.start({ host: "p1" });
    const provider = new Routed();
    const gm = new GameMaster({ engine, provider: stampNonce(provider), everyNUtterances: 1, reask: false });
    for (let i = 0; i < 3; i++) { await engine.say("guest", `Sam says ${i}`); await gm.tick(); }
    expect(provider.kinds).toEqual([]);
    await engine.say("host", "Sam, are you staying?");
    await gm.tick();
    expect(provider.kinds).toEqual(["exit", "fact"]);
  });
});
