import { CLIENT_ID_MAX_CHARS, isNoticeVersion, isReservedRoleId, isScenarioId, isValidSessionId } from "@acr/events";
import { REBIND_PENDING } from "./consent.js";
import { assertSessionId } from "./log-files.js";
import { SecureFileError, readSecureJson, removeSecureFile, writeSecureJson, type SyncCheck } from "./secure-json-file.js";

/**
 * US-0070 (EPIC-0003 voice A1a): the per-session voice record, `<SESSION_DATA_DIR>/<sessionId>.voice.json` (owner-only, written by the
 * runtime under its session lock). It holds each seat's voice choice bound to the PARTICIPANT who made it, so a choice is never
 * inherited: a seat whose recorded participant is not the current holder (after a reissue, a rebind or a restart with another person)
 * counts as text only. It is a separate file, not a change to the consent file, so an older build simply ignores it (spec section 6).
 *
 * Named by the session id, not the log identity (overview contradiction C5): a failed create deletes exactly `<sessionId>.*`. It is
 * bound inside to `{sessionId, logIdentity}`; a record for another log (a fresh start on an old id) is ignored as "no choices".
 * Nothing is ever seeded into it from the session log.
 */
export const VOICE_RECORD_VERSION = 1;
export const MAX_VOICE_FILE_BYTES = 64 * 1024;
const HEX32 = /^[0-9a-f]{32}$/;

export type VoiceChoice = "voice" | "text_only";
export type VoiceEntry = { participantId: string; choice: VoiceChoice; noticeVersion: string; at: number };
export type VoiceBind = { sessionId: string; logIdentity: string };
export type VoiceRecord = { v: 1; sessionId: string; logIdentity: string; entries: Record<string, VoiceEntry> };
/** Why a voice file was ignored: unreadable as a record, or bound to another session or log. */
export type VoiceFileProblem = "malformed" | "other_log";

/** A voice record that cannot be used. The message is a fixed sentence: it never quotes the record. */
export class VoiceRecordError extends Error {
  constructor(message: string, readonly kind: VoiceFileProblem = "malformed") { super(message); this.name = "VoiceRecordError"; }
}

/** `<sessionId>.voice.json`; refuses a session id that is not a safe id before anything touches the disk. */
export function voiceFileName(sessionId: string): string {
  assertSessionId(sessionId);
  return `${sessionId}.voice.json`;
}

const isVoiceRoleId = (roleId: string): boolean => roleId.length >= 1 && roleId.length <= CLIENT_ID_MAX_CHARS && isScenarioId(roleId) && !isReservedRoleId(roleId);
const isParticipantId = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= CLIENT_ID_MAX_CHARS && v !== REBIND_PENDING;

/** Throws VoiceRecordError unless `v` is a well-formed entry; returns a fresh copy. */
function checkEntry(v: unknown): VoiceEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v) || Object.keys(v).sort().join(",") !== "at,choice,noticeVersion,participantId") throw new VoiceRecordError("the voice file has an invalid entry");
  const { participantId, choice, noticeVersion, at } = v as Record<string, unknown>;
  if (!isParticipantId(participantId)) throw new VoiceRecordError("the voice file has an invalid participant id");
  if (choice !== "voice" && choice !== "text_only") throw new VoiceRecordError("the voice file has an invalid choice");
  if (typeof noticeVersion !== "string" || !isNoticeVersion(noticeVersion)) throw new VoiceRecordError("the voice file has an invalid notice version");
  if (typeof at !== "number" || !Number.isFinite(at) || at < 0) throw new VoiceRecordError("the voice file has an invalid time");
  return { participantId, choice, noticeVersion, at };
}

function checkBind(bind: VoiceBind): void {
  if (!isValidSessionId(bind.sessionId)) throw new VoiceRecordError("the voice record has an invalid session id");
  if (!HEX32.test(bind.logIdentity)) throw new VoiceRecordError("the voice record has an invalid log identity");
}

/** The voice choices of one session's seats, in memory. Bound to one session and log identity. */
export class VoiceChoices {
  private constructor(private readonly bind: VoiceBind, private readonly entries: Map<string, VoiceEntry>) {}

  static empty(bind: VoiceBind): VoiceChoices {
    assertSessionId(bind.sessionId);
    checkBind(bind);
    return new VoiceChoices({ ...bind }, new Map());
  }

