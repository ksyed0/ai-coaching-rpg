import type { Criterion } from "@acr/script";
import { deriveConfidence, isScore, levelLabel, parseConfidence, type Confidence, type Score } from "./aggregate.js";
import { formatClock, normText, type Transcript, type UtteranceRec } from "./transcript.js";

// ---- tolerant JSON ----------------------------------------------------------------------------------------------

export type JsonParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

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
  return { ok: false, error: text.includes("{") ? "no complete, valid JSON object was found in the reply" : "the reply held no JSON object" };
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
/** Next actions as {lo, action}; an item without a known LO id is tied to `fallbackLo`. */
export function cleanActions(v: unknown, validLos: string[], fallbackLo: string, maxItems = 3): Action[] {
  if (!Array.isArray(v)) return [];
  const out: Action[] = [];
  for (const item of v) {
    const action = cleanProse(isObject(item) ? (item.action ?? item.text ?? item.description) : item, 400);
    if (!action || out.some((a) => a.action === action)) continue;
    const loRaw = isObject(item) && typeof item.lo === "string" ? item.lo.trim() : "";
    out.push({ lo: validLos.includes(loRaw) ? loRaw : fallbackLo, action });
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---- evidence verification --------------------------------------------------------------------------------------

export type Evidence = { seq: number; roleId: string; quote: string; sceneId: string | null; sceneNumber: number; sceneTitle: string; atMs: number; time: string };
export const MIN_QUOTE_CHARS = 8;
export const MAX_QUOTE_CHARS = 300;
export const MAX_EVIDENCE_PER_CRITERION = 4;
const QUOTE_EDGES = /^[\s"'“”‘’«»`]+|[\s"'“”‘’«»`]+$/g;
const ELLIPSIS_EDGES = /^(?:\.{2,}|…)\s*|\s*(?:\.{2,}|…)$/g;

/** What a quote looks like after the model's decoration (quote marks, leading or trailing ellipsis) is removed. */
export function cleanQuote(q: string): string {
  let out = normText(q);
  for (let i = 0; i < 3; i++) out = out.replace(QUOTE_EDGES, "").replace(ELLIPSIS_EDGES, "");
  return out.trim();
}

export type Verifier = (raw: unknown) => Evidence | null;

/**
 * The programmatic check at the heart of the evidence rule: a quote is accepted only when `seq` is an utterance by an allowed speaker and
 * the quote (whitespace-normalised, without quote marks or ellipses) is a substring of that recorded utterance. `allow` decides whose
 * lines count: one role for an individual, any player for the group.
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
    if (!u.norm.includes(q)) return null;
    return { seq, roleId: u.roleId, quote: q.length > MAX_QUOTE_CHARS ? q.slice(0, MAX_QUOTE_CHARS) : q, sceneId: u.sceneId, sceneNumber: u.sceneNumber, sceneTitle: u.sceneTitle, atMs: u.atMs, time: formatClock(u.atMs) };
  };
}

export function verifyAll(raw: unknown, verify: Verifier): { verified: Evidence[]; dropped: number } {
  const list = Array.isArray(raw) ? raw.slice(0, 12) : [];
  const verified: Evidence[] = [];
  let dropped = 0;
  for (const item of list) {
    const e = verify(item);
    if (!e) { dropped++; continue; }
    if (verified.some((v) => v.seq === e.seq && v.quote === e.quote)) continue;
    if (verified.length < MAX_EVIDENCE_PER_CRITERION) verified.push(e);
  }
  return { verified, dropped };
}

// ---- criteria ---------------------------------------------------------------------------------------------------

export type CriterionResult = {
  id: string; name: string; score: Score | null; label: string; confidence: Confidence | null; rationale: string;
  evidence: Evidence[]; droppedQuotes: number; flags: string[];
};

const NOT_OBSERVED_WORDS = new Set(["n/o", "no", "not observed", "not_observed", "none", "null", "n/a", "na"]);

/** Reads a model's score: a whole number 1 to 4 (also "3"); null or "N/O" for not observed; anything else is rejected with a reason. */
export function readScore(v: unknown): { score: Score | null; rejected: string | null } {
  if (v === null || v === undefined) return { score: null, rejected: null };
  if (typeof v === "string" && NOT_OBSERVED_WORDS.has(v.trim().toLowerCase())) return { score: null, rejected: null };
  const n = typeof v === "number" ? v : typeof v === "string" && /^[1-4]$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (isScore(n)) return { score: n, rejected: null };
  const shown = typeof v === "number" || typeof v === "string" ? JSON.stringify(String(v).slice(0, 20)) : typeof v;
  return { score: null, rejected: `score ${shown} is not a whole number from 1 to 4` };
}

/**
 * Turns the model's `criteria` array into one result per rubric criterion, in rubric order. Unknown ids are ignored, missing ones are Not
 * observed, scores that are not whole numbers 1 to 4 are rejected, evidence that cannot be verified is dropped, and a 3 or 4 left with no
 * verified quote is capped at 2. `recognised` counts the model entries that matched a rubric criterion.
 */
export function normaliseCriteria(raw: unknown, rubric: Criterion[], verify: Verifier): { criteria: CriterionResult[]; recognised: number } {
  const entries = Array.isArray(raw) ? raw.filter(isObject).slice(0, 200) : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of entries) {
    const id = typeof e.id === "string" ? e.id.trim() : "";
    if (id && !byId.has(id)) byId.set(id, e);
  }
  let recognised = 0;
  const criteria = rubric.map((c): CriterionResult => {
    const e = byId.get(c.id);
    const base = { id: c.id, name: c.name };
    if (!e) return { ...base, score: null, label: levelLabel(null), confidence: null, rationale: "", evidence: [], droppedQuotes: 0, flags: ["not reported by the evaluator"] };
    recognised++;
    const flags: string[] = [];
    const read = readScore(e.score);
    if (read.rejected) flags.push(`${read.rejected}: treated as Not observed`);
    const rationale = cleanProse(e.rationale, 600);
    if (read.score === null) {
      return { ...base, score: null, label: levelLabel(null), confidence: null, rationale, evidence: [], droppedQuotes: 0, flags };
    }
    const { verified, dropped } = verifyAll(e.evidence, verify);
    let score: Score = read.score;
    let capped = false;
    if (dropped > 0) flags.push(`${dropped} quote(s) could not be verified against the recording and were dropped`);
    if (verified.length === 0) {
      if (score >= 3) { flags.push(`capped from ${score} to 2: no verified quote`); score = 2; capped = true; }
      else flags.push("no verified quote");
    }
    if (!rationale) flags.push("no rationale given");
    return { ...base, score, label: levelLabel(score), confidence: deriveConfidence(verified.length, parseConfidence(e.confidence), capped || verified.length === 0), rationale, evidence: verified, droppedQuotes: dropped, flags };
  });
  return { criteria, recognised };
}
