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

/** US-0060: the most code points a bot alert's message may have after cleaning. */
export const MAX_BOT_ALERT_CHARS = 200;
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

/**
 * US-0060: an AI player's alert message as one clean line: terminal escape sequences removed whole, line breaks and tabs and other
 * whitespace collapsed to one space, then cut to 200 code points and cleaned like a facilitator's label (hidden, bidirectional and
 * control characters stripped, trimmed). Undefined when nothing is left. Unlike the label, the text is cut, never refused.
 */
export function cleanBotAlertMessage(raw: string): string | undefined {
  const flat = raw.replace(ANSI_SEQUENCE, "").replace(/\s+/g, " ");
  const cut = [...stripHidden(flat).replace(/\s+/g, " ").trim()].slice(0, MAX_BOT_ALERT_CHARS).join("");
  try { return cleanText(cut, MAX_BOT_ALERT_CHARS, "message", []); }
  catch (err) { if (err instanceof ReviewUsageError) return undefined; throw err; }
}
