/**
 * Echo detection for the showcase (an observation, never a failure): two AI character replies that follow each other in a scene and
 * say nearly the same thing. Similarity is the Jaccard index of the two replies' token sets after lowercasing, stripping punctuation
 * and dropping stop words, so a rephrasing with different filler words still counts. Pure.
 */
export const ECHO_THRESHOLD = 0.6;

const STOP_WORDS = new Set((
  "a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its just me more my no not of on one or our she so " +
  "than that the their them then there these they this to too us was we were what when which who will with would you your yes still also very really about over only"
).split(" "));

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

export type EchoLine = { seq: number; sceneId: string | null; role: string; text: string; fallback?: boolean };
export type EchoPair = { sceneId: string | null; first: { seq: number; role: string }; second: { seq: number; role: string }; similarity: number };

/**
 * The near-duplicate pairs among consecutive AI character replies of the same scene (in the order of `lines`, which are the AI
 * character replies only). Canned fallback lines are skipped (they repeat by design). `similarity` is rounded to 2 decimals.
 */
export function findEchoes(lines: EchoLine[], threshold: number = ECHO_THRESHOLD): EchoPair[] {
  const pairs: EchoPair[] = [];
  let prev: EchoLine | undefined;
  for (const l of lines) {
    if (l.fallback) continue;
    if (prev && prev.sceneId === l.sceneId) {
      const s = similarity(prev.text, l.text);
      if (s >= threshold) pairs.push({ sceneId: l.sceneId, first: { seq: prev.seq, role: prev.role }, second: { seq: l.seq, role: l.role }, similarity: Math.round(s * 100) / 100 });
    }
    prev = l;
  }
  return pairs;
}
