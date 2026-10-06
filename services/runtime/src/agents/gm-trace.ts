import { chmodSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GmTraceRecord } from "./game-master.js";

/**
 * Appends one JSON line per Game Master model reply to `file` (GM_TRACE_FILE / `--gm-trace`): the raw reply and how it was read.
 * The file holds model replies about the whole dialogue, so it is facilitator-grade data: created with mode 0600 (owner only),
 * never part of the session log, and off unless asked for. Throws when the file cannot be created (so a bad path fails at start-up).
 */
export function createGmTraceWriter(file: string): (rec: GmTraceRecord) => void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "", { flag: "a", mode: 0o600 });
  chmodSync(file, 0o600);
  return (rec) => { appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 }); };
}

/** GM_TRACE_FILE: a path, relative to `baseDir`; blank or unset means off (undefined). Control characters are refused. */
export function parseGmTraceEnv(raw: string | undefined, baseDir: string): { ok: true; file: string | undefined } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, file: undefined };
  if (new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(text)) return { ok: false, error: "GM_TRACE_FILE is invalid: it must be a plain file path" };
  return { ok: true, file: path.resolve(baseDir, text) };
}
