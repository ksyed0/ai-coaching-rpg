import type { SessionEvent } from "@acr/events";
import type { ServerMessage } from "../host/protocol.js";

/** Longest server-supplied string we will display (R26). */
export const MAX_DISPLAY_CHARS = 4_000;
const TRUNCATED = "…[truncated]";

// Written with double-escaped \\u sequences so no invisible character ever lives in this source file.
const NEWLINE = new RegExp("\\r\\n|\\n|\\u2028|\\u2029", "g");
// Bidi embedding/override/isolate, zero-width and directional marks, BOM: removed outright.
const INVISIBLE = new RegExp("[\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\ufeff]", "g");
// Remaining C0 (incl. ESC, NUL, bare CR), DEL and C1 (incl. 8-bit CSI/OSC introducers): visibly replaced.
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");

/**
 * R26: makes text written by other participants / NPCs / the GM safe to print on a terminal. It can never contain an
 * escape sequence, a control character, a bidi override or an embedded line break (newlines become a visible marker
 * so nobody can forge a fresh "[role]:" line). Output is capped at MAX_DISPLAY_CHARS. Pure; apply BEFORE any styling.
 */
export function sanitizeText(s: string): string {
  const raw = typeof s === "string" ? s : s === undefined || s === null ? "" : String(s);
  // Cap first so a huge payload costs O(cap); the multiplier leaves room for characters that are stripped.
  const clipped = raw.length > MAX_DISPLAY_CHARS * 2 ? raw.slice(0, MAX_DISPLAY_CHARS * 2) : raw;
  let out = clipped
    .replace(NEWLINE, " ⏎ ")
    .replace(INVISIBLE, "")
    .replace(/\t/g, " ")
    .replace(CONTROL, "·");
  if (raw.length > clipped.length || out.length > MAX_DISPLAY_CHARS) out = out.slice(0, MAX_DISPLAY_CHARS) + TRUNCATED;
  return out;
}

const s = sanitizeText;

/** Most history lines shown when joining (or rejoining). */
export const MAX_HISTORY_LINES = 50;

/** One printable line for an event, or null when this viewer should see nothing. Unknown event types render nothing. */
export function renderEvent(e: SessionEvent, me: string): string | null {
  const isFacilitator = me === "facilitator";
  switch (e.type) {
    case "utterance": return `${e.roleId === me ? "you" : s(e.roleId)}: ${s(e.text)}`;
    case "scene.entered": return `--- scene ${s(e.sceneId)} ---`;
    case "scene.exited": return `--- scene ${s(e.sceneId)} ended (${s(e.reason)}) ---`;
    case "inject.fired": return `[inject] ${s(e.content)}`;
    case "gm.decision": return isFacilitator ? `[gm] ${s(e.condition)} => ${s(String(e.verdict))} (${s(e.reasoning)})` : null;
    case "gm.no_verdict": return isFacilitator ? `[gm] no verdict for ${JSON.stringify(s(e.condition))} (${s(e.reason)}${e.attempts > 1 ? " after re-ask" : ""})` : null;
    case "facilitator.alert": return isFacilitator ? `[alert] ${s(e.message)}` : null;
    // US-0034: by role and number only (the event carries no fact text). A suggestion is the facilitator's alert; an auto-release says who released it.
    case "gm.fact_earned":
      if (!isFacilitator) return null;
      return e.autoRelease
        ? `[gm] the Game Master released hidden fact #${s(String(e.fact))} of ${s(e.roleId)} itself (GM_AUTO_RELEASE is on): ${s(e.reasoning)}`
        : `[alert] Game Master suggests releasing hidden fact #${s(String(e.fact))} of ${s(e.roleId)} (${s(e.reasoning)}): type /release ${s(e.roleId)} ${s(String(e.fact))} to release it`;
    case "facilitator.command":
      // A release names the role and the fact NUMBER only: the event carries no fact text (it goes in the facilitator-only npc.updated).
      if (e.command === "release_hidden") return isFacilitator ? `[facilitator] released hidden fact #${s(String(e.fact))} of ${s(e.roleId)}` : null;
      return e.command === "whisper" ? `[whisper] ${s(e.text)}` : `[facilitator] ${s(e.command)}`;
    case "session.started": return `session started: ${s(e.scenarioId)} v${s(e.version)}`;
    case "session.ended": return `=== session ended (${s(e.reason)}) ===`;
    case "session.resumed": return isFacilitator ? "=== session paused (server restarted): /resume to continue ===" : "=== session paused (server restarted); the facilitator will resume it ===";
    case "npc.updated": return isFacilitator ? `[npc ${s(e.roleId)}] goals: ${(e.goals ?? []).map(s).join("; ")}` : null;
    default: return null;
  }
}

/** Most roles and facts per role the client will list: a hostile or broken server cannot make it print without bound. */
const MAX_LISTED_ROLES = 100;
const MAX_LISTED_FACTS = 50;
/** Most facts (all roles together) and most characters of one fact the client keeps and lists; 1000 is the scenario limit for a fact. */
export const MAX_LISTED_TOTAL = 200;
export const MAX_LISTED_FACT_CHARS = 1_000;

