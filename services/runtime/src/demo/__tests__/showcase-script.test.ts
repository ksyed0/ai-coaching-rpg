import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, type Scenario } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { SHOWCASE_FILE, ShowcaseScriptError, expectedGmEvaluations, loadShowcaseScript, parseShowcaseScript } from "../showcase-script.js";

const scenario: Scenario = {
  meta: { id: "m", title: "M", version: "1", audience: "", duration_minutes: 10, players: { min: 1, max: 2 }, context: "c", learning_objectives: [], rubrics: [], facilitator_notes: "" },
  roles: {
    pa: { id: "pa", type: "player", brief: "b", private_facts: [] },
    pb: { id: "pb", type: "player", brief: "b", private_facts: [] },
    bot: { id: "bot", type: "npc", name: "Bot", title: "", persona: "p", goals: ["g"], knowledge: [], hidden: [], guardrails: [], fallback_line: "f", voice: { style: "s", pace: "p" }, seniority: 3, responds_with: [], only_you_say: [], defer_to: [] },
  },
  script: {
    scenes: [
      { id: "one", title: "One", goal: "g", participants: ["pa", "pb"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed", { gm_detects: "the players agreed something" }] } },
      { id: "two", title: "Two", goal: "g", participants: ["pa", "bot"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed"] } },
    ],
  },
};
const GM = "'{\"verdict\": true, \"reasoning\": \"ok\"}'";
const valid = `
scenes:
  - scene: one
    lines:
      - { role: pa, text: "hello" }
      - { role: pb, text: "hi" }
      - { role: pa, text: "so" }
    mock: { gm: [${GM}] }
  - scene: two
    lines:
      - { role: pa, text: "hey bot" }
    mock: { npc: { bot: ["hello there"] } }
`;
const mock = { mode: "mock" as const };
const err = (text: string, o: Parameters<typeof parseShowcaseScript>[2] = mock) => {
  try { parseShowcaseScript(text, scenario, o); } catch (e) { expect(e).toBeInstanceOf(ShowcaseScriptError); return (e as Error).message; }
  throw new Error("expected an error");
};

describe("parseShowcaseScript", () => {
  it("accepts a valid file", () => {
    const s = parseShowcaseScript(valid, scenario, mock);
    expect(s.scenes.map((x) => [x.scene, x.lines.length])).toEqual([["one", 3], ["two", 1]]);
    expect(s.scenes[1]!.mock.npc.bot).toEqual(["hello there"]);
  });
  it("does not require the mock section in live mode, and ignores nothing else", () => {
    const live = valid.replace(/ {4}mock:.*\n/g, "");
    expect(parseShowcaseScript(live, scenario, { mode: "live" }).scenes).toHaveLength(2);
    expect(err(live)).toBe(`${SHOWCASE_FILE}: scene 'one': the mock run needs 1 Game Master verdict(s) but only 0 are scripted`);
  });
  it("reports malformed YAML by file name, with no stack trace", () => {
    const m = err("scenes: [\n  - {");
    expect(m).toMatch(/^showcase\.yaml: not valid YAML: /);
    expect(m).not.toMatch(/\n\s+at /);
  });
  it("reports a schema problem with its path", () => {
    expect(err("scenes: []")).toBe(`${SHOWCASE_FILE}: scenes.length Array must contain at least 1 element(s)`.replace("scenes.length", "scenes"));
    expect(err("scenes:\n  - scene: one\n    lines:\n      - { role: pa }")).toBe(`${SHOWCASE_FILE}: scenes.0.lines.0.text Required`);
    expect(err("scenes:\n  - scene: one\n    lines: []")).toMatch(/^showcase\.yaml: scenes\.0\.lines /);
    expect(err("scenes:\n  - scene: one\n    lines:\n      - { role: pa, text: \"   \" }")).toBe(`${SHOWCASE_FILE}: scenes.0.lines.0.text must not be blank`);
    expect(err(`scenes:\n  - scene: one\n    lines:\n      - { role: pa, text: "${"x".repeat(2001)}" }`)).toBe(`${SHOWCASE_FILE}: scenes.0.lines.0.text is longer than 2000 characters (the server refuses longer lines)`);
    expect(err("42")).toMatch(/^showcase\.yaml: \(root\) /);
  });
  it("names an unknown scene, a duplicated scene and a scene without lines", () => {
    expect(err(valid.replace("scene: two", "scene: nine"))).toBe(`${SHOWCASE_FILE}: scene 'nine' is not in the scenario`);
    expect(err(valid.replace("scene: two", "scene: one"))).toBe(`${SHOWCASE_FILE}: scene 'one' is listed more than once`);
    expect(err(valid.slice(0, valid.indexOf("  - scene: two")))).toBe(`${SHOWCASE_FILE}: scene 'two' has no entry (every scene needs scripted player lines)`);
  });
  it("names an unknown role, an AI character speaking as a player and a role outside the scene", () => {
    expect(err(valid.replace("role: pb", "role: ghost"))).toBe(`${SHOWCASE_FILE}: scene 'one': line 2 uses role 'ghost', which is not a role in the scenario`);
    expect(err(valid.replace("role: pb", "role: bot"))).toBe(`${SHOWCASE_FILE}: scene 'one': line 2 is spoken by 'bot', an AI character; only player roles may have scripted lines`);
    expect(err(valid.replace("role: pa, text: \"hey bot\"", "role: pb, text: \"hey bot\""))).toBe(`${SHOWCASE_FILE}: scene 'two': line 1 is spoken by 'pb', who is not in that scene`);
  });
  it("names mock replies for a role that is not an AI character of that scene", () => {
    expect(err(valid.replace("npc: { bot:", "npc: { pa:"))).toBe(`${SHOWCASE_FILE}: scene 'two': mock replies are given for 'pa', who is not an AI character in that scene`);
    expect(err(valid.replace("mock: { gm: [", "mock: { npc: { bot: ['x'] }, gm: ["))).toBe(`${SHOWCASE_FILE}: scene 'one': mock replies are given for 'bot', who is not an AI character in that scene`);
    expect(err(valid.replace("npc: { bot:", "npc: { nobody:"))).toBe(`${SHOWCASE_FILE}: scene 'two': mock replies are given for 'nobody', who is not an AI character in that scene`);
  });
  it("fails loudly when the mock script is too short for the lines", () => {
    expect(err(valid.replace('["hello there"]', "[]"))).toBe(`${SHOWCASE_FILE}: scene 'two': 'bot' has 0 mock replies but the scene has 1 scripted line(s) and needs one reply per line`);
    expect(err(valid.replace(`gm: [${GM}]`, "gm: []"))).toBe(`${SHOWCASE_FILE}: scene 'one': the mock run needs 1 Game Master verdict(s) but only 0 are scripted`);
    expect(err(valid.replace("    mock: { npc: { bot: [\"hello there\"] } }\n", ""))).toBe(`${SHOWCASE_FILE}: scene 'two': 'bot' has 0 mock replies but the scene has 1 scripted line(s) and needs one reply per line`);
  });
  it("covers only the lines that will be spoken when --max-lines caps the script", () => {
    const short = valid.replace('["hello there"]', "[]").replace(`gm: [${GM}]`, "gm: []");
    expect(err(short)).toContain("scene 'one'");
    // One line per scene: scene one has 1 utterance (no evaluation yet); scene two still needs its reply.
    expect(err(short, { mode: "mock", maxLines: 1 })).toContain("scene 'two'");
    expect(parseShowcaseScript(valid.replace(`gm: [${GM}]`, "gm: []"), scenario, { mode: "mock", maxLines: 2 }).scenes[0]!.lines).toHaveLength(3);
  });
  it("computes the Game Master evaluations that a number of lines can trigger", () => {
    const one = scenario.script.scenes[0]!;
    const four = { ...one, exit_when: { any_of: [{ gm_detects: "a" }, { gm_detects: "b" }] as never } };
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => expectedGmEvaluations(one, n, 0))).toEqual([0, 0, 1, 1, 1, 2, 2]);
    expect(expectedGmEvaluations(one, 4, 2)).toBe(4); // 3 utterances per line: an evaluation after every line
    expect(expectedGmEvaluations(four, 3, 0)).toBe(2);
    expect(expectedGmEvaluations(scenario.script.scenes[1]!, 9, 1)).toBe(0); // no gm_detects condition
  });
});

describe("loadShowcaseScript", () => {
  it("loads the shipped showcase script for the extended scenario, covering every scene and AI character", async () => {
    const dir = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
    const sc = await loadScenario(dir);
    const s = await loadShowcaseScript(dir, sc, mock);
    expect(s.scenes.map((x) => x.scene)).toEqual(sc.script.scenes.map((x) => x.id));
    expect(s.scenes.map((x) => x.lines.length)).toEqual([6, 4, 6, 4, 4, 6]);
    expect(s.scenes.reduce((n, x) => n + x.lines.length, 0)).toBe(30);
    expect(s.scenes.reduce((n, x) => n + Object.values(x.mock.npc).reduce((m, r) => m + r.length, 0), 0)).toBe(20);
    // Live mode needs no mock section; a smaller --max-lines is still valid in mock mode.
    await expect(loadShowcaseScript(dir, sc, { mode: "live", maxLines: 1 })).resolves.toBeDefined();
    await expect(loadShowcaseScript(dir, sc, { mode: "mock", maxLines: 2 })).resolves.toBeDefined();
  });
  it("names the file when it is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-showcase-test-"));
    try {
      await expect(loadShowcaseScript(dir, scenario, mock)).rejects.toThrow(`${SHOWCASE_FILE}: the scenario has no showcase script (expected a ${SHOWCASE_FILE} file next to scenario.yaml)`);
      await writeFile(path.join(dir, SHOWCASE_FILE), valid);
      await expect(loadShowcaseScript(dir, scenario, mock)).resolves.toBeDefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("showcase.yaml size cap", () => {
  it("refuses a file larger than 256 KiB with a clear one-line error", () => {
    const huge = `${valid}\n# ${"x".repeat(256 * 1024)}\n`;
    expect(err(huge)).toBe(`${SHOWCASE_FILE}: the file is larger than 256 KiB`);
    expect(parseShowcaseScript(valid, scenario, mock)).toBeDefined();
  });
});

describe("facilitator steps (US-0016)", () => {
  const withFacts: Scenario = { ...scenario, roles: { ...scenario.roles, bot: { ...(scenario.roles.bot as object), hidden: ["fact one", "fact two"] } as Scenario["roles"][string] } };
  const step = (extra: string, at = "two") => valid.replace(`    lines:\n      - { role: pa, text: "hey bot" }\n`, `    lines:\n      - { role: pa, text: "hey bot" }\n      - { role: pa, text: "again" }\n${extra}`)
    .replace("bot: [\"hello there\"]", "bot: [\"hello there\", \"and again\"]").replace(/scene: two/, `scene: ${at}`);
  const parse = (text: string, o: Parameters<typeof parseShowcaseScript>[2] = mock) => parseShowcaseScript(text, withFacts, o);
  const fail = (text: string) => { try { parse(text); } catch (e) { expect(e).toBeInstanceOf(ShowcaseScriptError); return (e as Error).message; } throw new Error("expected an error"); };
  const ok = "    facilitator:\n      - { after_line: 1, release_hidden: { role: bot, fact: 2 } }\n";

  it("parses a release step and defaults to none", () => {
    expect(parse(step(ok)).scenes[1]!.facilitator).toEqual([{ afterLine: 1, role: "bot", fact: 2 }]);
    expect(parse(valid).scenes[0]!.facilitator).toEqual([]);
  });
  it("accepts the step with a --max-lines cap below its line (it is skipped when run), and in live mode", () => {
    expect(parse(step(ok.replace("after_line: 1", "after_line: 2")), { mode: "mock", maxLines: 1 }).scenes[1]!.facilitator).toHaveLength(1);
    expect(parse(step(ok), { mode: "live" })).toBeDefined();
  });
  it.each([
    ["a player role", "role: pb", "player role"],
    ["an unknown role", "role: ghost", "not a role in the scenario"],
    ["a prototype key", "role: __proto__", "not a role in the scenario"],
    ["fact 0", "fact: 0", "scenes.1.facilitator.0.release_hidden.fact"],
    ["fact 51", "fact: 51", "scenes.1.facilitator.0.release_hidden.fact"],
    ["a fact the role does not have", "fact: 3", "has 2 hidden fact(s)"],
    ["a fractional fact", "fact: 1.5", "scenes.1.facilitator.0.release_hidden.fact"],
  ])("refuses %s", (_name, edit, msg) => {
    expect(fail(step(ok.replace("role: bot", edit.startsWith("role") ? edit : "role: bot").replace("fact: 2", edit.startsWith("fact") ? edit : "fact: 2")))).toContain(msg);
  });
  it("refuses a line the scene does not have, a duplicate release and unknown keys", () => {
    expect(fail(step(ok.replace("after_line: 1", "after_line: 3")))).toContain("the scene has 2 scripted line(s)");
    expect(fail(step(ok + "      - { after_line: 2, release_hidden: { role: bot, fact: 2 } }\n"))).toContain("a second time");
    expect(fail(step(ok.replace("} }", "}, text: hi }")))).toMatch(/facilitator\.0/);
    expect(fail(step("    facilitator:\n      - { after_line: 0, release_hidden: { role: bot, fact: 1 } }\n"))).toContain("facilitator.0.after_line");
    expect(fail(step("    facilitator:\n      - { after_line: 1, whisper: { role: pa } }\n"))).toContain("facilitator.0");
  });
  it("refuses a character that is not in the scene", () => {
    const away: Scenario = { ...withFacts, script: { scenes: [withFacts.script.scenes[0]!, { ...withFacts.script.scenes[1]!, participants: ["pa"] }] } };
    expect(() => parseShowcaseScript(step(ok, "two").replace(/ {4}mock: \{ npc.*\n/, ""), away, { mode: "live" })).toThrow(/who is not in that scene/);
  });
});
