import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CriterionSchema, InjectSchema, LearningObjectiveSchema, NpcRoleSchema, PlayerRoleSchema, RubricSchema, SceneSchema,
  ScenarioMetaSchema, loadRubrics, loadScenario, validateScenario,
} from "../index.js";

/**
 * US-0020 / AC-0062, characterisation: the identifier rules of the scenario package as they were BEFORE they moved into one shared
 * module. Each row says whether the id is accepted by: [scenarioId] a scenario, role, scene, inject or `defer_to` id (lower case, digits,
 * `_`, `-`, any length), [lower64] a rubric id, criterion id or rubric file name (the same characters, 1 to 64), [mixed64] a
 * learning-objective id (upper case allowed, 1 to 64). The refactor must keep every row.
 */
const long = (c: string, n: number) => c.repeat(n);
const ROWS: [string, boolean, boolean, boolean][] = [
  ["a", true, true, true], ["a-b", true, true, true], ["a_b", true, true, true], ["a1", true, true, true], ["-", true, true, true], ["_", true, true, true],
  ["s1_huddle", true, true, true], ["con", true, true, true],
  ["A", false, false, true], ["Ab9", false, false, true], ["LO1", false, false, true], ["CON", false, false, true],
  ["a.b", false, false, false], ["a b", false, false, false], ["a/b", false, false, false], ["a\\b", false, false, false], ["../x", false, false, false],
  ["..", false, false, false], [".", false, false, false], [".hidden", false, false, false], ["", false, false, false],
  ["a\n", false, false, false], ["\na", false, false, false], ["a\0", false, false, false], ["a‮", false, false, false],
  ["é", false, false, false], ["ａ", false, false, false], ["a%2e", false, false, false], ["a:b", false, false, false], ["~", false, false, false],
  [long("x", 64), true, true, true], [long("x", 65), true, false, false], [long("x", 500), true, false, false],
  [long("X", 64), false, false, true], [long("X", 65), false, false, false],
  ["__proto__", true, true, true], ["constructor", true, true, true], ["prototype", true, true, true], ["facilitator", true, true, true],
];
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: string) => schema.safeParse(v).success;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("characterisation: scenario package identifier rules (US-0020)", () => {
  it.each(ROWS)("scenario, role, scene, inject and defer_to ids: %j", (id, scenarioId) => {
    expect(ok(ScenarioMetaSchema.shape.id, id)).toBe(scenarioId);
    expect(ok(PlayerRoleSchema.shape.id, id)).toBe(scenarioId);
    expect(ok(NpcRoleSchema.shape.id, id)).toBe(scenarioId);
    expect(ok(NpcRoleSchema.shape.defer_to.removeDefault().element, id)).toBe(scenarioId);
    expect(ok(SceneSchema.shape.id, id)).toBe(scenarioId);
    expect(ok(SceneSchema.shape.participants.element, id)).toBe(scenarioId);
    expect(ok(InjectSchema.shape.id, id)).toBe(scenarioId);
    expect(ok(InjectSchema.shape.to.element, id)).toBe(scenarioId);
  });

  it.each(ROWS)("rubric and criterion ids: %j", (id, _s, lower64) => {
    expect(ok(RubricSchema.shape.id, id)).toBe(lower64);
    expect(ok(CriterionSchema.shape.id, id)).toBe(lower64);
  });

  it.each(ROWS)("learning-objective ids: %j", (id, _s, _l, mixed64) => {
    expect(ok(LearningObjectiveSchema.shape.id, id)).toBe(mixed64);
  });

  it("keeps the messages of the schema refusals", () => {
    expect(ScenarioMetaSchema.shape.id.safeParse("A").error?.issues[0]?.message).toBe("ids are lowercase letters, digits, _ or -");
    expect(RubricSchema.shape.id.safeParse("A").error?.issues[0]?.message).toBe("ids are lowercase letters, digits, _ or -");
    expect(LearningObjectiveSchema.shape.id.safeParse("a.b").error?.issues[0]?.message).toBe("learning objective ids are 1 to 64 letters, digits, _ or -");
  });

  it.each(ROWS)("the rubric loader's file-name rule: %j", async (id, _s, lower64) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-ids-"));
    try {
      const r = await loadRubrics(dir, { meta: { rubrics: [id], learning_objectives: [] } });
      const refused = r.errors.some((e) => e.includes("is not a safe name"));
      expect(refused).toBe(!lower64);
      // an accepted id goes on to read rubrics/<id>.yaml, which does not exist here
      if (lower64) expect(r.errors.some((e) => e.includes("cannot be read"))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.each(["__proto__", "constructor", "prototype"])("validateScenario refuses the prototype key %s for a role and for a scene, not for an inject or the scenario id", async (k) => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0]!.id = k;
    expect(validateScenario(s).errors).toContain(`scene id '${k}' is not allowed (it is a prototype key)`);
    const t = await loadScenario(path.join(fixtures, "minimal"));
    Object.defineProperty(t.roles, k, { value: { ...(t.roles["guest"] as object), id: k }, enumerable: true });
    expect(validateScenario(t).errors).toContain(`role id '${k}' is not allowed (it is a prototype key)`);
    const u = await loadScenario(path.join(fixtures, "minimal"));
    u.meta.id = k;
    expect(validateScenario(u).errors.filter((e) => e.includes("prototype key"))).toEqual([]);
  });

  it("validateScenario refuses the role id facilitator and no other reserved scene or scenario word", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    const first = Object.values(s.roles)[0]!;
    s.roles["facilitator"] = { ...first, id: "facilitator" };
    expect(validateScenario(s).errors).toContain("role id 'facilitator' is reserved for the facilitator connection");
    const t = await loadScenario(path.join(fixtures, "minimal"));
    t.script.scenes[0]!.id = "facilitator"; t.meta.id = "facilitator";
    expect(validateScenario(t).errors.filter((e) => e.includes("reserved"))).toEqual([]);
  });
});
