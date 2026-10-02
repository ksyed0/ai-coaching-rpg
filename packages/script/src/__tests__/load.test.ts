import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
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
    await expect(loadScenario(path.join(fixtures, "no-roles"))).rejects.toThrow(/roles\/ directory is missing/);
  });

  it("fails with one message naming the folder when roles/ is empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-empty-roles-"));
    try {
      await mkdir(path.join(dir, "roles"));
      await cp(path.join(fixtures, "minimal", "scenario.yaml"), path.join(dir, "scenario.yaml"));
      await cp(path.join(fixtures, "minimal", "script.yaml"), path.join(dir, "script.yaml"));
      const err = await loadScenario(dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ScenarioLoadError);
      expect((err as Error).message).toContain(dir);
      expect((err as Error).message).toMatch(/roles\/ directory is empty/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails naming the file when a role file is invalid", async () => {
    await expect(loadScenario(path.join(fixtures, "bad-role"))).rejects.toThrow(/roles\/broken\.yaml/);
  });
});
