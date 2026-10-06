import type { SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";

/**
 * Collapses every kind of whitespace and control character to one space and drops invisible and bidi controls. Used for BOTH the text
 * the model sees and the text a quote is checked against, so a quote copied from the prompt always matches the recorded line.
 */
const INVISIBLE = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "g");
const SPACES = new RegExp("[\\u0000-\\u0020\\u007f-\\u00a0\\u2028\\u2029]+", "g");

export function normText(s: string): string {
  return String(s ?? "").replace(INVISIBLE, "").replace(SPACES, " ").trim();
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)}`;
}

export type UtteranceRec = {
  seq: number; roleId: string; speaker: "player" | "npc"; /** The AI character's display name (npc only). */ name?: string;
  /** The recorded text, untouched. */ text: string; /** normText(text): what the model saw and what quotes are verified against. */ norm: string;
  atMs: number; sceneId: string | null; /** 1-based scene number in order of entry; 0 outside any scene. */ sceneNumber: number; sceneTitle: string;
};

export type Entry =
  | { kind: "scene_start"; seq: number; sceneId: string; number: number; title: string; goal: string; participants: string[] }
  | { kind: "scene_end"; seq: number; sceneId: string; number: number; reason: string }
  | { kind: "inject"; seq: number; to: string[]; content: string }
  | { kind: "gm"; seq: number; condition: string; verdict: boolean; reasoning: string }
  | ({ kind: "utterance" } & UtteranceRec);

export type Transcript = {
  entries: Entry[];
  utterances: Map<number, UtteranceRec>;
  /** Utterance count by role id. */
  counts: Record<string, number>;
  /** The scene order: id and title. */
  scenes: { id: string; title: string }[];
  startedTs: number;
  sessionId: string;
  scenarioId: string | null;
  /** True when the log ends with session.ended. */
  complete: boolean;
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Builds the full, ordered transcript of a session from its events. Pure. Players, AI characters, injects, scene boundaries and Game Master verdicts. */
export function buildTranscript(events: SessionEvent[], scenario: Scenario): Transcript {
  const entries: Entry[] = [];
  const utterances = new Map<number, UtteranceRec>();
  const counts: Record<string, number> = {};
  const scenes: { id: string; title: string }[] = [];
  const titleOf = (id: string) => scenario.script.scenes.find((s) => s.id === id)?.title ?? id;
  let current: { id: string; number: number } | null = null;
  const startedTs = events[0]?.ts ?? 0;
  let complete = false;
  for (const e of events) {
    switch (e.type) {
      case "scene.entered": {
        const number = scenes.length + 1;
        scenes.push({ id: e.sceneId, title: titleOf(e.sceneId) });
        current = { id: e.sceneId, number };
        const sc = scenario.script.scenes.find((s) => s.id === e.sceneId);
        entries.push({ kind: "scene_start", seq: e.seq, sceneId: e.sceneId, number, title: titleOf(e.sceneId), goal: normText(sc?.goal ?? ""), participants: e.participants });
        break;
      }
      case "scene.exited":
        entries.push({ kind: "scene_end", seq: e.seq, sceneId: e.sceneId, number: current?.number ?? 0, reason: e.reason });
        current = null;
        break;
      case "utterance": {
        const role = scenario.roles[e.roleId];
        const rec: UtteranceRec = {
          seq: e.seq, roleId: e.roleId, speaker: role?.type === "npc" ? "npc" : "player", name: role?.type === "npc" ? role.name : undefined,
          text: e.text, norm: normText(e.text), atMs: e.ts - startedTs, sceneId: current?.id ?? null, sceneNumber: current?.number ?? 0,
          sceneTitle: current ? titleOf(current.id) : "",
        };
        utterances.set(e.seq, rec);
        counts[e.roleId] = (counts[e.roleId] ?? 0) + 1;
        entries.push({ kind: "utterance", ...rec });
        break;
      }
      case "inject.fired": entries.push({ kind: "inject", seq: e.seq, to: e.to, content: normText(e.content) }); break;
      case "gm.decision": entries.push({ kind: "gm", seq: e.seq, condition: normText(e.condition), verdict: e.verdict, reasoning: clip(normText(e.reasoning), 300) }); break;
      case "session.ended": complete = true; break;
      default: break;
    }
  }
  const first = events[0];
  return { entries, utterances, counts, scenes, startedTs, sessionId: first?.sessionId ?? "", scenarioId: first && first.type === "session.started" ? first.scenarioId : null, complete };
}

export type TrimInfo = { budgetChars: number; fullChars: number; keptChars: number; omittedLines: number; shortenedLines: number };
const MIN_CAP = 60;
const MAX_CAP = 2_000;

function speakerLabel(u: UtteranceRec): string {
  return u.speaker === "npc" ? `${u.roleId} (AI character ${normText(u.name ?? "")})` : `${u.roleId} (player)`;
}
function speechHeader(u: UtteranceRec): string { return `#${u.seq} ${formatClock(u.atMs)} ${speakerLabel(u)}: `; }

