import { stripHidden } from "../calibration/hidden-chars.js";
import { cleanText } from "../review/text.js";
import { ReviewUsageError } from "../review/errors.js";

/** US-0053: the most code points a display name may have after cleaning. */
export const MAX_DISPLAY_NAME_CHARS = 60;

/**
 * A participant's display name, cleaned (hidden, bidirectional and control characters stripped, trimmed), or null when it is empty
 * after cleaning, longer than 60 code points, or holds a line break or a tab anywhere. A name is one line; the raw input is checked
 * because cleanText's scrub turns a line feed or tab into a visible mark instead of dropping it.
 */
export function normalizeDisplayName(raw: string): string | null {
  if (/[\r\n\t]/.test(raw)) return null;
  let name: string;
  try { name = cleanText(raw, MAX_DISPLAY_NAME_CHARS, "displayName", []); } catch (err) {
    if (err instanceof ReviewUsageError) return null;
    throw err;
  }
  return name;
}

/**
 * US-0059: the facilitator's name as recorded on a command or named in an alert: line breaks and tabs flattened to a space, cut to 60
 * code points, then cleaned (hidden, bidirectional and control characters stripped, trimmed). Undefined when absent, empty after
 * cleaning, or refused. A label, not proof of identity.
 */
export function cleanFacilitatorLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const flat = raw.replace(/[\r\n\t]+/g, " ");
  return normalizeDisplayName([...flat].slice(0, MAX_DISPLAY_NAME_CHARS).join("")) ?? undefined;
}

/** The name a facilitator-only alert carries: the cleaned label, or "the facilitator". */
export function actorLabel(by?: string): string {
  return cleanFacilitatorLabel(by) ?? "the facilitator";
}

/** US-0059: the most code points a closing message may have after cleaning. */
export const MAX_END_MESSAGE_CHARS = 300;

/**
 * US-0059: the facilitator's closing message, cleaned (hidden, bidirectional and control characters stripped, trimmed), or undefined
 * when absent or empty after stripping (whitespace only). Throws ReviewUsageError when longer than 300 code points; the host turns
 * that into bad_message. Markup is kept as typed: the clients render it as text. scrubText may rewrite home and temp paths to "~" / "<tmp>".
 */
export function cleanClosingMessage(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (stripHidden(raw).trim() === "") return undefined;
  return cleanText(raw, MAX_END_MESSAGE_CHARS, "message", []);
}