  /** Throws VoiceRecordError (never quoting the record; kind `other_log` when it is well formed but bound elsewhere). */
  static fromRecord(raw: unknown, bind: VoiceBind): VoiceChoices {
    const out = VoiceChoices.empty(bind);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new VoiceRecordError("the voice file is not a JSON object");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "entries,logIdentity,sessionId,v") throw new VoiceRecordError("the voice file has missing or unexpected fields");
    if (r.v !== VOICE_RECORD_VERSION) throw new VoiceRecordError("the voice file has an unknown format version");
    if (typeof r.sessionId !== "string" || !isValidSessionId(r.sessionId)) throw new VoiceRecordError("the voice file has an invalid session id");
    if (typeof r.logIdentity !== "string" || !HEX32.test(r.logIdentity)) throw new VoiceRecordError("the voice file has an invalid log identity");
    const e = r.entries;
    if (typeof e !== "object" || e === null || Array.isArray(e)) throw new VoiceRecordError("the voice file has no entry table");
    for (const [roleId, v] of Object.entries(e as Record<string, unknown>)) {
      if (!isVoiceRoleId(roleId)) throw new VoiceRecordError("the voice file names an invalid role");
      out.entries.set(roleId, checkEntry(v));
    }
    // Checked last, so a malformed record bound elsewhere is still reported as malformed.
    if (r.sessionId !== bind.sessionId || r.logIdentity !== bind.logIdentity) throw new VoiceRecordError("the voice file belongs to another session or log", "other_log");
    return out;
  }

  /** Records a seat's choice (replacing any earlier one). Throws VoiceRecordError for anything the file would refuse. */
  set(roleId: string, entry: VoiceEntry): void {
    if (!isVoiceRoleId(roleId)) throw new VoiceRecordError("not a valid role for a voice choice");
    this.entries.set(roleId, checkEntry({ ...entry }));
  }

  /** Forgets a seat's choice; true when there was one. */
  remove(roleId: string): boolean { return this.entries.delete(roleId); }

  /** A copy of the seat's entry, or undefined. */
  entry(roleId: string): VoiceEntry | undefined {
    const e = this.entries.get(roleId);
    return e ? { ...e } : undefined;
  }

  /**
   * The seat's choice for its current holder: `none` without an entry; the entry's choice when it names this holder; `text_only` when it
   * names anyone else (or there is no holder): a choice is never inherited.
   */
  choiceFor(roleId: string, holder: string | undefined): "none" | VoiceChoice {
    const e = this.entries.get(roleId);
    if (!e) return "none";
    return holder !== undefined && holder !== REBIND_PENDING && e.participantId === holder ? e.choice : "text_only";
  }

  /** Whether these choices belong to this session and log. */
  boundTo(bind: VoiceBind): boolean { return this.bind.sessionId === bind.sessionId && this.bind.logIdentity === bind.logIdentity; }

  toRecord(): VoiceRecord {
    return { v: 1, sessionId: this.bind.sessionId, logIdentity: this.bind.logIdentity, entries: Object.fromEntries([...this.entries].map(([k, e]) => [k, { ...e }])) };
  }
}

/**
 * Reads the voice record. Missing: no choices, no problem. Malformed (bad JSON, bad shape, a link, not a regular file, too large) or
 * bound to another session or log: no choices, with the problem named. Never throws for the file's content; an I/O error other than a
 * missing file throws (the caller reports it by name).
 */
export function readVoiceFile(dir: string, bind: VoiceBind): { choices: VoiceChoices; problem?: VoiceFileProblem } {
  const name = voiceFileName(bind.sessionId);
  let raw: unknown;
  try { raw = readSecureJson(dir, name, { maxBytes: MAX_VOICE_FILE_BYTES }); }
  catch (err) {
    if (err instanceof SecureFileError) return { choices: VoiceChoices.empty(bind), problem: "malformed" };
    throw err;
  }
  if (raw === null) return { choices: VoiceChoices.empty(bind) };
  try { return { choices: VoiceChoices.fromRecord(raw, bind) }; }
  catch (err) {
    if (err instanceof VoiceRecordError) return { choices: VoiceChoices.empty(bind), problem: err.kind };
    throw err;
  }
}

/** Replaces the voice record (O_EXCL temp, fsync, rename, directory fsync). `beforeCommit` runs right before the rename. */
export function writeVoiceFile(dir: string, bind: VoiceBind, choices: VoiceChoices, beforeCommit?: SyncCheck): void {
  if (!choices.boundTo(bind)) throw new VoiceRecordError("the voice choices belong to another session or log", "other_log");
  writeSecureJson(dir, voiceFileName(bind.sessionId), choices.toRecord(), beforeCommit, "voice file");
}

/** Removes the voice record; a missing file is fine. */
export function removeVoiceFile(dir: string, sessionId: string): void {
  removeSecureFile(dir, voiceFileName(sessionId));
}

/** The voice record of ONE session as the host uses it: the session store builds it beside the seat files (the host never sees a path). */
export type VoiceFileIO = {
  read(): { choices: VoiceChoices; problem?: VoiceFileProblem };
  /** Throws when the file could not be written (or the session lock was lost). */
  write(choices: VoiceChoices): void;
  /** Throws when the file could not be removed (or the session lock was lost). */
  remove(): void;
};

/** The real VoiceFileIO over `<dir>/<sessionId>.voice.json`; `holdLock` (synchronous, throws when the lock was lost) guards every write and removal. */
export function voiceFileIO(dir: string, bind: VoiceBind, holdLock?: SyncCheck): VoiceFileIO {
  return {
    read: () => readVoiceFile(dir, bind),
    write: (c) => writeVoiceFile(dir, bind, c, holdLock),
    remove: () => { holdLock?.(); removeVoiceFile(dir, bind.sessionId); },
  };
}
