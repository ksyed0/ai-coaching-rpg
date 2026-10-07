import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { parseEvalConfig } from "../../evaluator/config.js";
import { loadProbes } from "../probe-load.js";
import { runJudge, MAX_REPEAT } from "../runner.js";
import { fakeJudge } from "./fake-judge.js";
import type { Judge } from "../judge.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cfgParsed = parseEvalConfig({}); if (!cfgParsed.ok) throw new Error("cfg");
const cfg = cfgParsed;
const dir = path.join(REPO, "scenarios/friday-escalation");

async function setup() {
  const scenario = await loadScenario(dir);
  const { rubrics } = await loadRubrics(dir, scenario);
  const { probes } = await loadProbes(dir, scenario, rubrics);
  const ids = rubrics.filter((r) => r.scope === "individual").flatMap((r) => r.criteria.map((c) => c.id));
  return { scenario, rubrics, probes, ids };
}
const judgeOf = (provider: Judge["provider"]): Judge => ({ label: "primary", model: "fake", family: "fake", provider });

describe("runJudge", () => {
  it("scores each probe through the real evaluator and records observed levels", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ transcript }) => (transcript.includes("consider it done") ? { discovery: 1 } : { discovery: 3 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.kind).toBe("single");
    if (o.kind === "single") expect(o.runs).toEqual([1]);
    expect(o.evidence[0]!.quotes.length).toBeGreaterThan(0);
  });
  it("scores every player of a contrast probe and maps them by role", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ role }) => ({ listening: role === "delivery_lead" ? 4 : 1 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "listening-contrast-01"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "contrast" && o.runs[0]).toEqual({ delivery_lead: 4, account_manager: 1 });
  });
  it("records an unreachable judge as unusable, not as a score", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({}), () => true);
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "single" && o.runs[0]).toBe("failed");
  });
  it("repeats, filters with --only and caps repeat", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    const out = await runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: 2, only: ["disc-l2"], allCriteria: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind === "single" && out[0]!.runs).toEqual([2, 2]);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: MAX_REPEAT + 1, allCriteria: true })).rejects.toThrow(/repeat/);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfg, { repeat: 1, only: ["missing"], allCriteria: true })).rejects.toThrow(/missing/);
  });
  it("narrows the rubric to the probe's criterion when allCriteria is false", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: false });
    const system = provider.calls[0]!.system;
    // The learning-objective lines name other criterion ids, so assert on the criteria listing, not the whole prompt.
    expect(system).toContain('Criterion id "discovery"');
    expect(system).toContain('use exactly these ids): discovery.');
    expect(system).not.toContain('Criterion id "negotiation"');
  });
  it("lists every individual criterion when allCriteria is true", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfg, { repeat: 1, allCriteria: true });
    for (const id of ids) expect(provider.calls[0]!.system).toContain(`Criterion id "${id}"`);
  });
});
