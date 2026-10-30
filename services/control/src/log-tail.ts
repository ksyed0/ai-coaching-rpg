import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/** How much of the end of the log is read. A last line longer than this is treated as `running`. */
export const TAIL_BYTES = 64 * 1024;

/**
 * Lock-free status of a session from the end of its event log (JSONL), without opening a session store or taking the session lock.
 * - `empty`: the file is missing, or has no complete line yet.
 * - `ended`: the last COMPLETE line is an event with `type: "session.ended"`.
 * - `running`: anything else (including an unparseable last complete line, and a last line longer than the window: the safe answer is
 *   "not over").
 * A cut-off final line (no trailing newline and not parseable) is ignored, so the line before it decides.
 * A missing file is `empty`; a file that cannot be read for any other reason THROWS a plain error (no path), so the caller never
 * mistakes an unreadable log for an ended or empty one.
 */
export function readLogStatus(file: string): "empty" | "running" | "ended" {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "empty";
    throw new Error("the session log cannot be read");
  }
  let text: string;
  let truncatedFront: boolean;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a file");
    if (st.size === 0) return "empty";
    // One extra byte when the front is cut off: if it is a newline, the line after it is complete and counts.
    truncatedFront = st.size > TAIL_BYTES;
    const len = truncatedFront ? TAIL_BYTES + 1 : st.size;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, st.size - len + got);
      if (n === 0) break;
      got += n;
    }
    text = buf.subarray(0, got).toString("utf8");
  } catch { throw new Error("the session log cannot be read"); }
  finally { closeSync(fd); }

  const lines = text.split("\n");
  if (truncatedFront) lines.shift(); // the first segment may start mid-line
  const tail = lines.pop() ?? ""; // text after the last newline ("" when the file ends with one)
  const complete = lines.filter((l) => l.trim() !== "");
  if (tail.trim() !== "" && parsesAsObject(tail)) complete.push(tail);
  const last = complete[complete.length - 1];
  if (last === undefined) return truncatedFront ? "running" : "empty";
  const event = parseObject(last);
  return event !== null && event.type === "session.ended" ? "ended" : "running";
}

function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}
const parsesAsObject = (line: string): boolean => parseObject(line) !== null;
