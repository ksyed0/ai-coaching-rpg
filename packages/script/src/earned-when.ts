import type { NpcRole } from "./schema.js";

/** US-0034: a character's `earned_when` conditions as (fact number, condition) pairs in fact order; empty when it has none. */
export function earnedWhenOf(role: Pick<NpcRole, "earned_when">): { fact: number; condition: string }[] {
  const map = role.earned_when;
  if (!map) return [];
  return Object.keys(map).map((k) => ({ fact: Number(k), condition: map[k]! })).sort((a, b) => a.fact - b.fact);
}
