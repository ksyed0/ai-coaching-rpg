import type { Criterion } from "@acr/script";
import { INVALID_LABEL, deriveConfidence, isScore, levelLabel, parseConfidence, type Confidence, type Score } from "./aggregate.js";
import { formatClock, normText, type Transcript, type UtteranceRec } from "./transcript.js";

// ---- tolerant JSON ----------------------------------------------------------------------------------------------

export type JsonParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string; /** The reply opened a JSON object and never closed it: it was probably cut off at the token budget. */ truncated?: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The first balanced `{...}` starting at `from` (string- and escape-aware), or null. Linear time. */
function balancedObject(text: string, from: number): { json: string; end: number } | null {
  let depth = 0; let inStr = false; let esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return { json: text.slice(from, i + 1), end: i + 1 }; }
  }
  return null;
}

function tryParse(json: string): Record<string, unknown> | null {
  for (const candidate of [json, json.replace(/,\s*([}\]])/g, "$1")]) {
    try { const v = JSON.parse(candidate) as unknown; if (isObject(v)) return v; } catch { /* try the next form */ }
  }
  return null;
}

/**
 * Extracts one JSON object from a model reply: removes a `<think>` block, accepts a ```json code fence or prose around the object, and
 * tolerates trailing commas. Never throws. Looks at no more than 8 candidate objects.
 */
export function extractJson(reply: string): JsonParse {
  let text = String(reply ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
  if (text === "") return { ok: false, error: "the reply was empty" };
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) candidates.push(m[1]!.trim());
  candidates.push(text);
  let tried = 0;
  for (const c of candidates) {
    let from = c.indexOf("{");
    while (from !== -1 && tried < 8) {
      tried++;
      const obj = balancedObject(c, from);
      if (!obj) break;
      const parsed = tryParse(obj.json);
      if (parsed) return { ok: true, value: parsed };
      from = c.indexOf("{", from + 1);
    }
  }
  const open = text.indexOf("{");
  const truncated = open !== -1 && balancedObject(text, open) === null;
  return { ok: false, error: truncated ? "the reply was cut off before the JSON object was complete" : open !== -1 ? "no complete, valid JSON object was found in the reply" : "the reply held no JSON object", ...(truncated ? { truncated: true } : {}) };
}

// ---- text cleaning ----------------------------------------------------------------------------------------------

