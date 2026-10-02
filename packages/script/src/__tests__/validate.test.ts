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
});
