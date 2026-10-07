import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
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
    expect(r.probes.every((p) => p.source === "handwritten")).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/fewer than 20/);
  });
});
