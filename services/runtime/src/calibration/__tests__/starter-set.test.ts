import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { modelFamily } from "../judge.js";
import { loadProbes } from "../probe-load.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("Friday starter probe set", () => {
  it("validates against the scenario's rubrics and covers every level of discovery", async () => {
    const dir = path.join(REPO, "scenarios/friday-escalation");
    const scenario = await loadScenario(dir);
    const { rubrics } = await loadRubrics(dir, scenario);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toHaveLength(8);
    const disc = r.probes.filter((p) => p.kind === "single" && p.criterion === "discovery").map((p) => (p.kind === "single" ? p.expected : 0));
    expect(disc.sort()).toEqual([1, 2, 3, 4]);
    expect(r.probes.filter((p) => p.kind === "contrast")).toHaveLength(2);
    // R26: agent-drafted starter probes, approved by the owner in chat (2026-10-07)
    for (const p of r.probes) {
      expect({ id: p.id, source: p.source, drafter: p.drafter, approved_by: p.approved_by, approved_at: p.approved_at }).toEqual({
        id: p.id, source: "drafted", drafter: "claude-sonnet-5-5", approved_by: "Kamal", approved_at: "2026-10-07T20:30:00-04:00",
      });
    }
    // the drafter's family is neither judge's, so the report raises no self-agreement warning for these probes
    expect(modelFamily("claude-sonnet-5-5")).toBe("claude");
    for (const judgeModel of ["gemma-4-31b-it-qat-mxfp4", "holo3-35b-a3b", "OsaurusAI/Holo3-35B-A3B-JANGTQ4"]) expect(modelFamily(judgeModel)).not.toBe("claude");
    expect(r.warnings.join("\n")).toMatch(/fewer than 20/);
    // 10 expectations with a single level 2 and a single level 3 (10% each): the balance warning is legitimate for the thin starter set
    expect(r.warnings.filter((w) => w.startsWith("expected levels are unbalanced")).map((w) => w.slice(0, 55))).toEqual([
      "expected levels are unbalanced: level 2 has 1 of 10 exp",
      "expected levels are unbalanced: level 3 has 1 of 10 exp",
    ]);
    expect(r.warnings.filter((w) => w.includes("not scored"))).toEqual([]);
  });
});
