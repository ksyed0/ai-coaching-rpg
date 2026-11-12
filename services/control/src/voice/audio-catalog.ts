import { closeSync, constants as fc, fstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import path from "node:path";
import { isFileSafeId, isValidSessionId } from "@acr/events";
import { isLowerHex } from "@acr/speech/protocol";
import { auditFile } from "./audit-log.js";
import { MAX_INDEX_BYTES } from "./sweep.js";

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
 * - `audioDir` must be a directory of this user with no group or other write bit (0700 or 0750; ruling R3), or the answer is `[]`.
 * - The fallback (`fallbackIdentity`, the session log's identity for folders recorded before markers existed) is asked only when no
 *   marker matched; its answer must be 32 lower-case hex and name a real directory of this user that holds NO `session.json` (any
 *   marker there, valid or not, refuses it). A rejection counts as no answer.
 * - No cache (every call scans), never throws, logs nothing (so no path, id or content can leak).
 *
 * `list(identity)` (spec section 4) reads one identity folder under the same rules: each file-safe role folder that opens as a real
 * directory of this user contributes the segments of its `index.jsonl` (O_NOFOLLOW, regular file of this user, 64 MiB cap, strict v1
 * lines, torn lines skipped; an index that cannot be trusted contributes nothing for that role). `raw` is never copied. A segment's audio
 * is `deleted` when a `kind:"deleted"` line names it, `available` when its WAV opens as a regular file of this user with one link, else
 * `missing`; a WAV with no index line is not listed. `readSegmentIndex` exposes one role's index for the replay route.
 */
export const MAX_SESSION_MARKER_BYTES = 4_096;
const MARKER_NAME = "session.json";
// O_NONBLOCK: a FIFO planted under a watched name must fail or open at once, never hang the open (fstat then refuses it).
const DIR_FLAGS = fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW | fc.O_NONBLOCK;
export const FILE_FLAGS = fc.O_RDONLY | fc.O_NOFOLLOW | fc.O_NONBLOCK;

export type AudioCatalogOptions = {
  audioDir: string;
  /** Asked only when no marker names the session: the identity recorded in the session's log, or undefined. */
  fallbackIdentity?: (sessionId: string) => Promise<string | undefined>;
};

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);
export const isOwn = (st: Stats): boolean => { const uid = ownUid(); return uid === null || st.uid === uid; };
const sameIdent = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Opens `p` as a real directory of this user: the descriptor and its Stats, or null (missing, a link, not a directory, foreign). */
export function openOwnDir(p: string): { fd: number; st: Stats } | null {
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
export function stillOwnDir(p: string, expected: Stats): boolean {
  const d = openOwnDir(p);
  if (d === null) return false;
  try { return sameIdent(d.st, expected); } finally { closeSync(d.fd); }
}

const MISSING = Object.freeze({ missing: true as const });

/**
 * A small file's text, opened FIRST (O_NOFOLLOW|O_NONBLOCK) and judged through its descriptor: a regular file of this user, on the
 * device of `folder` when one is given, at most `maxBytes`, read through the descriptor. MISSING only when the open failed with ENOENT;
 * null on every other failure (a link, not a regular file, another user's, too large, unreadable).
 */
function readOwnFile(file: string, maxBytes: number, folder: Stats | null): string | typeof MISSING | null {
  let fd: number;
  try { fd = openSync(file, FILE_FLAGS); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? MISSING : null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !isOwn(st) || (folder !== null && st.dev !== folder.dev) || st.size > maxBytes) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    return buf.toString("utf8", 0, off);
  } catch { return null; } finally { closeSync(fd); }
}

/** The marker's text: opened O_NOFOLLOW, a regular file of this user on the folder's device, at most 4 KB, read through the descriptor. */
function readMarker(file: string, folder: Stats): string | null {
  const r = readOwnFile(file, MAX_SESSION_MARKER_BYTES, folder);
  return typeof r === "string" ? r : null;
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

/**
 * The fallback's folder is accepted only as a folder recorded BEFORE markers existed: a real directory of this user with NO `session.json`
 * at all (ENOENT on the O_NOFOLLOW open). Any marker, even a torn, oversized, linked or foreign one, is the folder's own binding and the
 * session log's answer never overrides it (a stale or wrong logIdentity must not hand out another session's audio).
 */
function preMarkerFolder(dirPath: string): boolean {
  const d = openOwnDir(dirPath);
  if (d === null) return false;
  try {
    let fd: number;
    try { fd = openSync(path.join(dirPath, MARKER_NAME), FILE_FLAGS); } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" && stillOwnDir(dirPath, d.st);
    }
    closeSync(fd); // something is there: refused
    return false;
  } finally { closeSync(d.fd); }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Task 5 (spec section 4): a role's segment index and the listing of one identity folder.
// ---------------------------------------------------------------------------------------------------------------------------------

/** The largest role `index.jsonl` (and audit file) read: the sweep's cap, 64 MiB. A larger file contributes nothing. */
export const MAX_SEGMENT_INDEX_BYTES = MAX_INDEX_BYTES;
const INDEX_NAME = "index.jsonl";

/** What a listing or a replay may know of a segment's index line: never `raw` (the transcript text) and never `timings`. */
export type SegmentEntry = { participantId: string; startMs: number; endMs: number; status: string; seq?: number };
/** A role's index: segment id -> its entry and whether a `kind:"deleted"` line names it. */
export type SegmentIndex = Map<string, { entry: SegmentEntry; deleted: boolean }>;
export type SegmentAudio = "available" | "deleted" | "missing";
export type SegmentInfo = { role: string; segment: string } & SegmentEntry & { audio: SegmentAudio };
export type SegmentListing = { segments: SegmentInfo[]; recordingStopped: boolean };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isMs = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const optFinite = (x: unknown): boolean => x === undefined || (typeof x === "number" && Number.isFinite(x));
const validStatus = (s: unknown): s is string =>
  s === "transcribed" || s === "empty" || s === "stt_failed" || (typeof s === "string" && s.startsWith("refused:") && s.length > "refused:".length);
const validSeq = (x: unknown): boolean => x === undefined || (typeof x === "number" && Number.isSafeInteger(x) && x >= 1);

/** A `kind:"segment"` line of exactly the worker's shape (`IndexEntry` in the speech store), reduced to the fields that may leave; else null. */
function segmentEntryOf(v: unknown): { segment: string; entry: SegmentEntry } | null {
  if (!isObj(v) || v.v !== 1 || v.kind !== "segment") return null;
  if (typeof v.segment !== "string" || !isFileSafeId(v.segment) || typeof v.participantId !== "string") return null;
  if (!isMs(v.startMs) || !isMs(v.endMs) || !validStatus(v.status) || !validSeq(v.seq)) return null;
  if (v.raw !== undefined && typeof v.raw !== "string") return null;
  if (v.timings !== undefined && !(isObj(v.timings) && optFinite(v.timings.vadEndMs) && optFinite(v.timings.sttMs))) return null;
  // Built field by field: `raw`, `timings` and any unknown key are never copied.
  const entry: SegmentEntry = { participantId: v.participantId, startMs: v.startMs, endMs: v.endMs, status: v.status };
  if (v.seq !== undefined) entry.seq = v.seq as number;
  return { segment: v.segment, entry };
}

/** Parses an index: torn and malformed lines are skipped; the first segment line of an id wins; a deleted line for an unknown id is ignored. */
function parseSegmentIndex(text: string): SegmentIndex {
  const out: SegmentIndex = new Map();
  const deleted = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; } // a torn last line, or garbage
    if (isObj(v) && v.v === 1 && v.kind === "deleted") {
      if (typeof v.segment === "string" && isFileSafeId(v.segment)) deleted.add(v.segment);
      continue;
    }
    const e = segmentEntryOf(v);
    if (e !== null && !out.has(e.segment)) out.set(e.segment, { entry: e.entry, deleted: false });
  }
  for (const segment of deleted) { const hit = out.get(segment); if (hit !== undefined) hit.deleted = true; }
  return out;
}

