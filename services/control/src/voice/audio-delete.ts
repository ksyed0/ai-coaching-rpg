import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import path from "node:path";
import { isFileSafeId } from "@acr/events";
import { appendDeletedLines, isLowerHex, type DeletedIndexLine } from "@acr/speech/protocol";
import { FILE_FLAGS, isOwn, openOwnDir, openOwnDirErr, readSegmentIndex, stillBelongs, stillOwnDir, type AudioCatalog } from "./audio-catalog.js";
import type { AuditLog, DeleteScope } from "./audit-log.js";
import { acquireStoreLock, type IdentityMutex, type StoreLock, type StoreLockResult } from "./store-lock.js";

/**
 * US-0075 (voice A2b-1b, spec section 4): the facilitator's audited delete of a session's audio (session, role or participant scope).
 * Participants never get their own audio; they ask the facilitator, and this is how the request is honoured, with proof.
 *
 * Per identity folder, in the catalog's sorted order, ONE AT A TIME (never two locks at once):
 *   1-2. the identity mutex and the store lock through `acquireStoreLock` (a held mutex or `error`: `pending busy`; `unsafe`: `pending
 *        store_unsafe`; `locked_other`: a live worker, the WHOLE request stops as live with the work done so far). Under the lock the
 *        folder is re-checked with `stillBelongs` (the sweep may have moved it away): no longer ours is listed in `gone`.
 *   3.   the role folders are enumerated through the verified identity folder; a role entry that is a link, a non-directory or another
 *        user's makes the identity `pending store_unsafe` when it is in scope (every role for the session and participant scopes, that
 *        role for a role scope). Each in-scope index is read through the fail-closed reader: untrusted is `pending store_unsafe`.
 *   4.   the undeleted segments in scope are chosen (participant scope: the entry's `participantId`, compared as a string, never a path).
 *        None: a `facilitator` request writes nothing; a `participant_request` writes one `segments: 0` audit line when the identity
 *        holds audio (a WAV or a segment line in any role), as proof the request was honoured.
 *   5.   the `audio.deleted` audit line (with a fresh 16-hex `op`) is appended FIRST; `false` is `pending audit_unavailable` and nothing
 *        else happens for the identity.
 *   6.   `assertHeld`, then each role's marks in ONE `appendDeletedLines` call (one write, one fsync); a throw is `pending store_unsafe`
 *        and nothing is unlinked. The marks make the segments unplayable at once.
 *   7.   `assertHeld` again (false: `pending store_unsafe`; the marks hold and the sweep finishes the unlink), then each WAV is unlinked.
 *        A failed unlink still counts: the mark already makes it unplayable and the sweep removes it.
 *   8.   the lock and the mutex are released on every path.
 * `isLive` is asked before the first identity and again before each one (a worker can start meanwhile); a throw counts as live.
 *
 * No check-then-use of a path (CodeQL `js/file-system-race`): every folder is OPENED (O_DIRECTORY|O_NOFOLLOW) and judged on its descriptor,
 * and re-opened afterwards to prove the path still names it. Node has no `unlinkat`, so the residual same-user race between the last
 * descriptor check and `unlinkSync(path)` is recorded (spec section 12; the 0700 root bounds it to this user). Ids are checked with the
 * shared rules only (`isFileSafeId`, `isLowerHex`). Nothing here logs, and the outcome carries identities and counts only, never a path.
 */

export type { DeleteScope };
export type DeleteReason = "facilitator" | "participant_request";
export type PendingReason = "busy" | "store_unsafe" | "audit_unavailable";
export type DeleteOutcome = {
  live: boolean;
  deleted: number;
  /** Identities `find` returned that no longer belong to the session under the lock (moved away by the sweep, or removed). */
  gone: string[];
  identities: Array<{ identity: string; deleted: number; state: "done" }>;
  pending: Array<{ identity: string; reason: PendingReason }>;
};

export type DeleteOptions = {
  audioDir: string;
  catalog: Pick<AudioCatalog, "find">;
  audit: Pick<AuditLog, "append">;
  /** Shared with the sweep (one per control process). */
  mutex: IdentityMutex;
  /** True while VoiceHost holds a live entry for the session (`VoiceHost.isLive`). */
  isLive: (sessionId: string) => boolean;
  now: () => number;
  /** Test seam: the request's operation id (default 16 random hex). */
  randomOp?: () => string;
  /** Test seam: the store-lock acquirer (default `acquireStoreLock`). */
  acquireLock?: (dir: string, id: string, mutex: IdentityMutex) => StoreLockResult;
};

const INDEX_NAME = "index.jsonl";

type IdentityResult =
  | { kind: "done"; deleted: number }
  | { kind: "pending"; reason: PendingReason }
  | { kind: "gone" }
  | { kind: "live" };

type RoleDir = { role: string; st: Stats };
type RolePlan = { role: string; st: Stats; segments: string[] };
type Plan = { kind: "unsafe" } | { kind: "ok"; roles: RolePlan[]; holdsAudio: boolean };

const sameIdent = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const safeClose = (fd: number): void => { try { closeSync(fd); } catch { /* nothing more to do */ } };
const inScope = (scope: DeleteScope, role: string): boolean => scope.kind !== "role" || scope.role === role;

