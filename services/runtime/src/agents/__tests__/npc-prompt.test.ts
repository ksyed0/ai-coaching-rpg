import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole, type PlayerRole, type Scene } from "@acr/script";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { buildNpcRequest } from "../npc-prompt.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
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

  it("never leaks rubric, another role's brief/private_facts, unreleased hidden facts or display names (real scenario + engine)", async () => {
    const scenario = await loadScenario(fixture);
    const host = scenario.roles.host as PlayerRole;
    const guestRole = scenario.roles.guest as NpcRole;
    host.brief = "BRIEF_MARKER_91c2"; host.private_facts = ["PRIVATE_MARKER_44de"];
    scenario.meta.rubrics = ["RUBRIC_MARKER_b0b0"];
    scenario.meta.learning_objectives[0].rubric_criteria = ["RUBRIC_MARKER_b0b0"];
    guestRole.hidden = ["HIDDEN_RELEASED_1a1a", "HIDDEN_SECRET_2b2b"];
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
    await engine.start({ host: "Zebediah Quux" });
    await engine.say("host", "Hello there");
    await engine.say("guest", "Hi");
    await engine.say("host", "Tell me more");
    await engine.updateNpc("guest", { released: ["HIDDEN_RELEASED_1a1a"] });
    const req = buildNpcRequest({ role: guestRole, scene: engine.currentScene()!, state: engine.state });
    const all = req.system + req.messages.map((m) => m.content).join("\n");
    for (const m of ["BRIEF_MARKER_91c2", "PRIVATE_MARKER_44de", "RUBRIC_MARKER_b0b0", "HIDDEN_SECRET_2b2b", "Zebediah", "Quux"]) expect(all).not.toContain(m);
    expect(req.system).toContain("HIDDEN_RELEASED_1a1a");
  });

  it("the input type structurally rejects the scenario, rubric and other roles (compile-time guard)", () => {
    const state = stateWith();
    // buildNpcRequest only accepts { role, scene, state, window }: nothing else can be handed to it.
    // These @ts-expect-error lines fail `pnpm typecheck` if the input type ever widens to accept them.
    // @ts-expect-error rubric is not an accepted input
    buildNpcRequest({ role, scene, state, rubric: ["x"] });
    // @ts-expect-error other roles are not an accepted input
    buildNpcRequest({ role, scene, state, roles: {} });
    // @ts-expect-error the scenario is not an accepted input
    buildNpcRequest({ role, scene, state, scenario: {} });
    expect(true).toBe(true);
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

  it("starts with a user turn when the NPC spoke first", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["client_sponsor", "Let's begin"], ["delivery_lead", "Thanks"]) });
    expect(req.messages[0].role).toBe("user");
    expect(req.messages).toEqual([
      { role: "user", content: "[scene]: The scene has started. Speak first if it is natural for you to." },
      { role: "assistant", content: "Let's begin" },
      { role: "user", content: "[delivery_lead]: Thanks" },
    ]);
  });

  it("starts with a user turn when the window cut lands on an NPC line", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "a"], ["client_sponsor", "b"], ["delivery_lead", "c"], ["delivery_lead", "d"]), window: 3 });
    expect(req.messages[0].role).toBe("user");
    expect(req.messages.at(-1)?.role).toBe("user");
    expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(req.messages[2].content).toBe("[delivery_lead]: c\n[delivery_lead]: d");
  });
});

describe("the persona sentence the demo's scripted mock routes on", () => {
  it("is the exported npcIntro(role) and starts the system prompt, so changing the wording changes the router with it", async () => {
    const { npcIntro } = await import("../npc-prompt.js");
    expect(npcIntro(role)).toBe("You are playing Priya Raman");
    expect(buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "hi"]) }).system.startsWith(npcIntro(role))).toBe(true);
  });
});

describe("buildNpcRequest token budget (US-0026)", () => {
  it("defaults to 600 tokens (room for a reasoning model to think and answer)", () => {
    expect(buildNpcRequest({ role, scene, state: stateWith() }).maxTokens).toBe(600);
  });
  it("uses the configured budget", () => {
    expect(buildNpcRequest({ role, scene, state: stateWith(), maxTokens: 1234 }).maxTokens).toBe(1234);
  });

  it("tells the model to speak only for the character and never to write speaker tags", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith() });
    expect(req.system).toMatch(/only Priya Raman's own words/);
    expect(req.system).toMatch(/never begin a reply with a \[\.\.\.\] speaker tag/);
  });
});
