import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, MAX_ENDS_WHEN_CHARS, SceneSchema, sceneEndsWhen, type Scene } from "../index.js";

// US-0080 (AC-0460, AC-0461): an optional player-facing `ends_when` sentence per scene, and the plain rule text players are shown:
// `ends_when`, else the scene's first Game Master condition, else nothing.
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const base = { id: "s1", title: "T", goal: "G", participants: ["p"], time_box_minutes: 5, exit_when: { any_of: ["time_box_elapsed"] } };

describe("ends_when (scene schema)", () => {
  it("test_scene_without_ends_when_loads_with_no_such_key", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    for (const scene of s.script.scenes) expect(Object.hasOwn(scene, "ends_when"), scene.id).toBe(false);
    expect(JSON.stringify(s)).not.toContain("ends_when");
  });

  it("test_ends_when_is_trimmed", () => {
    expect(SceneSchema.parse({ ...base, ends_when: "  the team agrees one position  " }).ends_when).toBe("the team agrees one position");
  });

  it("test_ends_when_bounds_and_control_characters_are_refused", () => {
    for (const bad of ["", "   ", "x".repeat(MAX_ENDS_WHEN_CHARS + 1), "two\nlines", "tab\there", "bell\u0007", 7, ["a"]])
      expect(SceneSchema.safeParse({ ...base, ends_when: bad }).success, JSON.stringify(bad)).toBe(false);
    expect(MAX_ENDS_WHEN_CHARS).toBe(200);
    expect(SceneSchema.safeParse({ ...base, ends_when: "x".repeat(MAX_ENDS_WHEN_CHARS) }).success).toBe(true);
  });
});

describe("sceneEndsWhen (the rule text players see)", () => {
  const scene = (o: Partial<Scene>): Scene => SceneSchema.parse({ ...base, ...o });

  it("test_sceneEndsWhen_prefers_ends_when_over_gm_detects", () => {
    expect(sceneEndsWhen(scene({ ends_when: "Priya agrees a next step", exit_when: { any_of: [{ gm_detects: "a concrete next step is agreed" }] } }))).toBe("Priya agrees a next step");
  });

  it("test_sceneEndsWhen_falls_back_to_the_first_gm_detects_condition", () => {
    expect(sceneEndsWhen(scene({ exit_when: { any_of: ["time_box_elapsed", { gm_detects: "  first  " }, { gm_detects: "second" }] } }))).toBe("first");
  });

  it("test_sceneEndsWhen_is_undefined_without_either", () => {
    expect(sceneEndsWhen(scene({ exit_when: { any_of: ["time_box_elapsed", "facilitator_advance"] } }))).toBeUndefined();
  });

  it("test_sceneEndsWhen_drops_a_fallback_the_ends_when_rule_would_refuse", () => {
    // gm_detects is plain text for the Game Master with no bound: only a condition that would pass as ends_when goes to a player.
    for (const bad of ["", "   ", "x".repeat(MAX_ENDS_WHEN_CHARS + 1), "a\nb"])
      expect(sceneEndsWhen(scene({ exit_when: { any_of: [{ gm_detects: bad }] } })), JSON.stringify(bad)).toBeUndefined();
    expect(sceneEndsWhen(scene({ exit_when: { any_of: [{ gm_detects: "a\nb" }, { gm_detects: "ok" }] } }))).toBe("ok");
  });
});
