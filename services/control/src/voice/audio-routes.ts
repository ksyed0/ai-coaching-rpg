import { AUTHOR_SUFFIX, isConsoleName } from "../moderation.js";
import type { AudioCatalog, SegmentAudio } from "./audio-catalog.js";
import { deleteAudio, type DeleteOutcome, type DeleteReason, type DeleteScope } from "./audio-delete.js";
import { replaySegment, type ReplayResult } from "./audio-replay.js";
import type { AuditLog } from "./audit-log.js";
import { IdentityMutex } from "./store-lock.js";

/**
 * US-0074 (voice A2b-1a, spec sections 4, 5 and 8): the facilitator's audio listing and replay, behind control's service token. The
 * routes in `api.ts` validate every path id and the `X-Acr-By` name first; this service only reads through the catalog and the audited
 * replay (open-then-check lives there). It logs nothing. US-0075 adds the audited delete (`delete`), with its own in-flight cap.
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;
/** US-0075: concurrent deletes, counted apart from the replays (spec section 4). */
export const DEFAULT_MAX_DELETES_IN_FLIGHT = 4;

export type ListedSegment = {
  identity: string; role: string; segment: string; participantId: string; startMs: number; endMs: number; status: string; seq?: number;
  audio: SegmentAudio;
};
export type ListBody = { identities: number; recordingStopped: boolean; segments: ListedSegment[] };
export type PlayResult = ReplayResult | { ok: false; code: "busy" };
export type DeleteBody = { scope: DeleteScope; reason: DeleteReason; by: string };
/** `outcome` is null when the session has no audio (the listing's 404). */
export type DeleteResult = { ok: true; outcome: DeleteOutcome | null } | { ok: false; code: "busy" };

/**
 * The facilitator's name from `X-Acr-By`, or null. The header carries the review layer's author form `<name>-console`: the
 * `-console` suffix (`AUTHOR_SUFFIX`) is required, and `<name>` must pass `isConsoleName` (the `--by` rule: a safe id of at most 56
 * characters), exactly what the review layer accepts as a typed name before it appends the suffix. So the whole value is at most 64
 * characters and holds no comma (a repeated header, which Node joins with ", "), whitespace, control character or non-ASCII. The value
 * is returned unchanged: the audit line's `by` matches the review chain's author.
 */
export function parseBy(header: string | undefined): string | null {
  if (typeof header !== "string" || !header.endsWith(AUTHOR_SUFFIX)) return null;
  return isConsoleName(header.slice(0, -AUTHOR_SUFFIX.length)) ? header : null;
}

export class AudioService {
  private inFlight = 0;
  private readonly maxInFlight: number;
  private deletesInFlight = 0;
  private readonly maxDeletesInFlight: number;
  private readonly mutex: IdentityMutex;
  private readonly isLive: (sessionId: string) => boolean;

  constructor(private readonly o: {
    catalog: AudioCatalog; audit: Pick<AuditLog, "append">; audioDir: string; maxInFlight?: number;
    /** US-0075: the identity mutex shared with the sweep (one per control process); default: a private one. */
    mutex?: IdentityMutex;
    /** US-0075: `VoiceHost.isLive`; default: never live (no voice host). */
    isLive?: (sessionId: string) => boolean;
    maxDeletesInFlight?: number;
    now?: () => number;
  }) {
    this.maxInFlight = o.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxDeletesInFlight = o.maxDeletesInFlight ?? DEFAULT_MAX_DELETES_IN_FLIGHT;
    this.mutex = o.mutex ?? new IdentityMutex();
    this.isLive = o.isLive ?? (() => false);
  }

  /** Every identity folder of the session, in the catalog's sorted order, each identity's segments in its list order; null when none. */
  async list(sessionId: string): Promise<ListBody | null> {
    const identities = await this.o.catalog.find(sessionId);
    if (identities.length === 0) return null;
    const segments: ListedSegment[] = [];
    let recordingStopped = false;
    for (const identity of [...identities].sort()) {
      const listing = await this.o.catalog.list(identity);
      recordingStopped ||= listing.recordingStopped;
      for (const s of listing.segments) {
        // field by field: nothing the catalog might add later (never `raw`) leaves by accident
        segments.push({
          identity, role: s.role, segment: s.segment, participantId: s.participantId, startMs: s.startMs, endMs: s.endMs, status: s.status,
          ...(s.seq !== undefined ? { seq: s.seq } : {}), audio: s.audio,
        });
      }
    }
    return { identities: identities.length, recordingStopped, segments };
  }

  /** The audited whole-file read; over `maxInFlight` concurrent calls answers `busy` at once (the slot is freed on every path). */
  async play(sessionId: string, role: string, segment: string, by: string): Promise<PlayResult> {
    if (this.inFlight >= this.maxInFlight) return { ok: false, code: "busy" };
    this.inFlight++;
    try {
      const identities = await this.o.catalog.find(sessionId);
      if (identities.length === 0) return { ok: false, code: "not_found" };
      return await replaySegment({ audioDir: this.o.audioDir, identities, role, segment, by, audit: this.o.audit });
    } finally {
      this.inFlight--;
    }
  }

  /**
   * US-0075: the audited delete (`deleteAudio`). The live check comes FIRST, before the catalog or any file call (spec section 4): a live
   * session answers an empty outcome with `live: true`. Over `maxDeletesInFlight` concurrent calls answers `busy` at once; the slot is
   * freed on every path, a throw included. The store-lock acquirer is always the production one (no test seam is passed).
   */
  async delete(sessionId: string, body: DeleteBody): Promise<DeleteResult> {
    if (this.deletesInFlight >= this.maxDeletesInFlight) return { ok: false, code: "busy" };
    this.deletesInFlight++;
    try {
      if (this.liveNow(sessionId)) return { ok: true, outcome: { live: true, deleted: 0, gone: [], identities: [], pending: [] } };
      const outcome = await deleteAudio(
        { audioDir: this.o.audioDir, catalog: this.o.catalog, audit: this.o.audit, mutex: this.mutex, isLive: this.isLive, now: this.o.now ?? Date.now },
        sessionId, body.scope, body.reason, body.by,
      );
      return { ok: true, outcome };
    } finally {
      this.deletesInFlight--;
    }
  }

  private liveNow(sessionId: string): boolean {
    try { return this.isLive(sessionId) !== false; } catch { return true; } // a predicate that cannot answer fails closed (as deleteAudio)
  }
}
