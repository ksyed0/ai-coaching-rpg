import { randomBytes } from "node:crypto";
import {
  closeSync, constants as fsConstants, chmodSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  realpathSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import path from "node:path";
import { parseIPv4 } from "./text.js";

/**
 * US-0072 (EPIC-0003 voice A1c, Task 3): the private voice state directory (`VOICE_STATE_DIR`, default `<HOME>/.scenecoach/voice`), its
 * `state.json` and its lock.
 *
 * - The directory is 0700, owned by this user, not a symbolic link, and never inside the repository. "Inside" is decided on the
 *   REAL paths: the repository root and the nearest existing parent of the state directory are resolved with `realpath`, and on darwin
 *   (a case-insensitive file system by default) both sides are compared in lower case, so neither a symlink nor another letter case
 *   gets it into the repository (batch 1 review A F14; `settings.ts` compares names only). Nothing is created before that check.
 * - `state.json` (0600) records what `voice:up` started: never a secret (no key, no secret, no request path); the shape is strict (an
 *   extra key, a missing one or `v` other than 1 reads as unreadable). It is written atomically (an O_EXCL temp, fsync, rename,
 *   directory fsync) and read through one O_NOFOLLOW descriptor, at most 64 KiB.
 * - The lock (`lock`, 0600) holds the pid of the `voice:up` / `voice:down` that runs. It is made complete before it exists: the pid is
 *   written to a temp file that is then hard-linked to `lock` (link fails if `lock` exists), so a reader never sees an empty lock. A
 *   lock whose pid is dead, or that holds no pid, is removed and taken once. Residual: two runs that find the same dead lock at the
 *   same moment can both take it (each removes and links in turn); only the same user can start them.
 *
 * Errors are StateDirError with a fixed sentence per code, naming the variable, never a path.
 */

export type StateDirErrorCode = "inside_repo" | "symlink" | "not_directory" | "not_owner" | "too_open" | "not_empty" | "unusable";

const SENTENCES: Record<StateDirErrorCode, string> = {
  inside_repo: "VOICE_STATE_DIR must be outside the repository (also through a symbolic link or another letter case): it holds livekit.env and whisper.log",
  symlink: "VOICE_STATE_DIR (or a folder in it) is a symbolic link: use a real folder, mode 700",
  not_directory: "VOICE_STATE_DIR (or a folder in it) is not a folder: remove what is there or choose another VOICE_STATE_DIR",
  not_owner: "VOICE_STATE_DIR (or a folder in it) belongs to another user: choose a folder of your own",
  too_open: "VOICE_STATE_DIR (or a folder in it) is open to other users: run chmod 700 on it, then try again",
  not_empty: "the public folder in VOICE_STATE_DIR is not empty: whisper-server would serve what is in it; empty it, then pnpm voice:up",
  unusable: "VOICE_STATE_DIR cannot be created or read: check the folder and its permissions",
};

export class StateDirError extends Error {
  constructor(readonly code: StateDirErrorCode) {
    super(SENTENCES[code]);
    this.name = "StateDirError";
  }
}

export const STATE_FILE = "state.json";
export const LOCK_FILE = "lock";
const MAX_STATE_BYTES = 64 * 1024;
export const COMPOSE_PROJECT_NAME = "scenecoach-voice";
const PROFILES = new Set(["lan", "lan-dns"]);

export type WhisperRecord = { pid: number; port: number; startedAt: number; comm: string };
export type VoiceOpsState = {
  v: 1; access: "local" | "lan"; nodeIp: string;
  ports: { stt: number; livekit: 7880; tcp: 7881; udp: 7882; https?: number; livekitTls?: number };
  /** [] or ["lan"] (["lan-dns"] with Task 13). */
  profiles: string[];
  /** comm: the `ps -o comm=` basename read right after voice:up's own spawn. */
  whisper?: WhisperRecord;
  compose?: { project: "scenecoach-voice"; profiles: string[] };
};

type OpenOptions = { repoRoot: string; uid?: number; platform?: NodeJS.Platform };

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** `realpath` of the nearest existing parent of `p` (or `p` itself), with the components that do not exist yet appended unchanged. */
function realOfNearest(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(realpathSync(cur), ...rest.reverse()); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw new StateDirError("unusable");
      const parent = path.dirname(cur);
      if (parent === cur) throw new StateDirError("unusable");
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** Whether `p` is `root` or inside it, on real paths, ignoring case on darwin. */
export function isInsideReal(root: string, p: string, platform: NodeJS.Platform = process.platform): boolean {
  let r = realOfNearest(root);
  let q = realOfNearest(p);
  if (platform === "darwin") { r = r.toLowerCase(); q = q.toLowerCase(); }
  const rel = path.relative(r, q);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** lstat checks of one directory: a directory, not a link, owned by `uid`, no group or other bits. */
function checkPrivateDir(dir: string, uid: number | undefined): void {
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(dir); } catch { throw new StateDirError("unusable"); }
  if (st.isSymbolicLink()) throw new StateDirError("symlink");
  if (!st.isDirectory()) throw new StateDirError("not_directory");
  if (uid !== undefined && st.uid !== uid) throw new StateDirError("not_owner");
  if ((st.mode & 0o077) !== 0) throw new StateDirError("too_open");
}

/** mkdir of one level at 0700 (set again after creation, whatever the umask); an existing entry is left as it is. */
function makePrivateDir(dir: string): void {
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw new StateDirError("unusable");
  }
  try { chmodSync(dir, 0o700); } catch { throw new StateDirError("unusable"); }
}

/**
 * Opens (creating when missing, with any missing parents at 0700) the state directory and checks it. The inside-the-repository refusal
 * comes first, so nothing is ever created inside the repository. Throws StateDirError.
 */
export function openStateDir(dir: string, o: OpenOptions): void {
  const abs = path.resolve(dir);
  if (isInsideReal(o.repoRoot, abs, o.platform)) throw new StateDirError("inside_repo");
  const missing: string[] = [];
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try { lstatSync(cur); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new StateDirError("unusable");
      if (path.dirname(cur) === cur) throw new StateDirError("unusable");
      missing.push(cur);
    }
  }
  for (const d of missing.reverse()) makePrivateDir(d);
  checkPrivateDir(abs, o.uid ?? currentUid());
}

