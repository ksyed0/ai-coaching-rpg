import type { SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import { fallbackReason, isFallbackReply } from "./provenance.js";
import { normalizeJoinCode } from "../engine/join-codes.js";
import { scrubText } from "./report.js";

/**
 * US-0023: what a run of the 29-check main story can say about the AI characters' replies and the facilitator alerts, read from the
 * facilitator's complete event stream. Shown in the narration, in check F-08's evidence and in the JSON report (`liveEvidence`).
 */
export type AlertEvidence = {
  seq: number;
  level: "info" | "warning";
  /** The AI character the alert is about, when its text names one. */
  role: string | null;
  /** True when the alert says the character spoke its canned fallback line. */
  fallback: boolean;
  /** Why (sanitized and clipped): the failure inside a fallback alert, otherwise the alert text without its prefix. */
  reason: string;
  /** The seq of the AI character's reply the alert belongs to (the next reply of that character), or null. */
  replySeq: number | null;
};
export type CharacterEvidence = { roleId: string; name: string; replies: number; fallbackReplies: number };
export type LiveEvidence = {
  npcReplies: number;
  fallbackReplies: number;
  /** The --max-fallbacks limit; null when none was given (the count is then only a warning). */
  maxFallbacks: number | null;
  byCharacter: CharacterEvidence[];
  alerts: AlertEvidence[];
  /** Problems that do not fail the run: fallback lines without a --max-fallbacks limit. */
  warnings: string[];
};

export const ALERT_CHARS = 300;
const REDACTED = "[redacted]";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Characters that never count when comparing text with a hidden fact: invisible and formatting characters, bidi overrides, soft hyphen, combining marks.
const IGNORED = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\p{M}]/u;
type Folded = { s: string; from: number[]; to: number[] };
/** NFKC, lower case and no ignorable characters, with, for every kept character, where it came from in `text` (so a match can be mapped back). */
function fold(text: string): Folded {
  const f: Folded = { s: "", from: [], to: [] };
  let i = 0;
  for (const ch of text) {
    for (const c of ch.normalize("NFKC").toLowerCase()) {
      if (IGNORED.test(c)) continue;
      for (let k = 0; k < c.length; k++) { f.s += c[k]; f.from.push(i); f.to.push(i + ch.length); }
    }
    i += ch.length;
  }
  return f;
}
/** Every hidden text (and a cut-off start of one at the very end of the text) replaced, whatever invisible characters, case or width forms hide it. */
function redactHidden(text: string, hidden: readonly string[]): string {
  const f = fold(text);
  const ranges: [number, number][] = [];
  for (const h of hidden) {
    const hf = fold(h).s;
    if (hf.length < 4) continue;
    for (let at = f.s.indexOf(hf); at >= 0; at = f.s.indexOf(hf, at + 1)) ranges.push([f.from[at]!, f.to[at + hf.length - 1]!]);
    for (let k = Math.min(hf.length - 1, f.s.length); k >= 8; k--) if (f.s.endsWith(hf.slice(0, k))) { ranges.push([f.from[f.s.length - k]!, text.length]); break; }
  }
  if (ranges.length === 0) return text;
  ranges.sort((x, y) => x[0] - y[0]);
  let out = ""; let pos = 0;
  for (const [start, end] of ranges) {
    if (end <= pos) continue;
    out += text.slice(pos, Math.max(start, pos)) + REDACTED;
    pos = end;
  }
  return out + text.slice(pos);
}

