import { existsSync } from "node:fs";
import type { Run } from "../run.js";
import type { CheckResult } from "./types.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 8): the audio folder and the state folder (it holds livekit.env and whisper.log) should be left out
 * of Time Machine backups. macOS `tmutil isexcluded <dir>` through the command runner (PATH /usr/bin:/bin). **Its output format is
 * UNVERIFIED** (expected `[Excluded]    <path>` or `[Included]    <path>`): anything without `[Excluded]` is a warning. Other platforms
 * skip. Folders are named by their setting, never by path.
 */
export async function backupCheck(o: { platform: NodeJS.Platform; dirs: { label: string; dir: string }[]; run: Run; exists?: (p: string) => boolean }): Promise<CheckResult[]> {
  if (o.platform !== "darwin") return [{ name: "backup", level: "skip", line: "backup exclusion: checked on macOS only" }];
  const exists = o.exists ?? existsSync;
  const out: CheckResult[] = [];
  for (const { label, dir } of o.dirs) {
    if (!exists(dir)) { out.push({ name: "backup", level: "skip", line: `${label} does not exist yet` }); continue; }
    let said: string | null = null;
    try { const r = await o.run("tmutil", ["isexcluded", dir], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000 }); said = r.code === 0 ? r.stdout : null; } catch { said = null; }
    if (said === null) out.push({ name: "backup", level: "warn", line: `could not ask Time Machine about ${label}` });
    else if (said.includes("[Excluded]")) out.push({ name: "backup", level: "ok", line: `${label} is excluded from Time Machine backups` });
    else out.push({ name: "backup", level: "warn", line: `${label} is not excluded from Time Machine backups: see docs/VOICE_RUNBOOK.md (tmutil addexclusion)` });
  }
  return out;
}
