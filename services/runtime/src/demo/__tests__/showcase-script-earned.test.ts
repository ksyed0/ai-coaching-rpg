import { describe, expect, it } from "vitest";
import type { Scenario } from "@acr/script";
import { ShowcaseScriptError, gmRoundLines, parseShowcaseScript } from "../showcase-script.js";

// US-0034 (AC-0126): the showcase mock scripts the Game Master's earned_when verdicts per character and fact (`mock.gm_earned`).
const npc = (id: string, earned?: Record<string, string>) => ({
  id, type: "npc" as const, name: id, title: "", persona: "p", goals: ["g"], knowledge: [], hidden: ["fact one", "fact two"], guardrails: [], fallback_line: "f",
  voice: { style: "s", pace: "p" }, seniority: 3, responds_with: [], only_you_say: [], defer_to: [], ...(earned ? { earned_when: earned } : {}),
});
const scenario: Scenario = {
  meta: { id: "m", title: "M", version: "1", audience: "", duration_minutes: 10, players: { min: 1, max: 2 }, context: "c", learning_objectives: [], rubrics: [], facilitator_notes: "" },
  roles: {
    pa: { id: "pa", type: "player", brief: "b", private_facts: [] },
    bot: npc("bot", { "1": "a player asks the bot about fact one" }),
    plain: npc("plain"),
  },
  script: {
    scenes: [
      { id: "one", title: "One", goal: "g", participants: ["pa", "bot"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed"] } },
      { id: "two", title: "Two", goal: "g", participants: ["pa", "bot", "plain"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed"] } },
    ],
  },
};
const F = "'{\"verdict\": false, \"reasoning\": \"no\"}'";
const T = "'{\"verdict\": true, \"reasoning\": \"yes\"}'";
// Scene one: 2 utterances per line (the player and the bot), so with every 3 utterances the Game Master judges after lines 2 and 4.
const lines = (n: number) => Array.from({ length: n }, (_, i) => `      - { role: pa, text: "line ${i + 1}" }`).join("\n");
const script = (oneEarned: string, twoMock = "{ npc: { bot: [a, b], plain: [c, d] } }", facilitator = "") => `
scenes:
  - scene: one
    lines:
${lines(4)}
${facilitator}
    mock:
      npc: { bot: [r1, r2, r3, r4] }
${oneEarned}
  - scene: two
    lines:
${lines(2)}
    mock: ${twoMock}
`;
const mock = { mode: "mock" as const };
const err = (text: string, o: Parameters<typeof parseShowcaseScript>[2] = mock) => {
  try { parseShowcaseScript(text, scenario, o); } catch (e) { expect(e).toBeInstanceOf(ShowcaseScriptError); return (e as Error).message; }
  throw new Error("expected an error");
};

describe("gmRoundLines", () => {
  it("names the lines after which the Game Master judges", () => {
    expect(gmRoundLines(4, 1, 3)).toEqual([2, 4]);
    expect(gmRoundLines(4, 2, 3)).toEqual([1, 2, 3, 4]);
    expect(gmRoundLines(7, 0, 3)).toEqual([3, 6]);
    expect(gmRoundLines(0, 2, 3)).toEqual([]);
  });
});

describe("mock.gm_earned in the showcase script", () => {
  it("parses the replies per character and fact; a suggestion in scene one means scene two needs none", () => {
    const s = parseShowcaseScript(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${F}, ${T}] }]`), scenario, mock);
    expect(s.scenes[0]!.mock.gmEarned).toEqual([{ role: "bot", fact: 1, replies: [F.slice(1, -1), T.slice(1, -1)] }]);
    expect(s.scenes[1]!.mock.gmEarned).toEqual([]);
  });

  it("in a mock run, a character with a pending condition needs one scripted verdict per Game Master round until the first true", () => {
    expect(err(script(""))).toMatch(/scene 'one': the mock run needs 2 earned_when verdict\(s\) for hidden fact 1 of 'bot' but 0 are scripted/);
    expect(err(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${F}] }]`))).toMatch(/needs 2 earned_when verdict\(s\) for hidden fact 1 of 'bot' but 1 are scripted/);
    // both false: still pending in scene two (one round after line 2 with 3 utterances per line)
    expect(err(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${F}, ${F}] }]`))).toMatch(/scene 'two': the mock run needs 2 earned_when verdict\(s\) for hidden fact 1 of 'bot' but 0/);
    expect(() => parseShowcaseScript(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${F}, ${F}] }]`, `{ npc: { bot: [a, b], plain: [c, d] }, gm_earned: [{ role: bot, fact: 1, replies: [${F}, ${F}] }] }`), scenario, mock)).not.toThrow();
    // a live run ignores the counts
    expect(() => parseShowcaseScript(script(""), scenario, { mode: "live" })).not.toThrow();
  });

  it("a facilitator release in the scene stops the evaluations after the round of that line", () => {
    const step = "    facilitator:\n      - { after_line: 2, release_hidden: { role: bot, fact: 1 } }";
    expect(() => parseShowcaseScript(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${F}] }]`, undefined, step), scenario, mock)).not.toThrow();
  });

  it("refuses a character that is not an AI character in the scene, a fact without earned_when, and a repeated entry", () => {
    expect(err(script(`      gm_earned: [{ role: plain, fact: 1, replies: [${T}] }]`))).toMatch(/'plain', who is not an AI character in that scene/);
    expect(err(script(`      gm_earned: [{ role: pa, fact: 1, replies: [${T}] }]`))).toMatch(/'pa', who is not an AI character in that scene/);
    expect(err(script(`      gm_earned: [{ role: bot, fact: 2, replies: [${T}] }]`))).toMatch(/hidden fact 2 of 'bot' has no earned_when condition/);
    expect(err(script(`      gm_earned: [{ role: bot, fact: 1, replies: [${T}] }, { role: bot, fact: 1, replies: [${T}] }]`))).toMatch(/hidden fact 1 of 'bot' is listed twice/);
    expect(err(script(`      gm_earned: [{ role: bot, fact: 1, replies: [] }]`))).toMatch(/gm_earned/);
  });
});
