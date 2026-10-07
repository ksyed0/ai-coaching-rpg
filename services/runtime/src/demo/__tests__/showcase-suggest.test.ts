import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../../main.js";
import { runDemo, type RunDeps } from "../runner.js";
import type { ShowcaseReport } from "../showcase-report.js";
// Whole-demo tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// US-0034 (AC-0124, AC-0126): the showcase's mock Game Master judges the CFO's earned_when condition: three no-suggestion verdicts in s4, then the
// suggestion (facilitator only), which the scripted facilitator release in s5 follows.
const EXTENDED = path.join(REPO_ROOT, "scenarios", "friday-escalation-extended");
const FACT = "Can approve a priced change request without escalation if it is fixed-fee and tied to a firm date";
const CONDITION = "A player has offered a fixed fee (not an estimate) tied to a firm delivery date, with a consequence for the supplier if that date is missed";
const SUGGESTED = "suggests releasing hidden fact number 1 of cfo (to the facilitator only: /release cfo 1)";

type Captured = { out: string[]; err: string[]; stdout: { write(s: string): void; isTTY?: boolean }; stderr: { write(s: string): void; isTTY?: boolean } };
const capture = (): Captured => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s) => { out.push(s); }, isTTY: false }, stderr: { write: (s) => { err.push(s); }, isTTY: false } };
};
// A private parent for every temp directory these runs create (AGENTS.md section 8).
let PARENT = "";
let savedTmp: string | undefined;
beforeAll(() => { PARENT = mkdtempSync(path.join(os.tmpdir(), "acr-suggest-parent-")); savedTmp = process.env.TMPDIR; process.env.TMPDIR = PARENT; });
afterAll(() => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; rmSync(PARENT, { recursive: true, force: true }); });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const tmp = async () => { const d = await mkdtemp(path.join(PARENT, "t-")); cleanups.push(() => rm(d, { recursive: true, force: true })); return d; };

const run = async (argv: string[], over: Partial<RunDeps> = {}) => {
  const c = capture();
  const r = await runDemo({
    argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, repoRoot: REPO_ROOT, version: "0.0.0-test", tempParent: PARENT,
    resolveLiveEnv: () => { throw new Error("the live environment must not be read here"); }, ...over,
  });
  return { ...r, stdout: c.out.join(""), stderr: c.err.join(""), showcase: r.report?.showcase as ShowcaseReport };
};
const result = (r: Awaited<ReturnType<typeof run>>, id: string) => r.report!.results.find((x) => x.id === id)!;
type Sys = { gm?: { calls: { system: string }[]; served?: { key: string; reply: string }[] } };
const at = (scene: string, index: number, fn: (a: { sys?: Sys; players?: Record<string, { inbox: unknown[] }> }) => void) => ({
  beforeLine: async (a: { sceneId: string; index: number; sys?: Sys; players?: Record<string, { inbox: unknown[] }> }) => { if (a.sceneId === scene && a.index === index) fn(a); },
});
const FAIL = ["--showcase", "--fast", "--no-color"];

