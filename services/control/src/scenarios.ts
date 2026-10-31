import { lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isSafeId } from "@acr/events";
import { loadScenario, validateScenario } from "@acr/script";

export type ScenarioListing = { id: string; title: string };

/**
 * The allowlist: every real (non-symlink) sub-folder of `dir` whose name is a safe id and which loads and validates. The id is the
 * FOLDER name, because the runtime takes SCENARIO_DIR as a folder and the shipped folders do not carry their `meta.id`
 * (`friday-escalation` holds `esc-scope-creep-01`). A missing directory is an empty list. A folder that is refused is reported to
 * `onSkip` by its folder name only (or a fixed text when the name itself is unsafe); no path or loader message leaves this function.
 */
export async function listScenarios(dir: string, onSkip?: (folder: string) => void): Promise<ScenarioListing[]> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("the scenarios folder cannot be read");
  }
  const out: ScenarioListing[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // files, symlinks and the like never count
    if (!isSafeId(entry.name)) { onSkip?.("(a folder with an unsafe name)"); continue; }
    try {
      const scenario = await loadScenario(path.join(dir, entry.name));
      if (validateScenario(scenario).errors.length > 0) { onSkip?.(entry.name); continue; }
      out.push({ id: entry.name, title: scenario.meta.title });
    } catch { onSkip?.(entry.name); }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Exact match only: no trimming, no case folding. A path-like or non-string id is never allowed. */
export function isAllowedScenario(list: { id: string }[], id: string): boolean {
  return typeof id === "string" && isSafeId(id) && list.some((s) => s.id === id);
}

/**
 * The folder for an id, or a throw. Defence in depth for callers that already checked `isAllowedScenario`: the id must be a safe id
 * (so no separator, `..`, NUL, absolute path or over-long name can reach the join) and a real directory (not a symlink) must exist.
 */
export function scenarioDir(dir: string, id: string): string {
  const refuse = (): never => { throw new Error("not an allowed scenario"); };
  if (typeof id !== "string" || !isSafeId(id)) return refuse();
  const folder = path.join(dir, id);
  try { if (!lstatSync(folder).isDirectory()) return refuse(); }
  catch { return refuse(); }
  return folder;
}
