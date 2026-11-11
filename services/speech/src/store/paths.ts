import { closeSync, constants as fc, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { isFileSafeId } from "@acr/events";
import { assertInside } from "@acr/runtime/files";
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

const DIR_FLAGS = fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW;

/**
 * Opens `dir` as a directory without following a link: a link, a file or a missing entry makes the open itself fail (the path is never
 * checked first and then used). macOS answers a link with ELOOP, Linux (O_DIRECTORY) may answer ENOTDIR; both are refused.
 */
function openRealDir(dir: string, what: "folder" | "audio directory"): number {
  try { return openSync(dir, DIR_FLAGS); } catch (err) { throw openError(err, what); }
}
function openError(err: unknown, what: "folder" | "audio directory"): StorePathError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new StorePathError(`${what} missing`);
  if (code === "ELOOP") return new StorePathError(`${what} is a link`);
  if (code === "ENOTDIR") return new StorePathError(`${what} is not a directory`);
  return new StorePathError(`${what} could not be opened safely`);
}

/**
 * Every check on the open descriptor: a directory owned by this user; group and other permissions are dropped through the descriptor
 * (`storeFsHooks.fchmod`) and a folder that is still group/other-writable is refused.
 */
function requireRealOwnDirFd(fd: number, what: "folder" | "audio directory"): void {
  const open = fstatSync(fd);
  if (!open.isDirectory()) throw new StorePathError(`${what} is not a directory`);
  const uid = ownUid();
  if (uid !== null && open.uid !== uid) throw new StorePathError(`${what} is owned by another user`);
  let mode = open.mode;
  if ((mode & 0o077) !== 0) {
    try { storeFsHooks.fchmod(fd, mode & 0o700); mode = fstatSync(fd).mode; } catch { /* judged below */ }
  }
  if ((mode & 0o022) !== 0) throw new StorePathError(`${what} is writable by others and could not be repaired`);
}

/** Throws unless `dir` is a real private directory of this user (see `openRealDir` and `requireRealOwnDirFd`). */
function requireRealOwnDir(dir: string): void {
  const fd = openRealDir(dir, "folder");
  try { requireRealOwnDirFd(fd, "folder"); } finally { closeSync(fd); }
}

/** `mkdir` one level (0700, EEXIST tolerated), then require it to be a real private folder of this user. */
function makeLevel(dir: string): void {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new StorePathError("could not create a folder");
  }
  requireRealOwnDir(dir);
}

/**
 * Checks `audioDir` itself, opening it first: missing, it is created (0700, with its parents) and opened again; a link or a file at
 * that name fails the open and is refused (nothing is ever created through a link).
 */
export function ensureAudioRoot(audioDir: string): void {
  let fd: number;
  try { fd = openSync(audioDir, DIR_FLAGS); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw openError(err, "audio directory");
    try { mkdirSync(audioDir, { recursive: true, mode: 0o700 }); } catch { throw new StorePathError("audio directory could not be created"); }
    fd = openRealDir(audioDir, "audio directory");
  }
  try { requireRealOwnDirFd(fd, "audio directory"); } finally { closeSync(fd); }
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
 * Creates `<audioDir>/<identity>/<roleId>` one level at a time (0700) and returns it. Every level, `audioDir` included, is opened
 * O_DIRECTORY|O_NOFOLLOW after its `mkdir` and judged through that descriptor: a real directory owned by this user, made private.
 */
export function ensureRoleDir(audioDir: string, identity: string, roleId: string): string {
  const role = roleDir(audioDir, identity, roleId); // validates every id first: nothing touches the disk on a bad one
  ensureSessionDir(audioDir, identity);
  makeLevel(role);
  return role;
}
