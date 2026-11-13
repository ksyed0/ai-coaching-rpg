import { closeSync, constants as fc, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { SessionLock, assertInside, type LockOptions } from "@acr/runtime/files";
import { isLowerHex } from "@acr/speech/protocol";

/**
 * US-0073 (A2a Task 8, spec sections 3 and 7): the session's audio audit log, `<audioDir>/<logIdentity>.audio-audit.jsonl`, one JSON line
 * per event (`{ v: 1, ts, ...event }`). It holds participant ids and facilitator labels only: no event type has a text, audio or
 * transcript field, and each line is rebuilt field by field from the event, so an extra key a caller smuggles in is never written.
 */
export type AuditEvent =
  | { type: "voice.recording_stopped"; reason: "disk_low" | "write_error" }
  | { type: "voice.opted_in"; role: string; participant: string; noticeVersion: "v3" }
  | { type: "voice.opted_out"; role: string; participant: string }
  | { type: "audio.deleted"; scope: { kind: "session" }; reason: "expired"; by: "system"; segments: number }
  | { type: "audio.played"; role: string; segment: string; by: string };

/** The one sentence a failed append logs (never a path, an identity or an event). */
export const AUDIT_APPEND_FAILED = "audit append failed";
/** `SessionLock.acquire` never waits: an append that meets a held audit lock tries this often in all, AUDIT_RETRY_MS apart. */
export const AUDIT_LOCK_ATTEMPTS = 3;
export const AUDIT_RETRY_MS = 50;
const LOCK_SUFFIX = "audio-audit";

export class AuditPathError extends Error {
  constructor(message: string) { super(message); this.name = "AuditPathError"; }
}

export type AcquireLock = (dir: string, id: string, opts: LockOptions) => { release(): void };

/** The audit file of an identity (the caller has validated it: 32 lower-case hex). */
export function auditFile(audioDir: string, logIdentity: string): string {
  const file = path.resolve(audioDir, `${logIdentity}.audio-audit.jsonl`);
  assertInside(audioDir, file);
  return file;
}

const ownUid = (): number | null => (typeof process.getuid === "function" ? process.getuid() : null);

const DIR_FLAGS = fc.O_RDONLY | fc.O_DIRECTORY | fc.O_NOFOLLOW;

function openError(err: unknown): AuditPathError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new AuditPathError("audio directory missing");
  // macOS answers a link with ELOOP under O_NOFOLLOW; Linux (O_DIRECTORY) may answer ENOTDIR: both are refused.
  if (code === "ELOOP") return new AuditPathError("audio directory is a link");
  if (code === "ENOTDIR") return new AuditPathError("audio directory is not a directory");
  return new AuditPathError("audio directory could not be opened safely");
}

/**
 * The audio directory must exist, be a real directory of this user (not a link) and private (0700). Like the worker's
 * `ensureAudioRoot` (speech `store/paths.ts`, re-implemented here because control imports only `@acr/speech/protocol`): the directory
 * is OPENED first with O_DIRECTORY|O_NOFOLLOW (a link, a file or a missing entry fails the open; the path is never checked and then
 * used), created 0700 when missing and opened again, and every check is made on that descriptor: a directory, owned by this user, with
 * group and other permissions dropped through the descriptor; any group or other bit that remains is refused. Throws AuditPathError
 * (a fixed sentence) on anything unsafe.
 */