/** The index of the role folder `rolePath` (already opened as `roleSt`): an empty Map when it does not exist, null when it cannot be trusted. */
function readIndexIn(rolePath: string, roleSt: Stats): SegmentIndex | null {
  const r = readOwnFile(path.join(rolePath, INDEX_NAME), MAX_SEGMENT_INDEX_BYTES, roleSt);
  if (r === null) return null; // a link, not a regular file, another user's, over the cap, unreadable: "cannot tell"
  if (typeof r !== "string") return new Map(); // ENOENT only: no segments yet
  return parseSegmentIndex(r);
}

/** True when `<rolePath>/<segment>.wav` opens O_NOFOLLOW as a regular file of this user on the role folder's device with one link. */
function wavAvailable(rolePath: string, segment: string, roleSt: Stats): boolean {
  let fd: number;
  try { fd = openSync(path.join(rolePath, `${segment}.wav`), FILE_FLAGS); } catch { return false; }
  try {
    const st = fstatSync(fd);
    return st.isFile() && isOwn(st) && st.nlink === 1 && st.dev === roleSt.dev;
  } catch { return false; } finally { closeSync(fd); }
}

/** One role folder's segments (`role` already checked file-safe), or null when the folder or its index cannot be trusted. */
function roleSegments(identityPath: string, role: string): SegmentInfo[] | null {
  const rolePath = path.join(identityPath, role);
  const d = openOwnDir(rolePath);
  if (d === null) return null; // missing, a link, a file, another user's
  try {
    const index = readIndexIn(rolePath, d.st);
    if (index === null) return null;
    const out: SegmentInfo[] = [];
    for (const [segment, { entry, deleted }] of index) {
      const audio: SegmentAudio = deleted ? "deleted" : wavAvailable(rolePath, segment, d.st) ? "available" : "missing";
      out.push({ role, segment, ...entry, audio });
    }
    // The folder was reached by path: it must still be the directory judged above, or nothing read through it counts.
    return stillOwnDir(rolePath, d.st) ? out : null;
  } finally { closeSync(d.fd); }
}

