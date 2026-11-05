/**
 * THE one table of code points that are invisible or reorder text (R25: "Trojan Source", ASCII smuggling). Used by the probe schema (no
 * transcript text, drafter or approver may contain them), by `printable` (they never reach a terminal) and by the hidden-fact check (they
 * are stripped before comparing, so a fact cannot be smuggled past it). Numeric [from, to] pairs, inclusive; no character classes.
 *
 * A curated list, not the whole Unicode Default_Ignorable_Code_Point property. Sorted: isHiddenChar stops at the first range above c.
 * Deliberately NOT in the table: TAB U+0009 and LF U+000A (allowed in text; `printable` replaces them for one-line messages), the visible
 * spaces U+00A0, U+2000-U+200A, U+202F and U+205F, and the emoji presentation selectors U+FE0E and U+FE0F and the supplementary variation selectors U+E0100-E01EF. U+200C and U+200D (zero-width
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
  [0xfff0, 0xfff8], // unassigned specials (default ignorable)
  [0xfff9, 0xfffb], // interlinear annotation controls
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0000, 0xe007f], // tag characters (ASCII smuggling)
  [0xe0080, 0xe00ff], // unassigned, default ignorable
  // U+E0100-E01EF (variation selectors supplement) are allowed in text (R27); the hidden-fact check strips them (FOLD_ONLY_RANGES)
  [0xe01f0, 0xe0fff], // unassigned, default ignorable
].map(([a, b]) => Object.freeze([a, b] as const)));

export function isHiddenChar(c: number): boolean {
  for (const [a, b] of HIDDEN_RANGES) { if (c < a) return false; if (c <= b) return true; }
  return false;
}

export function hasHiddenChar(s: string): boolean {
  for (const ch of s) if (isHiddenChar(ch.codePointAt(0)!)) return true;
  return false;
}

/** Allowed in text, but stripped before the hidden-fact comparison (R27): all variation selectors. */
export const FOLD_ONLY_RANGES: readonly (readonly [number, number])[] = Object.freeze([[0xfe00, 0xfe0f], [0xe0100, 0xe01ef]].map(([a, b]) => Object.freeze([a, b] as const)));

const inRanges = (c: number, ranges: readonly (readonly [number, number])[]): boolean => ranges.some(([a, b]) => c >= a && c <= b);

const stripFolded = (s: string): string => {
  let out = "";
  for (const ch of s) { const c = ch.codePointAt(0)!; if (!isHiddenChar(c) && !inRanges(c, FOLD_ONLY_RANGES)) out += ch; }
  return out;
};

/**
 * `s` folded for comparison (R28): every hidden character and variation selector removed, THEN compatibility forms folded (NFKC), then
 * removed again. Stripping first matters: a hidden character between a base letter and its combining mark ("cafe", U+200B, U+0301) would
 * otherwise block composition and the line would never equal "café". The strip after NFKC is a guard: today NFKC never yields one of these
 * characters from a visible one (a test checks every code point), but a future Unicode version could.
 */
export function foldForComparison(s: string): string {
  return stripFolded(stripFolded(s).normalize("NFKC"));
}

/** `s` without any character of the table. */
export function stripHidden(s: string): string {
  let out = "";
  for (const ch of s) if (!isHiddenChar(ch.codePointAt(0)!)) out += ch;
  return out;
}

export const HIDDEN_CHARS_MESSAGE = "hidden or bidirectional control characters";
