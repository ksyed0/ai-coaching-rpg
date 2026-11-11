import { closeSync, constants as fc, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";

/** One line of a role's `index.jsonl` (US-0073 A2a). No audio and no transcript beyond the raw text the speaker already consented to store. */
export type IndexEntry = {
  v: 1;
  kind: "segment";
  segment: string;
  participantId: string;
  startMs: number;
  endMs: number;
  status: "transcribed" | "empty" | "stt_failed" | `refused:${string}`;
  seq?: number;
  raw?: string;
  timings?: { vadEndMs?: number; sttMs?: number };
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const optNum = (x: unknown): boolean => x === undefined || isNum(x);
const validStatus = (s: unknown): boolean =>
  s === "transcribed" || s === "empty" || s === "stt_failed" || (typeof s === "string" && s.startsWith("refused:") && s.length > "refused:".length);

function isEntry(x: unknown): x is IndexEntry {
  if (!isObj(x) || x.v !== 1 || x.kind !== "segment") return false;
  if (typeof x.segment !== "string" || typeof x.participantId !== "string") return false;
  if (!isNum(x.startMs) || !isNum(x.endMs) || !validStatus(x.status)) return false;
  if (!optNum(x.seq) || (x.raw !== undefined && typeof x.raw !== "string")) return false;
  if (x.timings !== undefined && !(isObj(x.timings) && optNum(x.timings.vadEndMs) && optNum(x.timings.sttMs))) return false;
  return true;
}

/**
 * Appends one line (O_APPEND, 0600, never through a link). A torn last line (no final newline, after a crash) is terminated first so
 * the new line starts on its own. Errors carry the errno code only, never the path.
 */
export function appendIndexLine(file: string, entry: IndexEntry): void {
  let fd: number;
  try { fd = openSync(file, fc.O_RDWR | fc.O_APPEND | fc.O_CREAT | fc.O_NOFOLLOW, 0o600); }
  catch (err) { throw new Error(`could not open the audio index (${(err as NodeJS.ErrnoException).code ?? "error"})`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("the audio index is not a regular file");
    let prefix = "";
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, st.size - 1);
      if (last[0] !== 0x0a) prefix = "\n";
    }
    writeSync(fd, Buffer.from(`${prefix}${JSON.stringify(entry)}\n`, "utf8"));
  } catch (err) {
    if (err instanceof Error && !(err as NodeJS.ErrnoException).code) throw err;
    throw new Error(`could not write the audio index (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  } finally { closeSync(fd); }
}

/** Reads every well-formed line; a missing, linked or unreadable file reads as empty, and a torn or foreign line is skipped. Never throws. */
export function readIndex(file: string): IndexEntry[] {
  let text: string;
  try {
    const fd = openSync(file, fc.O_RDONLY | fc.O_NOFOLLOW);
    try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
  } catch { return []; }
  const out: IndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try { const x: unknown = JSON.parse(line); if (isEntry(x)) out.push(x); } catch { /* torn or foreign line */ }
  }
  return out;
}
