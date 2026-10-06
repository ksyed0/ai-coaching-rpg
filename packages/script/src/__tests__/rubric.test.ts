import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { LEVEL_LABELS, MAX_RUBRIC_BYTES, RubricSchema, loadRubrics, validateRubrics, type Rubric } from "../index.js";

const level = (anchor: string, examples: string[] = []) => ({ anchor, examples });
const criterion = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `Name of ${id}`, description: "What this criterion is about.", what_to_look_for: ["an observable thing"],
  levels: {
    1: level("Does not do the thing at all."), 2: level("Does the thing in part.", ["a phrase"]),
    3: level("Does the thing well."), 4: level("Does the thing so well it changes the room.", ["another phrase"]),
  },
  ...over,
});
const rubric = (id: string, ids: string[], over: Record<string, unknown> = {}) => ({
  id, name: id, scope: "individual", version: "1", criteria: ids.map((i) => criterion(i)), ...over,
});

describe("RubricSchema", () => {
  it("accepts a four-level behaviourally anchored rubric and exposes the level labels", () => {
    const r = RubricSchema.parse(rubric("r1", ["a", "b"]));
    expect(r.criteria).toHaveLength(2);
    expect(LEVEL_LABELS).toEqual({ 1: "Not yet demonstrated", 2: "Developing", 3: "Proficient", 4: "Advanced" });
  });
  it("requires all four levels, with anchors", () => {
    const c = criterion("a") as { levels: Record<string, unknown> };
    delete c.levels[3];
    expect(() => RubricSchema.parse({ ...rubric("r1", []), criteria: [c] })).toThrow(/levels/);
    expect(() => RubricSchema.parse({ ...rubric("r1", []), criteria: [criterion("a", { levels: { 1: level(""), 2: level("x", ["e"]), 3: level("y"), 4: level("z", ["e"]) } })] })).toThrow();
  });
  it("rejects unsafe ids and an unknown scope", () => {
    expect(() => RubricSchema.parse(rubric("../x", ["a"]))).toThrow();
    expect(() => RubricSchema.parse(rubric("r1", ["A b"]))).toThrow();
    expect(() => RubricSchema.parse(rubric("r1", ["a"], { scope: "team" }))).toThrow();
  });
});

describe("validateRubrics", () => {
  const lo = (id: string, criteria: string[]) => ({ id, statement: "s", rubric_criteria: criteria });
  it("accepts a consistent set", () => {
    const r = [RubricSchema.parse(rubric("r1", ["a", "b"]))];
    expect(validateRubrics(r, [lo("LO1", ["a", "b"])])).toEqual({ errors: [], warnings: [] });
  });
  it("errors on duplicate criterion ids, also across rubrics", () => {
    const r = [RubricSchema.parse(rubric("r1", ["a"])), RubricSchema.parse(rubric("r2", ["a"]))];
    expect(validateRubrics(r, []).errors.join(" ")).toMatch(/criterion id 'a' is used by both r1 and r2/);
    const dup = RubricSchema.parse(rubric("r1", ["a", "a"]));
    expect(validateRubrics([dup], []).errors.join(" ")).toMatch(/'a' is defined more than once in r1/);
  });
  it("errors when a learning objective names a criterion no rubric defines", () => {
    const r = [RubricSchema.parse(rubric("r1", ["a"]))];
    expect(validateRubrics(r, [lo("LO2", ["a", "zzz"])]).errors).toEqual(["learning objective LO2 maps to criterion 'zzz', which no loaded rubric defines"]);
  });
  it("errors when level 2 or 4 has no example phrase", () => {
    const c = criterion("a", { levels: { 1: level("one"), 2: level("two"), 3: level("three"), 4: level("four", ["e"]) } });
    const r = [RubricSchema.parse(rubric("r1", [], { criteria: [c] }))];
    expect(validateRubrics(r, []).errors.join(" ")).toMatch(/level 2 needs at least one example phrase/);
  });
});

