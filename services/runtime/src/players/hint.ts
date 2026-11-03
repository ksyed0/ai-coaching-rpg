/** The longest cleaned facilitator steer, in code points. */
export const MAX_HINT_CHARS = 300;

/** Tag characters, variation selectors and every control or format character (bidi, zero-width, soft hyphen, invisible operators). */
const STRIP = /[\u{E0000}-\u{E007F}]|\p{Cc}|\p{Cf}|\p{Variation_Selector}/gu;
const FENCE = /<<<|>>>/g;

/**
 * Makes untrusted text safe to place in the system section: NFKC (so full-width fence marks fold first); tab, line breaks and
 * separators become spaces; every control, format (bidi, zero-width, soft hyphen), tag and variation-selector character is removed;
 * every `<<<` and `>>>` is removed, repeatedly, so pieces cannot join into a fence; whitespace is collapsed to single spaces.
 */
export function stripFences(raw: string): string {
  let t = raw.normalize("NFKC").replace(/[\t\n\r\u0085\u2028\u2029]/g, " ").replace(STRIP, "");
  for (let prev = ""; prev !== t; ) { prev = t; t = t.replace(FENCE, ""); }
  return t.replace(/\s+/g, " ").trim();
}

/** Cleans a facilitator's steer (idempotent). Null when not a string, empty, or longer than MAX_HINT_CHARS code points after cleaning. */
export function cleanHint(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = stripFences(raw);
  return t === "" || [...t].length > MAX_HINT_CHARS ? null : t;
}
