import { createHash } from "node:crypto";
import type { Rubric } from "@acr/script";

/** A short content hash of the rubrics a calibration ran against, so a later report can tell a stale result from a current one. */
export function rubricHash(rubrics: Rubric[]): string {
  return createHash("sha256").update(JSON.stringify(rubrics)).digest("hex").slice(0, 16);
}
