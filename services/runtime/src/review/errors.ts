/**
 * The closed codes a moderation result can carry (slice 2c-3). A refusal may name one in `code`; `toModResult`
 * (`@acr/runtime/moderation`) maps errors to them. Messages stay as they are: the CLI prints them, the console never does.
 */
export type ModerationCode =
  | "not_ended"
  | "already_evaluated"
  | "already_running"
  | "too_many_running"
  | "confirm_mismatch"
  | "no_review"
  | "unknown_subject"
  | "unknown_criterion"
  | "stale"
  | "blocked"
  | "not_released"
  | "not_editable"
  | "superseded"
  | "needs_amend"
  | "refused"
  | "busy"
  | "invalid"
  | "unavailable";

/** Bad flags or input the user can correct: exit 2. */
export class ReviewUsageError extends Error {
  readonly exit = 2;
  constructor(m: string) {
    super(m);
    this.name = "ReviewUsageError";
  }
}
/** A well-formed request the current state refuses (unresolved items, mismatch, illegal state, lock held): exit 1. */
export class ReviewRefusedError extends Error {
  readonly exit = 1;
  /** The closed code of this refusal, when the place that refuses knows it. Never changes the message. */
  code?: ModerationCode;
  /** Subject ids the refusal is about (for `blocked`); ids only, never text. */
  detail?: string[];
  constructor(m: string, code?: ModerationCode, detail?: string[]) {
    super(m);
    this.name = "ReviewRefusedError";
    if (code !== undefined) this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
/** The review lock is held by another command: a refusal (exit 1) that a caller may retry. */
export class ReviewBusyError extends ReviewRefusedError {
  constructor(m: string) {
    super(m);
    this.name = "ReviewBusyError";
  }
}
/** The log or a draft file is damaged or does not match: exit 2. Nothing repairs it. */
export class ReviewCorruptError extends Error {
  readonly exit = 2;
  constructor(m: string) {
    super(m);
    this.name = "ReviewCorruptError";
  }
}
/** The fold met an illegal sequence. On an existing log the store turns it into ReviewCorruptError; on new entries into ReviewRefusedError. */
export class ReviewIllegalError extends Error {
  /** Carried to the ReviewRefusedError the store makes of it on new entries; ignored on a log already on disk (damage). */
  readonly code?: ModerationCode;
  constructor(m: string, code?: ModerationCode) {
    super(m);
    this.name = "ReviewIllegalError";
    if (code !== undefined) this.code = code;
  }
}
