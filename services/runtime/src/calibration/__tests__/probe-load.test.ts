import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { assignSplit, lintProbeSet, loadProbes, MIN_SET_PROBES } from "../probe-load.js";
import type { Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCEN = path.join(REPO, "scenarios/friday-escalation");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); await mkdir(path.join(dir, "calibration"), { recursive: true }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ctx() {
  const scenario = await loadScenario(SCEN);
  const { rubrics } = await loadRubrics(SCEN, scenario);
  return { scenario, rubrics };
}
const yaml = (o: string) => o.replace(/^\n/, "");
const good = yaml(`
kind: single
id: p1
criterion: discovery
source: handwritten
split: tune
subject: delivery_lead
expected: 1
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "Can you confirm by Friday?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that." }
  - { scene: s2_client_call, role: delivery_lead, text: "Consider it done." }
`);

describe("loadProbes", () => {
  it("returns no probes and a warning when there is no calibration directory", async () => {
    const { scenario, rubrics } = await ctx();
    const r = await loadProbes(path.join(dir, "nope"), scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no calibration directory/);
  });
  it("loads a valid probe", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes.map((p) => p.id)).toEqual(["p1"]);
  });
  it("reports every problem in one list", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good.replace("criterion: discovery", "criterion: nonexistent"));
    await writeFile(path.join(dir, "calibration", "p2.yaml"), good.replace("id: p1", "id: p2").replace("subject: delivery_lead", "subject: client_sponsor"));
    await writeFile(path.join(dir, "calibration", "p3.yaml"), good.replace("id: p1", "id: other"));
    await writeFile(path.join(dir, "calibration", "p4.yaml"), good.replace("id: p1", "id: p4").replace(/ {2}- \{ scene: s2_client_call, role: delivery_lead, text: "Consider it done." \}\n/, ""));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/p1.yaml.*criterion/s);
    expect(r.errors.join("\n")).toMatch(/p2.yaml.*player/s);
    expect(r.errors.join("\n")).toMatch(/p3.yaml.*id.*file name/s);
    expect(r.errors.join("\n")).toMatch(/p4.yaml.*at least 2/s);
  });
  it("refuses an oversized file, an alias bomb and a prototype key without throwing", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "big.yaml"), "x: " + "a".repeat(200 * 1024));
    await writeFile(path.join(dir, "calibration", "bomb.yaml"), "a: &a [1,1,1,1,1,1,1,1,1,1,1]\n" + Array.from({ length: 30 }, (_, i) => `b${i}: *a`).join("\n"));
    await writeFile(path.join(dir, "calibration", "proto.yaml"), good.replace("id: p1", "id: proto") + "__proto__: { polluted: 1 }\n");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors.length).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("ignores drafts and targets.yaml", async () => {
    const { scenario, rubrics } = await ctx();
    await mkdir(path.join(dir, "calibration", "drafts"), { recursive: true });
    await writeFile(path.join(dir, "calibration", "drafts", "d.yaml"), "not a probe");
    await writeFile(path.join(dir, "calibration", "targets.yaml"), "contrastOrdering: 0.9\n");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toEqual([]);
  });
});

const mk = (id: string, criterion: string, expected: 1 | 2 | 3 | 4, split: "tune" | "holdout" = "tune"): Probe => ({
  kind: "single", id, criterion, source: "handwritten", drafter: null, approved_by: null, approved_at: null, split,
  subject: "delivery_lead", expected, transcript: [{ scene: "s1", role: "a", text: "x" }, { scene: "s1", role: "a", text: "y" }],
});

describe("lintProbeSet and assignSplit", () => {
  it("warns about a thin set, thin criteria, thin holdout and mid-heavy levels", () => {
    const w = lintProbeSet([mk("a", "discovery", 2), mk("b", "discovery", 3), mk("c", "listening", 3)]).join("\n");
    expect(w).toMatch(new RegExp(`fewer than ${MIN_SET_PROBES}`));
    expect(w).toMatch(/discovery.*fewer than 4/s);
    expect(w).toMatch(/holdout/);
    expect(w).toMatch(/level 1.*level 4|levels 1 and 4/s);
  });
  it("is deterministic, never changes with order, and splits roughly by the percentage", () => {
    expect(assignSplit("probe-1", 10)).toBe(assignSplit("probe-1", 10));
    const ids = Array.from({ length: 400 }, (_, i) => `probe-${i}`);
    const tune50 = ids.filter((id) => assignSplit(id, 10) === "tune").length;
    const tune70 = ids.filter((id) => assignSplit(id, 100) === "tune").length;
    expect(tune50).toBeGreaterThan(160); expect(tune50).toBeLessThan(240);
    expect(tune70).toBeGreaterThan(240); expect(tune70).toBeLessThan(320);
  });
});
