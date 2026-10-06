/**
 * Cleans an assembled NPC reply. Small models see other speakers as `[role_id]: text` and sometimes continue the pattern, writing
 * lines for the other participants. This removes a leading prefix that names the character itself, then cuts the reply where a
 * `[role_id]:` tag starts a line (or a sentence), keeping only the text before it. Pure.
 */
export type CleanedReply = { text: string; cut: boolean };

const TAG = /\[[A-Za-z0-9_-]+\]\s*:/g;
const OPEN = /[[［【〔〖]/;
const CLOSE = /[\]］】〕〗]/;
const COLON = /[:：﹕꞉]/;
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤﾠ︀-️]/u;
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
const SENTENCE_END = /[.!?…"'”’)]/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An ASCII copy of `text` for matching only (look-alike brackets, colons and fullwidth letters folded, invisible characters dropped), with each kept character's index in `text`. */
function foldForMatching(text: string): { folded: string; index: number[] } {
  const out: string[] = []; const index: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (INVISIBLE.test(c)) continue;
    const code = c.charCodeAt(0);
    let f = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : c;
    if (OPEN.test(f)) f = "["; else if (CLOSE.test(f)) f = "]"; else if (COLON.test(f)) f = ":";
    out.push(f); index.push(i);
  }
  return { folded: out.join(""), index };
}

/** True when the tag at `at` begins a line or a sentence (not mid-sentence text such as "see [1]: ..."). */
function startsSegment(folded: string, at: number): boolean {
  let i = at - 1;
  let gap = false; let broke = false;
  while (i >= 0 && /\s/.test(folded[i]!)) { gap = true; if (LINE_BREAK.test(folded[i]!)) broke = true; i--; }
  if (i < 0 || broke) return true;
  return gap && SENTENCE_END.test(folded[i]!);
}

export function cleanNpcReply(raw: string, role: { id: string; name: string }): CleanedReply {
  let text = raw.trim();
  // 1. A prefix naming the character itself: "[cfo]:", "[Helena Brandt]:", "cfo:", "Helena Brandt:".
  const self = `(?:${escapeRe(role.id)}|${escapeRe(role.name)})`;
  const selfPrefix = new RegExp(`^(?:\\[\\s*${self}\\s*\\]|${self})\\s*:\\s*`, "i");
  for (let n = 0; n < 3; n++) {
    const { folded, index } = foldForMatching(text);
    const m = selfPrefix.exec(folded);
    if (!m) break;
    text = text.slice(index[m[0].length] ?? text.length).trimStart();
  }
  // 2. Cut at the first tag-shaped speaker label that starts a line or a sentence.
  const { folded, index } = foldForMatching(text);
  TAG.lastIndex = 0;
  for (let m = TAG.exec(folded); m; m = TAG.exec(folded)) {
    if (!startsSegment(folded, m.index)) continue;
    return { text: text.slice(0, index[m.index]).trim(), cut: true };
  }
  return { text, cut: false };
}
