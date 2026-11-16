import { EndsWhenText, type Scene } from "./schema.js";

/**
 * US-0080: the plain rule text a player is shown for what ends `scene`: its `ends_when`, else its first Game Master condition that would
 * pass as an `ends_when` (one line, 1 to 200 characters, trimmed), else undefined (the player then sees only the time box and the
 * facilitator line). Resolved on the server so a client needs no scenario knowledge.
 */
export function sceneEndsWhen(scene: Pick<Scene, "ends_when" | "exit_when">): string | undefined {
  if (scene.ends_when !== undefined) return scene.ends_when;
  for (const c of scene.exit_when.any_of) {
    if (typeof c !== "object") continue;
    const r = EndsWhenText.safeParse(c.gm_detects);
    if (r.success) return r.data;
  }
  return undefined;
}