/** The hidden facts a `joined` message carries, validated: role id -> up to 50 strings (anything else is dropped). Facilitator connections only. */
export function parseHiddenFacts(v: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  let total = 0;
  for (const [role, facts] of Object.entries(v as Record<string, unknown>).slice(0, MAX_LISTED_ROLES)) {
    if (!Array.isArray(facts) || total >= MAX_LISTED_TOTAL) continue;
    const kept = facts.filter((f): f is string => typeof f === "string").slice(0, Math.min(MAX_LISTED_FACTS, MAX_LISTED_TOTAL - total)).map((f) => f.slice(0, MAX_LISTED_FACT_CHARS));
    total += kept.length;
    out.set(role, kept);
  }
  return out;
}

/**
 * The facilitator's `/hidden` listing: `cfo #1 [released] text`, numbered as `/release <role> <n>` expects. A fact the Game Master judged earned but
 * that is not released yet is marked `[suggested by the Game Master]` (US-0034). Text goes through sanitizeText.
 */
export function renderHidden(facts: Map<string, string[]>, released: Map<string, string[]>, suggested: Map<string, number[]> = new Map()): string[] {
  const lines: string[] = [];
  for (const [role, list] of facts) {
    const done = released.get(role) ?? [];
    const hint = suggested.get(role) ?? [];
    list.forEach((text, i) => lines.push(`${s(role)} #${i + 1}${done.includes(text) ? " [released]" : hint.includes(i + 1) ? " [suggested by the Game Master]" : ""} ${s(text)}`));
  }
  if (lines.length >= MAX_LISTED_TOTAL) lines.push(`(only the first ${MAX_LISTED_TOTAL} hidden facts are listed)`);
  return lines.length ? lines : ["no AI character has hidden facts"];
}

/** US-0034: the facts the Game Master judged earned, from a facilitator's `joined` snapshot (`state.factsEarned`), validated: role id -> whole numbers 1..50. */
export function parseFactsEarned(v: unknown): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
  for (const [role, list] of Object.entries(v as Record<string, unknown>).slice(0, MAX_LISTED_ROLES)) {
    if (Array.isArray(list)) out.set(role, list.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= MAX_LISTED_FACTS).slice(0, MAX_LISTED_FACTS));
  }
  return out;
}

/** For the facilitator: a line for each fact an `npc.updated` newly released (not in `known`), with its number when the fact list is known. */
export function renderNewReleases(e: Extract<SessionEvent, { type: "npc.updated" }>, facts: Map<string, string[]>, known: Map<string, string[]>): string[] {
  const before = known.get(e.roleId) ?? [];
  const list = facts.get(e.roleId) ?? [];
  return (Array.isArray(e.released) ? e.released : []).filter((t) => typeof t === "string" && !before.includes(t)).map((t) => {
    const n = list.indexOf(t) + 1;
    return `[npc ${s(e.roleId)}] released${n > 0 ? ` #${n}` : ""}: ${s(t)}`;
  });
}

export function renderJoined(m: Extract<ServerMessage, { type: "joined" }>): string[] {
  const lines = [`joined as ${s(m.roleId)}`]; // never the reconnect token
  if (m.notice) lines.push(`warning: ${s(m.notice)}`);
  if (m.roleId === "facilitator") {
    const held = [...parseHiddenFacts(m.hiddenFacts)].filter(([, f]) => f.length > 0);
    if (held.length) lines.push(`hidden facts: ${held.map(([r, f]) => `${s(r)} ${f.length}`).join(", ")} (/hidden lists them, /release <role> <n> releases one)`);
  }
  if (m.brief) {
    lines.push("", `Your brief: ${s(m.brief)}`);
    for (const f of m.privateFacts ?? []) lines.push(`  - ${s(f)}`);
    lines.push("");
  }
  // The server already filtered the transcript to what this viewer may see; it still goes through sanitizeText (R26).
  const transcript = m.state?.transcript ?? [];
  if (transcript.length > 0) {
    const shown = transcript.slice(-MAX_HISTORY_LINES);
    lines.push("--- history ---");
    if (transcript.length > shown.length) lines.push(`(+${transcript.length - shown.length} earlier lines)`);
    for (const u of shown) lines.push(`${u.roleId === m.roleId ? "you" : s(u.roleId)}: ${s(u.text)}`);
  }
  return lines;
}

export function renderError(code: string, message: string): string {
  if (code === "not_started") return "waiting for the facilitator to /start the session before anyone can speak";
  if (code === "unauthorized") return "error: unauthorized: this server needs the facilitator token (set FACILITATOR_TOKEN, use --token-file <path>, or type it at the prompt)";
  if (code === "rate_limited") return "slow down: too many messages, some were dropped";
  if (code === "log_failed") return "the server can no longer record this session and is stopping; when it is back, rejoin: the session resumes, paused, from its log";
  return `error: ${s(code)}: ${s(message)}`;
}
