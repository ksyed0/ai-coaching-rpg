import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, validateScenario } from "../index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("validateScenario", () => {
  it("passes the minimal fixture with no errors", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    expect(validateScenario(s).errors).toEqual([]);
  });

  it("errors on a scene participant that is not a role", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].participants.push("ghost");
    expect(validateScenario(s).errors).toContain("scene s1_open: participant 'ghost' is not a role");
  });

  it("errors on duplicate inject ids across scenes", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[1].injects = [{ ...s.script.scenes[0].injects![0] }];
    expect(validateScenario(s).errors).toContain("inject id 'late_inject' is used more than once");
  });

  it("warns when an inject fires after the scene time box", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].injects![0].at_minute = 5;
    expect(validateScenario(s).warnings).toContain("scene s1_open: inject 'late_inject' at minute 5 is after the 2 minute time box");
  });

  it("warns on a learning objective with no rubric criteria", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.meta.learning_objectives[0].rubric_criteria = [];
    expect(validateScenario(s).warnings).toContain("learning objective LO1 maps to no rubric criteria");
  });

  it("errors when an inject id equals a scene id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].injects![0].id = "s2_close";
    expect(validateScenario(s).errors).toContain("id 's2_close' is used by both a scene and an inject");
  });

  it("errors when a scene id equals a role id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[1].id = "guest";
    expect(validateScenario(s).errors).toContain("id 'guest' is used by both a role and a scene");
  });

  it("errors when the scenario id equals a role id", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.meta.id = "guest";
    expect(validateScenario(s).errors).toContain("id 'guest' is used by both the scenario and a role");
  });
});
