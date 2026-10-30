import { CLIENT_ID_MAX_CHARS, SAFE_ID_MAX_CHARS, isReservedRoleId } from "@acr/events";
import type { Bind } from "./credentials.js";

/**
 * US-0053: who has agreed to the consent notice. Each entry names the participant who gave it and counts only for that participant;
 * a different person later holding the same role must agree again. An entry under another notice version never counts and is
 * dropped when a session resumes.
 */
export const CONSENT_RECORD_VERSION = 1;

export type ConsentNotice = { version: string; text: string };
export type ConsentEntry = { participantId: string; noticeVersion: string; at: number };
export type ConsentRecord = { v: 1; sessionId: string; scenarioSha256: string; entries: Record<string, ConsentEntry> };

export class ConsentError extends Error {
  constructor(readonly code: "version_mismatch" | "invalid_input") { super(`consent refused: ${code}`); this.name = "ConsentError"; }
}

/** A consent record that cannot be used. The message never contains a value from the record. */
export class ConsentRecordError extends Error {
  constructor(message: string) { super(message); this.name = "ConsentRecordError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * US-0058: the participant id a seat's consent carries between a code reissue after the start and the next person who joins with the
 * new code. It passes the record shape checks (so the existing file format persists it) and cannot collide with a participant id the
 * web layer mints (a random UUID). `has` is false for everyone while it stands, and `claimRebind` refuses it as a participant.
 */
export const REBIND_PENDING = "rebind-pending";

export class ConsentStore {
  private readonly entries: Map<string, ConsentEntry>;
  constructor(private readonly noticeValue: ConsentNotice, initial: Record<string, ConsentEntry> = {}) {
    // A pending rebind is kept under any version: it holds no person's agreement, only the right to inherit the one the log records.
    this.entries = new Map(Object.entries(initial).filter(([, e]) => e.noticeVersion === noticeValue.version || e.participantId === REBIND_PENDING));
  }

  get notice(): ConsentNotice { return this.noticeValue; }

  give(roleId: string, participantId: string, noticeVersion: string, at: number): void {
    // The same checks fromRecord applies, so nothing is written that a restart would refuse.
    if (isReservedRoleId(roleId) || roleId.length === 0 || roleId.length > CLIENT_ID_MAX_CHARS) throw new ConsentError("invalid_input");
    if (participantId.length === 0 || participantId.length > CLIENT_ID_MAX_CHARS) throw new ConsentError("invalid_input");
    if (noticeVersion.length > 64) throw new ConsentError("invalid_input");
    if (!Number.isFinite(at) || at < 0) throw new ConsentError("invalid_input");
    if (noticeVersion !== this.noticeValue.version) throw new ConsentError("version_mismatch");
    this.entries.set(roleId, { participantId, noticeVersion, at });
  }

  /**
   * R14: records a consent the session log holds, without comparing its notice version with the current one: the log is the history of what
   * this participant agreed to at the start, and a restart under a newer notice must not lock them out. Same shape checks as give.
   */
  adopt(roleId: string, participantId: string, noticeVersion: string, at: number): void {
    if (isReservedRoleId(roleId) || roleId.length === 0 || roleId.length > CLIENT_ID_MAX_CHARS) throw new ConsentError("invalid_input");
    if (participantId.length === 0 || participantId.length > CLIENT_ID_MAX_CHARS) throw new ConsentError("invalid_input");
    if (noticeVersion.length === 0 || noticeVersion.length > 64) throw new ConsentError("invalid_input");
    if (!Number.isFinite(at) || at < 0) throw new ConsentError("invalid_input");
    this.entries.set(roleId, { participantId, noticeVersion, at });
  }

  withdraw(roleId: string): boolean { return this.entries.delete(roleId); }

  /**
   * US-0058: after a code reissue past the start, the role's consent waits for the next participant (see REBIND_PENDING). Keeps the
   * notice version and time. True when an entry existed.
   */
  releaseForRebind(roleId: string): boolean {
    const e = this.entries.get(roleId);
    if (!e) return false;
    this.entries.set(roleId, { participantId: REBIND_PENDING, noticeVersion: e.noticeVersion, at: e.at });
    return true;
  }

  isRebindPending(roleId: string): boolean { return this.entries.get(roleId)?.participantId === REBIND_PENDING; }

  /** US-0058: binds the waiting consent to `participantId` (only while pending; same shape checks as give). `at` is when the rebind happened. */
  claimRebind(roleId: string, participantId: string, at: number): boolean {
    const e = this.entries.get(roleId);
    if (!e || e.participantId !== REBIND_PENDING) return false;
    if (participantId === REBIND_PENDING || participantId.length === 0 || participantId.length > CLIENT_ID_MAX_CHARS) return false;
    if (!Number.isFinite(at) || at < 0) return false;
    this.entries.set(roleId, { participantId, noticeVersion: e.noticeVersion, at });
    return true;
  }

  /** Whether any entry stands for the role (whoever gave it). */
  hasEntry(roleId: string): boolean { return this.entries.has(roleId); }

  /** True only when this participant gave the consent now held for the role (never while a rebind is pending, for anyone). */
  has(roleId: string, participantId: string): boolean { return participantId !== REBIND_PENDING && this.entries.get(roleId)?.participantId === participantId; }

  /** What a client may see: when each role agreed and to what, never who. */
  snapshot(): Record<string, { noticeVersion: string; at: number }> {
    return Object.fromEntries([...this.entries].map(([k, e]) => [k, { noticeVersion: e.noticeVersion, at: e.at }]));
  }

  toRecord(bind: Bind): ConsentRecord {
    return { v: 1, sessionId: bind.sessionId, scenarioSha256: bind.scenarioSha256, entries: Object.fromEntries(this.entries) };
  }

  /** Throws ConsentRecordError (never quoting the record) for an invalid record or one bound to another session or scenario. */
  static fromRecord(raw: unknown, notice: ConsentNotice, bind: Bind): ConsentStore {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConsentRecordError("the consent file is not a JSON object");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "entries,scenarioSha256,sessionId,v") throw new ConsentRecordError("the consent file has missing or unexpected fields");
    if (r.v !== CONSENT_RECORD_VERSION) throw new ConsentRecordError("the consent file has an unknown format version");
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > SAFE_ID_MAX_CHARS) throw new ConsentRecordError("the consent file has an invalid session id");
    if (typeof r.scenarioSha256 !== "string" || !HEX64.test(r.scenarioSha256)) throw new ConsentRecordError("the consent file has an invalid scenario hash");
    if (r.sessionId !== bind.sessionId || r.scenarioSha256 !== bind.scenarioSha256) throw new ConsentRecordError("the consent file belongs to another session or scenario");
    const e = r.entries;
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new ConsentRecordError("the consent file has no entry table");
    const initial: Record<string, ConsentEntry> = {};
    for (const [roleId, v] of Object.entries(e as Record<string, unknown>)) {
      if (isReservedRoleId(roleId) || roleId.length === 0 || roleId.length > CLIENT_ID_MAX_CHARS) throw new ConsentRecordError("the consent file names an invalid role");
      if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).sort().join(",") !== "at,noticeVersion,participantId") throw new ConsentRecordError("the consent file has an invalid entry");
      const { participantId, noticeVersion, at } = v as { participantId: unknown; noticeVersion: unknown; at: unknown };
      if (typeof participantId !== "string" || participantId.length === 0 || participantId.length > CLIENT_ID_MAX_CHARS) throw new ConsentRecordError("the consent file has an invalid participant id");
      if (typeof noticeVersion !== "string" || noticeVersion.length === 0 || noticeVersion.length > 64) throw new ConsentRecordError("the consent file has an invalid notice version");
      if (typeof at !== "number" || !Number.isFinite(at) || at < 0) throw new ConsentRecordError("the consent file has an invalid time");
      initial[roleId] = { participantId, noticeVersion, at };
    }
    return new ConsentStore(notice, initial); // the constructor drops entries under another version
  }
}