function liveNow(o: DeleteOptions, sessionId: string): boolean {
  try { return o.isLive(sessionId) !== false; } catch { return true; } // a predicate that cannot answer fails closed
}

/**
 * The role folders of the identity folder, enumerated while its verified descriptor is held open and re-checked afterwards. `unsafe` when
 * the identity folder is not a real directory of this user (or changed during the listing), or an in-scope file-safe entry is a link, a
 * non-directory or another user's. Names that are not file-safe (`session.json`, `ended.json`, hidden names) are never role folders.
 */
function roleDirs(identityPath: string, scope: DeleteScope): RoleDir[] | "unsafe" {
  const id = openOwnDir(identityPath);
  if (id === null) return "unsafe";
  try {
    let names: string[];
    try { names = readdirSync(identityPath); } catch { return "unsafe"; }
    const out: RoleDir[] = [];
    for (const name of names.sort()) {
      if (!isFileSafeId(name)) continue;
      const d = openOwnDirErr(path.join(identityPath, name));
      if (!d.ok) {
        if (d.code === "ENOENT") continue; // vanished since the listing: nothing of it can be in scope
        if (inScope(scope, name)) return "unsafe";
        continue;
      }
      safeClose(d.fd);
      out.push({ role: name, st: d.st });
    }
    return stillOwnDir(identityPath, id.st) ? out : "unsafe";
  } finally { safeClose(id.fd); }
}

/** True when the role folder (still the one `st` describes) holds at least one `<file-safe id>.wav` entry. */
function roleHasWav(rolePath: string, st: Stats): boolean {
  const d = openOwnDir(rolePath);
  if (d === null) return false;
  try {
    if (!sameIdent(d.st, st)) return false;
    let names: string[];
    try { names = readdirSync(rolePath); } catch { return false; }
    const any = names.some((n) => n.endsWith(".wav") && isFileSafeId(n.slice(0, -4)));
    return any && stillOwnDir(rolePath, st);
  } finally { safeClose(d.fd); }
}

/** Steps 3 and 4: the segments in scope, per role, and whether the identity holds any audio at all. */
async function planIdentity(audioDir: string, identity: string, scope: DeleteScope): Promise<Plan> {
  const identityPath = path.join(audioDir, identity);
  const dirs = roleDirs(identityPath, scope);
  if (dirs === "unsafe") return { kind: "unsafe" };
  const roles: RolePlan[] = [];
  let holdsAudio = false;
  for (const { role, st } of dirs) {
    const rolePath = path.join(identityPath, role);
    const read = await readSegmentIndex(audioDir, identity, role);
    if (!inScope(scope, role)) {
      if (!holdsAudio && ((read.kind === "trusted" && read.index.size > 0) || roleHasWav(rolePath, st))) holdsAudio = true;
      continue;
    }
    if (read.kind === "untrusted") return { kind: "unsafe" };
    // The reader opened the role folder by itself: it must be the very folder enumerated above, or nothing read counts.
    if (!stillOwnDir(rolePath, st)) return { kind: "unsafe" };
    if (read.index.size > 0 || roleHasWav(rolePath, st)) holdsAudio = true;
    const segments: string[] = [];
    for (const [segment, { entry, deleted }] of read.index) {
      if (deleted) continue;
      if (scope.kind === "participant" && entry.participantId !== scope.participant) continue;
      segments.push(segment);
    }
    if (segments.length > 0) roles.push({ role, st, segments });
  }
  return { kind: "ok", roles, holdsAudio };
}

/** Step 6 for one role: the marks in one write, only while the path still names the role folder planned. Throws on any failure. */
function markRole(identityPath: string, r: RolePlan, op: string, ts: number): void {
  const rolePath = path.join(identityPath, r.role);
  const d = openOwnDir(rolePath);
  if (d === null) throw new Error("the role folder changed");
  try {
    if (!sameIdent(d.st, r.st)) throw new Error("the role folder changed");
    const lines: DeletedIndexLine[] = r.segments.map((segment) => ({ v: 1, kind: "deleted", segment, op, ts }));
    appendDeletedLines(path.join(rolePath, INDEX_NAME), lines);
    if (!stillOwnDir(rolePath, r.st)) throw new Error("the role folder changed");
  } finally { safeClose(d.fd); }
}

/**
 * Step 7 for one role, best effort (every failure is left to the sweep; the marks already make the segments unplayable). The role
 * folder is opened O_DIRECTORY|O_NOFOLLOW and must be the folder planned; each WAV is opened O_NOFOLLOW|O_NONBLOCK and must be a regular
 * file of this user on that device (a link in its place fails the open and is never followed); then `unlinkSync(path)` removes OUR name
 * (a WAV with more links keeps its other names), and the folder is re-opened to prove the path still named it.
 * Residual (spec section 12): Node has no `unlinkat`, so a same-user swap between the last check and `unlinkSync` is not excluded.
 */
