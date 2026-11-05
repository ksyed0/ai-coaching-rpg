import type { SessionEvent } from "./events.js";
import type { PlayerSnapshot, SessionState } from "./state.js";

// Framework-free and Node-free: runs in the browser. `reduce` (state.ts) cannot be used on a player's stream because it throws on a seq
// gap, and a player's stream has gaps by design (the server filters what a player may not see). This is the gap-tolerant counterpart.

/** Scene info a player may see: only scenes the player takes part in (carried in `joined.scenes`). */
export type PlayerScene = { id: string; title: string; goal: string; timeBoxMinutes: number };
/** US-0059: an inject as the facilitator's console sees it. For the facilitator's `joined` ONLY: never in a player's message. */
export type FacilitatorInject = { id: string; to: string[]; content: string; atMinute?: number };
/** US-0059: a scene with its injects, in script order (the facilitator's `joined.scenes`). */
export type FacilitatorScene = PlayerScene & { injects: FacilitatorInject[] };
export type PlayerLine = { seq: number; ts: number; roleId: string; text: string; sceneId: string | null };
export type PlayerView = {
  lastSeq: number;
  status: SessionState["status"];
  paused: boolean;
  /** ts of the pause event that began the current pause; null when not paused. */
  pausedSince: number | null;
  scene: { id: string; enteredAt: number; pausedMs: number } | null;
  transcript: PlayerLine[];
  /** Updates in seq order. `private: true` marks a facilitator whisper to this player (BUG-0023); an inject has no such key. */
  injects: { seq: number; content: string; sceneId: string; private?: true }[];
  ended: { reason: string; message?: string } | null;
  /** US-0060: player roles an AI plays; [] when none. Labels come from this, never from a name. */
  aiRoles: string[];
};

const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** BUG-0023: the player's own whispers from a snapshot, as private updates. Total: a missing or malformed list gives [], a bad entry is dropped, order is by seq and a repeated seq is kept once. */
function whisperUpdates(v: unknown): PlayerView["injects"] {
  if (!Array.isArray(v)) return [];
  const out: PlayerView["injects"] = [];
  for (const w of v as unknown[]) {
    const x = w as { seq?: unknown; text?: unknown; sceneId?: unknown } | null;
    if (typeof x !== "object" || x === null || !Number.isSafeInteger(x.seq) || typeof x.text !== "string") continue;
    const seq = x.seq as number;
    if (out.some((o) => o.seq === seq)) continue;
    out.push({ seq, content: x.text, sceneId: typeof x.sceneId === "string" ? x.sceneId : "", private: true });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Seeds the view from the redacted join snapshot. The snapshot carries no inject content, so `injects` starts with the player's own whispers only (BUG-0023). */
export function initPlayerView(snapshot: PlayerSnapshot | SessionState): PlayerView {
  const sc = snapshot.currentScene;
  return {
    lastSeq: snapshot.lastSeq, status: snapshot.status, paused: snapshot.paused, pausedSince: snapshot.pausedSince,
    scene: sc ? { id: sc.id, enteredAt: sc.enteredAt, pausedMs: sc.pausedMs } : null,
    transcript: snapshot.transcript.map((u) => ({ seq: u.seq, ts: u.ts, roleId: u.roleId, text: u.text, sceneId: u.sceneId })),
    injects: whisperUpdates(snapshot.whispers) /* a SessionState's record (never sent to a player) is not a list: none */, ended: null, aiRoles: stringsOf(snapshot.aiRoles),
  };
}

/**
 * Pure and total: returns a new view, never throws. A seq gap is expected (the lastSeq jumps), a seq at or below lastSeq is a duplicate
 * or stale and changes nothing. The cases mirror `reduce` (state.ts); a test keeps the pause arithmetic from drifting.
 */
export function applyPlayerEvent(view: PlayerView, e: SessionEvent): PlayerView {
  // A malformed seq (NaN, Infinity, fractional, missing) must not poison lastSeq: it is dropped like a duplicate.
  if (!e || !Number.isSafeInteger(e.seq) || e.seq <= view.lastSeq) return view;
  const v: PlayerView = { ...view, lastSeq: e.seq };
  // The cases below that do arithmetic on `ts` take a non-finite one as a no-op, so a bad ts cannot turn pausedSince, pausedMs or enteredAt into NaN.
  const tsOk = Number.isFinite(e.ts);
  switch (e.type) {
    case "session.started":
      return { ...v, status: "running", aiRoles: stringsOf(e.aiRoles) };
    case "scene.entered":
      if (!tsOk) return v;
      return { ...v, scene: { id: e.sceneId, enteredAt: e.ts, pausedMs: 0 }, pausedSince: v.paused ? e.ts : null };
    case "scene.exited":
      return { ...v, scene: null };
    case "utterance":
      if (typeof e.text !== "string") return v;
      return { ...v, transcript: [...v.transcript, { seq: e.seq, ts: e.ts, roleId: e.roleId, text: e.text, sceneId: v.scene?.id ?? null }] };
    case "inject.fired":
      return { ...v, injects: [...v.injects, { seq: e.seq, content: e.content, sceneId: e.sceneId }] };
    case "facilitator.command":
      if (!tsOk) return v;
      // A whisper the runtime sent to this player (a player's stream carries only its own): shown with the updates, as text.
      if (e.command === "whisper") return typeof e.text === "string" ? { ...v, injects: [...v.injects, { seq: e.seq, content: e.text, sceneId: v.scene?.id ?? "", private: true }] } : v;
      if (e.command === "pause") return v.paused ? v : { ...v, paused: true, pausedSince: e.ts };
      if (e.command === "resume") {
        if (!v.paused) return v;
        const scene = v.scene && v.pausedSince !== null ? { ...v.scene, pausedMs: v.scene.pausedMs + Math.max(0, e.ts - v.pausedSince) } : v.scene;
        return { ...v, paused: false, pausedSince: null, scene };
      }
      return v;
    case "session.ended":
      return { ...v, status: "ended", scene: null, ended: typeof e.message === "string" ? { reason: e.reason, message: e.message } : { reason: e.reason } };
    case "session.resumed":
      if (!tsOk) return v;
      if (v.status !== "running") return v;
      return v.paused ? v : { ...v, paused: true, pausedSince: Number.isFinite(e.downFromTs) ? Math.min(e.downFromTs, e.ts) : e.ts };
    default:
      // Facilitator-only events never reach a player, and an unknown type must not break the page: ignore, but keep the seq.
      return v;
  }
}
