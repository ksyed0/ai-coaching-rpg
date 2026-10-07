import type { RoleKind, SessionEvent, Channel } from "./events.js";

export type Utterance = { seq: number; ts: number; sceneId: string | null; roleId: string; text: string; channel: Channel };
export type NpcState = { goals: string[]; knowledge: string[]; released: string[] };

export type SessionState = {
  status: "idle" | "running" | "ended";
  lastSeq: number;
  scenarioId: string | null;
  version: string | null;
  roles: Record<string, { kind: RoleKind; participantId?: string }>;
  /** `pausedMs`: total ms the CURRENT scene spent paused so far (closed pause intervals only). */
  currentScene: { id: string; enteredAt: number; participants: string[]; pausedMs: number } | null;
  sceneHistory: { id: string; participants: string[] }[];
  paused: boolean;
  /** ts of the pause event that began the current pause; null when not paused. A scene entered while paused is frozen from its entry ts. */
  pausedSince: number | null;
  transcript: Utterance[];
  injectsFired: string[];
  npcs: Record<string, NpcState>;
  /** True once the facilitator asked to advance the current scene; reset on scene.entered. */
  advanceRequested: boolean;
  /** GM verdicts for the CURRENT scene, keyed by condition text. */
  gmVerdicts: Record<string, boolean>;
};

export function initialState(): SessionState {
  return {
    status: "idle", lastSeq: 0, scenarioId: null, version: null, roles: {},
    currentScene: null, sceneHistory: [], paused: false, pausedSince: null, transcript: [], injectsFired: [], npcs: {},
    advanceRequested: false, gmVerdicts: {},
  };
}

export function reduce(state: SessionState, e: SessionEvent): SessionState {
  if (e.seq !== state.lastSeq + 1) throw new Error(`event seq ${e.seq} out of order; expected ${state.lastSeq + 1}`);
  const s: SessionState = { ...state, lastSeq: e.seq };
  switch (e.type) {
    case "session.started":
      return { ...s, status: "running", scenarioId: e.scenarioId, version: e.version, roles: e.roles };
    case "scene.entered":
      return { ...s, advanceRequested: false, gmVerdicts: {}, currentScene: { id: e.sceneId, enteredAt: e.ts, participants: e.participants, pausedMs: 0 },
        pausedSince: s.paused ? e.ts : null,
        sceneHistory: [...s.sceneHistory, { id: e.sceneId, participants: e.participants }] };
    case "scene.exited":
      return { ...s, currentScene: null, gmVerdicts: {} };
    case "utterance":
      return { ...s, transcript: [...s.transcript, { seq: e.seq, ts: e.ts, sceneId: s.currentScene?.id ?? null, roleId: e.roleId, text: e.text, channel: e.channel }] };
    case "inject.fired":
      return { ...s, injectsFired: [...s.injectsFired, e.injectId] };
    case "npc.updated": {
      const prev = s.npcs[e.roleId] ?? { goals: [], knowledge: [], released: [] };
      return { ...s, npcs: { ...s.npcs, [e.roleId]: { goals: e.goals, knowledge: e.knowledge, released: e.released ?? prev.released } } };
    }
    case "facilitator.command":
      if (e.command === "pause") return s.paused ? s : { ...s, paused: true, pausedSince: e.ts };
      if (e.command === "resume") {
        if (!s.paused) return s;
        const sc = s.currentScene && s.pausedSince !== null ? { ...s.currentScene, pausedMs: s.currentScene.pausedMs + Math.max(0, e.ts - s.pausedSince) } : s.currentScene;
        return { ...s, paused: false, pausedSince: null, currentScene: sc };
      }
      if (e.command === "advance") return { ...s, advanceRequested: true };
      return s;
    case "gm.decision":
      if (s.currentScene?.id !== e.sceneId) return s;
      return { ...s, gmVerdicts: { ...s.gmVerdicts, [e.condition]: e.verdict } };
    case "facilitator.alert":
    case "gm.no_verdict":
      return s;
    case "session.ended":
      return { ...s, status: "ended", currentScene: null };
    case "session.resumed":
      // Back paused after a restart. A session that was already paused keeps its pause start; otherwise the downtime counts as paused
      // time from the last recorded event (never after this event's own ts, so the paused interval is never negative).
      if (s.status !== "running") return s;
      return s.paused ? s : { ...s, paused: true, pausedSince: Number.isFinite(e.downFromTs) ? Math.min(e.downFromTs, e.ts) : e.ts };
  }
}

/**
 * @internal Restore-only fold (US-0018), not for live use: the same result as `reduce`, but utterances and fired injects are appended to `state`'s OWN arrays in
 * place instead of copied, so replaying n events is linear instead of quadratic. The caller must own those arrays (start from a fresh
 * initialState() and never share an intermediate state). The live engine keeps the pure `reduce`; a property test proves both agree.
 */
export function reduceReplay(state: SessionState, e: SessionEvent): SessionState {
  if (e.type !== "utterance" && e.type !== "inject.fired") return reduce(state, e);
  if (e.seq !== state.lastSeq + 1) throw new Error(`event seq ${e.seq} out of order; expected ${state.lastSeq + 1}`);
  if (e.type === "utterance") state.transcript.push({ seq: e.seq, ts: e.ts, sceneId: state.currentScene?.id ?? null, roleId: e.roleId, text: e.text, channel: e.channel });
  else state.injectsFired.push(e.injectId);
  return { ...state, lastSeq: e.seq };
}

/**
 * Active (unpaused) time in the current scene at `now`: now - enteredAt - pausedMs - the open pause, if any.
 * Representation: paused_ms accumulated per scene from the recorded pause/resume events, so replaying the log
 * (US-0018) gives the same value. 0 with no current scene; never negative.
 */
export function activeElapsedMs(state: SessionState, now: number): number {
  const sc = state.currentScene;
  if (!sc) return 0;
  const open = state.paused && state.pausedSince !== null ? Math.max(0, now - state.pausedSince) : 0;
  const v = now - sc.enteredAt - sc.pausedMs - open;
  return Number.isFinite(v) ? Math.max(0, v) : 0; // a corrupt log (NaN/Infinity ts) must not poison the schedule
}

export function visibleTranscript(state: SessionState, roleId: string): Utterance[] {
  const visibleScenes = new Set(state.sceneHistory.filter((sc) => sc.participants.includes(roleId)).map((sc) => sc.id));
  return state.transcript.filter((u) => u.sceneId !== null && visibleScenes.has(u.sceneId));
}