function unlinkRole(identityPath: string, r: RolePlan): void {
  const rolePath = path.join(identityPath, r.role);
  for (const segment of r.segments) {
    const d = openOwnDir(rolePath);
    if (d === null) return; // a link or another folder in its place: never followed
    try {
      if (!sameIdent(d.st, r.st)) return;
      const file = path.join(rolePath, `${segment}.wav`);
      let fd: number;
      try { fd = openSync(file, FILE_FLAGS); } catch { continue; } // already gone, or a link: nothing of ours to remove
      let ok = false;
      try { const st = fstatSync(fd); ok = st.isFile() && isOwn(st) && st.dev === r.st.dev; } catch { ok = false; } finally { safeClose(fd); }
      if (!ok) continue;
      try { unlinkSync(file); } catch { /* the sweep repairs it */ }
      if (!stillOwnDir(rolePath, r.st)) return;
    } finally { safeClose(d.fd); }
  }
}

function opOf(o: DeleteOptions): string {
  if (o.randomOp !== undefined) return o.randomOp();
  return randomBytes(8).toString("hex");
}

function tsOf(o: DeleteOptions): number {
  let t: number;
  try { t = o.now(); } catch { t = Date.now(); }
  return Number.isFinite(t) && t >= 0 ? t : Date.now(); // a mark with a bad ts would not count as a mark (`isDeletedLine`)
}

/** Steps 1 to 8 for one identity. Never rejects. */
async function deleteOne(o: DeleteOptions, sessionId: string, identity: string, scope: DeleteScope, reason: DeleteReason, by: string): Promise<IdentityResult> {
  let lockR: StoreLockResult;
  try { lockR = (o.acquireLock ?? acquireStoreLock)(o.audioDir, identity, o.mutex); } catch { lockR = { kind: "error" }; }
  switch (lockR.kind) {
    case "held": break;
    case "locked_other": return { kind: "live" };
    case "unsafe": return { kind: "pending", reason: "store_unsafe" };
    default: return { kind: "pending", reason: "busy" }; // locked_here (the sweep or another delete) and error
  }
  const lock: StoreLock = lockR;
  try {
    if (!stillBelongs(o.audioDir, identity, sessionId)) return { kind: "gone" };
    let plan: Plan;
    try { plan = await planIdentity(o.audioDir, identity, scope); } catch { plan = { kind: "unsafe" }; }
    if (plan.kind === "unsafe") return { kind: "pending", reason: "store_unsafe" };
    const n = plan.roles.reduce((sum, r) => sum + r.segments.length, 0);
    if (n === 0 && (reason === "facilitator" || !plan.holdsAudio)) return { kind: "done", deleted: 0 };

    const op = opOf(o);
    const ok = await o.audit.append(identity, { type: "audio.deleted", scope, reason, by, segments: n, op });
    if (ok !== true) return { kind: "pending", reason: "audit_unavailable" };
    if (n === 0) return { kind: "done", deleted: 0 };

    // Crash window between the audit line and the marks: a documented residual (spec section 4); a retry writes a new op.
    if (!(await lock.assertHeld())) return { kind: "pending", reason: "store_unsafe" };
    const identityPath = path.join(o.audioDir, identity);
    const ts = tsOf(o);
    try {
      for (const r of plan.roles) markRole(identityPath, r, op, ts);
    } catch { return { kind: "pending", reason: "store_unsafe" }; }

    // The marks hold from here: a lost lock leaves the WAVs to the sweep (it treats a marked WAV as an orphan).
    if (!(await lock.assertHeld())) return { kind: "pending", reason: "store_unsafe" };
    for (const r of plan.roles) { try { unlinkRole(identityPath, r); } catch { /* the sweep repairs it */ } }
    return { kind: "done", deleted: n };
  } catch {
    return { kind: "pending", reason: "store_unsafe" };
  } finally {
    lock.release();
  }
}

/**
 * Deletes the audio of `sessionId` in `scope`. `null` when the catalog finds no identity for the session; otherwise the outcome, with
 * `live: true` and the work done so far when a live signal (`isLive`, or another process holding a store lock) stopped it. Never rejects.
 */
export async function deleteAudio(o: DeleteOptions, sessionId: string, scope: DeleteScope, reason: DeleteReason, by: string): Promise<DeleteOutcome | null> {
  let identities: string[];
  try { identities = await o.catalog.find(sessionId); } catch { identities = []; }
  if (identities.length === 0) return null;
  const out: DeleteOutcome = { live: false, deleted: 0, gone: [], identities: [], pending: [] };
  if (liveNow(o, sessionId)) { out.live = true; return out; }
  for (const identity of identities) {
    if (liveNow(o, sessionId)) { out.live = true; return out; }
    if (!isLowerHex(identity, 32)) { out.gone.push(identity); continue; } // never from the real catalog; never used as a path
    const r = await deleteOne(o, sessionId, identity, scope, reason, by);
    switch (r.kind) {
      case "done": out.deleted += r.deleted; out.identities.push({ identity, deleted: r.deleted, state: "done" }); break;
      case "pending": out.pending.push({ identity, reason: r.reason }); break;
      case "gone": out.gone.push(identity); break;
      case "live": out.live = true; return out;
    }
  }
  return out;
}
