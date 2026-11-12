import { closeSync, constants as fc, fstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { isLowerHex } from "@acr/speech/protocol";

/**
 * US-0074 (voice A2b-1a, spec sections 2 and 3): finds the audio folders of a session. Each identity folder the speech worker writes holds
 * `session.json` = `{ "v": 1, "sessionId": "<id>" }`; a restart on the same session can rotate the log and start a new identity, so a
 * session may own several folders. The folders hold consented voice audio, so every step is conservative and read-only:
 *
 * - The session id is checked first (`isValidSessionId`): an invalid one returns `[]` before any file call.
 * - Open-then-check only (CodeQL `js/file-system-race`): every directory is OPENED with O_DIRECTORY|O_NOFOLLOW and judged through
 *   `fstat` on that descriptor (a directory owned by this user) before it is listed or entered; the marker is opened O_NOFOLLOW and
 *   judged through its descriptor (a regular file of this user, at most 4 KB) and read through it. No path is ever stat'ed first.
 * - Candidates are `audioDir` entries named exactly 32 lower-case hex (`isLowerHex`). A marker is trusted only when it is a JSON object
 *   with exactly the keys `v` (1) and `sessionId` (the requested id); anything else ignores that folder.
 * - Node cannot list a directory through a descriptor, so `audioDir` is listed by path while its verified descriptor is held open and
 *   re-opened afterwards: a different directory under that path (same device and inode required) gives `[]`.
 * - The fallback (`fallbackIdentity`, the session log's identity for folders recorded before markers existed) is asked only when no
 *   marker matched; its answer must be 32 lower-case hex and name a real directory of this user. A rejection counts as no answer.
 * - No cache (every call scans), never throws, logs nothing (so no path, id or content can leak).
 */
export const MAX_SESSION_MARKER_BYTES = 4_096;
const MARKER_NAME = "session.json";
// O_NONBLOCK: a FIFO planted under a watched name must fail or open at once, never hang the open (fstat then refuses it).
const DIR_FLAGS = fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW | fc.O_NONBLOCK;
const FILE_FLAGS = fc.O_RDONLY | fc.O_NOFOLLOW | fc.O_NONBLOCK;

export type AudioCatalogOptions = {
  audioDir: string;
  /** Asked only when no marker names the session: the identity recorded in the session's log, or undefined. */
  fallbackIdentity?: (sessionId: string) => Promise<string | undefined>;
};

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);
const isOwn = (st: Stats): boolean => { const uid = ownUid(); return uid === null || st.uid === uid; };
const sameIdent = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Opens `p` as a real directory of this user: the descriptor and its Stats, or null (missing, a link, not a directory, foreign). */
function openOwnDir(p: string): { fd: number; st: Stats } | null {
  let fd: number;
  try { fd = openSync(p, DIR_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (st.isDirectory() && isOwn(st)) return { fd, st };
  } catch { /* judged unsafe below */ }
  try { closeSync(fd); } catch { /* nothing more to do */ }
  return null;
}

/** True when `p` still opens as a real directory of this user with the identity `expected` (opened, never stat'ed by path). */
function stillOwnDir(p: string, expected: Stats): boolean {
  const d = openOwnDir(p);
  if (d === null) return false;
  try { return sameIdent(d.st, expected); } finally { closeSync(d.fd); }
}

/** The marker's text: opened O_NOFOLLOW, a regular file of this user on the folder's device, at most 4 KB, read through the descriptor. */
function readMarker(file: string, folder: Stats): string | null {
  let fd: number;
  try { fd = openSync(file, FILE_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !isOwn(st) || st.dev !== folder.dev || st.size > MAX_SESSION_MARKER_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}

/** A marker names `sessionId` only when it is exactly `{ v: 1, sessionId }` (no other key, no other shape). */
function markerNames(text: string, sessionId: string): boolean {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return false; }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes("v") || !keys.includes("sessionId")) return false;
  const m = v as { v: unknown; sessionId: unknown };
  return m.v === 1 && m.sessionId === sessionId;
}

/** True when the identity folder `<audioDir>/<name>` is a real directory of this user whose marker names `sessionId`. */
function folderMatches(audioDir: string, name: string, sessionId: string): boolean {
  const dirPath = path.join(audioDir, name);
  const d = openOwnDir(dirPath);
  if (d === null) return false;
  try {
    // The folder's descriptor stays open while its marker is read (its inode cannot be reused meanwhile), and the folder is opened
    // again afterwards: a folder swapped under the name during the read is not trusted.
    const text = readMarker(path.join(dirPath, MARKER_NAME), d.st);
    return text !== null && markerNames(text, sessionId) && stillOwnDir(dirPath, d.st);
  } finally { closeSync(d.fd); }
}

export class AudioCatalog {
  constructor(private readonly o: AudioCatalogOptions) {}

  /** Every identity folder of the session, sorted; else the fallback's identity when its folder is real; else `[]`. Never rejects. */
  async find(sessionId: string): Promise<string[]> {
    if (!isValidSessionId(sessionId)) return [];
    const audioDir = this.o.audioDir;
    const rootDir = openOwnDir(audioDir);
    if (rootDir === null) return []; // missing, a link, not a directory or another user's: nothing is read through it
    try {
      let names: string[];
      try { names = readdirSync(audioDir); } catch { return []; }
      const found: string[] = [];
      for (const name of names) {
        if (isLowerHex(name, 32) && folderMatches(audioDir, name, sessionId)) found.push(name);
      }
      if (found.length === 0) {
        const answer = await this.askFallback(sessionId);
        if (answer !== undefined && isLowerHex(answer, 32)) {
          const d = openOwnDir(path.join(audioDir, answer));
          if (d !== null) { closeSync(d.fd); found.push(answer); }
        }
      }
      // The listing and every folder were reached through the path `audioDir`: it must still be the directory judged at the start.
      if (!stillOwnDir(audioDir, rootDir.st)) return [];
      return found.sort();
    } catch {
      return [];
    } finally {
      try { closeSync(rootDir.fd); } catch { /* nothing more to do */ }
    }
  }

  private async askFallback(sessionId: string): Promise<string | undefined> {
    const f = this.o.fallbackIdentity;
    if (f === undefined) return undefined;
    try { return await f(sessionId); } catch { return undefined; }
  }
}
