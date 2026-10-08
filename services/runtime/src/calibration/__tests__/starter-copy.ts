import path from "node:path";

/** The 8 hand-set starter probes. Authoring tests copy the Friday scenario with only these, so they do not depend on the size of the approved set or on a developer's git-ignored drafts/ folder. */
export const STARTER_FILES = ["disc-l1", "disc-l2", "disc-l3", "disc-l4", "neg-l1", "neg-l4", "listening-contrast-01", "negotiation-contrast-01"].map((n) => `${n}.yaml`);

/** `cp` filter for the Friday scenario directory: drops drafts/ and every calibration probe that is not a starter. */
export function starterOnly(src: string): boolean {
  const parts = src.split(path.sep);
  const i = parts.lastIndexOf("calibration");
  if (i < 0 || i === parts.length - 1) return true;
  const rest = parts.slice(i + 1);
  if (rest.length === 1) return STARTER_FILES.includes(rest[0]!);
  return false;
}
