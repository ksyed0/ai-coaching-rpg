import type { Scenario } from "./schema.js";

export function validateScenario(s: Scenario): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roleIds = new Set(Object.keys(s.roles));
  const sceneIds = new Set<string>();
  const injectIds = new Map<string, number>();
  if (roleIds.has("facilitator")) errors.push("role id 'facilitator' is reserved for the facilitator connection");

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

  const kindsById = new Map<string, string[]>();
  const note = (id: string, kind: string) => {
    const kinds = kindsById.get(id) ?? [];
    if (!kinds.includes(kind)) kinds.push(kind);
    kindsById.set(id, kinds);
  };
  note(s.meta.id, "the scenario");
  for (const id of roleIds) note(id, "a role");
  for (const id of sceneIds) note(id, "a scene");
  for (const id of injectIds.keys()) note(id, "an inject");
  for (const [id, kinds] of kindsById)
    for (let i = 0; i < kinds.length; i++)
      for (let j = i + 1; j < kinds.length; j++) errors.push(`id '${id}' is used by both ${kinds[i]} and ${kinds[j]}`);

  for (const r of Object.values(s.roles)) {
    if (r.type !== "npc") continue;
    for (const d of r.defer_to) {
      const target = s.roles[d];
      if (d === r.id) errors.push(`role ${r.id}: defer_to cannot name the role itself`);
      else if (!target) errors.push(`role ${r.id}: defer_to '${d}' is not a role`);
      else if (target.type !== "npc") errors.push(`role ${r.id}: defer_to '${d}' is not an AI character (npc) role`);
    }
    for (const d of r.defer_to) {
      const target = s.roles[d];
      if (target?.type !== "npc" || d === r.id) continue;
      if (target.seniority < r.seniority) warnings.push(`role ${r.id}: defer_to '${d}' is less senior (${target.seniority}) than ${r.id} (${r.seniority})`);
      if (target.defer_to.includes(r.id) && r.id < d) warnings.push(`roles ${r.id} and ${d} defer to each other`);
    }
    if (new Set(r.defer_to).size !== r.defer_to.length) errors.push(`role ${r.id}: defer_to lists a role more than once`);
  }
  const playerCount = Object.values(s.roles).filter((r) => r.type === "player").length;
  if (playerCount < s.meta.players.min) errors.push(`only ${playerCount} player roles but players.min is ${s.meta.players.min}`);
  for (const lo of s.meta.learning_objectives)
    if (lo.rubric_criteria.length === 0) warnings.push(`learning objective ${lo.id} maps to no rubric criteria`);

  return { errors, warnings };
}