const CODE_SYMBOL = (ch: string): string => (ch === "0" ? "[0oO]" : ch === "1" ? "[1iIlL]" : `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
/** Every spelling the server accepts for a join code: any case, spaces, hyphens or line breaks between symbols, O for 0 and I or L for 1. */
function joinCodePatterns(secrets: readonly string[]): RegExp[] {
  const seen = new Set<string>();
  const out: RegExp[] = [];
  for (const secret of secrets) {
    const norm = normalizeJoinCode(secret);
    if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(new RegExp([...norm].map(CODE_SYMBOL).join("[\\s\\-⏎]*"), "g"));
  }
  return out;
}

const OPAQUE = /[A-Za-z0-9+/_=-]{20,}/g;
const looksOpaque = (m: string): boolean => {
  if (m.length >= 32) return true;
  if (!/\d/.test(m) || !/[A-Za-z]/.test(m)) return false;
  return (/[a-z]/.test(m) && /[A-Z]/.test(m)) || /[+/=]/.test(m) || /^[0-9a-f]+$/i.test(m);
};

/**
 * An alert message made safe to print or store. Control characters are replaced (line breaks by a visible marker) first; then every known
 * secret is replaced (keys and tokens exactly, join codes in every spelling the server accepts), then an authorization header, key shapes
 * and long opaque tokens, then every hidden-fact text (compared without case, width forms or invisible characters), and home and temp
 * paths are shortened; the result is clipped.
 */
export function sanitizeAlert(message: string, o: { secrets: readonly string[]; hidden: readonly string[] }): string {
  let out = scrubText(message, [...o.secrets]);
  out = out.replace(/\bBearer(?:[\s⏎]|\\[nrt])+[^\s⏎"']+/gi, REDACTED);
  for (const re of joinCodePatterns(o.secrets)) out = out.replace(re, REDACTED);
  out = out.replace(/\b(?:sk|pk|rk|xai|gsk|AIza)[-_][A-Za-z0-9_-]{12,}/g, REDACTED);
  out = out.replace(OPAQUE, (m) => (looksOpaque(m) ? REDACTED : m));
  out = redactHidden(out, o.hidden);
  return clip(out, ALERT_CHARS);
}

const ROLE_OF = [/^NPC ([^:\s]+):/, /^character (\S+) /];
const roleOf = (message: string): string | null => {
  for (const re of ROLE_OF) { const m = re.exec(message); if (m) return m[1]!; }
  return null;
};

type Ctx = { secrets: readonly string[]; hidden: readonly string[]; npcs: readonly NpcRole[]; legacy: boolean };

/**
 * The reply an alert belongs to. A fallback alert belongs to the same character's next utterance in the same scene, and only when that
 * utterance IS the fallback line. Any other alert belongs to the character's next utterance in the same scene with no player line in
 * between. Otherwise null: the alert is an orphan (for instance the reply was refused because its scene had ended).
 */
function replyFor(alert: Extract<SessionEvent, { type: "facilitator.alert" }>, role: string | null, fallback: boolean, events: SessionEvent[], o: Ctx): number | null {
  const npc = role === null ? undefined : o.npcs.find((r) => r.id === role);
  if (!npc) return null;
  const start = events.findIndex((x) => x.seq === alert.seq);
  for (let i = start + 1; i < events.length; i++) {
    const x = events[i]!;
    if (x.type === "scene.entered" || x.type === "scene.exited" || x.type === "session.ended") return null;
    if (x.type !== "utterance") continue;
    if (x.roleId === npc.id) return fallback ? (isFallbackReply(npc, x, events[i - 1], { legacy: o.legacy }) ? x.seq : null) : x.seq;
    if (!fallback && o.npcs.every((r) => r.id !== x.roleId)) return null;
  }
  return null;
}

/** One alert, sanitized, with the reply it belongs to. */
function describeAlert(e: Extract<SessionEvent, { type: "facilitator.alert" }>, events: SessionEvent[], o: Ctx): AlertEvidence {
  const role = roleOf(e.message);
  const why = fallbackReason(e.message);
  const bare = e.message.replace(/^(?:NPC |GM: |character )?[^:]*: /, "");
  return {
    seq: e.seq, level: e.level, role, fallback: why !== null,
    reason: sanitizeAlert(why ?? (/^[^:]+: /.test(e.message) ? bare : e.message), o),
    replySeq: replyFor(e, role, why !== null, events, o),
  };
}

/** Counts the AI characters' replies and fallback lines and collects the alerts, from the facilitator's complete stream. */
export function collectLiveEvidence(events: SessionEvent[], scenario: Scenario, o: { maxFallbacks: number | null; secrets: readonly string[]; /** Hidden-fact texts to keep out of alert text (default: the AI characters' hidden facts; the runner also passes its distinctive fragments). */ hidden?: readonly string[]; legacy?: boolean }): LiveEvidence {
  const npcs = Object.values(scenario.roles).filter((r): r is NpcRole => r.type === "npc");
  const stats = new Map(npcs.map((r) => [r.id, { replies: 0, fallback: 0 }]));
  const hidden = [...npcs.flatMap((r) => r.hidden), ...(o.hidden ?? [])];
  const alerts: AlertEvidence[] = [];
  let prev: SessionEvent | undefined;
  for (const e of events) {
    if (e.type === "utterance") {
      const npc = npcs.find((r) => r.id === e.roleId);
      const s = npc ? stats.get(npc.id) : undefined;
      if (npc && s) { s.replies++; if (isFallbackReply(npc, e, prev, { legacy: o.legacy === true })) s.fallback++; }
    } else if (e.type === "facilitator.alert") alerts.push(describeAlert(e, events, { secrets: o.secrets, hidden, npcs, legacy: o.legacy === true }));
    prev = e;
  }
  const byCharacter = npcs.map((r) => ({ roleId: r.id, name: r.name, replies: stats.get(r.id)!.replies, fallbackReplies: stats.get(r.id)!.fallback }));
  const npcReplies = byCharacter.reduce((a, c) => a + c.replies, 0);
  const fallbackReplies = byCharacter.reduce((a, c) => a + c.fallbackReplies, 0);
  const warnings = fallbackReplies > 0 && o.maxFallbacks === null
    ? [`${fallbackReplies} of ${npcReplies} AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)`] : [];
  return { npcReplies, fallbackReplies, maxFallbacks: o.maxFallbacks, byCharacter, alerts, warnings };
}

/** The alerts (sanitized) that belong to one reply, for narration next to it (see `replyFor` for what belongs). */
export function alertsForReply(events: SessionEvent[], reply: { seq: number; roleId: string }, o: { secrets: readonly string[]; hidden: readonly string[]; scenario: Scenario; legacy?: boolean }): AlertEvidence[] {
  const npcs = Object.values(o.scenario.roles).filter((r): r is NpcRole => r.type === "npc");
  const ctx: Ctx = { secrets: o.secrets, hidden: [...o.hidden, ...npcs.flatMap((r) => r.hidden)], npcs, legacy: o.legacy === true };
  const out: AlertEvidence[] = [];
  for (const e of events) {
    if (e.type !== "facilitator.alert" || e.seq >= reply.seq) continue;
    const a = describeAlert(e, events, ctx);
    if (a.replySeq === reply.seq) out.push(a);
  }
  return out;
}

/** One line for the narration and for check F-08: "4 AI replies, 1 canned fallback line". */
export function countText(ev: Pick<LiveEvidence, "npcReplies" | "fallbackReplies">): string {
  return `${ev.fallbackReplies} canned fallback line${ev.fallbackReplies === 1 ? "" : "s"} of ${ev.npcReplies} AI replies`;
}
