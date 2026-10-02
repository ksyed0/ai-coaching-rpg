import type { Scenario } from "./schema.js";

export function validateScenario(s: Scenario): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roleIds = new Set(Object.keys(s.roles));
  const sceneIds = new Set<string>();
  const injectIds = new Map<string, number>();

  for (const scene of s.script.scenes) {
    if (sceneIds.has(scene.id)) errors.push(`scene id '${scene.id}' is used more than once`);
    sceneIds.add(scene.id);
    for (const p of scene.participants) if (!roleIds.has(p)) errors.push(`scene ${scene.id}: participant '${p}' is not a role`);
    for (const inj of scene.injects ?? []) {
      injectIds.set(inj.id, (injectIds.get(inj.id) ?? 0) + 1);
      for (const t of inj.to) if (!roleIds.has(t)) errors.push(`scene ${scene.id}: inject '${inj.id}' targets unknown role '${t}'`);
      if (inj.at_minute !== undefined && inj.at_minute > scene.time_box_minutes)
        warnings.push(`scene ${scene.id}: inject '${inj.id}' at minute ${inj.at_minute} is after the ${scene.time_box_minutes} minute time box`);
    }
    if (scene.opening_inject && !(scene.injects ?? []).some((i) => i.id === scene.opening_inject))
      errors.push(`scene ${scene.id}: opening_inject '${scene.opening_inject}' is not defined in its injects`);
  }
  for (const [id, n] of injectIds) if (n > 1) errors.push(`inject id '${id}' is used more than once`);

  const playerCount = Object.values(s.roles).filter((r) => r.type === "player").length;
  if (playerCount < s.meta.players.min) errors.push(`only ${playerCount} player roles but players.min is ${s.meta.players.min}`);
  for (const lo of s.meta.learning_objectives)
    if (lo.rubric_criteria.length === 0) warnings.push(`learning objective ${lo.id} maps to no rubric criteria`);

  return { errors, warnings };
}