/**
 * A 0700 folder directly in the state directory (`public`, `tmp`, `caddy-data`), created when missing and checked like the state
 * directory; with `empty`, it must hold nothing (whisper-server's `--public` folder: it serves what is in it). Returns its path.
 */
export function openPrivateSubdir(stateDir: string, name: string, o: { empty?: boolean; uid?: number } = {}): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error("a state folder name is one plain path segment");
  const dir = path.join(stateDir, name);
  makePrivateDir(dir);
  checkPrivateDir(dir, o.uid ?? currentUid());
  if (o.empty) {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { throw new StateDirError("unusable"); }
    if (entries.length > 0) throw new StateDirError("not_empty");
  }
  return dir;
}

// ---- state.json ----

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Exactly the required keys, plus any of the optional ones, and nothing else. */
function hasKeys(o: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  for (const k of required) if (!Object.hasOwn(o, k)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}
const isProfiles = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === "string" && PROFILES.has(p));
/** A process name as `ps -o comm=` gives it, basename only: 1 to 64 printable characters, no slash. */
function isComm(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 1 || v.length > 64) return false;
  for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (c < 0x20 || c > 0x7e || c === 0x2f) return false; }
  return true;
}

/** The strict shape of `state.json`; anything else is not a state. */
export function isVoiceOpsState(v: unknown): v is VoiceOpsState {
  if (!isPlainObject(v) || !hasKeys(v, ["v", "access", "nodeIp", "ports", "profiles"], ["whisper", "compose"])) return false;
  if (v.v !== 1 || (v.access !== "local" && v.access !== "lan") || typeof v.nodeIp !== "string" || parseIPv4(v.nodeIp) === null) return false;
  const p = v.ports;
  if (!isPlainObject(p) || !hasKeys(p, ["stt", "livekit", "tcp", "udp"], ["https", "livekitTls"])) return false;
  if (!isPort(p.stt) || p.livekit !== 7880 || p.tcp !== 7881 || p.udp !== 7882) return false;
  if ((Object.hasOwn(p, "https") && !isPort(p.https)) || (Object.hasOwn(p, "livekitTls") && !isPort(p.livekitTls))) return false;
  if (!isProfiles(v.profiles)) return false;
  if (Object.hasOwn(v, "whisper")) {
    const w = v.whisper;
    if (!isPlainObject(w) || !hasKeys(w, ["pid", "port", "startedAt", "comm"])) return false;
    if (typeof w.pid !== "number" || !Number.isInteger(w.pid) || w.pid < 1 || !isPort(w.port)) return false;
    if (typeof w.startedAt !== "number" || !Number.isFinite(w.startedAt) || !isComm(w.comm)) return false;
  }
  if (Object.hasOwn(v, "compose")) {
    const c = v.compose;
    if (!isPlainObject(c) || !hasKeys(c, ["project", "profiles"]) || c.project !== COMPOSE_PROJECT_NAME || !isProfiles(c.profiles)) return false;
  }
  return true;
}