export function ensureAuditRoot(audioDir: string): void {
  // Create-if-missing first (idempotent: an existing folder, or a link to one, is left alone), then ONE open that refuses a link:
  // the path is never probed and then used.
  try { mkdirSync(audioDir, { recursive: true, mode: 0o700 }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new AuditPathError("audio directory could not be created");
  }
  let fd: number;
  try { fd = openSync(audioDir, DIR_FLAGS); } catch (err) { throw openError(err); }
  try {
    let st = fstatSync(fd);
    if (!st.isDirectory()) throw new AuditPathError("audio directory is not a directory");
    const uid = ownUid();
    if (uid !== null && st.uid !== uid) throw new AuditPathError("audio directory is owned by another user");
    if ((st.mode & 0o077) !== 0) {
      try { fchmodSync(fd, st.mode & 0o700); st = fstatSync(fd); } catch { /* judged below */ }
    }
    if ((st.mode & 0o077) !== 0) throw new AuditPathError("audio directory is not private");
  } finally { closeSync(fd); }
}

/** The line written for an event: only the fields its type declares, whatever else the object carries. */
function lineOf(ts: number, e: AuditEvent): Record<string, unknown> {
  switch (e.type) {
    case "voice.recording_stopped": return { v: 1, ts, type: e.type, reason: e.reason };
    case "voice.opted_in": return { v: 1, ts, type: e.type, role: e.role, participant: e.participant, noticeVersion: e.noticeVersion };
    case "voice.opted_out": return { v: 1, ts, type: e.type, role: e.role, participant: e.participant };
    case "audio.deleted": return { v: 1, ts, type: e.type, scope: { kind: e.scope.kind }, reason: e.reason, by: e.by, segments: e.segments };
    case "audio.played": return { v: 1, ts, type: e.type, role: e.role, segment: e.segment, by: e.by };
    default: throw new AuditPathError("unknown audit event"); // only reachable past the type system: nothing is written
  }
}

/** Appends one line: O_APPEND|O_CREAT|O_NOFOLLOW, 0600, a regular file of this user; fsynced. Throws on any failure. */
function appendLine(file: string, line: string): void {
  const fd = openSync(file, fc.O_WRONLY | fc.O_APPEND | fc.O_CREAT | fc.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid)) throw new AuditPathError("audit file is not a regular file of this user");
    if ((st.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    const buf = Buffer.from(line, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * The audit log. `append` never throws and its promise never rejects: it resolves once the line is written, or after logging
 * AUDIT_APPEND_FAILED once when it could not be (a malformed identity, an unsafe or missing-and-uncreatable audio directory, a held lock
 * after AUDIT_LOCK_ATTEMPTS tries, a write error). Callers may fire and forget it. Appends for one identity run one after another in call
 * order, so lines never interleave; it resolves `true` when the line was written and `false` on every failure path (so a caller that
 * must not proceed without the audit line, such as a replay, can check it; fire-and-forget callers ignore it); each holds the identity's audit lock (`<id>.audio-audit.lock`) only while it writes its line.
 */
export class AuditLog {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly acquireLock: AcquireLock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (m: string) => void;

  constructor(private readonly o: {
    audioDir: string; now: () => number;
    /** Test seam (default SessionLock.acquire). */
    acquireLock?: AcquireLock;
    /** Test seam (default a real timer). */
    sleep?: (ms: number) => Promise<void>;
    log?: (m: string) => void;
  }) {
    this.acquireLock = o.acquireLock ?? ((dir, id, opts) => SessionLock.acquire(dir, id, opts));
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }));
    this.log = o.log ?? (() => {});
  }

  append(logIdentity: string, e: AuditEvent): Promise<boolean> {
    try {
      if (!isLowerHex(logIdentity, 32)) { this.failed(); return Promise.resolve(false); }
      const line = `${JSON.stringify(lineOf(this.o.now(), e))}\n`; // the time of the call, so ts follows the call order
      const prev = this.chains.get(logIdentity) ?? Promise.resolve();
      let written = false; // this call's own result; the chain itself stays Promise<void> and never rejects
      const next = prev.then(async () => { written = await this.write(logIdentity, line); }).catch(() => { written = false; this.failed(); });
      this.chains.set(logIdentity, next);
      void next.then(() => { if (this.chains.get(logIdentity) === next) this.chains.delete(logIdentity); });
      return next.then(() => written);
    } catch {
      this.failed();
      return Promise.resolve(false);
    }
  }

  /** True when the line was written; false (after logging once) on every failure. */
  private async write(logIdentity: string, line: string): Promise<boolean> {
    const dir = this.o.audioDir;
    try { ensureAuditRoot(dir); } catch { this.failed(); return false; }
    for (let attempt = 1; attempt <= AUDIT_LOCK_ATTEMPTS; attempt++) {
      let lock: { release(): void };
      try { lock = this.acquireLock(dir, logIdentity, { suffix: LOCK_SUFFIX }); } catch {
        if (attempt < AUDIT_LOCK_ATTEMPTS) await this.sleep(AUDIT_RETRY_MS);
        continue;
      }
      let ok = false;
      try { appendLine(auditFile(dir, logIdentity), line); ok = true; } catch { this.failed(); } finally {
        try { lock.release(); } catch { /* best effort: a leftover lock goes stale */ }
      }
      return ok;
    }
    this.failed();
    return false;
  }

  private failed(): void {
    try { this.log(AUDIT_APPEND_FAILED); } catch { /* logging must not make an append throw */ }
  }
}
