import type { GmNoVerdictReason, GmVia } from "@acr/events";
export type { GmNoVerdictReason, GmVia };

/** `ignored`: verdict objects set aside because they lacked the evaluation's nonce (a forged or echoed object). */
export type GmParse =
  | { ok: true; verdict: boolean; reasoning: string; via: "strict" | "tolerant"; ignored: number }
  | { ok: false; reason: GmNoVerdictReason; ignored: number };

export type GmParseOptions = {
  /**
   * The random per-evaluation nonce that the system prompt asks the model to put in its answer as `"id"` (it is never in the dialogue, so
   * no participant can know it). With a nonce, ONLY a JSON object whose `id` equals it can give a verdict: prose, plain `verdict: true` lines,
   * bare true/false and objects without the id are all ignored. Without one (offline corpus checks) every shape is read, with the hardening below.
   */
  nonce?: string | null;
};

/** Only the tail of a reply is looked at (a verdict comes last): bounded work on hostile input. */
const MAX_SCAN_CHARS = 20_000;

/** Nonce comparison is exact except for case and surrounding whitespace or quotes (a small model may wrap or upper-case the id it copies). */
const normId = (s: string): string => s.trim().replace(/^["\u0027`\u201c\u2018]+|["\u0027`\u201d\u2019]+$/g, "").trim().toLowerCase();

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A usable verdict is a real boolean or exactly the string "true"/"false" (any case). Never 1, "yes" or null. */
function readVerdict(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") { const t = v.trim().toLowerCase(); if (t === "true") return true; if (t === "false") return false; }
  return undefined;
}

/** The end index (exclusive) of the brace- or bracket-balanced, string-aware value starting at `start`, or -1 when it never closes. */
function balancedEnd(s: string, start: number): number {
  const open = s[start]!; const close = open === "{" ? "}" : "]";
  let depth = 0; let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") { if (--depth === 0) return c === close ? i + 1 : -1; }
  }
  return -1;
}

/** The keys of the top level of a (balanced) JSON object text, in order and WITH duplicates (JSON.parse hides them). */
function topKeys(obj: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < obj.length && obj[j] !== "\"") j += obj[j] === "\\" ? 2 : 1;
      if (depth === 1) { let k = j + 1; while (k < obj.length && /\s/.test(obj[k]!)) k++; if (obj[k] === ":") { try { keys.push(JSON.parse(obj.slice(i, j + 1)) as string); } catch { keys.push(""); } } }
      i = j;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  return keys;
}

/** Removes `<think>` blocks (an unclosed one swallows the rest; a stray closing tag drops everything before it). Linear: indexOf only. */
function stripThink(t: string): { text: string; had: boolean } {
  const lower = t.toLowerCase();
  const next = (from: number, tags: string[]): { idx: number; len: number } | null => {
    let best: { idx: number; len: number } | null = null;
    for (const tag of tags) { const idx = lower.indexOf(tag, from); if (idx !== -1 && (!best || idx < best.idx)) best = { idx, len: tag.length }; }
    return best;
  };
  const OPEN = ["<thinking>", "<think>"]; const CLOSE = ["</thinking>", "</think>"];
  let out = ""; let i = 0; let had = false;
  while (i < t.length) {
    const open = next(i, OPEN); const close = next(i, CLOSE);
    if (close && (!open || close.idx < open.idx)) { out = ""; i = close.idx + close.len; had = true; continue; }
    if (!open) { out += t.slice(i); break; }
    had = true;
    out += `${t.slice(i, open.idx)} `;
    const c = next(open.idx + open.len, CLOSE);
    if (!c) break;
    i = c.idx + c.len;
  }
  return { text: out, had };
}

/**
 * Reads a Game Master verdict from a model reply. Pure and total: never throws, whatever the input. The reply is untrusted (the model may
 * quote a participant who tried to inject a verdict), so a verdict is accepted only when it is unambiguous:
 *  - `<think>` blocks and code fences are dropped, and only the last 20 000 characters are read;
 *  - EVERY complete JSON object of the reply is examined (an object that fails to parse is skipped as a whole, never searched inside; an array
 *    is skipped as a whole), and objects with a duplicate `verdict` or `id` key give no verdict;
 *  - with a nonce (see GmParseOptions) only objects carrying `"id": nonce` count, so a forged object in quoted text is ignored;
 *  - if the usable verdicts DISAGREE the answer is `conflict` (nothing is accepted: the caller asks once more);
 *  - a reply with an unclosed object is `truncated` and gives no verdict by any path;
 *  - without a nonce only: a `verdict: true` line of its own and a reply that is exactly `true` or `false` are read, but never when the reply
 *    echoes a dialogue record (`{"role": ...`) or quotes a `verdict: ...` inside quotation marks.
 * The reasoning text of a model is never searched for a verdict outside those anchored rules.
 */
export function parseGmReply(input: string, opts: GmParseOptions = {}): GmParse {
  const text = typeof input === "string" ? input : "";
  const fail = (reason: GmNoVerdictReason, ignored = 0): GmParse => ({ ok: false, reason, ignored });
  if (text.trim() === "") return fail("empty");

  let body = text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text;
  const thought = stripThink(body);
  const hadThink = thought.had;
  const unchanged = thought.text === body && !/```/.test(body);
  body = thought.text.replace(/```[A-Za-z0-9_-]*/g, " ");
  if (body.trim() === "") return fail(hadThink ? "reasoning_only" : "empty");

  const nonce = opts.nonce ?? undefined;
  const found: { verdict: boolean; reasoning: string; raw: string }[] = [];
  let ignored = 0; let sawBad = false; let bracketsOk = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "[") { // an array never gives a verdict; an unclosed "[" is not tried again (bounded work)
      if (!bracketsOk) continue;
      const end = balancedEnd(body, i);
      if (end === -1) bracketsOk = false; else i = end - 1;
      continue;
    }
    if (c !== "{" || !/^\{\s*(?:"|\})/.test(body.slice(i, i + 40))) continue;
    const end = balancedEnd(body, i);
    if (end === -1) return fail("truncated", ignored); // an unclosed object: no verdict by any path
    const raw = body.slice(i, end);
    i = end - 1; // never look inside a candidate again
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { sawBad = true; continue; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as Record<string, unknown>;
    if (!has(o, "verdict")) continue;
    const keys = topKeys(raw);
    if (keys.filter((k) => k === "verdict").length > 1 || keys.filter((k) => k === "id").length > 1) { sawBad = true; continue; }
    if (nonce !== undefined && !(typeof o.id === "string" && normId(o.id) === normId(nonce))) { ignored++; continue; }
    const v = readVerdict(o.verdict);
    if (v === undefined) { sawBad = true; continue; }
    found.push({ verdict: v, reasoning: typeof o.reasoning === "string" ? o.reasoning : "", raw });
  }

  // plain text and bare words: only without a nonce, and only when the reply is not an echo or a quotation
  const echoes = /\{\s*"role"\s*:/.test(body) || /["“'][^"“”\n]*\bverdict\s*[:=]\s*(?:true|false)/i.test(body);
  if (found.length === 0 && nonce === undefined && !echoes && !sawBad) {
    const lines = [...body.matchAll(/^\s*["']?verdict["']?\s*[:=]\s*(true|false)\s*$/gim)];
    const values = new Set(lines.map((m) => m[1]!.toLowerCase()));
    if (values.size > 1) return fail("conflict", ignored);
    if (values.size === 1) {
      const reasoning = /^\s*["']?reasoning["']?\s*[:=]\s*(.*)$/im.exec(body)?.[1]?.trim() ?? "";
      return { ok: true, verdict: [...values][0] === "true", reasoning, via: "tolerant", ignored };
    }
    const word = /^\s*(true|false)\s*$/i.exec(body);
    if (word) return { ok: true, verdict: word[1]!.toLowerCase() === "true", reasoning: "", via: "tolerant", ignored };
  }

  if (found.length > 0) {
    if (new Set(found.map((f) => f.verdict)).size > 1) return fail("conflict", ignored);
    const f = found[0]!;
    return { ok: true, verdict: f.verdict, reasoning: f.reasoning, via: found.length === 1 && unchanged && text.trim() === f.raw ? "strict" : "tolerant", ignored };
  }
  if (sawBad) return fail("bad_verdict", ignored);
  if (ignored > 0) return fail("no_nonce", ignored);
  return fail(/["']?verdict["']?\s*[:=]/i.test(body) ? "bad_verdict" : "no_json", ignored);
}