const bySegmentOrder = (a: SegmentInfo, b: SegmentInfo): number =>
  a.role < b.role ? -1 : a.role > b.role ? 1 : a.startMs - b.startMs || (a.segment < b.segment ? -1 : a.segment > b.segment ? 1 : 0);

/** Every listed segment of `<audioDir>/<identity>` (the root already judged private), sorted by (role, startMs, segment). */
function identitySegments(audioDir: string, identity: string): SegmentInfo[] {
  const identityPath = path.join(audioDir, identity);
  const d = openOwnDir(identityPath);
  if (d === null) return [];
  try {
    let names: string[];
    try { names = readdirSync(identityPath); } catch { return []; }
    const out: SegmentInfo[] = [];
    for (const name of names) {
      if (!isFileSafeId(name)) continue; // session.json, ended.json, hidden and odd names are never role folders
      const segs = roleSegments(identityPath, name);
      if (segs !== null) out.push(...segs);
    }
    if (!stillOwnDir(identityPath, d.st)) return [];
    return out.sort(bySegmentOrder);
  } finally { closeSync(d.fd); }
}

/** True when the identity's audit file (a regular file of this user in the root, within the cap) holds a v1 `voice.recording_stopped` line. */
function recordingStoppedIn(audioDir: string, identity: string, rootSt: Stats): boolean {
  let text: string | typeof MISSING | null;
  try { text = readOwnFile(auditFile(audioDir, identity), MAX_SEGMENT_INDEX_BYTES, rootSt); } catch { return false; }
  if (typeof text !== "string") return false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; } // parsed, never matched by substring
    if (isObj(v) && v.v === 1 && v.type === "voice.recording_stopped") return true;
  }
  return false;
}

