import type { SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import { fallbackReason, isFallbackReply } from "./provenance.js";
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
// Defence in depth for text the runner cannot know in advance: an authorization header, a provider key shape or any long opaque token.
const TOKENISH = [/\bBearer\s+\S+/gi, /\b(?:sk|pk|rk|xai|gsk|AIza)[-_][A-Za-z0-9_-]{12,}/g, /\b[A-Za-z0-9_-]{32,}\b/g];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * An alert message made safe to print or store: control characters removed, every known secret (keys, tokens, join codes) and every
 * hidden-fact text replaced, key-shaped strings replaced, home and temp paths shortened, then clipped.
 */
export function sanitizeAlert(message: string, o: { secrets: readonly string[]; hidden: readonly string[] }): string {
  let out = message;
  for (const h of o.hidden) if (h.length >= 4) out = out.split(h).join(REDACTED);
  out = scrubText(out, [...o.secrets]);
  for (const re of TOKENISH) out = out.replace(re, REDACTED);
  return clip(out, ALERT_CHARS);
}

const ROLE_OF = [/^NPC ([^:\s]+):/, /^character (\S+) /];
const roleOf = (message: string): string | null => {
  for (const re of ROLE_OF) { const m = re.exec(message); if (m) return m[1]!; }
  return null;
};

/** One alert, sanitized, with the reply it belongs to (the same character's next reply after the alert). */
function describeAlert(e: Extract<SessionEvent, { type: "facilitator.alert" }>, events: SessionEvent[], o: { secrets: readonly string[]; hidden: readonly string[] }): AlertEvidence {
  const role = roleOf(e.message);
  const why = fallbackReason(e.message);
  const bare = e.message.replace(/^(?:NPC |GM: |character )?[^:]*: /, "");
  const next = role === null ? undefined : events.find((x) => x.seq > e.seq && x.type === "utterance" && x.roleId === role);
  return {
    seq: e.seq, level: e.level, role, fallback: why !== null,
    reason: sanitizeAlert(why ?? (/^[^:]+: /.test(e.message) ? bare : e.message), o),
    replySeq: next?.seq ?? null,
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
    } else if (e.type === "facilitator.alert") alerts.push(describeAlert(e, events, { secrets: o.secrets, hidden }));
    prev = e;
  }
  const byCharacter = npcs.map((r) => ({ roleId: r.id, name: r.name, replies: stats.get(r.id)!.replies, fallbackReplies: stats.get(r.id)!.fallback }));
  const npcReplies = byCharacter.reduce((a, c) => a + c.replies, 0);
  const fallbackReplies = byCharacter.reduce((a, c) => a + c.fallbackReplies, 0);
  const warnings = fallbackReplies > 0 && o.maxFallbacks === null
    ? [`${fallbackReplies} of ${npcReplies} AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)`] : [];
  return { npcReplies, fallbackReplies, maxFallbacks: o.maxFallbacks, byCharacter, alerts, warnings };
}

/** The alert (sanitized) that explains one reply, for narration next to it: the alert about the same character just before it. */
export function alertsForReply(events: SessionEvent[], reply: { seq: number; roleId: string }, o: { secrets: readonly string[]; hidden: readonly string[] }): AlertEvidence[] {
  const out: AlertEvidence[] = [];
  for (const e of events) {
    if (e.type !== "facilitator.alert" || e.seq >= reply.seq) continue;
    const a = describeAlert(e, events, o);
    if (a.replySeq === reply.seq) out.push(a);
  }
  return out;
}

/** One line for the narration and for check F-08: "4 AI replies, 1 canned fallback line". */
export function countText(ev: Pick<LiveEvidence, "npcReplies" | "fallbackReplies">): string {
  return `${ev.fallbackReplies} canned fallback line${ev.fallbackReplies === 1 ? "" : "s"} of ${ev.npcReplies} AI replies`;
}
