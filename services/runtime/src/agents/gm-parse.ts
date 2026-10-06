import type { GmNoVerdictReason, GmVia } from "@acr/events";
export type { GmNoVerdictReason, GmVia };

export type GmParse =
  | { ok: true; verdict: boolean; reasoning: string; via: "strict" | "tolerant" }
  | { ok: false; reason: GmNoVerdictReason };

/** Only the tail of a reply is looked at (a verdict comes last), and only this many candidate objects: the parser stays linear-ish on hostile input. */
const MAX_SCAN_CHARS = 20_000;
const MAX_CANDIDATES = 200;

/** A usable verdict is a real boolean or exactly the string "true"/"false" (any case). Never 1, "yes" or null. */
function readVerdict(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") { const t = v.trim().toLowerCase(); if (t === "true") return true; if (t === "false") return false; }
  return undefined;
}

/** The end index (exclusive) of the brace-balanced, string-aware object starting at `start`, or -1 when it never closes. */
function balancedEnd(s: string, start: number): number {
  let depth = 0; let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === "\\") i++; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Reads a Game Master verdict from a model reply. Pure and total: never throws, whatever the input.
 * Order: drop `<think>` blocks and code fences; a reply that is exactly one JSON object is `strict`; otherwise take the LAST
 * brace-balanced JSON object with a usable `verdict` (an echoed schema example comes first and is not valid JSON anyway);
 * then `verdict: true|false` as plain text; then a reply that is exactly `true` or `false`. The reasoning text of a model
 * is never searched for a verdict. On failure, `reason` says why.
 */
export function parseGmReply(input: string): GmParse {
  const text = typeof input === "string" ? input : "";
  if (text.trim() === "") return { ok: false, reason: "empty" };

  // strict: the whole reply is one JSON object
  try {
    const whole = JSON.parse(text.trim()) as unknown;
    if (whole && typeof whole === "object" && !Array.isArray(whole)) {
      const o = whole as { verdict?: unknown; reasoning?: unknown };
      const v = readVerdict(o.verdict);
      if (v !== undefined) return { ok: true, verdict: v, reasoning: typeof o.reasoning === "string" ? o.reasoning : "", via: "strict" };
    }
  } catch { /* not strict JSON: read it tolerantly below */ }

  // <think>...</think> blocks are the model's thinking; an unclosed one swallows the rest of the reply.
  const hadThink = /<think(?:ing)?>/i.test(text);
  let body = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ").replace(/<think(?:ing)?>[\s\S]*$/i, " ").replace(/<\/think(?:ing)?>/gi, " ");
  body = body.replace(/```[A-Za-z0-9_-]*/g, " ");
  if (body.trim() === "") return { ok: false, reason: hadThink ? "reasoning_only" : "empty" };
  if (body.length > MAX_SCAN_CHARS) body = body.slice(-MAX_SCAN_CHARS);

  let found: { verdict: boolean; reasoning: string } | undefined;
  let sawObjectWithoutVerdict = false; let sawUnclosed = false;
  let attempts = 0;
  for (let i = body.indexOf("{"); i !== -1 && attempts < MAX_CANDIDATES; i = body.indexOf("{", i + 1)) {
    if (!/^\{\s*(?:"|\})/.test(body.slice(i, i + 40))) continue; // a JSON object starts { then a key or }
    attempts++;
    const end = balancedEnd(body, i);
    if (end === -1) { sawUnclosed = true; continue; }
    let obj: unknown;
    try { obj = JSON.parse(body.slice(i, end)); } catch { continue; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const o = obj as { verdict?: unknown; reasoning?: unknown };
    const v = readVerdict(o.verdict);
    if (v === undefined) { if ("verdict" in o) sawObjectWithoutVerdict = true; continue; }
    found = { verdict: v, reasoning: typeof o.reasoning === "string" ? o.reasoning : "" };
    i = end - 1; // continue after this object; the last usable one wins
  }
  if (found) return { ok: true, ...found, via: "tolerant" };

  // plain text: verdict: true / "verdict" = false (the last one)
  const plain = sawObjectWithoutVerdict ? undefined : [...body.matchAll(/["']?verdict["']?\s*[:=]\s*["']?(true|false)\b/gi)].at(-1);
  if (plain) {
    const reasoning = /["']?reasoning["']?\s*[:=]\s*"((?:[^"\\]|\\.)*)"/i.exec(body)?.[1] ?? "";
    return { ok: true, verdict: plain[1]!.toLowerCase() === "true", reasoning: reasoning.replace(/\\(.)/g, "$1"), via: "tolerant" };
  }
  // a reply that is exactly the word true or false
  const word = /^\s*(true|false)\s*$/i.exec(body);
  if (word) return { ok: true, verdict: word[1]!.toLowerCase() === "true", reasoning: "", via: "tolerant" };

  if (sawObjectWithoutVerdict) return { ok: false, reason: "bad_verdict" };
  if (sawUnclosed) return { ok: false, reason: "truncated" };
  return { ok: false, reason: /["']?verdict["']?\s*[:=]/i.test(body) ? "bad_verdict" : "no_json" };
}
