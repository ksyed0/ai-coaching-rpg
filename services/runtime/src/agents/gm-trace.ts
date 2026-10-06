import { closeSync, constants as C, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import path from "node:path";
import type { GmTraceRecord } from "./game-master.js";

export type GmTraceWriter = ((rec: GmTraceRecord) => void) & { close(): void };

const realOrResolved = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Appends one JSON line per Game Master model reply to `file` (GM_TRACE_FILE / `--gm-trace`): the raw reply and how it was read.
 * The file holds model replies about the whole conversation, so it is facilitator-grade data: created with mode 0600 (owner only),
 * never part of the session log, and off unless asked for. It is opened once with O_NOFOLLOW (a symlink is refused, never followed), the mode is
 * set on the open descriptor and every line goes through it, so nothing is reopened by name. `forbid` lists paths it may never be (the session log).
 * Throws when the file cannot be created or is not allowed (so a bad path fails at start-up). `close()` releases the descriptor.
 */
export function createGmTraceWriter(file: string, opts: { forbid?: string[] } = {}): GmTraceWriter {
  const target = path.resolve(file);
  for (const f of opts.forbid ?? []) {
    if (path.resolve(f) === target || realOrResolved(f) === realOrResolved(target)) throw new Error("the trace file must not be the session log");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  try { if (lstatSync(target).isSymbolicLink()) throw Object.assign(new Error("a symbolic link"), { code: "ELOOP" }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const fd = openSync(target, C.O_WRONLY | C.O_APPEND | C.O_CREAT | (C.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "EISDIR" });
    fchmodSync(fd, 0o600);
  } catch (err) { closeSync(fd); throw err; }
  let open = true;
  const write = ((rec: GmTraceRecord) => { if (open) writeSync(fd, `${JSON.stringify(rec)}\n`); }) as GmTraceWriter;
  write.close = () => { if (open) { open = false; closeSync(fd); } };
  return write;
}

/** GM_TRACE_FILE: a path, relative to `baseDir`; blank or unset means off (undefined). Control characters are refused. */
export function parseGmTraceEnv(raw: string | undefined, baseDir: string): { ok: true; file: string | undefined } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, file: undefined };
  if (new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]").test(text)) return { ok: false, error: "GM_TRACE_FILE is invalid: it must be a plain file path" };
  return { ok: true, file: path.resolve(baseDir, text) };
}
