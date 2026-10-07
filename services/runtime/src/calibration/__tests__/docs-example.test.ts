import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadRubrics, loadScenario } from "@acr/script";
import { loadProbes } from "../probe-load.js";
import { ProbeSchema } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** The first fenced yaml block of docs/EVALUATOR.md that is a probe (the rubric example comes earlier). */
async function documentedProbe(): Promise<string> {
  const doc = await readFile(path.join(REPO, "docs", "EVALUATOR.md"), "utf8");
  const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const probe = blocks.find((b) => /^kind: single/m.test(b));
  if (!probe) throw new Error("no probe example in docs/EVALUATOR.md");
  return probe;
}

describe("the probe example in docs/EVALUATOR.md", () => {
  it("passes the probe schema", async () => {
    const r = ProbeSchema.safeParse(parse(await documentedProbe()));
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  });
  it("loads without a problem into the Friday scenario (rubric, scenes, roles, at least 2 lines per scored player)", async () => {
    const text = await documentedProbe();
    const id = (parse(text) as { id: string }).id;
    const scn = path.join(dir, "scn");
    await cp(path.join(REPO, "scenarios", "friday-escalation"), scn, { recursive: true });
    await rm(path.join(scn, "calibration"), { recursive: true, force: true });
    await mkdir(path.join(scn, "calibration"));
    await writeFile(path.join(scn, "calibration", `${id}.yaml`), text);
    const scenario = await loadScenario(scn);
    const { rubrics } = await loadRubrics(scn, scenario);
    const loaded = await loadProbes(scn, scenario, rubrics);
    expect(loaded.errors).toEqual([]);
    expect(loaded.probes.map((p) => p.id)).toEqual([id]);
  });
});
