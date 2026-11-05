import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent, type SessionState } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import { NO_REPEAT_RULE, SHARE_SECTION, buildNpcRequest, npcIntro, stableNpcPrefix } from "../npc-prompt.js";

// US-0019, AC-0061 (TC-0022): the AI character prompt puts its stable content first, so the cached prefix survives an NPC update.
const role: NpcRole = {
  id: "client_sponsor", type: "npc", name: "Priya Raman", title: "VP Operations", persona: "Direct, time-poor, protective of her team.",
  goals: ["GOAL_START_a1"], knowledge: ["KNOW_START_b2"], hidden: ["HIDDEN_FACT_c3"],
  guardrails: ["Never reveal hidden information unless earned"], fallback_line: "Sorry, say again?", voice: { style: "brisk", pace: "fast" },
  seniority: 3, responds_with: ["a decision on the timeline"], only_you_say: ["what the board will accept"], defer_to: [],
};
const s1: Scene = { id: "s1", title: "First call", goal: "SCENE_ONE_GOAL", participants: ["lead", "client_sponsor"], time_box_minutes: 10, exit_when: { any_of: ["facilitator_advance"] } };
const s2: Scene = { ...s1, id: "s2", title: "Second call", goal: "SCENE_TWO_GOAL", participants: ["lead", "client_sponsor", "cfo"] };
const peers = [{ id: "cfo", name: "Helena Brandt", title: "CFO", seniority: 5 }];

const ev = (s: SessionState, e: Record<string, unknown>) => reduce(s, { seq: s.lastSeq + 1, ts: s.lastSeq + 1, sessionId: "x", ...e } as SessionEvent);
function start(): SessionState {
  let s = ev(initialState(), { type: "session.started", scenarioId: "x", version: "1", roles: { lead: { kind: "player", participantId: "Kamal Syed" }, client_sponsor: { kind: "npc" }, cfo: { kind: "npc" } } });
  s = ev(s, { type: "npc.updated", roleId: "client_sponsor", goals: role.goals, knowledge: role.knowledge, released: [] });
  return ev(s, { type: "scene.entered", sceneId: "s1", participants: s1.participants });
}
const prefixOf = (r: { system: string; cachePrefixChars?: number }) => r.system.slice(0, r.cachePrefixChars);

describe("test_npc_prompt_stable_prefix_survives_updates (AC-0061, TC-0022)", () => {
  it("marks a non-empty stable prefix that is exactly the start of the system prompt, and caching stays on", () => {
    const req = buildNpcRequest({ role, scene: s1, state: start() });
    expect(req.cacheSystem).toBe(true);
    expect(req.cachePrefixChars).toBeGreaterThan(0);
    expect(req.cachePrefixChars).toBeLessThan(req.system.length);
    expect(prefixOf(req)).toBe(stableNpcPrefix(role));
    expect(req.system.startsWith(stableNpcPrefix(role))).toBe(true);
  });

  it("the prefix holds the stable content (intro, rules, persona, guardrails, voice) and none of the changing content", () => {
    const p = prefixOf(buildNpcRequest({ role, scene: s1, state: ev(start(), { type: "utterance", roleId: "client_sponsor", text: "MY_LAST_LINE_d4", channel: "text" }), peers }));
    for (const x of [npcIntro(role), NO_REPEAT_RULE, "## Persona", role.persona, "## Rules you must follow", role.guardrails[0]!, "## Voice", "Style: brisk. Pace: fast."]) expect(p).toContain(x);
    for (const x of ["GOAL_START_a1", "KNOW_START_b2", "SCENE_ONE_GOAL", "MY_LAST_LINE_d4", "## Your current goals", "## What you know", "## Current scene", "## How you respond", "## Your last lines", SHARE_SECTION]) expect(p).not.toContain(x);
  });

  it("the prefix bytes are identical before and after an NPC update (goals, knowledge, a released fact), new lines, an inject and a new scene with another character", () => {
    let s = start();
    const before = buildNpcRequest({ role, scene: s1, state: s });
    s = ev(s, { type: "utterance", roleId: "lead", text: "Can we talk timelines?", channel: "text" });
    s = ev(s, { type: "utterance", roleId: "client_sponsor", text: "We need it Friday.", channel: "text" });
    s = ev(s, { type: "npc.updated", roleId: "client_sponsor", goals: ["GOAL_LATER_e5"], knowledge: ["KNOW_START_b2", "KNOW_LATER_f6"], released: [] });
    const afterGoals = buildNpcRequest({ role, scene: s1, state: s });
    s = ev(s, { type: "npc.updated", roleId: "client_sponsor", goals: ["GOAL_LATER_e5"], knowledge: ["KNOW_LATER_f6"], released: ["HIDDEN_FACT_c3"] });
    const afterRelease = buildNpcRequest({ role, scene: s1, state: s });
    s = ev(s, { type: "scene.exited", sceneId: "s1", reason: "facilitator_advance" });
    s = ev(s, { type: "scene.entered", sceneId: "s2", participants: s2.participants });
    const nextScene = buildNpcRequest({ role, scene: s2, state: s, peers });
    // The changing parts did change (the audit is not vacuous) ...
    expect(afterGoals.system).toContain("GOAL_LATER_e5");
    expect(afterRelease.system).toContain("HIDDEN_FACT_c3");
    expect(nextScene.system).toContain("SCENE_TWO_GOAL");
    expect(nextScene.system).toContain("## Who else is in the room");
    // ... and every request shares the same prefix, byte for byte.
    for (const r of [afterGoals, afterRelease, nextScene]) {
      expect(r.cachePrefixChars).toBe(before.cachePrefixChars);
      expect(Buffer.from(prefixOf(r), "utf8").equals(Buffer.from(prefixOf(before), "utf8"))).toBe(true);
    }
  });

  it("keeps every section and its meaning: same sections as before, released facts last and after the rules they override", () => {
    let s = start();
    s = ev(s, { type: "utterance", roleId: "client_sponsor", text: "Hello.", channel: "text" });
    s = ev(s, { type: "npc.updated", roleId: "client_sponsor", goals: role.goals, knowledge: role.knowledge, released: ["HIDDEN_FACT_c3"] });
    const sys = buildNpcRequest({ role, scene: s2, state: s, peers }).system;
    const order = ["## Persona", "## Rules you must follow", "## Voice", "## Your current goals", "## What you know", "## Current scene", "## Who else is in the room", "## How you respond", "## Your last lines", SHARE_SECTION].map((h) => sys.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const know = sys.slice(sys.indexOf("## What you know"), sys.indexOf("## Current scene"));
    expect(know).toContain("KNOW_START_b2");
    expect(know).not.toContain("HIDDEN_FACT_c3");
    expect(sys.slice(sys.indexOf(SHARE_SECTION))).toContain("- HIDDEN_FACT_c3");
  });

  it("an unreleased hidden fact and a participant name are in neither part of the prompt", () => {
    const req = buildNpcRequest({ role, scene: s1, state: ev(start(), { type: "utterance", roleId: "lead", text: "Hi", channel: "text" }) });
    const all = req.system + JSON.stringify(req.messages);
    expect(all).not.toContain("HIDDEN_FACT_c3");
    expect(all).not.toContain("Kamal");
  });
});
