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
    await expect(loadShowcaseScript(DIR, sc, { mode: "live", maxLines: 1 })).resolves.toBeDefined();
  });

  it("scripts a tolerant and a malformed Game Master reply, as the extended script does", async () => {
    const text = readFileSync(path.join(DIR, "showcase.yaml"), "utf8");
    expect(text).toContain("kind: tolerant");
    expect(text).toContain("kind: malformed");
  });

  it("does not put the players' private facts or Priya's hidden fact into any scripted line", async () => {
    const sc = await loadScenario(DIR);
    const s = await loadShowcaseScript(DIR, sc, { mode: "mock" });
    const spoken = s.scenes.flatMap((x) => x.lines.map((l) => l.text)).join("\n").toLowerCase();
    const secrets = [
      ...Object.values(sc.roles).filter((r): r is PlayerRole => r.type === "player").flatMap((r) => r.private_facts),
      ...Object.values(sc.roles).flatMap((r) => (r.type === "npc" ? r.hidden : [])),
    ];
    expect(secrets.length).toBeGreaterThan(0);
    for (const f of secrets) expect(spoken, f).not.toContain(f.toLowerCase());
    expect(spoken).not.toMatch(/three times|decision maker|6 person-weeks|six person-weeks/);
  });

  it("labels its negative controls: scene 1 not agreed after 3 and 4 lines, scene 2 after 2; scene 3 has no condition", async () => {
    expect(NEGATIVE_CUTS["esc-scope-creep-01"]).toEqual({ s1_huddle: [3, 4], s2_client_call: [2] });
    expect([lastNegativeLine("esc-scope-creep-01", "s1_huddle"), lastNegativeLine("esc-scope-creep-01", "s2_client_call"), lastNegativeLine("esc-scope-creep-01", "s3_internal_wrap")]).toEqual([4, 2, 0]);
    const sc = await loadScenario(DIR);
    const cases = buildShowcaseCases(sc, await loadShowcaseScript(DIR, sc, { mode: "mock" }));
    expect(cases.map((c) => c.id)).toEqual(["s1_huddle:full", "s1_huddle:cut-3", "s1_huddle:cut-4", "s2_client_call:full", "s2_client_call:cut-2"]);
    expect(cases.map((c) => c.label)).toEqual([true, false, false, true, false]);
  });

  it("plays in the mock showcase: every check passes, 16 scripted lines, 4 AI replies, scene 3 ended by the facilitator advance (it has no Game Master condition)", async () => {
    const { exitCode, report, showcase, stderr } = await run(["--showcase", "--fast", "--no-color", "--scenario", DIR]);
    expect(report!.results.filter((r) => r.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(report!.summary).toEqual({ passed: SHOWCASE_CHECKS.length, failed: 0, skipped: 0 });
    expect(stderr).toBe("");
    expect(showcase.playerLines).toBe(16);
    expect(showcase.npcReplies).toBe(4);
    expect(showcase.fallbackLines).toBe(0);
    expect(showcase.gm).toMatchObject({ evaluations: 4, verdictsTrue: 2, verdictsFalse: 2, exitedScenes: ["s1_huddle", "s2_client_call"], reasks: 1 });
    expect(showcase.gm.via.tolerant).toBe(1);
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
