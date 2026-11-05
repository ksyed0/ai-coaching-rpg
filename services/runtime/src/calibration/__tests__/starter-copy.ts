import path from "node:path";

/** The 8 hand-set starter probes (single source of truth for the authoring tests and friday-set.test.ts). */
export const STARTER_IDS = ["disc-l1", "disc-l2", "disc-l3", "disc-l4", "neg-l1", "neg-l4", "listening-contrast-01", "negotiation-contrast-01"];

/**
 * `cp` filter for a copy of a scenario directory (`scenarioDir`): keeps everything outside `calibration/`, and inside it only the starter
 * probe files, so authoring tests do not depend on the size of the approved set or on a developer's git-ignored drafts/ folder.
 */
export function starterOnly(scenarioDir: string): (src: string) => boolean {
  const cal = path.join(scenarioDir, "calibration");
  return (src) => {
    const rel = path.relative(cal, src);
    if (rel === "" || rel.startsWith("..")) return true; // the scenario itself, or outside calibration/
    return STARTER_IDS.map((id) => `${id}.yaml`).includes(rel);
  };
}
