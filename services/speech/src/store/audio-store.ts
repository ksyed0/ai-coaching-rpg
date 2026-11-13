import { statfsSync } from "node:fs";
import path from "node:path";
import type { SessionLock } from "@acr/runtime/files";
import { decide, type SegmentOutcome } from "./consent-rule.js";
import { DiskGuard } from "./disk-guard.js";
import { writeFileAtomic } from "./atomic-file.js";
import { writeFully, type IndexEntry } from "./index-file.js";
import { ensureRoleDir, ensureSessionDir, segmentFile } from "./paths.js";
import { writeSessionMarker } from "./session-marker.js";
import { CREATE_FLAGS, nodeStoreFs, type StoreFs } from "./store-fs.js";
import { wavBytes } from "./wav.js";

export { nodeStoreFs, type StoreFs };

export type StopReason = "disk_low" | "write_error";
export type WriteResult = "written" | "skipped" | "stopped";
export type StoreSegment = {
  roleId: string;
  participantId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  pcm: Int16Array;
  outcome: SegmentOutcome;
  seq?: number;
  raw?: string;
  timings?: IndexEntry["timings"];
};

const INDEX_NAME = "index.jsonl";
const ENDED_NAME = "ended.json";

/** `statfs` of the nearest existing ancestor: the audio folder may not exist before the first write (read-only, nothing is created). */
function statfsNearest(p: string): { bavail: number; bsize: number } {
  // Measured directly (never checked for existence first): an ENOENT moves one level up, any other error is thrown (counts as full).
  let dir = path.resolve(p);
  for (;;) {
    try { return statfsSync(dir); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(dir) === dir) throw err;
      dir = path.dirname(dir);
    }
  }
}

/**
 * US-0073 (voice A2a, Task 6): writes a held segment's audio once the runtime has answered. `decide` (an allowlist) runs first and a
 * skipped segment touches nothing. Then the disk guard, an exclusive 0600 WAV, fsync of the file and its folder, and only then the index
 * line, so no index line ever names a missing WAV. Any failure removes the partial WAV and stops the store for this process; low disk
 * stops it too. `onStopped` fires at most once. Never throws from `write` and never logs.
 */
export class AudioStore {
  private readonly audioDir: string;
  private readonly identity: string;
  private readonly now: () => number;
  private readonly lock: Pick<SessionLock, "lost">;
  private readonly guard: Pick<DiskGuard, "check">;
  private readonly fs: StoreFs;
  private readonly onStopped: (reason: StopReason) => void;
  private stoppedFlag = false;
  private endedFlag = false;
  private markerDone = false;
  private readonly sessionId: string;

  constructor(o: {
    audioDir: string; logIdentity: string; sessionId: string; sessionsDir: string; minFreeMb: number; now: () => number;
    lock: Pick<SessionLock, "lost">; guard?: Pick<DiskGuard, "check">; fs?: StoreFs; onStopped: (reason: StopReason) => void;
  }) {
    this.audioDir = o.audioDir;
    this.identity = o.logIdentity;
    this.sessionId = o.sessionId;
    this.now = o.now;
    this.lock = o.lock;
    this.guard = o.guard ?? new DiskGuard({ volumes: [o.audioDir, o.sessionsDir], minFreeMb: o.minFreeMb, statfs: statfsNearest });
    this.fs = o.fs ?? nodeStoreFs;
    this.onStopped = o.onStopped;
  }

  get stopped(): boolean { return this.stoppedFlag; }

  /** The store lock's `onLost` (wired by the worker's main): stops recording with `write_error`. */
  lockLost(): void { this.stop("write_error"); }

  write(seg: StoreSegment): WriteResult {
    if (this.stoppedFlag) return "stopped";
    if (this.lock.lost) { this.stop("write_error"); return "stopped"; }
    const d = decide(seg.outcome);
    if (!d.keep) return "skipped";
    let bytes: Buffer;
    try { bytes = wavBytes(seg.pcm); } catch { this.stop("write_error"); return "stopped"; }
    let ok: boolean;
    try { ok = this.guard.check(bytes.length).ok; } catch { ok = false; }
    if (!ok) { this.stop("disk_low"); return "stopped"; }

    let file: string | null = null;
    let fd: number | null = null;
    let created = false;
    try {
      file = segmentFile(this.audioDir, this.identity, seg.roleId, seg.segmentId);
      // The session marker goes in once, before the first WAV of this process (a failure here is a write error like any other).
      if (!this.markerDone) {
        writeSessionMarker(ensureSessionDir(this.audioDir, this.identity), this.sessionId, this.fs);
        this.markerDone = true;
      }
      const role = ensureRoleDir(this.audioDir, this.identity, seg.roleId);
      fd = this.fs.openSync(file, CREATE_FLAGS, 0o600);
      created = true;
      this.writeAll(fd, bytes);
      this.fs.fsyncSync(fd);
      const open = fd; fd = null; this.fs.closeSync(open);
      this.fs.fsyncDir(role);
      const entry: IndexEntry = { v: 1, kind: "segment", segment: seg.segmentId, participantId: seg.participantId, startMs: seg.startMs, endMs: seg.endMs, status: d.status };
      if (seg.seq !== undefined) entry.seq = seg.seq;
      if (seg.raw !== undefined) entry.raw = seg.raw;
      if (seg.timings !== undefined) entry.timings = seg.timings;
      // From here the line may already be on disk (an append can fail after writing, e.g. on close): never remove the WAV again.
      created = false;
      this.fs.appendIndex(path.join(role, INDEX_NAME), entry);
      return "written";
    } catch {
      if (fd !== null) { try { this.fs.closeSync(fd); } catch { /* best effort */ } }
      // Remove only a file this call created (an exclusive create that hit an existing file leaves that file alone), and only before
      // the index append was attempted: after it, a kept WAV is at worst an orphan the sweep removes, never a line without its WAV.
      if (file !== null && created) { try { this.fs.unlinkSync(file); } catch { /* best effort: the sweep removes an orphan */ } }
      this.stop("write_error");
      return "stopped";
    }
  }

  /**
   * Writes `<sessionDir>/ended.json` `{ v: 1, endedAtMs }` atomically (a private temp file, then rename). Idempotent once it succeeds;
   * a failure is silent, stops nothing and may be retried.
   */
  markEnded(): void {
    if (this.endedFlag) return;
    try {
      const dir = ensureSessionDir(this.audioDir, this.identity);
      writeFileAtomic(this.fs, dir, ENDED_NAME, Buffer.from(JSON.stringify({ v: 1, endedAtMs: this.now() }), "utf8"));
      this.endedFlag = true;
    } catch { /* silent: stops nothing and may be retried */ }
  }

  private writeAll(fd: number, buf: Buffer): void {
    writeFully(fd, buf, (f, b, o, l) => this.fs.writeSync(f, b, o, l));
  }

  private stop(reason: StopReason): void {
    if (this.stoppedFlag) return;
    this.stoppedFlag = true;
    try { this.onStopped(reason); } catch { /* reporting only */ }
  }
}
