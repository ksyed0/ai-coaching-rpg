import { AUTHOR_SUFFIX, isConsoleName } from "../moderation.js";
import type { AudioCatalog, SegmentAudio } from "./audio-catalog.js";
import { replaySegment, type ReplayResult } from "./audio-replay.js";
import type { AuditLog } from "./audit-log.js";

/**
 * US-0074 (voice A2b-1a, spec sections 4, 5 and 8): the facilitator's audio listing and replay, behind control's service token. The
 * routes in `api.ts` validate every path id and the `X-Acr-By` name first; this service only reads through the catalog and the audited
 * replay (open-then-check lives there). It logs nothing.
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;

export type ListedSegment = {
  identity: string; role: string; segment: string; participantId: string; startMs: number; endMs: number; status: string; seq?: number;
  audio: SegmentAudio;
};
export type ListBody = { identities: number; recordingStopped: boolean; segments: ListedSegment[] };
export type PlayResult = ReplayResult | { ok: false; code: "busy" };

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

  constructor(private readonly o: { catalog: AudioCatalog; audit: Pick<AuditLog, "append">; audioDir: string; maxInFlight?: number }) {
    this.maxInFlight = o.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
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
}
