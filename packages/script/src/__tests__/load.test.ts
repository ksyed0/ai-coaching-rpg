import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, ScenarioLoadError } from "../index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadScenario", () => {
  it("loads the minimal fixture", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    expect(s.meta.id).toBe("minimal-01");
    expect(Object.keys(s.roles).sort()).toEqual(["guest", "host"]);
    expect(s.script.scenes.map((sc) => sc.id)).toEqual(["s1_open", "s2_close"]);
    const guest = s.roles.guest;
    expect(guest.type).toBe("npc");
    if (guest.type === "npc") expect(guest.fallback_line).toMatch(/say that again/);
  });

  it("fails with one message when roles/ is missing", async () => {
    await expect(loadScenario(path.join(fixtures, "no-roles"))).rejects.toBeInstanceOf(ScenarioLoadError);
    await expect(loadScenario(path.join(fixtures, "no-roles"))).rejects.toThrow(/roles\/ directory/);
  });

  it("fails naming the file when a role file is invalid", async () => {
    await expect(loadScenario(path.join(fixtures, "bad-role"))).rejects.toThrow(/roles\/broken\.yaml/);
  });
});
