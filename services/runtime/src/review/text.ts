import { isFileSafeId, isSafeId } from "@acr/events";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { ReviewUsageError } from "./errors.js";
import type { Level } from "./types.js";

/**
 * C0 and C1 controls except line feed and tab (terminal escape sequences start here) and the bidirectional controls
 * (U+202A-202E, U+2066-2069). One rule for draft fields and for the short labels the fold accepts.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-misleading-character-class
const BIDI = /[\u202a-\u202e\u2066-\u2069]/;
export const isDirty = (s: string): boolean => CONTROL.test(s) || BIDI.test(s);

/** Length in code points: the one counting rule for every limit. */
export const cpLen = (s: string): number => Array.from(s).length;

/** Free text from a person: hidden characters stripped, secrets scrubbed, 1 to `max` characters. `what` names the option in the message. */
export function cleanText(
  raw: string,
  max: number,
  what: string,
  secrets: string[],
): string {
  const stripped = stripHidden(String(raw)).replace(/\r\n?/g, "\n").trim();
  const tooLong = () =>
    new ReviewUsageError(`${what} is longer than ${max} characters`);
  if (cpLen(stripped) > max) throw tooLong();
  const text = scrubText(stripped, secrets).trim();
  if (cpLen(text) > max) throw tooLong();
  if (text.length === 0)
    throw new ReviewUsageError(`${what} must not be empty`);
  return text;
}

/** A person's name as recorded in the log: validated like an id. */
export function cleanBy(raw: unknown): string {
  if (typeof raw !== "string" || !isSafeId(raw))
    throw new ReviewUsageError(
      "--by needs a name of 1 to 64 letters, digits, _ or -",
    );
  return raw;
}

export function parseLevel(raw: unknown): Level {
  if (raw === "na") return null;
  if (typeof raw === "string" && /^[1-4]$/.test(raw))
    return Number(raw) as 1 | 2 | 3 | 4;
  throw new ReviewUsageError("--level needs 1, 2, 3, 4 or na (not observed)");
}

/** The one rule for a draft file name a review may bind to: `<file-safe id up to 64>.md|json`. Shared by `open` and the review.opened check. */
export function isDraftFileName(name: string): boolean {
  const m = /^(.{1,64})\.(md|json)$/.exec(name);
  return m !== null && isFileSafeId(m[1]!);
}
