import type { PlayerScene } from "@acr/events";

// US-0080: the words a player reads about a scene's objective, what ends it, and why it ended. The rule text (`endsWhen`) comes from the
// runtime already resolved (the scene's `ends_when`, else its Game Master condition); this module only builds sentences around it.

export const SCENE_COPY = {
  objective: "Objective:",
  endsWhen: "Ends when:",
  facilitatorLine: "when your facilitator moves on",
  gmMet: "The Game Master judged this scene's goal was met",
  timeUp: "Time ran out",
  facilitatorAdvance: "Your facilitator moved the session on.",
  otherReason: "The scene has ended.",
  complete: "All scenes are done. The facilitator can now run the evaluation.",
  sessionComplete: "Session complete",
  nextHeading: "Next for you",
  nextStarted: "It has started: the clock is running.",
  nextWaiting: "It starts when the session reaches it.",
  noMoreScenes: "You are not in any more scenes. Stay on this page until the session ends.",
  continue: "Continue",
} as const;

/** A time box in minutes as a player reads it: whole minutes as they are, otherwise one decimal. */
export function minutesText(n: number): string {
  return Number.isInteger(n) ? String(n) : (Math.round(n * 10) / 10).toString();
}

/** The rule without a closing full stop, or null when there is none to show. */
function rule(scene: Pick<PlayerScene, "endsWhen"> | undefined): string | null {
  const r = scene?.endsWhen?.trim().replace(/\.+$/, "") ?? "";
  return r.length > 0 ? r : null;
}

/** What follows "Ends when:" on the scene card: the rule (when there is one), the time box and the facilitator. */
export function endsWhenText(scene: Pick<PlayerScene, "endsWhen" | "timeBoxMinutes">): string {
  const r = rule(scene);
  const box = `at ${minutesText(scene.timeBoxMinutes)} min, or ${SCENE_COPY.facilitatorLine}`;
  return r ? `${r}, ${box}` : box;
}

/** Why the scene ended, in one sentence, from the exit reason and the scene that ended (undefined when the page does not know it). */
export function exitWhy(reason: string, scene: Pick<PlayerScene, "endsWhen" | "timeBoxMinutes"> | undefined): string {
  switch (reason) {
    case "gm_detects": {
      const r = rule(scene);
      return r ? `${SCENE_COPY.gmMet}: ${r}.` : `${SCENE_COPY.gmMet}.`;
    }
    case "time_box_elapsed":
      return scene ? `${SCENE_COPY.timeUp} (${minutesText(scene.timeBoxMinutes)} min).` : `${SCENE_COPY.timeUp}.`;
    case "facilitator_advance":
      return SCENE_COPY.facilitatorAdvance;
    default:
      return SCENE_COPY.otherReason;
  }
}
