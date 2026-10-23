import { isSafeId } from "@acr/events";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { ReviewUsageError } from "./errors.js";
import type { Level } from "./types.js";

/** Free text from a person: hidden characters stripped, secrets scrubbed, 1 to `max` characters. `what` names the option in the message. */
export function cleanText(
  raw: string,
  max: number,
  what: string,
  secrets: string[],
): string {
  const stripped = stripHidden(String(raw)).replace(/\r\n?/g, "\n").trim();
  if (Array.from(stripped).length > max)
    throw new ReviewUsageError(`${what} is longer than ${max} characters`);
  const text = scrubText(stripped, secrets).trim();
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
