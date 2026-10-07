/**
 * THE one table of code points that are invisible or reorder text (R25: "Trojan Source", ASCII smuggling). Used by the probe schema (no
 * transcript text, drafter or approver may contain them), by `printable` (they never reach a terminal) and by the hidden-fact check (they
 * are stripped before comparing, so a fact cannot be smuggled past it). Numeric [from, to] pairs, inclusive; no character classes.
 *
 * Deliberately NOT in the table: TAB U+0009 and LF U+000A (allowed in text; `printable` replaces them for one-line messages), the visible
 * spaces U+00A0, U+2000-U+200A, U+202F and U+205F, and the emoji presentation selectors U+FE0E and U+FE0F. U+200C and U+200D (zero-width
 * non-joiner and joiner) ARE in it, so ZWJ emoji sequences and text that needs ZWNJ/ZWJ are not supported in probes.
 */
export const HIDDEN_RANGES: readonly (readonly [number, number])[] = Object.freeze([
  [0x0000, 0x0008], // C0 controls before TAB
  [0x000b, 0x001f], // C0 controls after LF
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner, LRM, RLM
  [0x2028, 0x202e], // line and paragraph separators, bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated format controls
  [0x2800, 0x2800], // Braille pattern blank
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0d], // variation selectors 1-14 (FE0E and FE0F stay: emoji presentation)
  [0xfeff, 0xfeff], // zero-width no-break space (BOM)
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff9, 0xfffb], // interlinear annotation controls
  [0xe0000, 0xe007f], // tag characters (ASCII smuggling)
  [0xe0100, 0xe01ef], // variation selectors supplement
].map(([a, b]) => Object.freeze([a, b] as const)));

export function isHiddenChar(c: number): boolean {
  for (const [a, b] of HIDDEN_RANGES) { if (c < a) return false; if (c <= b) return true; }
  return false;
}

export function hasHiddenChar(s: string): boolean {
  for (const ch of s) if (isHiddenChar(ch.codePointAt(0)!)) return true;
  return false;
}

/** `s` without any character of the table. */
export function stripHidden(s: string): string {
  let out = "";
  for (const ch of s) if (!isHiddenChar(ch.codePointAt(0)!)) out += ch;
  return out;
}

export const HIDDEN_CHARS_MESSAGE = "hidden or bidirectional control characters";
