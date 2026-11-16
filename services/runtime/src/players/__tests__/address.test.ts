import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { ADDRESS_RULE } from "../../agents/address-prompt.js";
import { DEFAULT_TURN_SETTINGS, TurnPolicy, buildLiveRequest, generateLiveLine, parseAiPlayerSettings, type AiPlayerSettings, type PlayerView } from "../index.js";

// US-0082 (AC-0489, AC-0490, AC-0491): the live AI player and "@Role" addressing.

const S = DEFAULT_TURN_SETTINGS;
function inScene(roleId = "bot-a") {
  const clock = { t: 1_000_000 };
  const p = new TurnPolicy({ roleId, settings: S, now: () => clock.t });
  p.observe({ kind: "started" });
  p.observe({ kind: "scene", sceneId: "s1", participants: [roleId, "npc", "human", "other"] });
  return { p, adv: (ms: number) => { clock.t += ms; } };
}

describe("TurnPolicy with addressed lines", () => {
  it("test_policy_addressed_reply_skips_the_settle_wait", () => {
    const { p } = inScene();
    p.observe({ kind: "line", roleId: "human", ai: false, to: "bot-a" });
    expect(p.due()).toEqual({ trigger: "reply" }); // at once
  });
  it("test_policy_addressed_reply_still_respects_the_gap_and_the_cap", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "line", roleId: "human", ai: false });
    adv(S.settleMs);
    const t = p.begin("reply")!; p.finish(t, true); // spoke just now
    p.observe({ kind: "line", roleId: "human", ai: false, to: "bot-a" });
    expect(p.due()).toBeNull();
    adv(S.minGapMs);
    expect(p.due()).toEqual({ trigger: "reply" });
  });
  it("test_policy_line_addressed_to_someone_else_sets_no_reply", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "line", roleId: "human", ai: false, to: "other" });
    adv(S.settleMs * 3);
    expect(p.due()).toBeNull();
    // the conversation goes back to everyone: the usual reply is due again after the settle wait
    p.observe({ kind: "line", roleId: "human", ai: false });
    adv(S.settleMs);
    expect(p.due()).toEqual({ trigger: "reply" });
  });
  it("test_policy_never_reacts_to_another_ai_player_even_when_addressed", () => {
    const { p, adv } = inScene();
    p.observe({ kind: "line", roleId: "other", ai: true, to: "bot-a" });
    adv(S.settleMs * 3);
    expect(p.due()).toBeNull();
  });
});

let scenarioP: Promise<Scenario> | undefined;
const scenario = () => (scenarioP ??= loadScenario(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..", "scenarios", "friday-escalation")));
const parsed = parseAiPlayerSettings({});
if (!parsed.ok) throw new Error("defaults must parse");
const settings: AiPlayerSettings = { ...parsed.settings, firstTokenTimeoutMs: 600_000, replyTimeoutMs: 600_000, hardTimeoutMs: 60_000 };
const view = (over: Partial<PlayerView> = {}): PlayerView => ({
  roleId: "tech_lead", brief: "b", privateFacts: [], scene: { title: "Huddle", goal: "Agree" }, injects: [],
  lines: [{ roleId: "delivery_lead", text: "Can you size it?", to: "tech_lead" }], ...over,
});
const say = (text: string): ModelProvider => ({ name: "fake", stream: () => (async function* () { yield text; })() });

describe("the live AI player prompt and reply", () => {
  it("test_live_prompt_says_who_the_last_line_was_for", () => {
    const { system } = buildLiveRequest({ view: view(), trigger: "reply" });
    expect(system).toContain(ADDRESS_RULE);
    expect(system).toContain("The last line was addressed to you (by delivery lead): answer it first, directly.");
    const other = buildLiveRequest({ view: view({ lines: [{ roleId: "delivery_lead", text: "Priya?", to: "client_sponsor" }], names: { client_sponsor: "Priya Raman" } }), trigger: "reply" }).system;
    expect(other).toContain("The last line was addressed to Priya Raman (by delivery lead)");
  });
  it("test_live_reply_address_is_parsed_against_the_scene_only", async () => {
    const parts = ["delivery_lead", "tech_lead", "account_manager"];
    expect(await generateLiveLine({ provider: say("@account_manager what is the margin?"), scenario: await scenario(), view: view(), trigger: "reply", settings, participants: parts }))
      .toEqual({ ok: true, text: "what is the margin?", cut: false, to: "account_manager" });
    // the AI character of another scene, or no participants at all: left as written, no addressee
    expect(await generateLiveLine({ provider: say("@Priya Raman hello"), scenario: await scenario(), view: view(), trigger: "reply", settings, participants: parts }))
      .toEqual({ ok: true, text: "@Priya Raman hello", cut: false });
    expect(await generateLiveLine({ provider: say("@account_manager hi"), scenario: await scenario(), view: view(), trigger: "reply", settings }))
      .toEqual({ ok: true, text: "@account_manager hi", cut: false });
  });
});
