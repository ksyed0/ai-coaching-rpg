import { cleanNpcReply, cutAtSeparator, type SpeakerName } from "../agents/npc-reply.js";

/** The longest line the server accepts (it refuses longer ones). */
export const MAX_LINE_CHARS = 2_000;

/** C0/C1 controls (not tab or line breaks, which are folded into spaces later) and bidi controls: never sent to the server. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** A leading echo of the private intent note: "[note to you only, not spoken]:", "Note:", and the note's own lead-in. */
const NOTE_PREFIX = /^\s*(?:\[\s*note\b[^\]]*\]|note)\s*:\s*(?:what you want to get across in this turn\s*\(do not quote it\)\s*:\s*)?/i;
const dropNote = (t: string): string => { let out = t; for (let i = 0; i < 3 && NOTE_PREFIX.test(out); i++) out = out.replace(NOTE_PREFIX, ""); return out; };

/** Where a model starts explaining itself: a separator of 3+ asterisks, dashes, underscores or equals (alone, between spaces), or a line/paragraph opening a note or intent. */
const SEPARATOR_ANY = /(?:^|\s)(?:\*{3,}|-{3,}|_{3,}|={3,})(?=\s|$)/;
const COMMENTARY = /^[ \t]*(?:\(\s*note\b|\[\s*note\b|note\s*:|intent\s*:|\(\s*intent\b|my intent\b)/im;
/** Cuts a reply at the first separator or commentary line, keeping only the words that precede it. */
const cutCommentary = (t: string): string => {
  const cuts = [SEPARATOR_ANY.exec(t)?.index, COMMENTARY.exec(t)?.index].filter((i): i is number => i !== undefined);
  return cuts.length ? t.slice(0, Math.min(...cuts)) : t;
};

/** Cleans a model's reply into one spoken line (empty or over-long results are the caller's to judge). `cut` is true when lines for other speakers were cut. */
export function cleanPlayerReply(raw: string, self: SpeakerName, others: SpeakerName[]): { text: string; cut: boolean } {
  const cleaned = cleanNpcReply(cutAtSeparator(cutCommentary(dropNote(raw.replace(CONTROLS, "")))), self, others);
  // One spoken line: line breaks become spaces; an echoed intent note is dropped.
  const text = cutCommentary(dropNote(cleaned.text.replace(CONTROLS, ""))).replace(/\s+/g, " ").trim();
  return { text, cut: cleaned.cut };
}