describe("loadRubrics", () => {
  const withDir = async (files: Record<string, string>, fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-rubrics-"));
    try {
      await mkdir(path.join(dir, "rubrics"));
      for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, "rubrics", name), text);
      await fn(dir);
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const scenario = (rubrics: string[], los = [{ id: "LO1", statement: "s", rubric_criteria: ["a"] }]) => ({ meta: { rubrics, learning_objectives: los } });

  it("loads the rubrics the scenario names, in order", async () => {
    await withDir({ "r1.yaml": stringify(rubric("r1", ["a"])), "r2.yaml": stringify(rubric("r2", ["b"], { scope: "group" })) }, async (dir) => {
      const res = await loadRubrics(dir, scenario(["r1", "r2"]));
      expect(res.errors).toEqual([]);
      expect(res.rubrics.map((r: Rubric) => r.id)).toEqual(["r1", "r2"]);
    });
  });
  it("treats an empty rubrics list as 'no rubrics' with a warning, even without a rubrics dir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-rubrics-"));
    try {
      const res = await loadRubrics(dir, scenario([]));
      expect(res.rubrics).toEqual([]);
      expect(res.errors).toEqual([]);
      expect(res.warnings.join(" ")).toMatch(/no rubrics/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("reports a missing file, a wrong id, bad yaml, a bad schema and an unsafe id as errors", async () => {
    await withDir({ "bad.yaml": "id: [", "wrong.yaml": stringify(rubric("other", ["a"])), "shape.yaml": stringify({ id: "shape", name: "x" }) }, async (dir) => {
      const res = await loadRubrics(dir, scenario(["missing", "bad", "wrong", "shape", "../evil"], []));
      const text = res.errors.join("\n");
      expect(text).toMatch(/missing\.yaml.*cannot be read/);
      expect(text).toMatch(/bad\.yaml.*not valid YAML/);
      expect(text).toMatch(/wrong\.yaml.*id 'other' does not match/);
      expect(text).toMatch(/shape\.yaml/);
      expect(text).toMatch(/rubric id '\.\.\/evil' is not a safe name/);
      expect(res.rubrics).toEqual([]);
    });
  });
  it("refuses an oversized file and a YAML alias bomb", async () => {
    const huge = `id: big\nname: ${"x".repeat(MAX_RUBRIC_BYTES + 1)}\n`;
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 30 }, (_, i) => `b${i}: *a`)].join("\n");
    await withDir({ "big.yaml": huge, "bomb.yaml": bomb }, async (dir) => {
      const res = await loadRubrics(dir, scenario(["big", "bomb"], []));
      expect(res.errors.join("\n")).toMatch(/big\.yaml.*larger than/);
      expect(res.errors.join("\n")).toMatch(/bomb\.yaml/);
    });
  });
  it("validates learning objectives against the loaded criteria", async () => {
    await withDir({ "r1.yaml": stringify(rubric("r1", ["a"])) }, async (dir) => {
      const res = await loadRubrics(dir, scenario(["r1"], [{ id: "LO9", statement: "s", rubric_criteria: ["nope"] }]));
      expect(res.errors.join(" ")).toMatch(/LO9 maps to criterion 'nope'/);
    });
  });
});

describe("the shipped scenarios", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../scenarios");
  it.each(["friday-escalation", "friday-escalation-extended"])("%s: every rubric loads and every learning objective resolves", async (name) => {
    const { loadScenario } = await import("../index.js");
    const dir = path.join(root, name);
    const scenario = await loadScenario(dir);
    const res = await loadRubrics(dir, scenario);
    expect(res.errors).toEqual([]);
    expect(res.rubrics.map((r) => r.id)).toEqual(["individual_delivery_v2", "group_collaboration_v1"]);
    const individual = res.rubrics[0]!.criteria.map((c) => c.id);
    expect(individual).toEqual(["discovery", "listening", "negotiation", "commercial_judgement", "stakeholder_management", "team_alignment", "role_clarity"]);
    expect(res.rubrics[1]!.criteria.map((c) => c.id)).toEqual(["shared_understanding", "decision_quality", "role_clarity_group", "escalation_discipline"]);
  });
});

describe("scenario hygiene", () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../scenarios");
  it("the two copies of each rubric file stay byte-identical", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["individual_delivery_v2.yaml", "group_collaboration_v1.yaml"]) {
      const a = await readFile(path.join(root, "friday-escalation", "rubrics", f));
      const b = await readFile(path.join(root, "friday-escalation-extended", "rubrics", f));
      expect(a.equals(b), f).toBe(true);
    }
  });
  it("learning-objective ids follow the safe id pattern (they are printed in reports)", async () => {
    const { LearningObjectiveSchema } = await import("../index.js");
    expect(LearningObjectiveSchema.parse({ id: "LO1", statement: "s", rubric_criteria: [] }).id).toBe("LO1");
    for (const bad of ["LO 1", "LO|1", "../x", "", "x".repeat(65), "<b>"]) expect(() => LearningObjectiveSchema.parse({ id: bad, statement: "s", rubric_criteria: [] })).toThrow();
  });
  it("no rubric example or anchor names a scenario figure or character", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const f of ["individual_delivery_v2.yaml", "group_collaboration_v1.yaml"]) {
      const text = await readFile(path.join(root, "friday-escalation-extended", "rubrics", f), "utf8");
      expect(text, f).not.toMatch(/48 thousand|Helena|Priya|three weeks after go-live/);
    }
  });
});

describe("bounded rubric reads", () => {
  it("a rubric file one byte over the cap is refused with the size message, with no separate size check", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-rb-"));
    try {
      await mkdir(path.join(dir, "rubrics"));
      await writeFile(path.join(dir, "rubrics", "big.yaml"), "x".repeat(MAX_RUBRIC_BYTES + 1));
      await mkdir(path.join(dir, "rubrics", "dir.yaml"));
      const res = await loadRubrics(dir, { meta: { rubrics: ["big", "dir"], learning_objectives: [] } });
      expect(res.errors.join("\n")).toMatch(/big\.yaml: the file is larger than 256 KiB/);
      expect(res.errors.join("\n")).toMatch(/dir\.yaml: the file cannot be read/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
