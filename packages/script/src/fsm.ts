import type { ExitReason } from "@acr/events";
import type { Inject, Scene, Script } from "./schema.js";

export type ExitContext = { elapsedMs: number; facilitatorAdvance: boolean; gmVerdicts: Record<string, boolean> };

export function evaluateExit(scene: Scene, ctx: ExitContext): ExitReason | null {
  for (const cond of scene.exit_when.any_of) {
    if (cond === "facilitator_advance" && ctx.facilitatorAdvance) return "facilitator_advance";
    if (cond === "time_box_elapsed" && ctx.elapsedMs >= scene.time_box_minutes * 60_000) return "time_box_elapsed";
    if (typeof cond === "object" && ctx.gmVerdicts[cond.gm_detects] === true) return "gm_detects";
  }
  return null;
}

export function nextSceneId(script: Script, currentId: string): string | null {
  const i = script.scenes.findIndex((s) => s.id === currentId);
  return i >= 0 && i + 1 < script.scenes.length ? script.scenes[i + 1].id : null;
}

export function dueInjects(scene: Scene, elapsedMs: number, alreadyFired: string[]): Inject[] {
  return (scene.injects ?? []).filter(
    (i) => i.at_minute !== undefined && elapsedMs >= i.at_minute * 60_000 && !alreadyFired.includes(i.id),
  );
}
