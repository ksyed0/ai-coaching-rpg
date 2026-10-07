import { createHash } from "node:crypto";
import type { Scenario } from "@acr/script";

/** JSON with object keys sorted at every level (array order kept), so the same scenario always gives the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** sha256 (hex) of the loaded scenario: recorded in session.started (log format 1) so a restart never resumes a log against another scenario. */
export function scenarioHash(scenario: Scenario): string {
  return createHash("sha256").update(canonicalJson(scenario)).digest("hex");
}
