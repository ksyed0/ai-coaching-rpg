/** The longest cleaned facilitator steer, in code points. */
export const MAX_HINT_CHARS = 300;

/** C0/C1 controls except tab and line breaks (folded to spaces below), bidi controls and zero-width characters. */
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;
const FENCE = /<<<|>>>/g;

/**
 * Cleans a facilitator's steer so it can sit inside the fenced system section: string only; NFKC (so full-width fence marks fold
 * first); controls, bidi and zero-width characters removed; tab and line breaks become spaces; every `<<<` and `>>>` removed, repeatedly,
 * so pieces cannot join into a fence; whitespace collapsed. Null when empty or longer than MAX_HINT_CHARS code points.
 */
export function cleanHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.normalize("NFKC").replace(/[\t\n\r]/g, " ").replace(STRIP, "");
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(FENCE, ""); }
  t = t.replace(/\s+/g, " ").trim();
  if (t === "" || [...t].length > MAX_HINT_CHARS) return null;
  return t;
}
