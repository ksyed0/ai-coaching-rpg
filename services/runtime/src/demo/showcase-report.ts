import type { SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import { sanitizeText } from "../cli/render.js";
import { classifyGmDecision, classifyNpcReply, isFallbackReply, type Provenance } from "./provenance.js";

export type LineSource = "player-bot" | "ai-character" | "game-master" | "system";
export type LineRecord = { seq: number; source: LineSource; /** SCRIPTED / GENERATED / FALLBACK / SYSTEM: the same tags as the Markdown transcript. */ tag: Provenance; sceneId: string | null; role?: string; text: string; fallback?: boolean };
export type NpcStats = { roleId: string; name: string; replies: number; modelReplies: number; fallbackReplies: number; latencyMs: { median: number; max: number } | null };
export type GmDecision = { seq: number; sceneId: string; condition: string; verdict: boolean; reasoning: string };
export type SceneStats = { id: string; title: string; exitReason: string | null; playerLines: number; npcReplies: number; gmDecisions: number };
export type ShowcaseReport = {
  scenario: { id: string; title: string };
  mode: "mock" | "live";
  /** A description of the configured provider (never a key or URL); live runs only. */
  provider?: string;
  maxLines: number | null;
  maxFallbacks: number | null;
  watchdogMinutes: number;
  scenes: SceneStats[];
  npcs: NpcStats[];
  gm: { evaluations: number; verdictsTrue: number; verdictsFalse: number; exitedScenes: string[]; decisions: GmDecision[] };
  playerLines: number;
  npcReplies: number;
  fallbackLines: number;
  facilitatorAdvances: number;
  /** Things worth knowing that are not failures, e.g. a scene the Game Master did not end. */
  observations: string[];
  /** Problems that do not fail the run: canned fallback lines when no --max-fallbacks limit was given. */
  warnings: string[];
  alerts: { seq: number; level: "info" | "warning"; message: string }[];
  /** Latency is derived from event timestamps: the time from the previous line in the stream to the reply. */
  lines: LineRecord[];
  wallTimeMs: number;
};

const REASONING_CHARS = 400;
const TEXT_CHARS = 2_000;

/** Sanitizes first (no control characters or forged lines survive), then truncates with an ellipsis. */
export function clip(text: string, max: number): string {
  const clean = sanitizeText(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export type ReportInput = {
  events: SessionEvent[]; scenario: Scenario; mode: "mock" | "live";
  /** Whether event timestamps are real time (false with the fake clock of the mock run). */
  timing: boolean;
  wallTimeMs: number; maxLines: number | null; maxFallbacks: number | null; watchdogMinutes: number; observations: string[]; provider?: string;
};

/**
 * Pure: everything the showcase reports, derived from the facilitator's complete event stream. A reply is a canned
 * fallback line only when it is the character's fallback text AND the engine logged the fallback alert right before it.
 */
export function buildShowcaseReport(i: ReportInput): ShowcaseReport {
  const firstScene = (id: string) => { const k = i.scenario.script.scenes.findIndex((s) => s.participants.includes(id)); return k < 0 ? Infinity : k; };
  const npcRoles = Object.values(i.scenario.roles).filter((r): r is NpcRole => r.type === "npc").sort((a, b) => firstScene(a.id) - firstScene(b.id));
  const titles = new Map(i.scenario.script.scenes.map((s) => [s.id, s.title]));
  const scenes = new Map<string, SceneStats>();
  const stats = new Map<string, { replies: number; fallback: number; latencies: number[] }>(npcRoles.map((r) => [r.id, { replies: 0, fallback: 0, latencies: [] }]));
  const lines: LineRecord[] = [];
  const decisions: GmDecision[] = [];
  const alerts: ShowcaseReport["alerts"] = [];
  const exited: string[] = [];
  let advances = 0; let playerLines = 0; let npcReplies = 0; let fallbackLines = 0;
  let current: string | null = null;
  let lastUtterance: { ts: number } | null = null;
  const sceneStat = (id: string): SceneStats => {
    let s = scenes.get(id);
    if (!s) { s = { id, title: titles.get(id) ?? id, exitReason: null, playerLines: 0, npcReplies: 0, gmDecisions: 0 }; scenes.set(id, s); }
    return s;
  };

  i.events.forEach((e, idx) => {
    switch (e.type) {
      case "scene.entered":
        current = e.sceneId; sceneStat(e.sceneId); lastUtterance = null;
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: e.sceneId, text: `scene started: ${clip(titles.get(e.sceneId) ?? e.sceneId, 200)}` });
        break;
      case "scene.exited":
        sceneStat(e.sceneId).exitReason = e.reason;
        if (e.reason === "gm_detects") exited.push(e.sceneId);
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: e.sceneId, text: `scene ended: ${e.reason}` });
        current = null;
        break;
      case "utterance": {
        const npc = npcRoles.find((r) => r.id === e.roleId);
        if (!npc) {
          playerLines++; if (current) sceneStat(current).playerLines++;
          lines.push({ seq: e.seq, source: "player-bot", tag: "scripted", sceneId: current, role: e.roleId, text: clip(e.text, TEXT_CHARS) });
        } else {
          const prev = i.events[idx - 1];
          const fallback = isFallbackReply(npc.fallback_line, e, prev);
          const st = stats.get(npc.id)!;
          st.replies++; npcReplies++;
          if (fallback) { st.fallback++; fallbackLines++; }
          if (i.timing && lastUtterance) st.latencies.push(Math.max(0, e.ts - lastUtterance.ts));
          if (current) sceneStat(current).npcReplies++;
          lines.push({ seq: e.seq, source: "ai-character", tag: classifyNpcReply(i.mode, fallback), sceneId: current, role: e.roleId, text: clip(e.text, TEXT_CHARS), ...(fallback ? { fallback: true } : {}) });
        }
        lastUtterance = { ts: e.ts };
        break;
      }
      case "gm.decision": {
        const d: GmDecision = { seq: e.seq, sceneId: e.sceneId, condition: clip(e.condition, 300), verdict: e.verdict, reasoning: clip(e.reasoning, REASONING_CHARS) };
        decisions.push(d); sceneStat(e.sceneId).gmDecisions++;
        lines.push({ seq: e.seq, source: "game-master", tag: classifyGmDecision(i.mode), sceneId: e.sceneId, text: `${e.verdict ? "TRUE" : "FALSE"}: ${d.reasoning}` });
        break;
      }
      case "facilitator.alert":
        alerts.push({ seq: e.seq, level: e.level, message: clip(e.message, 300) });
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: current, text: `alert (${e.level}): ${clip(e.message, 300)}` });
        break;
      case "facilitator.command":
        if (e.command === "advance") advances++;
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: current, text: `facilitator command: ${e.command}` });
        break;
      case "inject.fired":
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: e.sceneId, text: `inject ${e.injectId} to ${e.to.join(", ")}` });
        break;
      case "session.ended":
        lines.push({ seq: e.seq, source: "system", tag: "system", sceneId: null, text: `session ended: ${e.reason}` });
        break;
      default: break;
    }
  });

  const npcs: NpcStats[] = npcRoles.map((r) => {
    const s = stats.get(r.id)!;
    const m = median(s.latencies);
    return {
      roleId: r.id, name: r.name, replies: s.replies, modelReplies: s.replies - s.fallback, fallbackReplies: s.fallback,
      latencyMs: m === null ? null : { median: Math.round(m), max: Math.max(...s.latencies) },
    };
  });
  const warnings = fallbackLines > 0 && i.maxFallbacks === null
    ? [`${fallbackLines} of ${npcReplies} AI replies were canned fallback lines (use --max-fallbacks <n> to turn this into a failure)`] : [];
  const order = i.scenario.script.scenes.map((s) => s.id);
  return {
    scenario: { id: i.scenario.meta.id, title: i.scenario.meta.title },
    mode: i.mode, ...(i.provider ? { provider: i.provider } : {}),
    maxLines: i.maxLines, maxFallbacks: i.maxFallbacks, watchdogMinutes: i.watchdogMinutes,
    scenes: order.filter((id) => scenes.has(id)).map((id) => scenes.get(id)!),
    npcs,
    gm: {
      evaluations: decisions.length, verdictsTrue: decisions.filter((d) => d.verdict).length, verdictsFalse: decisions.filter((d) => !d.verdict).length,
      exitedScenes: exited, decisions,
    },
    playerLines, npcReplies, fallbackLines, facilitatorAdvances: advances, observations: i.observations.map((o) => clip(o, 300)), warnings, alerts, lines,
    wallTimeMs: Math.round(i.wallTimeMs),
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The closing "AI contribution" summary as plain lines (the narrator sanitizes them again on the way out). */
export function formatAiSummary(r: ShowcaseReport): string[] {
  const modelWord = r.mode === "mock" ? "scripted (mock) output" : "real model output";
  const out = ["AI contribution"];
  for (const n of r.npcs) {
    const latency = n.latencyMs ? `latency median ${seconds(n.latencyMs.median)}, max ${seconds(n.latencyMs.max)}` : "latency n/a";
    out.push(`  ${n.name} (${n.roleId}): ${n.replies} replies, ${n.modelReplies} ${modelWord}, ${n.fallbackReplies} fallback lines; ${latency}`);
  }
  const exits = (id: string) => r.scenes.filter((s) => s.exitReason === id).length;
  out.push(`  Game Master: ${r.gm.evaluations} evaluations (${r.gm.verdictsTrue} true, ${r.gm.verdictsFalse} false); exited: ${r.gm.exitedScenes.join(", ") || "none"}`);
  out.push(`  Scenes played: ${r.scenes.length} (ended by Game Master ${exits("gm_detects")}, time box ${exits("time_box_elapsed")}, facilitator advance ${exits("facilitator_advance")})`);
  out.push(`  Player-bot lines: ${r.playerLines}; AI character replies: ${r.npcReplies} (${r.fallbackLines} canned fallback)`);
  out.push(`  Facilitator advances: ${r.facilitatorAdvances}`);
  out.push(`  Alerts: ${r.alerts.length}`);
  for (const o of r.observations) out.push(`  Observation: ${o}`);
  for (const w of r.warnings) out.push(`  WARNING: ${w}`);
  out.push(`  Total wall time: ${seconds(r.wallTimeMs)}`);
  return out;
}
