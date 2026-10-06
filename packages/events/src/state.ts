import type { RoleKind, SessionEvent, Channel } from "./events.js";

export type Utterance = { seq: number; ts: number; sceneId: string | null; roleId: string; text: string; channel: Channel };
export type NpcState = { goals: string[]; knowledge: string[]; released: string[] };

export type SessionState = {
  status: "idle" | "running" | "ended";
  lastSeq: number;
  scenarioId: string | null;
  version: string | null;
  roles: Record<string, { kind: RoleKind; participantId?: string }>;
  currentScene: { id: string; enteredAt: number; participants: string[] } | null;
  sceneHistory: { id: string; participants: string[] }[];
  paused: boolean;
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
    currentScene: null, sceneHistory: [], paused: false, transcript: [], injectsFired: [], npcs: {},
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
      return { ...s, advanceRequested: false, gmVerdicts: {}, currentScene: { id: e.sceneId, enteredAt: e.ts, participants: e.participants },
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
      if (e.command === "pause") return { ...s, paused: true };
      if (e.command === "resume") return { ...s, paused: false };
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
  }
}

export function visibleTranscript(state: SessionState, roleId: string): Utterance[] {
  const visibleScenes = new Set(state.sceneHistory.filter((sc) => sc.participants.includes(roleId)).map((sc) => sc.id));
  return state.transcript.filter((u) => u.sceneId !== null && visibleScenes.has(u.sceneId));
}
