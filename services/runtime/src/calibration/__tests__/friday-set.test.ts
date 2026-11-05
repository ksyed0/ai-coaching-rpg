import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { modelFamily } from "../judge.js";
import { loadProbes, lintProbeSet } from "../probe-load.js";
import { STARTER_IDS } from "./starter-copy.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const STARTERS = STARTER_IDS;
const UNSCORED = [
  ["listening-l3-1", "delivery_lead"], ["listening-l4-1", "delivery_lead"], ["listening-l4-1", "tech_lead"],
  ["role_clarity-l2-1", "delivery_lead"], ["role_clarity-l3-1", "delivery_lead"], ["role_clarity-l4-1", "delivery_lead"],
  ["team_alignment-l2-1", "delivery_lead"], ["team_alignment-l3-1", "tech_lead"], ["team_alignment-l3-1", "delivery_lead"],
  ["team_alignment-l4-1", "delivery_lead"], ["team_alignment-l4-1", "tech_lead"],
].map(([id, role]) => `${id}.yaml: ${role} speaks 2 times but is not scored (costs a model call); give them one line or make them a subject`);

async function load() {
  const dir = path.join(REPO, "scenarios/friday-escalation");
  const scenario = await loadScenario(dir);
  const { rubrics } = await loadRubrics(dir, scenario);
  return loadProbes(dir, scenario, rubrics);
}

describe("Friday calibration set", () => {
  it("validates against the scenario's rubrics and has no loader errors", async () => {
    const r = await load();
    expect(r.errors).toEqual([]);
  });

  it("is big enough: at least 20 probes, 5 real excerpts and 10 holdout", async () => {
    const { probes } = await load();
    expect(probes.length).toBeGreaterThanOrEqual(20);
    expect(probes.filter((p) => p.source === "excerpt").length).toBeGreaterThanOrEqual(5);
    expect(probes.filter((p) => p.split === "holdout").length).toBeGreaterThanOrEqual(10);
    expect(probes.filter((p) => p.kind === "contrast")).toHaveLength(2);
    expect(probes.every((p) => p.split === "tune" || p.split === "holdout")).toBe(true);
  });

  it("represents every level 1 to 4 at least 3 times across expected levels (singles and contrast players)", async () => {
    const { probes } = await load();
    const counts = new Map<number, number>();
    for (const p of probes) {
      const levels = p.kind === "single" ? [p.expected] : Object.values(p.players);
      for (const l of levels) if (typeof l === "number") counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    for (const level of [1, 2, 3, 4]) expect(counts.get(level) ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("lints with no thin-set, thin-holdout or level-balance warning", async () => {
    const { probes, warnings } = await load();
    const all = [...warnings, ...lintProbeSet(probes)];
    expect(all.filter((w) => /fewer than|only \d+ holdout|unbalanced|mid-heavy|thin/.test(w))).toEqual([]);
  });

  it("has exactly the 11 known unscored-speaker warnings and no other warning, so a new one fails here", async () => {
    const { probes, warnings } = await load();
    expect([...warnings, ...lintProbeSet(probes)].sort()).toEqual([...UNSCORED].sort());
  });

  it("puts every criterion with at least 2 probes in both splits where it has the probes, and reports the rest", async () => {
    const { probes } = await load();
    const by = new Map<string, Set<string>>();
    for (const p of probes) by.set(p.criterion, (by.get(p.criterion) ?? new Set()).add(p.split ?? "none"));
    for (const [c, splits] of by) expect([...splits].sort(), c).toEqual(["holdout", "tune"]);
  });

  it("keeps the 8 starter probes drafted by the agent and approved by the owner in chat (R26), with their hand-set fields", async () => {
    const { probes } = await load();
    const starters = probes.filter((p) => STARTERS.includes(p.id));
    expect(starters.map((p) => p.id).sort()).toEqual([...STARTERS].sort());
    for (const p of starters) {
      expect({ id: p.id, source: p.source, drafter: p.drafter, approved_by: p.approved_by, approved_at: p.approved_at }).toEqual({
        id: p.id, source: "drafted", drafter: "claude-sonnet-5-5", approved_by: "Kamal", approved_at: "2026-10-07T19:58:00-04:00",
      });
    }
    const disc = starters.filter((p) => p.kind === "single" && p.criterion === "discovery").map((p) => (p.kind === "single" ? p.expected : 0));
    expect(disc.sort()).toEqual([1, 2, 3, 4]);
  });

  it("records provenance per source: drafted probes by claude-sonnet-5-5, excerpts with no drafter, all approved by Kamal with a time", async () => {
    const { probes } = await load();
    for (const p of probes) {
      expect(p.approved_by).toBe("Kamal");
      expect(p.approved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      if (p.source === "drafted") expect(p.drafter).toBe("claude-sonnet-5-5");
      else if (p.source === "excerpt") expect(p.drafter).toBeNull();
      else throw new Error(`${p.id}: unexpected source ${String(p.source)}`);
    }
    expect(probes.filter((p) => p.source === "excerpt").every((p) => p.id.startsWith("exc-"))).toBe(true);
  });

  it("uses a drafter family that is neither judge's, so the report raises no self-agreement warning", () => {
    expect(modelFamily("claude-sonnet-5-5")).toBe("claude");
    for (const judgeModel of ["gemma-4-31b-it-qat-mxfp4", "holo3-35b-a3b", "OsaurusAI/Holo3-35B-A3B-JANGTQ4"]) expect(modelFamily(judgeModel)).not.toBe("claude");
  });
});
