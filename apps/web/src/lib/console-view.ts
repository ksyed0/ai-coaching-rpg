import { initialState, reduce, type PlayerScene, type RoleKind, type SessionEvent, type SessionState } from "@acr/events";

// The facilitator console's read-only fold of one session (US-0059). The server sends a `reset` state and then events; this folds them
// into the state plus a readable timeline. It never throws on what arrives (an unknown event type is only a sequence number).

/** Lines kept in the browser for the transcript and for the timeline. */
export const MAX_CONSOLE_LINES = 1_000;

export type TimelineEntry = { seq: number; ts: number; kind: "line" | "notice" | "alert"; text: string; roleId?: string; level?: "info" | "warning" };
export type ConsoleView = { state: SessionState; timeline: TimelineEntry[]; gap: boolean };
type Ctx = { scenes: PlayerScene[]; label: (roleId: string) => string };

const NOT_SHOWN = "Earlier Game Master notices and alerts are not shown after a reconnect.";

export function viewFromReset(state: SessionState): ConsoleView {
  const kept = state.transcript.length > MAX_CONSOLE_LINES ? state.transcript.slice(-MAX_CONSOLE_LINES) : state.transcript;
  const notice = state.lastSeq > 0;
  // Slice the lines first, leaving room for the notice, so the notice stays at index 0 and the total stays within the cap.
  const lines: TimelineEntry[] = kept.slice(notice ? -(MAX_CONSOLE_LINES - 1) : -MAX_CONSOLE_LINES).map((u) => ({ seq: u.seq, ts: u.ts, kind: "line", text: u.text, roleId: u.roleId }));
  const timeline = notice ? [{ seq: 0, ts: 0, kind: "notice" as const, text: NOT_SHOWN }, ...lines] : lines;
  return { state: kept === state.transcript ? state : { ...state, transcript: kept }, timeline, gap: false };
}

export function timelineText(e: SessionEvent, before: SessionState, ctx: Ctx): Omit<TimelineEntry, "seq" | "ts"> | null {
  const by = ("by" in e && typeof e.by === "string" ? e.by : undefined) ?? "the facilitator";
  const scene = (id: string) => ctx.scenes.find((s) => s.id === id)?.title ?? id;
  const notice = (text: string) => ({ kind: "notice" as const, text });
  switch (e.type) {
    case "utterance":
      return { kind: "line", text: e.text, roleId: e.roleId };
    case "facilitator.alert":
      return { kind: "alert", text: e.message, level: e.level };
    case "gm.decision": {
      if (Object.hasOwn(before.gmVerdicts, e.condition) && before.gmVerdicts[e.condition] === e.verdict) return null;
      return notice(`Game Master: “${e.condition}” is ${e.verdict ? "met" : "not met"}`);
    }
    case "gm.no_verdict":
      return notice(`Game Master gave no verdict on “${e.condition}”`);
    case "gm.fact_earned":
      return notice(`Game Master suggests releasing fact ${e.fact} of ${ctx.label(e.roleId)}${e.autoRelease ? " (released automatically)" : ""}`);
    case "facilitator.command":
      switch (e.command) {
        case "pause": return notice(`Paused by ${by}`);
        case "resume": return notice(`Resumed by ${by}`);
        case "advance": return notice(`Advance requested by ${by}`);
        case "fire_inject": return notice(`Inject ${e.injectId} fired by ${by}`);
        case "whisper": return notice(`Whisper to ${ctx.label(e.roleId)} by ${by}: ${e.text}`);
        case "release_hidden": return notice(`Fact ${e.fact} of ${ctx.label(e.roleId)} released by ${by}`);
        case "set_npc_stance": return notice(`Stance of ${ctx.label(e.roleId)} changed by ${by}`);
        default: return null;
      }
    case "inject.fired":
      return notice(`Inject to ${(Array.isArray(e.to) ? e.to : []).map(ctx.label).join(", ")}: ${e.content}`);
    case "scene.entered":
      return notice(`Scene “${scene(e.sceneId)}” begins`);
    case "scene.exited":
      return notice(`Scene “${scene(e.sceneId)}” ends`);
    case "session.started":
      return notice("Session started");
    case "session.resumed":
      return notice("The session server restarted; the session is paused");
    case "session.ended":
      return notice(e.message ? `Session ended. Message to participants: ${e.message}` : "Session ended");
    default:
      return null; // npc.updated (blanked for the console) and any type this version does not know
  }
}

/** Folds one event. Never throws: an unknown type or a malformed known one still advances the sequence. */
export function applyConsoleEvent(v: ConsoleView | null, e: SessionEvent, ctx: Ctx): ConsoleView | null {
  if (!e || !Number.isInteger(e.seq)) return v;
  if (!v) return e.seq === 1 ? step({ state: initialState(), timeline: [], gap: false }, e, ctx) : null;
  if (e.seq <= v.state.lastSeq) return v;
  if (e.seq > v.state.lastSeq + 1) return { ...v, gap: true };
  return step(v, e, ctx);
}

function step(v: ConsoleView, e: SessionEvent, ctx: Ctx): ConsoleView {
  let state: SessionState;
  try {
    state = reduce(v.state, e) ?? { ...v.state, lastSeq: e.seq };
  } catch {
    // Deliberate: a malformed known event must not stop the live view, so it is swallowed and only the sequence advances.
    state = { ...v.state, lastSeq: e.seq };
  }
  if (state.transcript.length > MAX_CONSOLE_LINES) state = { ...state, transcript: state.transcript.slice(-MAX_CONSOLE_LINES) };
  let entry: Omit<TimelineEntry, "seq" | "ts"> | null = null;
  try {
    entry = timelineText(e, v.state, ctx);
  } catch {
    entry = null;
  }
  const timeline = entry ? [...v.timeline, { seq: e.seq, ts: e.ts, ...entry }].slice(-MAX_CONSOLE_LINES) : v.timeline;
  return { state, timeline, gap: false };
}

export type TalkRow = { roleId: string; kind: RoleKind; words: number; lines: number };

/** Words and lines per role: players first, then AI characters, each in `roles` order; the silent show 0. */
export function talkRows(state: SessionState): TalkRow[] {
  const rows = Object.entries(state.roles).map(([roleId, r]) => {
    const t = Object.hasOwn(state.talk, roleId) ? state.talk[roleId]! : { words: 0, lines: 0 };
    return { roleId, kind: r.kind, words: t.words, lines: t.lines };
  });
  return [...rows.filter((r) => r.kind === "player"), ...rows.filter((r) => r.kind !== "player")];
}