const URL_RE = /\b(?:https?|ftp|wss?):\/\/\S+|\bwww\.\S+/gi;
/** Model-written prose: whitespace folded, links removed (reports carry no URLs), clipped. */
export function cleanProse(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = normText(v).replace(URL_RE, "[link removed]");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
export function cleanList(v: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const t = cleanProse(isObject(item) ? (item.text ?? item.point ?? item.description) : item, maxChars);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
}
export type Action = { lo: string; action: string };
/** Next actions as {lo, action}. An item whose LO id is unknown is dropped (and counted), never re-tied to another objective. */
export function cleanActions(v: unknown, validLos: string[], maxItems = 3): { actions: Action[]; dropped: number } {
  if (!Array.isArray(v)) return { actions: [], dropped: 0 };
  const actions: Action[] = [];
  let dropped = 0;
  for (const item of v) {
    const action = cleanProse(isObject(item) ? (item.action ?? item.text ?? item.description) : item, 400);
    if (!action || actions.some((a) => a.action === action)) continue;
    const lo = isObject(item) && typeof item.lo === "string" ? item.lo.trim() : "";
    if (!validLos.includes(lo)) { dropped++; continue; }
    if (actions.length < maxItems) actions.push({ lo, action });
  }
  return { actions, dropped };
}

// ---- evidence verification --------------------------------------------------------------------------------------

export type Evidence = {
  seq: number; roleId: string; quote: string; sceneId: string | null; sceneNumber: number; sceneTitle: string; atMs: number; time: string;
  /** Where the quote sits in the normalised utterance (start, end): used to drop overlapping quotes. Not written to the reports. */
  span: [number, number];
  /** The quote contains rating language (a participant may write it into their own line to sway the scorer). A flag only: nothing is capped. */
  ratingLanguage: boolean;
};
/** A quote must have at least this many characters to count at all. */
export const MIN_QUOTE_CHARS = 8;
/** A quote that keeps a score of 3 or 4 must be a real phrase: at least 15 characters and 3 words. */
export const STRONG_QUOTE_CHARS = 15;
export const STRONG_QUOTE_WORDS = 3;
/** A longer quote is cut to this length when stored (the cut is still a verbatim prefix). */
export const MAX_QUOTE_CHARS = 300;
export const MAX_EVIDENCE_PER_CRITERION = 4;
const QUOTE_EDGES = /^[\s"'“”‘’«»`]+|[\s"'“”‘’«»`]+$/g;
const ELLIPSIS_EDGES = /^(?:\.{2,}|…)\s*|\s*(?:\.{2,}|…)$/g;
const RATING_LANGUAGE = /\b(?:scores?|scoring|rate (?:me|us)|rating|assessor|evaluator|marked? (?:me|us))\b|\bignore\b.{0,40}\binstructions?\b|\b(?:give|award)\b.{0,20}\b(?:me|us|everyone|them)\b.{0,12}\b[1-4]\b/i;

export const isStrongQuote = (q: string): boolean => q.length >= STRONG_QUOTE_CHARS && q.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length >= STRONG_QUOTE_WORDS;

/** What a quote looks like after the model's decoration (quote marks, leading or trailing ellipsis) is removed. */
export function cleanQuote(q: string): string {
  let out = normText(q);
  for (let i = 0; i < 3; i++) out = out.replace(QUOTE_EDGES, "").replace(ELLIPSIS_EDGES, "");
  return out.trim();
}

export type Verifier = (raw: unknown) => Evidence | null;

/**
 * The programmatic check at the heart of the evidence rule: a quote is accepted only when `seq` is an utterance by an allowed speaker and
 * the quote (whitespace-normalised, without quote marks or ellipses, at least 8 characters with a letter or digit) is a substring of that
 * recorded utterance. `allow` decides whose lines count: one role for an individual, any player for the group. Verification proves the
 * words exist in the participant's own line, not that they show the behaviour.
 */
export function makeVerifier(t: Transcript, allow: (u: UtteranceRec) => boolean): Verifier {
  return (raw) => {
    if (!isObject(raw)) return null;
    const seqRaw = raw.seq;
    const seq = typeof seqRaw === "number" ? seqRaw : typeof seqRaw === "string" && /^[0-9]{1,9}$/.test(seqRaw.trim()) ? Number(seqRaw) : NaN;
    if (!Number.isSafeInteger(seq)) return null;
    const u = t.utterances.get(seq);
    if (!u || !allow(u)) return null;
    if (typeof raw.quote !== "string" || raw.quote.length > 4_000) return null;
    const q = cleanQuote(raw.quote);
    if (q.length < MIN_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(q)) return null;
    const at = u.norm.indexOf(q);
    if (at === -1) return null;
    const stored = q.length > MAX_QUOTE_CHARS ? q.slice(0, MAX_QUOTE_CHARS) : q;
    return { seq, roleId: u.roleId, quote: stored, sceneId: u.sceneId, sceneNumber: u.sceneNumber, sceneTitle: u.sceneTitle, atMs: u.atMs, time: formatClock(u.atMs), span: [at, at + stored.length], ratingLanguage: RATING_LANGUAGE.test(stored) };
  };
}

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1];

/** Verifies a list of quotes. A quote contained in or overlapping one already accepted from the same line is dropped (counted), so one sentence cannot be sliced into several "quotes". */
export function verifyAll(raw: unknown, verify: Verifier): { verified: Evidence[]; dropped: number } {
  const list = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const verified: Evidence[] = [];
  let dropped = 0;
  for (const item of list) {
    const e = verify(item);
    if (!e || verified.some((v) => v.seq === e.seq && overlaps(v.span, e.span))) { dropped++; continue; }
    if (verified.length < MAX_EVIDENCE_PER_CRITERION) verified.push(e);
  }
  return { verified, dropped };
}

// ---- criteria ---------------------------------------------------------------------------------------------------

export type CriterionResult = {
  id: string; name: string; score: Score | null; label: string; confidence: Confidence | null; rationale: string;
  /** True when the evaluator's answer for this criterion was unusable (omitted, or a score that is not a whole number 1 to 4): not the same as Not observed. */
  invalid: boolean;
  evidence: Evidence[]; droppedQuotes: number; flags: string[];
};

const NOT_OBSERVED_WORDS = new Set(["n/o", "not observed", "not_observed", "null"]);

/** Reads a model's score: a whole number 1 to 4 (also "3"); null or "N/O" for not observed; anything else (0, 5, 2.5, "none", {}) is rejected with a reason. */
export function readScore(v: unknown): { score: Score | null; rejected: string | null } {
  if (v === null) return { score: null, rejected: null };
  if (typeof v === "string" && NOT_OBSERVED_WORDS.has(v.trim().toLowerCase())) return { score: null, rejected: null };
  const n = typeof v === "number" ? v : typeof v === "string" && /^[1-4]$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (isScore(n)) return { score: n, rejected: null };
  const shown = typeof v === "number" || typeof v === "string" ? JSON.stringify(String(v).slice(0, 20)) : v === undefined ? "missing" : typeof v;
  return { score: null, rejected: `score ${shown} is not a whole number from 1 to 4 (use null when there is no evidence either way)` };
}

/**
 * Turns the model's `criteria` array into one result per rubric criterion, in rubric order, and a list of problems for the re-ask.
 * Unknown ids are ignored. An omitted criterion and a score that is not a whole number 1 to 4 (or null) are problems and the criterion
 * is marked invalid (never silently Not observed). Evidence that cannot be verified is dropped. A 3 or 4 needs a verified quote of at least
 * 15 characters and 3 words, otherwise it is capped at 2. Confidence counts DISTINCT lines. `recognised` counts model entries that matched.
 */
export function normaliseCriteria(raw: unknown, rubric: Criterion[], verify: Verifier): { criteria: CriterionResult[]; recognised: number; problems: string[] } {
  const entries = Array.isArray(raw) ? raw.filter(isObject).slice(0, 200) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id && !byId.has(id)) byId.set(id, e);
  }
  let recognised = 0;
  const problems: string[] = [];
  const criteria = rubric.map((c): CriterionResult => {
    const e = byId.get(c.id);
    const base = { id: c.id, name: c.name };
    const invalid = (flag: string): CriterionResult => ({ ...base, score: null, label: INVALID_LABEL, confidence: null, rationale: "", invalid: true, evidence: [], droppedQuotes: 0, flags: [flag] });
    if (!e) { problems.push(`criterion "${c.id}" is missing from "criteria"`); return invalid("not reported by the evaluator"); }
    recognised++;
    const read = readScore(e.score);
    const rationale = cleanProse(e.rationale, 600);
    if (read.rejected) { problems.push(`criterion "${c.id}": ${read.rejected}`); return { ...invalid(`${read.rejected}: the criterion is invalid`), rationale }; }
    const flags: string[] = [];
    if (read.score === null) return { ...base, score: null, label: levelLabel(null), confidence: null, rationale, invalid: false, evidence: [], droppedQuotes: 0, flags };
    const { verified, dropped } = verifyAll(e.evidence, verify);
    const strong = verified.filter((v) => isStrongQuote(v.quote));
    let score: Score = read.score;
    let capped = false;
    if (dropped > 0) flags.push(`${dropped} quote(s) could not be verified against the recording, or overlapped another quote of the same line, and were dropped`);
    if (verified.length === 0) {
      if (score >= 3) { flags.push(`capped from ${score} to 2: no verified quote`); score = 2; capped = true; }
      else flags.push("no verified quote");
    } else if (score >= 3 && strong.length === 0) {
      flags.push(`capped from ${score} to 2: no verified quote of at least ${STRONG_QUOTE_CHARS} characters and ${STRONG_QUOTE_WORDS} words`); score = 2; capped = true;
    } else if (score <= 2 && strong.length === 0) flags.push("only short quotes (they can support a 1 or 2 only)");
    if (verified.some((v) => v.ratingLanguage)) flags.push("a quote contains rating language: read it with care");
    if (!rationale) flags.push("no rationale given");
    const counted = score >= 3 ? strong : verified;
    const distinct = new Set(counted.map((v) => v.seq)).size;
    return { ...base, score, label: levelLabel(score), confidence: deriveConfidence(distinct, parseConfidence(e.confidence), capped || verified.length === 0), rationale, invalid: false, evidence: verified, droppedQuotes: dropped, flags };
  });
  return { criteria, recognised, problems };
}
