export { roleTitle } from "./prompt.js";

/**
 * US-0081 (AC-0470): the human seat a nudge addresses. Pure. `candidates` are the human player seats in the current scene (connected
 * ones, as the caller sees them); `sceneSpeakers` is the role id of every line of the current scene, in order; `order` is the scenario's
 * role order. The seat that has spoken least in the scene wins; a tie goes to the one silent longest (its last line earliest, never
 * spoken first), then to scenario role order. Null when there is no candidate (then no nudge).
 */
export function pickNudgeTarget(o: { candidates: string[]; sceneSpeakers: string[]; order: string[] }): string | null {
  const count = new Map<string, number>();
  const last = new Map<string, number>();
  o.sceneSpeakers.forEach((r, i) => { count.set(r, (count.get(r) ?? 0) + 1); last.set(r, i); });
  const rank = (r: string): number => { const i = o.order.indexOf(r); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const sorted = [...new Set(o.candidates)].sort((a, b) =>
    (count.get(a) ?? 0) - (count.get(b) ?? 0) || (last.get(a) ?? -1) - (last.get(b) ?? -1) || rank(a) - rank(b));
  return sorted[0] ?? null;
}
