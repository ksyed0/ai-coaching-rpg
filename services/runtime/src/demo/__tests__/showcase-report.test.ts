import type { SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import { describe, expect, it } from "vitest";
import { buildShowcaseReport, clip, formatAiSummary, median } from "../showcase-report.js";

const scenario: Scenario = {
  meta: { id: "m", title: "Demo Scenario", version: "1", audience: "", duration_minutes: 10, players: { min: 1, max: 1 }, context: "c", learning_objectives: [], rubrics: [], facilitator_notes: "" },
  roles: {
    pa: { id: "pa", type: "player", brief: "b", private_facts: [] },
    bot: { id: "bot", type: "npc", name: "Bo Tester", title: "", persona: "p", goals: ["g"], knowledge: [], hidden: [], guardrails: [], fallback_line: "Say that again?", voice: { style: "s", pace: "p" }, seniority: 3, responds_with: [], only_you_say: [], defer_to: [] },
  },
  script: {
    scenes: [
      { id: "one", title: "One", goal: "g", participants: ["pa", "bot"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed", { gm_detects: "agreed" }] } },
      { id: "two", title: "Two", goal: "g", participants: ["pa"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed", "facilitator_advance"] } },
    ],
  },
};
type Body = { [K in SessionEvent["type"]]: Omit<Extract<SessionEvent, { type: K }>, "seq" | "ts" | "sessionId"> }[SessionEvent["type"]];
const stream = (items: [number, Body][]): SessionEvent[] => items.map(([ts, b], i) => ({ seq: i + 1, ts, sessionId: "s", ...b }) as SessionEvent);
const u = (roleId: string, text: string): Body => ({ type: "utterance", roleId, text, channel: "text" });
const fb = (roleId: string, text: string): Body => ({ type: "utterance", roleId, text, channel: "text", fallback: true });

const events = stream([
  [1000, { type: "session.started", scenarioId: "m", version: "1", roles: {} }],
  [1000, { type: "scene.entered", sceneId: "one", participants: ["pa", "bot"] }],
  [2000, u("pa", "hello")],
  [2400, u("bot", "hi, tell me more")],
  [3000, u("pa", "ok")],
  [3500, { type: "facilitator.alert", level: "warning", message: "NPC bot: no first token within timeout; used fallback line" }],
  [3500, fb("bot", "Say that again?")],
  [4000, u("pa", "so")],
  [4900, { type: "facilitator.alert", level: "warning", message: "NPC bot: model error: boom; used fallback line" }],
  [4900, fb("bot", "Say that again?")],
  [5000, { type: "gm.decision", sceneId: "one", condition: "agreed", verdict: false, reasoning: "not yet\u001b[31m" }],
  [5100, { type: "gm.decision", sceneId: "one", condition: "agreed", verdict: true, reasoning: "yes" }],
  [5100, { type: "scene.exited", sceneId: "one", reason: "gm_detects" }],
  [5100, { type: "scene.entered", sceneId: "two", participants: ["pa"] }],
  [5200, u("pa", "wrap up")],
  [5300, { type: "facilitator.command", command: "advance" }],
  [5300, { type: "scene.exited", sceneId: "two", reason: "facilitator_advance" }],
  [5300, { type: "session.ended", reason: "script_complete" }],
]);
const build = (over: Partial<Parameters<typeof buildShowcaseReport>[0]> = {}) => buildShowcaseReport({
  events, scenario, mode: "live", timing: true, wallTimeMs: 4300, maxLines: 2, maxFallbacks: null, watchdogMinutes: 30, observations: ["GM did not exit; facilitator advanced"], provider: "p", ...over,
});

describe("buildShowcaseReport", () => {
  it("counts replies per AI character, separating real model output from the canned fallback line", () => {
    const r = build();
    expect(r.npcs).toEqual([{ roleId: "bot", name: "Bo Tester", silentTurns: 0, replies: 3, modelReplies: 1, fallbackReplies: 2, latencyMs: { median: 500, max: 900 } }]);
    expect(r.fallbackLines).toBe(2);
    expect(r.playerLines).toBe(4);
    expect(r.npcReplies).toBe(3);
  });
  it("does not call a reply a fallback just because it repeats the fallback text (no marker), even right after an alert", () => {
    const unmarked = events.map((e) => (e.type === "utterance" ? ({ ...e, fallback: undefined } as SessionEvent) : e));
    expect(build({ events: unmarked }).fallbackLines).toBe(0);
    expect(build({ events: unmarked }).lines.filter((l) => l.source === "ai-character").every((l) => l.tag === "generated")).toBe(true);
  });
  it("derives latency from the previous line in the stream, and reports none without real timing", () => {
    expect(build().npcs[0]!.latencyMs).toEqual({ median: 500, max: 900 });
    expect(build({ timing: false }).npcs[0]!.latencyMs).toBeNull();
  });
  it("lists every Game Master decision with sanitized reasoning, verdict counts and the scenes it exited", () => {
    const r = build();
    expect(r.gm.evaluations).toBe(2);
    expect([r.gm.verdictsTrue, r.gm.verdictsFalse]).toEqual([1, 1]);
    expect(r.gm.exitedScenes).toEqual(["one"]);
    expect(r.gm.decisions[0]).toMatchObject({ sceneId: "one", condition: "agreed", verdict: false });
    expect(JSON.stringify(r)).not.toContain("\u001b");
  });
  it("records scene exit reasons, advances, alerts and per-line sources", () => {
    const r = build();
    expect(r.scenes.map((s) => [s.id, s.exitReason, s.playerLines, s.npcReplies, s.gmDecisions])).toEqual([["one", "gm_detects", 3, 3, 2], ["two", "facilitator_advance", 1, 0, 0]]);
    expect(r.facilitatorAdvances).toBe(1);
    expect(r.alerts).toEqual([
      { seq: 6, level: "warning", message: "NPC bot: no first token within timeout; used fallback line" },
      { seq: 9, level: "warning", message: "NPC bot: model error: boom; used fallback line" },
    ]);
    expect(r.observations).toEqual(["GM did not exit; facilitator advanced"]);
    const sources = new Set(r.lines.map((l) => l.source));
    expect([...sources].sort()).toEqual(["ai-character", "game-master", "player-bot", "system"]);
    const fallback = r.lines.filter((l) => l.fallback);
    expect(fallback).toHaveLength(2);
    expect(fallback.every((l) => l.source === "ai-character" && l.role === "bot")).toBe(true);
    expect(r.lines.find((l) => l.source === "player-bot")).toMatchObject({ role: "pa", sceneId: "one", text: "hello" });
  });
  it("warns about fallback lines only when no --max-fallbacks limit was given", () => {
    expect(build().warnings).toEqual(["2 of 3 AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)"]);
    expect(build({ maxFallbacks: 5 }).warnings).toEqual([]);
    expect(formatAiSummary(build()).join("\n")).toContain("WARNING: 2 of 3");
  });
  it("carries the run settings", () => {
    expect(build()).toMatchObject({ scenario: { id: "m", title: "Demo Scenario" }, mode: "live", maxLines: 2, maxFallbacks: null, watchdogMinutes: 30, wallTimeMs: 4300 });
  });
});

describe("helpers", () => {
  it("computes a median", () => { expect([median([]), median([5]), median([1, 9]), median([3, 1, 2])]).toEqual([null, 5, 5, 2]); });
  it("clips long text and sanitizes it", () => {
    expect(clip("a\u001bb", 10)).toBe("a·b");
    expect(clip("x".repeat(50), 10)).toBe("xxxxxxxxx…");
  });
});

describe("formatAiSummary", () => {
  it("prints per-character, Game Master and totals lines", () => {
    const text = formatAiSummary(build()).join("\n");
    expect(text).toContain("AI contribution");
    expect(text).toContain("Bo Tester (bot): 3 replies, 1 real model output, 2 fallback lines");
    expect(text).toContain("median 0.5 s, max 0.9 s");
    expect(text).toContain("Game Master: 2 evaluations (1 true, 1 false); exited: one");
    expect(text).toContain("Facilitator advances: 1");
    expect(text).toContain("Alerts: 2");
    expect(text).toContain("Total wall time: 4.3 s");
  });
  it("says n/a for latency and 'scripted' for mock output", () => {
    const text = formatAiSummary(build({ mode: "mock", timing: false })).join("\n");
    expect(text).toContain("latency n/a");
    expect(text).toContain("scripted (mock) output");
  });
});

describe("voices: echoes and silent turns (US-0032)", () => {
  const two: Scenario = { ...scenario, roles: { ...scenario.roles, boss: { ...(scenario.roles.bot as object), id: "boss", name: "Big Boss", seniority: 5 } as Scenario["roles"][string] } };
  const mk = (a: string, b: string) => stream([
    [1000, { type: "session.started", scenarioId: "m", version: "1", roles: {} }],
    [1000, { type: "scene.entered", sceneId: "one", participants: ["pa", "bot", "boss"] }],
    [2000, u("pa", "hello")], [2100, u("bot", a)], [2200, u("boss", b)],
    [2300, { type: "scene.exited", sceneId: "one", reason: "facilitator_advance" }],
  ]);
  const base = { scenario: two, mode: "mock" as const, timing: false, wallTimeMs: 1, maxLines: null, maxFallbacks: null, watchdogMinutes: 1, observations: [] };

  it("counts an echo and silent turns per character, in the JSON section and the summary", () => {
    const r = buildShowcaseReport({ ...base, events: mk("The budget is the problem, forty five thousand extra.", "Forty five thousand extra: the budget is the problem."), silences: [{ roleId: "boss", sceneId: "one" }, { roleId: "boss", sceneId: "one" }] });
    expect(r.voices.echoes).toHaveLength(1);
    expect(r.voices.echoes[0]).toMatchObject({ sceneId: "one", first: { role: "bot" }, second: { role: "boss" } });
    expect(r.voices.silentTurns).toEqual({ total: 2, byRole: { boss: 2 }, byScene: [{ sceneId: "one", roleId: "boss", count: 2 }] });
    expect(r.npcs.find((n) => n.roleId === "boss")!.silentTurns).toBe(2);
    expect(r.voices.echoThreshold).toBe(0.6);
    expect(formatAiSummary(r)).toContain("  AI voices: 1 near-duplicate consecutive AI reply pair(s) (similarity >= 0.6); silent turns: Big Boss 2");
  });

  it("distinct replies and no silences: zero, 'none', and a silent turn is no utterance in the lines", () => {
    const r = buildShowcaseReport({ ...base, events: mk("We need the module before the close.", "Fixed price, 45k, or no deal; the date is 14 June.") });
    expect(r.voices).toMatchObject({ echoes: [], silentTurns: { total: 0, byRole: {}, byScene: [] } });
    expect(formatAiSummary(r)).toContain("  AI voices: 0 near-duplicate consecutive AI reply pair(s) (similarity >= 0.6); silent turns: none");
    expect(JSON.stringify(r)).not.toContain("<silent");
  });
});
