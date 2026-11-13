import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import path from "node:path";
import { isFileSafeId } from "@acr/events";
import { isLowerHex } from "@acr/speech/protocol";
import { FILE_FLAGS, isOwn, openOwnDir, openPrivateRoot, readSegmentIndex, stillOwnDir } from "./audio-catalog.js";
import type { AuditLog } from "./audit-log.js";

/**
 * US-0074 (voice A2b-1a, spec sections 5, 7 and 9): the audited whole-file read of one segment's WAV. Audio of a person leaves the store
 * only through this function, so every step is conservative:
 *
 * - The ids are checked first (`role` and `segment` file-safe, every identity 32 lower-case hex): a bad one is `not_found` before any
 *   file call.
 * - `audioDir` must be a private directory of this user (the catalog's rule: no group or other write bit); it is held open throughout and
 *   re-checked (same device and inode) at the end.
 * - The identities are asked in the given order. The first whose role index holds a line for the segment OWNS it (a missing folder or an
 *   index that cannot be trusted counts as no line): a deleted mark there is `audio_deleted` and no later identity is asked.
 * - The owner's identity and role folders are OPENED as real directories of this user; the WAV is opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK
 *   and judged through its descriptor only (a regular file of this user on the role folder's device, one link, 44 to 524288 bytes); the
 *   buffer is sized by that fstat and exactly that many bytes are read through the descriptor (a short read is refused). Every folder
 *   is re-checked after the read, and the index is read again: the line must still be there and still not deleted.
 * - Only then is `audio.played { role, segment, by }` appended to THAT identity's audit log; a `false` (or a throw) is
 *   `audit_unavailable` and the bytes are dropped. No refusal writes an audit line; a success writes exactly one.
 * - Open-then-check only (CodeQL `js/file-system-race`): no path is stat'ed or probed before it is used. Never rejects; logs nothing.
 */
export const MIN_WAV_BYTES = 44;
export const MAX_WAV_BYTES = 524_288;

export type ReplayResult =
  | { ok: true; identity: string; bytes: Buffer }
  | { ok: false; code: "not_found" | "audio_deleted" | "audit_unavailable" };

export type ReplayOptions = {
  audioDir: string;
  /** The session's identity folders (from `AudioCatalog.find`), asked in this order. */
  identities: string[];
  role: string;
  segment: string;
  /** The facilitator's console name (validated by the route). */
  by: string;
  audit: Pick<AuditLog, "append">;
};

const NOT_FOUND = { ok: false, code: "not_found" } as const;
const refused = (code: "not_found" | "audio_deleted" | "audit_unavailable"): ReplayResult => ({ ok: false, code });

/** Reads exactly the fstat size of `<rolePath>/<segment>.wav` through its descriptor, or null (any rule broken, a short read). */
function readWav(rolePath: string, segment: string, roleSt: Stats): Buffer | null {
  let fd: number;
  try { fd = openSync(path.join(rolePath, `${segment}.wav`), FILE_FLAGS); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !isOwn(st) || st.dev !== roleSt.dev || st.nlink !== 1) return null;
    if (st.size < MIN_WAV_BYTES || st.size > MAX_WAV_BYTES) return null;
    const buf = Buffer.alloc(st.size); // sized by the descriptor's fstat only; bytes past it (a file that grew) are never read
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n <= 0) return null; // the file shrank: never serve a partial body
      off += n;
    }
    return buf;
  } catch { return null; } finally { try { closeSync(fd); } catch { /* nothing more to do */ } }
}

/** The owner's WAV, read with its identity and role folders opened as real directories of this user and re-checked after the read. */
function readOwnedWav(audioDir: string, identity: string, role: string, segment: string): Buffer | null {
  const identityPath = path.join(audioDir, identity);
  const idDir = openOwnDir(identityPath);
  if (idDir === null) return null;
  try {
    const rolePath = path.join(identityPath, role);
    const roleDir = openOwnDir(rolePath);
    if (roleDir === null) return null;
    try {
      const bytes = readWav(rolePath, segment, roleDir.st);
      if (bytes === null) return null;
      return stillOwnDir(rolePath, roleDir.st) && stillOwnDir(identityPath, idDir.st) ? bytes : null;
    } finally { closeSync(roleDir.fd); }
  } finally { closeSync(idDir.fd); }
}

const validIds = (o: ReplayOptions): boolean =>
  isFileSafeId(o.role) && isFileSafeId(o.segment) && Array.isArray(o.identities) && o.identities.every((i) => isLowerHex(i, 32));

export async function replaySegment(o: ReplayOptions): Promise<ReplayResult> {
  try {
    if (!validIds(o) || o.identities.length === 0) return NOT_FOUND; // before any file call
    const { audioDir, role, segment } = o;
    const root = openPrivateRoot(audioDir);
    if (root === null) return NOT_FOUND;
    let owner: string | null = null;
    let bytes: Buffer | null = null;
    try {
      for (const identity of o.identities) {
        const hit = (await readSegmentIndex(audioDir, identity, role))?.get(segment);
        if (hit === undefined) continue; // no folder, no index line, or an index that cannot be trusted
        if (hit.deleted) return refused("audio_deleted");
        owner = identity;
        break;
      }
      if (owner === null) return NOT_FOUND;
      bytes = readOwnedWav(audioDir, owner, role, segment);
      if (bytes === null) return NOT_FOUND;
      // Spec order: the index line is required AFTER the read too (a delete that marked it meanwhile wins).
      const after = (await readSegmentIndex(audioDir, owner, role))?.get(segment);
      if (after === undefined) return NOT_FOUND;
      if (after.deleted) return refused("audio_deleted");
      if (!stillOwnDir(audioDir, root.st)) return NOT_FOUND;
    } finally { try { closeSync(root.fd); } catch { /* nothing more to do */ } }

    let written = false;
    try { written = (await o.audit.append(owner, { type: "audio.played", role, segment, by: o.by })) === true; } catch { written = false; }
    if (!written) return refused("audit_unavailable"); // the bytes are dropped: nothing leaves unaudited
    return { ok: true, identity: owner, bytes };
  } catch { return NOT_FOUND; }
}
