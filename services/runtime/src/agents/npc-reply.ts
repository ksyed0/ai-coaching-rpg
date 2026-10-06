/**
 * Cleans an assembled NPC reply. Small models see other speakers as `[role_id]: text` and sometimes continue the pattern, writing
 * lines for the other participants. This drops a leading `<think>` block, removes a leading prefix that names the character itself,
 * then cuts the reply where another speaker's label starts a line or a sentence, keeping only the text before it. Pure, linear time.
 */
export type CleanedReply = { text: string; cut: boolean };
export type SpeakerName = { id: string; name: string };

const OPEN = /[[［【〔〖]/;
const CLOSE = /[\]］】〕〗]/;
const COLON = /[:：﹕꞉]/;
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠏ㅤﾠ︀-️]/u;
const LINE_BREAK = new RegExp(`[\\n\\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
/** A sentence end, including closing quotes and CJK full stops. */
const SENTENCE_END = /[.!?…"'”’)。｡]/;
const CLAUSE_END = /[,;:，；]/;
const QUOTE = `["“”'‘’«]?`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const nameRe = (s: string): string => escapeRe(s.trim()).replace(/\s+/g, "\\s+");

/** An ASCII-leaning copy of `text` for matching only (look-alike brackets, colons and fullwidth forms folded, invisible characters dropped), with the original UTF-16 index of every folded code unit. */
function foldForMatching(text: string): { folded: string; index: number[] } {
  const out: string[] = []; const index: number[] = [];
  let i = 0;
  for (const c of text) { // by code point, so astral invisible characters (tag characters U+E0000...) fold away
    if (!INVISIBLE.test(c)) {
      const code = c.codePointAt(0)!;
      let f = code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : c;
      if (OPEN.test(f)) f = "["; else if (CLOSE.test(f)) f = "]"; else if (COLON.test(f)) f = ":";
      out.push(f);
      for (let k = 0; k < f.length; k++) index.push(i);
    }
    i += c.length;
  }
  return { folded: out.join(""), index };
}

/** True when the label at `at` begins a line or a sentence. A bracketed label may directly follow a sentence or clause end ("Fine.[x]:", "Fine, [x]:"). */
function startsSegment(folded: string, at: number, bracketed: boolean): boolean {
  let i = at - 1;
  let gap = false; let broke = false;
  while (i >= 0 && /\s/.test(folded[i]!)) { gap = true; if (LINE_BREAK.test(folded[i]!)) broke = true; i--; }
  if (i < 0 || broke) return true;
  const c = folded[i]!;
  if (bracketed) return SENTENCE_END.test(c) || CLAUSE_END.test(c);
  return gap && SENTENCE_END.test(c);
}

/** The earliest qualifying label match in `folded` for `re` (global), or -1. */
function firstLabel(folded: string, re: RegExp, accept: (m: RegExpExecArray) => boolean): number {
  re.lastIndex = 0;
  for (let m = re.exec(folded); m; m = re.exec(folded)) {
    if (!accept(m)) continue;
    if (startsSegment(folded, m.index, m[0].includes("["))) return m.index;
  }
  return -1;
}

/** A leading `<think>...</think>` block is the model's inline thinking: dropped; an unclosed one swallows the rest. */
function stripThink(text: string): string {
  const open = /^\s*<think\b[^>]*>/i.exec(text);
  if (!open) return text;
  const rest = text.slice(open[0].length);
  const close = /<\/think\s*>/i.exec(rest);
  return close ? rest.slice(close.index + close[0].length) : "";
}

/** A run of 3+ asterisks or dashes standing alone (start of text or after whitespace) and followed by more text: a separator before a model's own commentary. */
const SEPARATOR = /(?:^|\s)(?:\*{3,}|-{3,})(?=\s+\S)/;
/** Cuts the reply at such a separator, keeping only the text before it. A single dash, an em dash, `**bold**`, `--` and `5*3` are not separators. */
export function cutAtSeparator(text: string): string {
  const m = SEPARATOR.exec(text);
  return m ? text.slice(0, m.index) : text;
}

export function cleanNpcReply(raw: string, role: SpeakerName, others: SpeakerName[] = []): CleanedReply {
  let text = cutAtSeparator(stripThink(raw)).trim();
  // 1. A prefix naming the character itself (its own id or name exactly): "[cfo]:", "[ Helena Brandt ]:", "cfo:", "Helena Brandt:".
  const self = `(?:${nameRe(role.id)}|${nameRe(role.name)})`;
  const selfPrefix = new RegExp(`^(?:\\[\\s*${self}\\s*\\]|${self})\\s*:\\s*`, "i");
  for (let n = 0; n < 3; n++) {
    const { folded, index } = foldForMatching(text);
    const m = selfPrefix.exec(folded);
    if (!m) break;
    text = text.slice(index[m[0].length] ?? text.length).trimStart();
  }
  // 2. Cut at the first label of another speaker that starts a line or sentence: a known role id or name (bracketed or not), or the generic [role_id]: shape.
  const { folded, index } = foldForMatching(text);
  const known = [...new Set(others.flatMap((o) => [o.id, o.name]).map((s) => s.trim()).filter((s) => s.length > 0))].sort((a, b) => b.length - a.length).map(nameRe);
  const cuts = [firstLabel(folded, new RegExp(`${QUOTE}\\[\\s*([A-Za-z0-9_-]{2,})\\s*\\]\\s*:`, "g"), (m) => /[A-Za-z]/.test(m[1]!))];
  if (known.length > 0) cuts.push(firstLabel(folded, new RegExp(`${QUOTE}(?:\\[\\s*(?:${known.join("|")})\\s*\\]?|(?:${known.join("|")}))\\s*:`, "gi"), () => true));
  const hits = cuts.filter((c) => c >= 0);
  if (hits.length === 0) return { text, cut: false };
  return { text: text.slice(0, index[Math.min(...hits)]).trim(), cut: true };
}

/** The silence marker in any case and spacing (`<silent/>`, `<SILENT />`, `<silent>`), wherever it appears: inside a longer reply or inside a quote. */
const SILENT_RE = /<\s*silent\s*\/?\s*>/gi;

/**
 * Removes every silence marker from an already cleaned reply. `silent` is true when a marker was present and nothing
 * that reads as words is left (the character chose not to speak); a marker inside a longer reply is only stripped, the rest is kept.
 * The marker is never an utterance: callers record `text` only when `silent` is false.
 */
export function stripSilentMarker(text: string): { text: string; marker: boolean; silent: boolean } {
  const marker = new RegExp(SILENT_RE.source, "i").test(text);
  if (!marker) return { text, marker: false, silent: false };
  const stripped = text.replace(SILENT_RE, "").replace(/[ \t]{2,}/g, " ").trim();
  return { text: stripped, marker: true, silent: !/[\p{L}\p{N}]/u.test(stripped) };
}
