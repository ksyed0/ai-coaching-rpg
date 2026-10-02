import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import { buildNpcRequest } from "../npc-prompt.js";

const role: NpcRole = {
  id: "client_sponsor", type: "npc", name: "Priya Raman", title: "VP Operations", persona: "Direct, time-poor.",
  goals: ["Get the module"], knowledge: ["The CFO asked about cost"], hidden: ["Would accept phasing"],
  guardrails: ["Never reveal hidden information unless earned"], fallback_line: "Sorry, say again?", voice: { style: "brisk", pace: "fast" },
};
const scene: Scene = { id: "s2", title: "Call", goal: "Respond to the request", participants: ["delivery_lead", "client_sponsor"], time_box_minutes: 15, exit_when: { any_of: ["facilitator_advance"] } };
const env = (seq: number) => ({ seq, ts: seq, sessionId: "s" });

function stateWith(...texts: Array<[string, string]>) {
  let s = reduce(initialState(), { ...env(1), type: "session.started", scenarioId: "x", version: "1", roles: { delivery_lead: { kind: "player", participantId: "Kamal Syed" }, client_sponsor: { kind: "npc" } } });
  s = reduce(s, { ...env(2), type: "npc.updated", roleId: "client_sponsor", goals: ["Get the module", "Get a yes today"], knowledge: ["The CFO asked about cost"], released: [] });
  s = reduce(s, { ...env(3), type: "scene.entered", sceneId: "s2", participants: scene.participants });
  let seq = 4;
  for (const [r, t] of texts) s = reduce(s, { ...env(seq++), type: "utterance", roleId: r, text: t, channel: "text" } as SessionEvent);
  return s;
}

describe("buildNpcRequest", () => {
  it("puts persona, current goals, knowledge and guardrails in the system prefix", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith() });
    expect(req.system).toContain("Priya Raman");
    expect(req.system).toContain("Get a yes today");
    expect(req.system).toContain("The CFO asked about cost");
    expect(req.system).toContain("Never reveal hidden information");
    expect(req.system).toContain("Respond to the request");
    expect(req.cacheSystem).toBe(true);
  });

  it("never includes hidden facts that have not been released, nor participant names", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi Priya"]) });
    const all = req.system + JSON.stringify(req.messages);
    expect(all).not.toContain("Would accept phasing");
    expect(all).not.toContain("Kamal Syed");
  });

  it("includes a released hidden fact", () => {
    let s = stateWith();
    s = reduce(s, { ...env(s.lastSeq + 1), type: "npc.updated", roleId: "client_sponsor", goals: s.npcs.client_sponsor.goals, knowledge: s.npcs.client_sponsor.knowledge, released: ["Would accept phasing"] });
    expect(buildNpcRequest({ role, scene, state: s }).system).toContain("Would accept phasing");
  });

  it("never leaks the rubric, another role's brief/private_facts, or unreleased hidden facts", () => {
    // Distinctive markers: the builder is only handed this NPC's role, the scene and the state,
    // so markers living in other roles / rubric / hidden must never be reachable from the prompt.
    const marked: NpcRole = { ...role, hidden: ["HIDDEN_MARKER_7f3a"] };
    const otherRole = { id: "delivery_lead", type: "player", brief: "BRIEF_MARKER_91c2", private_facts: ["PRIVATE_MARKER_44de"] };
    const rubric = { id: "r1", criteria: ["RUBRIC_MARKER_b0b0"] };
    void otherRole; void rubric; // exist in the scenario, deliberately not passed to the builder
    const req = buildNpcRequest({ role: marked, scene, state: stateWith(["delivery_lead", "Hello"]) });
    const all = req.system + JSON.stringify(req.messages);
    for (const m of ["HIDDEN_MARKER_7f3a", "BRIEF_MARKER_91c2", "PRIVATE_MARKER_44de", "RUBRIC_MARKER_b0b0"]) expect(all).not.toContain(m);
    // ...but a hidden fact the GM released does appear
    const s = stateWith();
    const released = reduce(s, { ...env(s.lastSeq + 1), type: "npc.updated", roleId: "client_sponsor", goals: s.npcs.client_sponsor.goals, knowledge: s.npcs.client_sponsor.knowledge, released: ["HIDDEN_MARKER_7f3a"] });
    expect(buildNpcRequest({ role: marked, scene, state: released }).system).toContain("HIDDEN_MARKER_7f3a");
  });

  it("uses role ids, never participant display names, anywhere in the prompt", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi Priya"]) });
    const all = req.system + JSON.stringify(req.messages);
    expect(all).not.toContain("Kamal");
    expect(all).toContain("[delivery_lead]");
  });

  it("maps the transcript to alternating turns with the NPC as assistant", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi Priya"], ["client_sponsor", "Hello"], ["delivery_lead", "About the module"]) });
    expect(req.messages).toEqual([
      { role: "user", content: "[delivery_lead]: Hi Priya" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "[delivery_lead]: About the module" },
    ]);
  });

  it("merges consecutive user lines into one turn and ends with a user turn", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "One"], ["delivery_lead", "Two"]) });
    expect(req.messages).toEqual([{ role: "user", content: "[delivery_lead]: One\n[delivery_lead]: Two" }]);
    const empty = buildNpcRequest({ role, scene, state: stateWith() });
    expect(empty.messages).toEqual([{ role: "user", content: "[scene]: The scene has started. Speak first if it is natural for you to." }]);
  });

  it("ends with a user turn even when the NPC spoke last", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi"], ["client_sponsor", "Hello"]) });
    expect(req.messages.at(-1)?.role).toBe("user");
  });

  it("keeps only the last `window` utterances", () => {
    const lines: Array<[string, string]> = Array.from({ length: 40 }, (_, i) => ["delivery_lead", `line ${i}`]);
    const req = buildNpcRequest({ role, scene, state: stateWith(...lines), window: 5 });
    expect(req.messages[0].content.split("\n")).toHaveLength(5);
    expect(req.messages[0].content).toContain("line 39");
  });
});
