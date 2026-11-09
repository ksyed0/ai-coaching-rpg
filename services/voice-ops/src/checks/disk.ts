import { existsSync } from "node:fs";
import path from "node:path";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): free disk space against AUDIO_MIN_FREE_MB (A2's setting, defined in voice-ops for now: K11),
 * measured on the nearest existing parent of each folder (the audio folder may not exist yet). The lowest value counts. No path is printed.
 */
const MB = 1024 * 1024;

function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!existsSync(cur) && path.dirname(cur) !== cur) cur = path.dirname(cur);
  return cur;
}

export function diskCheck(o: { dirs: string[]; minFreeMb: number; statfs: (p: string) => { bavail: number; bsize: number } }): CheckResult {
  let low = Infinity;
  try {
    for (const d of o.dirs) { const st = o.statfs(nearestExisting(d)); low = Math.min(low, Math.floor((Number(st.bavail) * Number(st.bsize)) / MB)); }
  } catch { return { name: "disk", level: "fail", line: "disk: the free space cannot be read" }; }
  if (!Number.isFinite(low)) return { name: "disk", level: "skip", line: "disk: no folder to check" };
  if (low < o.minFreeMb) return { name: "disk", level: "fail", line: `disk: ${low} MB free, below AUDIO_MIN_FREE_MB ${o.minFreeMb}: free some space` };
  return { name: "disk", level: "ok", line: `disk: ${low} MB free (AUDIO_MIN_FREE_MB ${o.minFreeMb})` };
}
