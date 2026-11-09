import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 12): `pnpm voice:timings <file>` reads control's timing record (VOICE_TIMING_LOG=1 writes
 * `<CONTROL_LOG_DIR>/voice-timing.log`, one line per voice line the runtime appended) and prints count, p50, p95 and max of the two
 * numbers, with the runbook's reading guide. Only lines of exactly the record's shape count; anything else is ignored. The file is read
 * through one descriptor opened with O_NOFOLLOW, must be a regular file and at most TIMINGS_MAX_BYTES. The output is fixed sentences
 * and numbers only: never the file's path, a session id or any other line of the file.
 */

/** The largest record read (control stops its record at 1 MiB; anything far larger is not one). */
export const TIMINGS_MAX_BYTES = 4 * 1024 * 1024;
/** The room test's targets (runbook): end of speech to line, and first word to line. */
export const END_TARGET_P95_MS = 1000;
export const START_TARGET_P95_MS = 3000;

const END_KEY = "end_to_append_ms=";
const START_KEY = "start_to_append_ms=";

/** A count of milliseconds as control writes it: 1 to 15 decimal digits, no sign, no leading zero (but "0"). */
function msOf(v: string, key: string): number | null {
  if (!v.startsWith(key)) return null;
  const d = v.slice(key.length);
  if (d.length < 1 || d.length > 15 || (d.length > 1 && d.startsWith("0"))) return null;
  for (const c of d) if (c < "0" || c > "9") return null;
  return Number(d);
}

/** The two numbers of every line of exactly `session <id> voice line timing end_to_append_ms=<n> start_to_append_ms=<m>`. */
export function parseTimingLines(text: string): { endToAppend: number[]; startToAppend: number[] } {
  const endToAppend: number[] = [];
  const startToAppend: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const p = line.split(" ");
    if (p.length !== 7 || p[0] !== "session" || p[1] === "" || p[2] !== "voice" || p[3] !== "line" || p[4] !== "timing") continue;
    const end = msOf(p[5]!, END_KEY);
    const start = msOf(p[6]!, START_KEY);
    if (end === null || start === null) continue;
    endToAppend.push(end);
    startToAppend.push(start);
  }
  return { endToAppend, startToAppend };
}

/** Count, nearest-rank p50 and p95, and max; null for no values. */
export function summarise(values: readonly number[]): { count: number; p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
  return { count: sorted.length, p50: rank(50), p95: rank(95), max: sorted.at(-1)! };
}

export type TimingsReadResult = { ok: true; text: string } | { ok: false; why: "missing" | "not_file" | "too_large" | "unreadable" };

/** Reads the record privately: O_NOFOLLOW, a regular file, at most `maxBytes`. Never throws; the reason is a code, never a path. */
export function readTimingFile(file: string, maxBytes = TIMINGS_MAX_BYTES): TimingsReadResult {
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, why: "not_file" };
    if (st.size > maxBytes) return { ok: false, why: "too_large" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return { ok: true, text: buf.subarray(0, off).toString("utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, why: code === "ENOENT" ? "missing" : code === "ELOOP" ? "not_file" : "unreadable" };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const READ_SENTENCES: Record<Exclude<TimingsReadResult, { ok: true }>["why"], string> = {
  missing: "voice:timings: the file does not exist (control writes voice-timing.log in CONTROL_LOG_DIR when VOICE_TIMING_LOG=1)",
  not_file: "voice:timings: the file is not a regular file (a link or a folder is not read)",
  too_large: `voice:timings: the file is larger than ${TIMINGS_MAX_BYTES} bytes: it is not a timing record`,
  unreadable: "voice:timings: the file cannot be read",
};

const describeSummary = (label: string, s: NonNullable<ReturnType<typeof summarise>>, target: number): string =>
  `voice:timings: ${label}: count ${s.count}, p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms (target p95 at most ${target} ms: ${s.p95 <= target ? "met" : "NOT met"})`;

/**
 * The command: `args` are the CLI's arguments after `timings`; a relative path is resolved against `initCwd` (pnpm runs the package
 * script in the package folder and sets INIT_CWD to where the operator typed the command), else `cwd`. Exit 0 with a summary, 1 when
 * the record holds no voice line, 2 for a usage or file problem.
 */
export function voiceTimings(o: { args: readonly string[]; out: (line: string) => void; cwd: string; initCwd?: string; read?: (file: string) => TimingsReadResult }): number {
  if (o.args.length !== 1 || o.args[0] === "") { o.out("usage: pnpm voice:timings <timing file> (control writes voice-timing.log in CONTROL_LOG_DIR when VOICE_TIMING_LOG=1)"); return 2; }
  const base = o.initCwd !== undefined && path.isAbsolute(o.initCwd) ? o.initCwd : o.cwd;
  const r = (o.read ?? readTimingFile)(path.resolve(base, o.args[0]!));
  if (!r.ok) { o.out(READ_SENTENCES[r.why]); return 2; }
  const { endToAppend, startToAppend } = parseTimingLines(r.text);
  const end = summarise(endToAppend);
  const start = summarise(startToAppend);
  if (!end || !start) { o.out("voice:timings: no voice lines in the timing record"); return 1; }
  o.out(describeSummary("end of speech to line (end_to_append_ms)", end, END_TARGET_P95_MS));
  o.out(describeSummary("first word to line, approximated by start_to_append_ms", start, START_TARGET_P95_MS));
  o.out("voice:timings: reading guide: end of speech to line: target p95 at most 1000 ms; first word to line: target p95 at most 3000 ms, approximated by start_to_append (the segment's first speech frame to the log append)");
  return 0;
}
