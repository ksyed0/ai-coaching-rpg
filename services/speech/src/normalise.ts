/**
 * US-0070 (EPIC-0003 voice A1a, spec 7.3; owner decision 2026-11-08): the CONSERVATIVE transcript cleaner. It never rewrites a word: the
 * logged text is what the facilitator reads, the characters answer and the evaluator quotes. It only
 *  - removes format characters (bidi controls, zero-width characters, the byte-order mark, soft hyphens: `\p{Cf}`),
 *  - turns whitespace (line breaks, tabs, no-break spaces) into one space, removes the other control characters (`\p{Cc}`), collapses
 *    spaces and trims,
 *  - drops a currency word repeated right after a currency amount ("$11,000 dollars" becomes "$11,000"; likewise £ and pounds, € and
 *    euros), and
 *  - cuts the text at MAX_LINE_CHARS code units, never inside a surrogate pair.
 * Spelled numbers, times and percentages stay exactly as the model wrote them. Deterministic and idempotent. No character class here
 * combines letters, digits and `_` (the US-0020 id-rule guard).
 */
export const MAX_LINE_CHARS = 2000;

const FORMAT = /\p{Cf}/gu;
const SPACE = /\s+/gu;
const CONTROL = /\p{Cc}/gu;
const SPACES = / {2,}/g;
const CURRENCY: readonly RegExp[] = [["\\$", "dollars?"], ["£", "pounds?"], ["€", "euros?"]].map(
  ([symbol, word]) => new RegExp(`(${symbol}\\d(?:[\\d,.]*\\d)?)(?: (?:${word}))+(?![\\p{L}\\p{N}])`, "giu"),
);

export function normalise(raw: string): string {
  let s = raw.replace(FORMAT, "").replace(SPACE, " ").replace(CONTROL, "").replace(SPACES, " ").trim();
  for (const re of CURRENCY) s = s.replace(re, "$1");
  if (s.length > MAX_LINE_CHARS) {
    s = s.slice(0, MAX_LINE_CHARS);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // a high surrogate whose pair was cut off
    // F9a: the cut can expose a currency word that had a letter after it ("$5 dollarsX"): the rule applies again (it only shortens).
    for (const re of CURRENCY) s = s.replace(re, "$1");
    s = s.trimEnd();
  }
  return s;
}
