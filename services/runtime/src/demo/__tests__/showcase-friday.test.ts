import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadScenario, validateScenario, type PlayerRole } from "@acr/script";
import { REPO_ROOT } from "../../main.js";
import { NEGATIVE_CUTS, buildShowcaseCases, lastNegativeLine } from "../../gm-eval/cases.js";
import { runDemo, type RunDeps } from "../runner.js";
import { SHOWCASE_CHECKS } from "../showcase.js";
import { loadShowcaseScript } from "../showcase-script.js";
import type { ShowcaseReport } from "../showcase-report.js";
// US-0040: the original Friday Escalation scenario (esc-scope-creep-01) has its own showcase script and plays in the showcase demo.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const DIR = path.join(REPO_ROOT, "scenarios", "friday-escalation");
const PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-friday-parent-"));
afterAll(() => rmSync(PARENT, { recursive: true, force: true }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

/** A line "recites" a fact when it holds most of the fact's content words (4+ letters, numbers; punctuation and case ignored), so a paraphrase counts, not only the exact words. */
const words = (t: string): string[] => t.toLowerCase().replace(/(\d),(\d)/g, "$1$2").split(/[^a-z0-9-]+/).map((w) => w.replace(/^-+|-+$/g, "")).filter((w) => w.length >= 4 || /^\d/.test(w));
const recites = (line: string, fact: string): boolean => {
  const f = [...new Set(words(fact))]; const l = new Set(words(line));
  return f.length > 0 && f.filter((w) => l.has(w)).length / f.length >= 0.6;
};

const run = async (argv: string[]) => {
  const out: string[] = []; const err: string[] = [];
  const deps: RunDeps = {
    argv, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false },
    env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test", tempParent: PARENT,
    resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); },
  };
  const r = await runDemo(deps);
  return { ...r, stdout: out.join(""), stderr: err.join(""), showcase: r.report?.showcase as ShowcaseReport };
};