describe("the Game Master's release suggestion in the showcase (mock mode)", () => {
  it("suggests once, in s4 after the no-suggestion verdicts, to the facilitator only; the checks stay at 14 and all pass", async () => {
    const dir = await tmp();
    const r = await run(["--showcase", "--fast", "--no-color", "--transcript", "t.md"], { cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(r.report!.results).toHaveLength(14);
    expect(r.report!.results.filter((x) => x.status !== "passed")).toEqual([]);
    expect(r.showcase.gm.suggestions).toEqual([expect.objectContaining({ sceneId: "s4_escalation_call", roleId: "cfo", fact: 1, autoRelease: false })]);
    expect(r.stdout).toContain(SUGGESTED);
    expect(r.stdout.indexOf(SUGGESTED)).toBeLessThan(r.stdout.indexOf("facilitator released hidden fact number 1 of cfo"));
    expect(result(r, "S-04").details).toContain("1 release suggestion(s) to the facilitator only (cfo #1 in s4_escalation_call)");
    expect(result(r, "S-06").details).toContain("4 of them earned_when checks");
    const md = readFileSync(path.join(dir, "t.md"), "utf8");
    expect(md).toContain("the Game Master suggested releasing hidden fact number 1 of cfo (facilitator only: /release cfo 1)");
    for (const hay of [r.stdout, md, JSON.stringify(r.report)]) expect(hay).not.toContain(FACT);
  });

  it("S-04 fails when the suggestions differ from the scripted true verdicts", async () => {
    const r = await run(FAIL, { showcaseHooks: at("s6_wrap_up", 0, ({ sys }) => { sys!.gm!.served!.push({ key: "s2_priya_call|earned:client_sponsor#1", reply: '{"verdict": true, "reasoning": "x"}' }); }) as never });
    expect(result(r, "S-04").status).toBe("failed");
    expect(result(r, "S-04").details).toMatch(/release suggestions .* differ from the scripted true earned_when verdicts/);
  });

  it("S-07 fails when a player receives a release suggestion", async () => {
    const hooks = at("s6_wrap_up", 0, ({ players }) => { players!.delivery_lead!.inbox.push({ type: "event", event: { seq: 9_100, ts: 1, sessionId: "demo", type: "gm.fact_earned", sceneId: "s4_escalation_call", roleId: "cfo", fact: 1, reasoning: "x" } }); });
    const r = await run(FAIL, { showcaseHooks: hooks as never });
    expect(result(r, "S-07").status).toBe("failed");
    expect(result(r, "S-07").details).toContain("received a gm.fact_earned event");
  });

  it("S-06 fails when an earned_when check prompt holds the hidden fact, and when it lacks its condition", async () => {
    const leak = await run(FAIL, { showcaseHooks: at("s5_final_terms", 0, ({ sys }) => { const c = sys!.gm!.calls.find((x) => x.system.includes("Earned-fact check:"))!; c.system += `\n${FACT}`; }) as never });
    expect(result(leak, "S-06").status).toBe("failed");
    const lost = await run(FAIL, { showcaseHooks: at("s5_final_terms", 0, ({ sys }) => { for (const c of sys!.gm!.calls) c.system = c.system.replace(JSON.stringify(CONDITION), "(gone)"); }) as never });
    expect(result(lost, "S-06").status).toBe("failed");
    expect(result(lost, "S-06").details).toContain("lacks the scene's condition");
  });

  it("without earned_when the showcase asks no earned_when check and suggests nothing (a scenario without it behaves as before)", async () => {
    const dir = await tmp();
    await cp(EXTENDED, dir, { recursive: true });
    const cfo = path.join(dir, "roles", "cfo.yaml");
    await writeFile(cfo, (await readFile(cfo, "utf8")).replace(/\nearned_when:\n {2}1: .*\n/, "\n"));
    const show = path.join(dir, "showcase.yaml");
    await writeFile(show, (await readFile(show, "utf8")).replace(/ {6}gm_earned:\n(?: {8}.*\n| {10}.*\n| {12}.*\n)+/g, ""));
    expect(await readFile(cfo, "utf8")).not.toContain("earned_when");
    expect(await readFile(show, "utf8")).not.toContain("gm_earned");
    const r = await run(["--showcase", "--fast", "--no-color", "--scenario", dir]);
    expect(r.report!.results.filter((x) => x.status !== "passed")).toEqual([]);
    expect(r.showcase.gm.suggestions).toEqual([]);
    expect(result(r, "S-04").details).toContain("no release suggestion");
    expect(result(r, "S-06").details).not.toContain("earned_when checks");
    expect(result(r, "S-06").details).toContain("all 37 captured prompts (20 AI character, 17 Game Master)"); // the calls of the run before US-0034
  });
});
