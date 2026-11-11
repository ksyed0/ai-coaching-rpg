import { closeSync, constants as fc, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { isFileSafeId } from "@acr/events";
import { assertInside, ensurePrivateDir } from "@acr/runtime/files";
import { isLowerHex } from "../protocol.js";

/** US-0073 (voice A2a, Task 4): the audio store's folder layout. Names the failure kind only: never a path, an id or an identity. */
export class StorePathError extends Error {
  constructor(kind: string) { super(`audio store path refused: ${kind}`); this.name = "StorePathError"; }
}

const IDENTITY_CHARS = 32;

function checkIdentity(identity: string): void {
  if (!isLowerHex(identity, IDENTITY_CHARS)) throw new StorePathError("bad log identity");
}
function checkId(id: string, kind: string): void {
  if (!isFileSafeId(id)) throw new StorePathError(`bad ${kind} id`);
}
/** Joins `parts` under `audioDir` and proves the result stays strictly inside it. */
function within(audioDir: string, ...parts: string[]): string {
  const target = path.join(audioDir, ...parts);
  try { assertInside(audioDir, target); } catch { throw new StorePathError("path outside the audio directory"); }
  return target;
}

/** `<audioDir>/<identity>`; `identity` is exactly 32 lower-case hex. */
export function sessionDir(audioDir: string, identity: string): string {
  checkIdentity(identity);
  return within(audioDir, identity);
}
/** `<audioDir>/<identity>/<roleId>`. */
export function roleDir(audioDir: string, identity: string, roleId: string): string {
  checkIdentity(identity); checkId(roleId, "role");
  return within(audioDir, identity, roleId);
}
/** `<audioDir>/<identity>/<roleId>/<segmentId>.wav`. */
export function segmentFile(audioDir: string, identity: string, roleId: string, segmentId: string): string {
  checkIdentity(identity); checkId(roleId, "role"); checkId(segmentId, "segment");
  return within(audioDir, identity, roleId, `${segmentId}.wav`);
}

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

/** Test seam: the one call that repairs a folder's mode (an owner-only repair cannot be made to fail for real). */
export const storeFsHooks = { fchmod: fchmodSync };

/**
 * Throws unless `dir` is a real directory (not a link) owned by this user, then drops group and other permissions through an
 * O_DIRECTORY|O_NOFOLLOW descriptor and refuses a folder that is still group/other-writable.
 */
function requireRealOwnDir(dir: string): void {
  let st;
  try { st = lstatSync(dir); } catch { throw new StorePathError("folder missing after creation"); }
  if (st.isSymbolicLink()) throw new StorePathError("folder is a link");
  if (!st.isDirectory()) throw new StorePathError("folder is not a directory");
  const uid = ownUid();
  if (uid !== null && st.uid !== uid) throw new StorePathError("folder is owned by another user");
  let fd: number;
  try { fd = openSync(dir, fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW); } catch { throw new StorePathError("folder could not be opened safely"); }
  try {
    const open = fstatSync(fd);
    if (open.ino !== st.ino || open.dev !== st.dev || !open.isDirectory()) throw new StorePathError("folder changed while checking");
    let mode = open.mode;
    if ((mode & 0o077) !== 0) {
      try { storeFsHooks.fchmod(fd, mode & 0o700); mode = fstatSync(fd).mode; } catch { /* judged below */ }
    }
    if ((mode & 0o022) !== 0) throw new StorePathError("folder is writable by others and could not be repaired");
  } finally { closeSync(fd); }
}

/** `mkdir` one level (0700, EEXIST tolerated), then require it to be a real private folder of this user. */
function makeLevel(dir: string): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new StorePathError("could not create a folder");
  }
  requireRealOwnDir(dir);
}

/** Checks `audioDir` itself: `lstat`ed BEFORE `ensurePrivateDir`, because that helper follows links and chmods a group-writable folder. */
export function ensureAudioRoot(audioDir: string): void {
  let st;
  try { st = lstatSync(audioDir); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new StorePathError("audio directory unreadable");
  }
  if (st?.isSymbolicLink()) throw new StorePathError("audio directory is a link");
  try { ensurePrivateDir(audioDir); } catch { throw new StorePathError("audio directory is not private"); }
  requireRealOwnDir(audioDir);
}

/**
 * Creates `<audioDir>/<identity>` (0700) and returns it (US-0073 Task 6: the folder `ended.json` lives in). Same checks as
 * `ensureRoleDir`: the identity is validated before anything touches the disk, and every level must be a real folder of this user.
 */
export function ensureSessionDir(audioDir: string, identity: string): string {
  const session = sessionDir(audioDir, identity);
  ensureAudioRoot(audioDir);
  makeLevel(session);
  return session;
}

/**
 * Creates `<audioDir>/<identity>/<roleId>` one level at a time (0700) and returns it. `audioDir` is `lstat`ed BEFORE
 * `ensurePrivateDir`, because that helper follows links and chmods a group-writable folder rather than refusing it; every
 * level is `lstat`ed after its `mkdir` and must be a real directory owned by this user.
 */
export function ensureRoleDir(audioDir: string, identity: string, roleId: string): string {
  const role = roleDir(audioDir, identity, roleId); // validates every id first: nothing touches the disk on a bad one
  ensureSessionDir(audioDir, identity);
  makeLevel(role);
  return role;
}
