import type { EventBody, SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import type { ChatRequest } from "@acr/adapters";
import { evaluateSession, type EvaluationResult } from "../evaluate.js";
import { parseEvalConfig } from "../config.js";

export const T0 = 1_800_000_000_000;
type Body = EventBody;

/** Builds events with consecutive seq numbers; `at` is seconds after the start. */
export function build(items: [number, Body][], sessionId = "sess1"): SessionEvent[] {
  return items.map(([at, b], i) => ({ ...(b as object), seq: i + 1, ts: T0 + at * 1000, sessionId }) as SessionEvent);
}

/** A tiny scenario: two players (alice, bob), one AI character (npc1), two scenes, two learning objectives, one individual and one group rubric. */
export function sampleScenario(): Scenario {
  return {
    meta: {
      id: "mini-01", title: "Mini scenario", version: "1.0", audience: "", duration_minutes: 10, players: { min: 2, max: 2 }, context: "ctx",
      learning_objectives: [
        { id: "LO1", statement: "Find the need", rubric_criteria: ["discovery", "listening"] },
        { id: "LO2", statement: "Agree a plan", rubric_criteria: ["negotiation", "shared_understanding"] },
      ],
      rubrics: ["ind", "grp"], facilitator_notes: "Compare the first price with the final terms.",
    },
    roles: {
      alice: { id: "alice", type: "player", brief: "b", private_facts: [] },
      bob: { id: "bob", type: "player", brief: "b", private_facts: [] },
      npc1: { id: "npc1", type: "npc", name: "Priya", title: "", persona: "p", goals: [], knowledge: [], hidden: [], guardrails: [], fallback_line: "x", voice: { style: "n", pace: "m" }, seniority: 3, responds_with: [], only_you_say: [], defer_to: [] },
    },
    script: { scenes: [
      { id: "s1", title: "Huddle", goal: "Agree", participants: ["alice", "bob"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed"] } },
      { id: "s2", title: "Call", goal: "Respond", participants: ["alice", "bob", "npc1"], time_box_minutes: 5, injects: [{ id: "i1", to: ["alice"], content: "Priya emails." }], exit_when: { any_of: ["time_box_elapsed"] } },
    ] },
  } as Scenario;
}

export function sampleRubrics() {
  const lv = (a: string) => ({ anchor: a, examples: ["e"] });
  const crit = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1).replace(/_/g, " "), description: `${id} d`, what_to_look_for: ["x"], levels: { 1: lv(`${id} one`), 2: lv(`${id} two`), 3: lv(`${id} three`), 4: lv(`${id} four`) } });
  return [
    { id: "ind", name: "Individual", scope: "individual" as const, version: "1", description: "", criteria: ["discovery", "listening", "negotiation"].map(crit) },
    { id: "grp", name: "Group", scope: "group" as const, version: "1", description: "", criteria: ["shared_understanding"].map(crit) },
  ];
}

export const U = {
  a1: "Let me understand what Finance really needs before we answer.",
  b1: "I worry about the ingestion layer and the go-live date.",
  a2: "So the need is tie-out of daily loads. Have I got that right?",
  b2: "Yes, and a phased module costs about three person-weeks.",
  n1: "Thanks for calling. Can you confirm the module for go-live?",
  a3: "We can offer a phased module for 48 thousand, three weeks after go-live.",
  b3: "I agree with that plan and I will own the timeline.",
};

/** seq: 1 started, 2 scene s1, 3 a1, 4 b1, 5 a2, 6 b2, 7 exit s1, 8 scene s2, 9 inject, 10 n1, 11 a3, 12 gm, 13 b3, 14 exit s2, 15 ended. */
export function sampleEvents(): SessionEvent[] {
  return build([
    [0, { type: "session.started", scenarioId: "mini-01", version: "1.0", roles: { alice: { kind: "player" }, bob: { kind: "player" }, npc1: { kind: "npc" } } }],
    [1, { type: "scene.entered", sceneId: "s1", participants: ["alice", "bob"] }],
    [10, { type: "utterance", roleId: "alice", text: U.a1, channel: "text" }],
    [20, { type: "utterance", roleId: "bob", text: U.b1, channel: "text" }],
    [30, { type: "utterance", roleId: "alice", text: U.a2, channel: "text" }],
    [40, { type: "utterance", roleId: "bob", text: U.b2, channel: "text" }],
    [50, { type: "scene.exited", sceneId: "s1", reason: "time_box_elapsed" }],
    [60, { type: "scene.entered", sceneId: "s2", participants: ["alice", "bob", "npc1"] }],
    [61, { type: "inject.fired", injectId: "i1", sceneId: "s2", to: ["alice"], content: "Priya emails." }],
    [70, { type: "utterance", roleId: "npc1", text: U.n1, channel: "text" }],
    [80, { type: "utterance", roleId: "alice", text: U.a3, channel: "text" }],
    [81, { type: "gm.decision", sceneId: "s2", condition: "a plan is agreed", verdict: true, reasoning: "they agreed" }],
    [90, { type: "utterance", roleId: "bob", text: U.b3, channel: "text" }],
    [100, { type: "scene.exited", sceneId: "s2", reason: "gm_detects" }],
    [101, { type: "session.ended", reason: "script_complete" }],
  ] as unknown as [number, Body][]);
}

// Shared evaluation helpers (moved out of reports.test.ts unchanged in behaviour).
const evalCfg = (() => { const c = parseEvalConfig({}); if (!c.ok) throw new Error("cfg"); return c; })();
export const crit = (id: string, score: unknown, seq: number, quote: string, rationale = `Because ${id}.`, more: { seq: number; quote: string }[] = []) => ({ id, score, rationale, confidence: "high", evidence: [{ seq, quote }, ...more] });
export const sampleAnswers: Record<string, unknown> = {
  alice: { criteria: [crit("discovery", 3, 3, "what Finance really needs", "Because discovery.", [{ seq: 5, quote: "tie-out of daily loads" }, { seq: 11, quote: "three weeks after go-live" }]), crit("listening", 4, 5, "Have I got that right?"), crit("negotiation", 2, 11, "phased module for 48 thousand")], strengths: ["You asked about the need."], development_points: ["Price earlier."], next_actions: [{ lo: "LO2", action: "State two options." }] },
  bob: { criteria: [crit("discovery", 2, 4, "the ingestion layer"), crit("listening", 3, 6, "a phased module costs about three person-weeks"), crit("negotiation", 3, 13, "I agree with that plan")], strengths: ["Clear on effort."], development_points: ["Ask more."], next_actions: [{ lo: "LO1", action: "Ask an open question." }] },
  group: { criteria: [crit("shared_understanding", 3, 6, "a phased module costs about three person-weeks")], talking_points: ["Compare first price and final terms."], notable_moments: [{ seq: 11, quote: "phased module for 48 thousand", note: "Price named." }] },
};
export function sampleProvider(over: Record<string, unknown> = {}) {
  const all = { ...sampleAnswers, ...over };
  return { name: "router", async *stream(req: ChatRequest): AsyncIterable<string> { const key = /role id "(\w+)"/.exec(req.system)?.[1] ?? "group"; yield JSON.stringify(all[key]); } };
}
export const sampleEvaluation = (over: Record<string, unknown> = {}, secrets: string[] = []): Promise<EvaluationResult> => {
  void secrets;
  return evaluateSession({ events: sampleEvents(), scenario: sampleScenario(), rubrics: sampleRubrics(), provider: sampleProvider(over), config: evalCfg, nonce: "n" });
};
