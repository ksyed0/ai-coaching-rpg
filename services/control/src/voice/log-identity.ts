import { closeSync, constants as fc, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { isLowerHex } from "@acr/speech/protocol";

/**
 * US-0074 (voice A2b-1a, spec section 3): the pre-marker fallback of the audio catalog. Audio folders recorded before session markers
 * existed are found through the session log's first event, `session.started`, whose `logIdentity` (32 lower-case hex, log format 2) names
 * the identity folder. Nothing in control read that field before (report jobs read the log's END through `log-tail.ts`), hence this reader.
 *
 * - The session id is checked first (`isValidSessionId`); the log is `<sessionsDir>/<sessionId>.jsonl` (as report-job.ts and
 *   moderation.ts build it).
 * - Open-then-check only: opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK, judged through `fstat` on the descriptor (a regular file of this user),
 *   and at most the first MAX_LOG_HEAD_BYTES are read through it.
 * - Only the FIRST line counts, and only when it is a complete JSON object `{ seq: 1, sessionId: <the id>, type: "session.started", ... }`
 *   whose `logIdentity` passes `isLowerHex(v, 32)`; anything else (torn, another event first, another session, a first line longer than
 *   the head) answers undefined.
 * - Never throws or rejects; logs nothing.
 */
export const MAX_LOG_HEAD_BYTES = 64 * 1024;
const FILE_FLAGS = fc.O_RDONLY | fc.O_NOFOLLOW | fc.O_NONBLOCK;

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** The first MAX_LOG_HEAD_BYTES of a regular file of this user, or null. */
function readHead(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, FILE_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid)) return null;
    const buf = Buffer.alloc(Math.min(st.size, MAX_LOG_HEAD_BYTES));
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}

export async function readLogIdentity(sessionsDir: string, sessionId: string): Promise<string | undefined> {
  try {
    if (!isValidSessionId(sessionId)) return undefined;
    const head = readHead(path.join(sessionsDir, `${sessionId}.jsonl`));
    if (head === null) return undefined;
    // A head with no newline is the whole first line only when JSON.parse accepts it (a cut-off line never parses as an object).
    const nl = head.indexOf("\n");
    const first = nl === -1 ? head : head.slice(0, nl);
    let v: unknown;
    try { v = JSON.parse(first); } catch { return undefined; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
    const e = v as { seq?: unknown; sessionId?: unknown; type?: unknown; logIdentity?: unknown };
    if (e.type !== "session.started" || e.seq !== 1 || e.sessionId !== sessionId) return undefined;
    return isLowerHex(e.logIdentity, 32) ? (e.logIdentity as string) : undefined;
  } catch { return undefined; }
}

/** The production `AudioCatalogOptions.fallbackIdentity` (wired in Task 8 with control's `config.sessionsDir`). */
export function makeFallbackIdentity(sessionsDir: string): (sessionId: string) => Promise<string | undefined> {
  return (sessionId) => readLogIdentity(sessionsDir, sessionId);
}
