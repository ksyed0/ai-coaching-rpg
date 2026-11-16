import { closeSync, constants as fc, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";

/**
 * A2b-2: a safe, bounded reader of the session log `<sessionsDir>/<sessionId>.jsonl`, returning its `utterance` events so the
 * facilitator can read the transcript next to the recordings.
 *
 * - The session id is checked first (`isValidSessionId`); a bad id answers not_found without touching the disk.
 * - Open-then-check only (as `readHead` in log-identity.ts): O_RDONLY|O_NOFOLLOW|O_NONBLOCK, judged through `fstat` on the descriptor
 *   (a regular file of this user), then read through that descriptor.
 * - Caps: a log over maxBytes, or utterance text over maxChars in total, answers too_large, never a partial list.
 * - A line is kept only when it parses, is an `utterance` of the requested session, and has numeric seq and ts and string roleId and
 *   text. Fields are picked one by one (no `channel`, nothing else leaks through).
 * - Synchronous; never throws; logs nothing.
 */
export type TranscriptLine = { seq: number; ts: number; roleId: string; text: string };
export type TranscriptRead = { kind: "ok"; lines: TranscriptLine[] } | { kind: "not_found" } | { kind: "too_large" };

export const MAX_LOG_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
const FILE_FLAGS = fc.O_RDONLY | fc.O_NOFOLLOW | fc.O_NONBLOCK;

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** The whole of a regular file of this user no larger than maxBytes; "too_large" over the cap; null otherwise. */
function readWhole(file: string, maxBytes: number): string | "too_large" | null {
  let fd: number;
  try { fd = openSync(file, FILE_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid)) return null;
    if (st.size > maxBytes) return "too_large";
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}

export function readTranscript(sessionsDir: string, sessionId: string, caps?: { maxBytes?: number; maxChars?: number }): TranscriptRead {
  try {
    if (!isValidSessionId(sessionId)) return { kind: "not_found" };
    const maxBytes = caps?.maxBytes ?? MAX_LOG_BYTES;
    const maxChars = caps?.maxChars ?? MAX_TRANSCRIPT_CHARS;
    const text = readWhole(path.join(sessionsDir, `${sessionId}.jsonl`), maxBytes);
    if (text === null) return { kind: "not_found" };
    if (text === "too_large") return { kind: "too_large" };
    const lines: TranscriptLine[] = [];
    let chars = 0;
    for (const raw of text.split("\n")) {
      if (raw === "") continue;
      let v: unknown;
      try { v = JSON.parse(raw); } catch { continue; }
      if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
      const e = v as { type?: unknown; sessionId?: unknown; seq?: unknown; ts?: unknown; roleId?: unknown; text?: unknown };
      if (e.type !== "utterance" || e.sessionId !== sessionId) continue;
      if (typeof e.seq !== "number" || typeof e.ts !== "number" || typeof e.roleId !== "string" || typeof e.text !== "string") continue;
      chars += e.text.length;
      if (chars > maxChars) return { kind: "too_large" };
      lines.push({ seq: e.seq, ts: e.ts, roleId: e.roleId, text: e.text });
    }
    return { kind: "ok", lines };
  } catch { return { kind: "not_found" }; }
}