describe("scenarios/friday-escalation/showcase.yaml (US-0040)", () => {
  it("covers every scene with lines by player roles in that scene, and npc/gm mocks for the AI character", async () => {
    const sc = await loadScenario(DIR);
    expect(validateScenario(sc)).toEqual({ errors: [], warnings: [] });
    const s = await loadShowcaseScript(DIR, sc, { mode: "mock" });
    expect(s.scenes.map((x) => x.scene)).toEqual(sc.script.scenes.map((x) => x.id));
    expect(s.scenes.map((x) => x.lines.length)).toEqual([6, 4, 6]);
    expect(s.scenes.map((x) => Object.keys(x.mock.npc))).toEqual([[], ["client_sponsor"], []]);
    expect(s.scenes.map((x) => x.mock.gmEarned.map((g) => `${g.role}#${g.fact}`))).toEqual([[], ["client_sponsor#1"], []]);
    await expect(loadShowcaseScript(DIR, sc, { mode: "live", maxLines: 1 })).resolves.toBeDefined();
  });

  it("scripts a tolerant and a malformed Game Master reply, as the extended script does", async () => {
    const text = readFileSync(path.join(DIR, "showcase.yaml"), "utf8");
    expect(text).toContain("kind: tolerant");
    expect(text).toContain("kind: malformed");
  });

  it("leaks no secret: no line recites another role's private fact before its owner stated it in play, and none recites an AI character's hidden fact", async () => {
    for (const dirName of ["friday-escalation", "friday-escalation-extended"]) {
      const dir = path.join(REPO_ROOT, "scenarios", dirName);
      const sc = await loadScenario(dir);
      const script = await loadShowcaseScript(dir, sc, { mode: "mock" });
      const players = Object.values(sc.roles).filter((r): r is PlayerRole => r.type === "player");
      const hidden = Object.values(sc.roles).flatMap((r) => (r.type === "npc" ? r.hidden : []));
      expect(hidden.length, dirName).toBeGreaterThan(0);
      // The detector is lexical (share of the fact's content words in the line), so it flags paraphrases but also shared vocabulary. Accepted, line by line:
      //  - extended s2_priya_call line 3 (delivery_lead, overlap 0.63): "Adding new code to ingestion now puts the launch date at risk..." shares words with the tech lead's
      //    private fact "Adding the module before go-live puts the go-live date at real risk"; the tech lead raised the same risk in the huddle in other words ("anything we add now
      //    competes with go-live"). Left as it was: changing extended lines would rebuild tests/gm-cases.
      //  - the original's s2 line 4 says the same thing in new words (overlap 0.50): below the 0.6 threshold, so it needs no exemption.
      const exempt = (dir: string, scene: string, index: number, fact: string) => dir === "friday-escalation-extended" && scene === "s2_priya_call" && index === 2 && fact === "Adding the module before go-live puts the go-live date at real risk";
      const said: { role: string; text: string }[] = []; // in play order
      for (const entry of script.scenes) {
        for (const [index, line] of entry.lines.entries()) {
          for (const owner of players.filter((p) => p.id !== line.role)) {
            for (const fact of owner.private_facts.filter((f) => !exempt(dirName, entry.scene, index, f))) {
              if (!recites(line.text, fact)) continue;
              // allowed only when the owner already said it earlier in play
              expect(said.some((x) => x.role === owner.id && recites(x.text, fact)), `${dirName} ${entry.scene}: ${line.role} recites ${owner.id}'s private fact "${fact}" before ${owner.id} said it`).toBe(true);
            }
          }
          for (const fact of hidden) expect(recites(line.text, fact), `${dirName} ${entry.scene}: ${line.role} recites a hidden fact "${fact}"`).toBe(false);
          said.push(line);
        }
      }
    }
  });

  it("Priya's reply to the line that earns her fact does not ask for the risk to be explained (the earned verdict and the mock reply agree)", async () => {
    for (const [dirName, scene] of [["friday-escalation", "s2_client_call"], ["friday-escalation-extended", "s2_priya_call"]] as const) {
      const dir = path.join(REPO_ROOT, "scenarios", dirName);
      const script = await loadShowcaseScript(dir, await loadScenario(dir), { mode: "mock" });
      const s2 = script.scenes.find((x) => x.scene === scene)!;
      expect(s2.lines[1]!.text, dirName).toMatch(/not safely before go-live/); // the risk and the phased offer, the line the earned verdict follows
      expect(s2.mock.npc.client_sponsor![1]!, dirName).not.toMatch(/walk me through the risk/i);
    }
  });

  it("the recital detector is meaningful: it catches a paraphrase, ignores an unrelated line", () => {
    expect(recites("Our delivery cost is 2400 per person-day and the margin floor on a change request is 20 percent", "Your delivery cost is 2,400 per person-day and the margin floor on any change request is 20 percent")).toBe(true);
    expect(recites("The renewal is worth about three times what this programme is", "The renewal is worth roughly three times this programme")).toBe(true);
    expect(recites("Let us book the review for Thursday", "The renewal is worth roughly three times this programme")).toBe(false);
  });

  it("labels its negative controls: scene 1 not agreed after 3 and 4 lines, scene 2 after 2, scene 3 after 1 and 3", async () => {
    expect(NEGATIVE_CUTS["esc-scope-creep-01"]).toEqual({ s1_huddle: [3, 4], s2_client_call: [2], s3_internal_wrap: [1, 3] });
    expect([lastNegativeLine("esc-scope-creep-01", "s1_huddle"), lastNegativeLine("esc-scope-creep-01", "s2_client_call"), lastNegativeLine("esc-scope-creep-01", "s3_internal_wrap")]).toEqual([4, 2, 3]);
    const sc = await loadScenario(DIR);
    const cases = buildShowcaseCases(sc, await loadShowcaseScript(DIR, sc, { mode: "mock" }));
    expect(cases.map((c) => c.id)).toEqual(["s1_huddle:full", "s1_huddle:cut-3", "s1_huddle:cut-4", "s2_client_call:full", "s2_client_call:cut-2", "s3_internal_wrap:full", "s3_internal_wrap:cut-1", "s3_internal_wrap:cut-3"]);
    expect(cases.map((c) => c.label)).toEqual([true, false, false, true, false, true, false, false]);
    expect(cases.find((c) => c.id === "s3_internal_wrap:cut-3")!.dialogue.at(-1)!.text).toMatch(/Someone should also tell the wider team/);
  });

  it("plays in the mock showcase: every check passes, 16 scripted lines, 4 AI replies, all 3 scenes ended by the Game Master, Priya's fact suggested once", async () => {
    const { exitCode, report, showcase, stderr, stdout } = await run(["--showcase", "--fast", "--no-color", "--scenario", DIR]);
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.summary).toEqual({ passed: SHOWCASE_CHECKS.length, failed: 0, skipped: 0 });
    expect(stderr).toBe("");
    expect(showcase.playerLines).toBe(16);
    expect(showcase.npcReplies).toBe(4);
    expect(showcase.fallbackLines).toBe(0);
    expect(showcase.gm).toMatchObject({ evaluations: 6, verdictsTrue: 3, verdictsFalse: 3, exitedScenes: ["s1_huddle", "s2_client_call", "s3_internal_wrap"], reasks: 1 });
    expect(showcase.gm.via.tolerant).toBe(1);
    expect(showcase.scenes.map((s) => s.exitReason)).toEqual(["gm_detects", "gm_detects", "gm_detects"]);
    expect(showcase.facilitatorAdvances).toBe(0);
    expect(showcase.observations).toEqual([]);
    expect(showcase.gm.suggestions).toEqual([expect.objectContaining({ sceneId: "s2_client_call", roleId: "client_sponsor", fact: 1, autoRelease: false })]);
    expect(stdout).toContain("/release client_sponsor 1");
  });

  it("a scene with NO Game Master condition still ends by the facilitator advance without failing S-14 (generic relaxation)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-friday-nocond-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await cp(DIR, dir, { recursive: true });
    const file = path.join(dir, "script.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace(/\n\s+- gm_detects: "the team has assigned an owner and a next action for each follow-up"/, ""));
    expect(await readFile(file, "utf8")).not.toContain("assigned an owner");
    const { exitCode, report, showcase } = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(showcase.scenes.map((s) => s.exitReason)).toEqual(["gm_detects", "gm_detects", "facilitator_advance"]);
    expect(showcase.observations).toEqual(["s3_internal_wrap has no Game Master exit condition; the facilitator advanced after its scripted lines"]);
  });

  it("still fails S-14 when a scene WITH a Game Master condition needs the advance", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-friday-variant-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await cp(DIR, dir, { recursive: true });
    const file = path.join(dir, "showcase.yaml");
    const yaml = (await readFile(file, "utf8")).replace('"verdict": true}\'\n\n  - scene: s2', '"verdict": false}\'\n\n  - scene: s2');
    await writeFile(file, yaml);
    const { exitCode, report } = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(exitCode).toBe(1);
    expect(report!.results.filter((r) => r.status === "failed").map((r) => r.id)).toEqual(["S-14"]);
    expect(report!.results.find((r) => r.id === "S-14")!.details).toMatch(/^scene\(s\) s1_huddle ended by facilitator advance/);
  });
});
