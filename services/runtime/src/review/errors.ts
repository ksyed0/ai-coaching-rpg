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
  constructor(m: string) {
    super(m);
    this.name = "ReviewRefusedError";
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
  constructor(m: string) {
    super(m);
    this.name = "ReviewIllegalError";
  }
}