/**
 * Reads `state.json`: `none` when there is none; `unreadable` when it is a link, not a regular file, not this user's, open to others,
 * over 64 KiB, not JSON or not exactly the state shape (the caller reports it by name: "the voice state is unreadable ...").
 */
export function loadState(dir: string, o: { uid?: number } = {}): { status: "none" } | { status: "unreadable" } | { status: "ok"; state: VoiceOpsState } {
  let fd: number;
  try { fd = openSync(path.join(dir, STATE_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? { status: "none" } : { status: "unreadable" }; }
  try {
    const st = fstatSync(fd);
    const uid = o.uid ?? currentUid();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0 || st.size > MAX_STATE_BYTES) return { status: "unreadable" };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    let parsed: unknown;
    try { parsed = JSON.parse(buf.subarray(0, off).toString("utf8")); } catch { return { status: "unreadable" }; }
    return isVoiceOpsState(parsed) ? { status: "ok", state: parsed } : { status: "unreadable" };
  } catch { return { status: "unreadable" }; }
  finally { try { closeSync(fd); } catch { /* read-only */ } }
}

/** The plan's shape: the state, or null when there is none or it is unreadable (`loadState` tells the two apart). */
export function readState(dir: string): VoiceOpsState | null {
  const r = loadState(dir);
  return r.status === "ok" ? r.state : null;
}

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, fsConstants.O_RDONLY); fsyncSync(fd); }
  catch { /* some file systems refuse a directory fsync; the rename itself is atomic */ }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* read-only */ } } }
}

/** Writes `data` to a new O_EXCL 0600 temp file beside `target` and renames it over `target`; the temp is removed on any failure. */
export function writePrivateFileAtomic(target: string, data: string | Buffer): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try {
      fchmodSync(fd, 0o600); // the umask may have removed owner bits from the 0600 of the open
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already renamed */ }
    throw err;
  }
  fsyncDir(dir);
}

/** Writes `state.json` atomically (0600). A state that would not read back (`isVoiceOpsState`) is refused before anything is written. */
export function writeState(dir: string, s: VoiceOpsState): void {
  if (!isVoiceOpsState(s)) throw new Error("refusing to write a voice state of the wrong shape");
  writePrivateFileAtomic(path.join(dir, STATE_FILE), JSON.stringify(s) + "\n");
}

export function clearState(dir: string): void {
  try { unlinkSync(path.join(dir, STATE_FILE)); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

// ---- the lock ----

/** The pid in the lock file, or null when it holds none; "link" when the lock is not a regular file (never followed). */
function lockHolder(file: string): number | null | "link" {
  let fd: number;
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return "link";
  }
  try {
    if (!fstatSync(fd).isFile()) return "link";
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8").trim();
    if (text.length < 1 || text.length > 10) return null;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c < 0x30 || c > 0x39) return null; }
    const pid = Number(text);
    return pid >= 1 ? pid : null;
  } finally { try { closeSync(fd); } catch { /* read-only */ } }
}

/** Creates `lock` holding `pid`, complete before it exists (temp, then link); false when `lock` already exists. */
function tryLink(dir: string, pid: number): boolean {
  const tmp = path.join(dir, `.lock.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    try { fchmodSync(fd, 0o600); writeSync(fd, `${pid}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, path.join(dir, LOCK_FILE)); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return false; throw err; }
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}

/**
 * Takes `<dir>/lock` for `pid`: "taken", or "busy" when another live process holds it. A lock whose pid `alive` says is dead, or that
 * holds no pid, is removed and taken once. A lock that is a symbolic link or not a regular file is never followed or removed: busy.
 */
export function acquireLock(dir: string, pid: number, alive: (pid: number) => boolean): "taken" | "busy" {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryLink(dir, pid)) return "taken";
    const holder = lockHolder(path.join(dir, LOCK_FILE));
    if (holder === "link") return "busy";
    if (holder !== null && holder !== pid && alive(holder)) return "busy";
    if (attempt === 0) {
      try { unlinkSync(path.join(dir, LOCK_FILE)); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "busy"; }
    }
  }
  return "busy";
}

/** Removes `<dir>/lock` only when it holds `pid`. */
export function releaseLock(dir: string, pid: number): void {
  if (lockHolder(path.join(dir, LOCK_FILE)) !== pid) return;
  try { unlinkSync(path.join(dir, LOCK_FILE)); } catch { /* already gone */ }
}
