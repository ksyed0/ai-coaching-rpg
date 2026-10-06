/**
 * Echo detection for the showcase (an observation, never a failure): two AI character replies that follow each other in a scene and
 * say nearly the same thing. Similarity is the Jaccard index of the two replies' token sets after lowercasing, stripping punctuation
 * and dropping stop words, so a rephrasing with different filler words still counts. Pure.
 */
export const ECHO_THRESHOLD = 0.6;

/** Each side of a pair needs at least this many content tokens, or the similarity of two short replies means nothing. */
export const MIN_ECHO_TOKENS = 4;

// Polarity words (no, not, yes, never...) are NOT stop words: "I will approve it" and "I will not approve it" must stay different.
const STOP_WORDS = new Set((
  "a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its just me more my of on one or our she so " +
  "than that the their them then there these they this to too us was we were what when which who will with would you your still also very really about over only"
).split(" "));
const NEGATION = /\b(?:no|not|never|none|nothing|cannot|refuse[sd]?|decline[sd]?|reject(?:s|ed)?)\b|n't\b|\bwon[’']t\b/i;

/** The set of meaningful words of `text`: lower case, letters and digits only, stop words and single characters removed. */
export function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (t.length > 1 && !STOP_WORDS.has(t)) out.add(t);
  return out;
}

/** Jaccard similarity of the token sets of two texts, 0 to 1; 0 when either has no meaningful words. */
export function similarity(a: string, b: string): number {
  const x = tokenSet(a); const y = tokenSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** One line of a scene in stream order: an AI character reply (`ai`) or any other spoken line (a player's), which separates player turns. */
export type EchoLine = { seq: number; sceneId: string | null; role: string; text: string; ai: boolean; fallback?: boolean };
export type EchoPair = { sceneId: string | null; first: { seq: number; role: string }; second: { seq: number; role: string }; similarity: number };

/**
 * Compares AI character replies that answer the SAME player line: two DIFFERENT roles, one right after the other, in the same scene,
 * with no player line between them (a character repeating itself is the repetition guard's business, not an echo). Canned fallback
 * lines are skipped (they repeat by design). `eligible` counts the pairs that could be compared (silent turns shrink it); an echo
 * also needs at least MIN_ECHO_TOKENS content tokens on each side, the same polarity (one side refusing, the other approving is not
 * an echo) and a similarity of at least `threshold`. `similarity` is rounded to 2 decimals.
 */
export function findEchoes(lines: EchoLine[], threshold: number = ECHO_THRESHOLD): { pairs: EchoPair[]; eligible: number } {
  const pairs: EchoPair[] = [];
  let eligible = 0;
  let prev: EchoLine | undefined;
  for (const l of lines) {
    if (!l.ai) { prev = undefined; continue; }
    if (l.fallback) { prev = undefined; continue; }
    if (prev && prev.sceneId === l.sceneId && prev.role !== l.role) {
      eligible++;
      const enough = tokenSet(prev.text).size >= MIN_ECHO_TOKENS && tokenSet(l.text).size >= MIN_ECHO_TOKENS;
      const s = similarity(prev.text, l.text);
      if (enough && s >= threshold && NEGATION.test(prev.text) === NEGATION.test(l.text)) pairs.push({ sceneId: l.sceneId, first: { seq: prev.seq, role: prev.role }, second: { seq: l.seq, role: l.role }, similarity: Math.round(s * 100) / 100 });
    }
    prev = l;
  }
  return { pairs, eligible };
}
