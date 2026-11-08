/**
 * US-0070 (spec 7.3, error taxonomy): typed speech-to-text failures. Each message is a FIXED sentence: a cause handed in (which could
 * quote a URL, a path or a response body) is never kept, in the message, the stack or a property. `transient` says whether a retry may help.
 */
type Init = { cause?: unknown; status?: number };

abstract class SpeechError extends Error {
  abstract readonly transient: boolean;
  /** The HTTP status, when one was the reason (a number only). */
  readonly status?: number;
  constructor(message: string, init: Init) {
    super(message); // the cause is deliberately not passed on
    if (init.status !== undefined && Number.isInteger(init.status)) this.status = init.status;
  }
}

/** The server could not be reached or answered 5xx. Transient. */
export class SpeechUnavailableError extends SpeechError {
  readonly transient = true;
  constructor(init: Init = {}) { super("the speech-to-text server is unavailable", init); this.name = "SpeechUnavailableError"; }
}

/** The segment's deadline passed or the caller aborted. Transient. */
export class SpeechTimeoutError extends SpeechError {
  readonly transient = true;
  constructor(init: Init = {}) { super("the speech-to-text request timed out", init); this.name = "SpeechTimeoutError"; }
}

/** The server refused the request (4xx) or its answer could not be read. Not transient. */
export class SpeechRefusedError extends SpeechError {
  readonly transient = false;
  constructor(init: Init = {}) { super("the speech-to-text server refused the request", init); this.name = "SpeechRefusedError"; }
}

export type AnySpeechError = SpeechUnavailableError | SpeechTimeoutError | SpeechRefusedError;

export function isSpeechError(err: unknown): err is AnySpeechError {
  return err instanceof SpeechUnavailableError || err instanceof SpeechTimeoutError || err instanceof SpeechRefusedError;
}

export function isTransientSpeechError(err: unknown): err is SpeechUnavailableError | SpeechTimeoutError {
  return isSpeechError(err) && err.transient;
}