function structuralLine(e: Exclude<Entry, { kind: "utterance" }>, verdictOnly = false): string {
  switch (e.kind) {
    case "scene_start": return `--- Scene ${e.number} begins: "${e.title}". Goal: ${e.goal}. In the room: ${e.participants.join(", ")} ---`;
    case "scene_end": return `--- Scene ${e.number} ends (${e.reason}) ---`;
    case "inject": return `[Inject #${e.seq} to ${e.to.join(", ")}: ${clip(e.content, 600)}]`;
    case "gm": return `[Game Master #${e.seq}: condition "${clip(e.condition, 200)}" judged ${e.verdict ? "TRUE" : "FALSE"}${verdictOnly ? "" : `: ${e.reasoning}`}]`;
  }
}

function speechLine(u: UtteranceRec, cap: number): string {
  const body = u.norm.length > cap ? `${u.norm.slice(0, cap)} […]` : u.norm;
  return `${speechHeader(u)}${body}`;
}

/**
 * The transcript as text for the model, within `budgetChars`. When it does not fit: Game Master reasoning is shortened to the verdict, then
 * every speaker keeps a share of the budget in proportion to how much they said (long lines are cut short, and if that is not enough
 * lines are thinned evenly, always keeping the first and the last), while injects and scene boundaries stay. Returns what was trimmed.
 */
export function renderTranscript(t: Transcript, budgetChars: number): { text: string; trimmed: TrimInfo | null } {
  const lines = (entries: Entry[], fn: (e: Entry) => string | null): string[] => entries.map(fn).filter((x): x is string => x !== null);
  const full = lines(t.entries, (e) => (e.kind === "utterance" ? speechLine(e, Number.MAX_SAFE_INTEGER) : structuralLine(e)));
  const fullChars = full.reduce((a, l) => a + l.length + 1, 0);
  if (fullChars <= budgetChars) return { text: full.join("\n"), trimmed: null };

  const structural = t.entries.filter((e): e is Exclude<Entry, { kind: "utterance" }> => e.kind !== "utterance");
  const structuralChars = structural.reduce((a, e) => a + structuralLine(e, true).length + 1, 0);
  const speech = t.entries.filter((e): e is Extract<Entry, { kind: "utterance" }> => e.kind === "utterance");
  const speechBudget = Math.max(budgetChars - structuralChars - 200, 400);
  const bySpeaker = new Map<string, UtteranceRec[]>();
  for (const u of speech) bySpeaker.set(u.roleId, [...(bySpeaker.get(u.roleId) ?? []), u]);
  const weight = (us: UtteranceRec[]) => us.reduce((a, u) => a + speechHeader(u).length + u.norm.length + 1, 0);
  const totalWeight = [...bySpeaker.values()].reduce((a, us) => a + weight(us), 0);

  const keep = new Map<number, number>(); // seq -> cap
  for (const us of bySpeaker.values()) {
    const share = Math.floor((speechBudget * weight(us)) / Math.max(totalWeight, 1));
    const sizeAt = (cap: number) => us.reduce((a, u) => a + speechHeader(u).length + Math.min(u.norm.length, cap) + (u.norm.length > cap ? 4 : 0) + 1, 0);
    if (sizeAt(MAX_CAP) <= share) { for (const u of us) keep.set(u.seq, MAX_CAP); continue; }
    let lo = MIN_CAP; let hi = MAX_CAP; let best = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (sizeAt(mid) <= share) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    if (best >= MIN_CAP) { for (const u of us) keep.set(u.seq, best); continue; }
    const per = us.reduce((a, u) => a + speechHeader(u).length, 0) / us.length + MIN_CAP + 5;
    const k = Math.max(1, Math.min(us.length, Math.floor(share / per)));
    for (let i = 0; i < k; i++) keep.set(us[k === 1 ? us.length - 1 : Math.round((i * (us.length - 1)) / (k - 1))]!.seq, MIN_CAP);
  }

  let omitted = 0; let shortened = 0;
  const out = lines(t.entries, (e) => {
    if (e.kind !== "utterance") return structuralLine(e, true);
    const cap = keep.get(e.seq);
    if (cap === undefined) { omitted++; return null; }
    if (e.norm.length > cap) shortened++;
    return speechLine(e, cap);
  });
  const note = `[Trimmed to fit: ${omitted} line(s) omitted and ${shortened} line(s) cut short. Only text shown here can be quoted.]`;
  const text = [note, ...out].join("\n");
  return { text, trimmed: { budgetChars, fullChars, keptChars: text.length, omittedLines: omitted, shortenedLines: shortened } };
}