/** Opens `audioDir` as a private directory of this user (ruling R3: no group or other write bit), or null. The caller closes it. */
export function openPrivateRoot(audioDir: string): { fd: number; st: Stats } | null {
  const d = openOwnDir(audioDir);
  if (d === null) return null;
  if ((d.st.mode & 0o022) === 0) return d;
  closeSync(d.fd);
  return null;
}

/**
 * Ruling R1: the index of `<audioDir>/<identity>/<role>` (Task 6 decides with it whether a segment may be played). The ids are checked
 * first (a bad one returns null before any file call); the root must be private and every folder a real directory of this user
 * (re-checked after the read). ENOENT for the index gives an empty Map; every other failure gives null. Never rejects; logs nothing.
 */
export async function readSegmentIndex(audioDir: string, identity: string, role: string): Promise<SegmentIndex | null> {
  if (!isLowerHex(identity, 32) || !isFileSafeId(role)) return null;
  try {
    const root = openPrivateRoot(audioDir);
    if (root === null) return null;
    try {
      const identityPath = path.join(audioDir, identity);
      const idDir = openOwnDir(identityPath);
      if (idDir === null) return null;
      try {
        const rolePath = path.join(identityPath, role);
        const roleDir = openOwnDir(rolePath);
        if (roleDir === null) return null;
        try {
          const index = readIndexIn(rolePath, roleDir.st);
          if (index === null) return null;
          const unchanged = stillOwnDir(rolePath, roleDir.st) && stillOwnDir(identityPath, idDir.st) && stillOwnDir(audioDir, root.st);
          return unchanged ? index : null;
        } finally { closeSync(roleDir.fd); }
      } finally { closeSync(idDir.fd); }
    } finally { closeSync(root.fd); }
  } catch { return null; }
}

const emptyListing = (): SegmentListing => ({ segments: [], recordingStopped: false });

export class AudioCatalog {
  constructor(private readonly o: AudioCatalogOptions) {}

  /**
   * The segments of one identity folder (from each real, file-safe role folder's index; a WAV with no index line is not listed) and
   * whether its audit log says recording stopped. A bad identity lists nothing before any file call; an unsafe root lists nothing.
   * Never rejects; `raw` is never copied.
   */
  async list(identity: string): Promise<SegmentListing> {
    if (!isLowerHex(identity, 32)) return emptyListing();
    const audioDir = this.o.audioDir;
    try {
      const root = openPrivateRoot(audioDir);
      if (root === null) return emptyListing();
      try {
        const segments = identitySegments(audioDir, identity);
        const recordingStopped = recordingStoppedIn(audioDir, identity, root.st);
        if (!stillOwnDir(audioDir, root.st)) return emptyListing();
        return { segments, recordingStopped };
      } finally { try { closeSync(root.fd); } catch { /* nothing more to do */ } }
    } catch { return emptyListing(); }
  }

  /** Every identity folder of the session, sorted; else the fallback's identity when it is a pre-marker folder; else `[]`. Never rejects. */
  async find(sessionId: string): Promise<string[]> {
    if (!isValidSessionId(sessionId)) return [];
    const audioDir = this.o.audioDir;
    const rootDir = openOwnDir(audioDir);
    if (rootDir === null) return []; // missing, a link, not a directory or another user's: nothing is read through it
    try {
      // Ruling R3: in a root others can write to, entries could be renamed or planted under watched names between our checks.
      if ((rootDir.st.mode & 0o022) !== 0) return [];
      let names: string[];
      try { names = readdirSync(audioDir); } catch { return []; }
      const found: string[] = [];
      for (const name of names) {
        if (isLowerHex(name, 32) && folderMatches(audioDir, name, sessionId)) found.push(name);
      }
      if (found.length === 0) {
        const answer = await this.askFallback(sessionId);
        if (answer !== undefined && isLowerHex(answer, 32) && preMarkerFolder(path.join(audioDir, answer))) found.push(answer);
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
