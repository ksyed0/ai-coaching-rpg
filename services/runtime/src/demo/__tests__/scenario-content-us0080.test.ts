import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadScenario, sceneEndsWhen } from "@acr/script";
import { REPO_ROOT } from "../../main.js";

// US-0080 scenario content: every scene of both Friday scenarios says what ends it in plain words, and opens with a message to its players.
const NAMES = ["friday-escalation", "friday-escalation-extended"] as const;

describe.each(NAMES)("%s scene content (US-0080)", (name) => {
  it("test_every_scene_has_its_own_ends_when_sentence", async () => {
    const sc = await loadScenario(path.join(REPO_ROOT, "scenarios", name));
    for (const scene of sc.script.scenes) {
      expect(scene.ends_when, scene.id).toBeTypeOf("string");
      expect(sceneEndsWhen(scene), scene.id).toBe(scene.ends_when);
      // A sentence that reads after "Ends when:", not a copy of the Game Master's condition or the goal.
      expect(scene.ends_when, scene.id).toMatch(/^[a-zH]/);
      expect(scene.exit_when.any_of).not.toContainEqual({ gm_detects: scene.ends_when });
    }
  });

  it("test_every_scene_opens_with_a_message_to_its_players_only", async () => {
    const sc = await loadScenario(path.join(REPO_ROOT, "scenarios", name));
    for (const scene of sc.script.scenes) {
      const opening = (scene.injects ?? []).find((i) => i.id === scene.opening_inject);
      expect(opening, scene.id).toBeDefined();
      for (const to of opening!.to) {
        expect(scene.participants, `${scene.id} -> ${to}`).toContain(to);
        expect(sc.roles[to]?.type, `${scene.id} -> ${to}`).toBe("player");
      }
      // Every player of the scene gets it.
      expect([...opening!.to].sort(), scene.id).toEqual(scene.participants.filter((p) => sc.roles[p]?.type === "player").sort());
      expect(opening!.at_minute, scene.id).toBeUndefined();
    }
  });
});
