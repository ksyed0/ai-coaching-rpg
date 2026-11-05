import type { EventBody, SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import type { Probe } from "./probe-schema.js";

export const PROBE_T0 = 1_800_000_000_000;
const STEP_MS = 10_000;

export function buildProbeEvents(probe: Probe, scenario: Scenario): SessionEvent[] {
  const sessionId = `probe-${probe.id}`;
  const out: SessionEvent[] = [];
  const push = (body: EventBody): void => {
    out.push({ ...body, seq: out.length + 1, ts: PROBE_T0 + out.length * STEP_MS, sessionId } as SessionEvent);
  };
  push({ type: "session.started", scenarioId: scenario.meta.id, version: scenario.meta.version, roles: {} });
  let current: string | null = null;
  probe.transcript.forEach((line, i) => {
    if (line.scene !== current) {
      if (current !== null) push({ type: "scene.exited", sceneId: current, reason: "facilitator_advance" });
      const participants: string[] = [];
      for (let j = i; j < probe.transcript.length && probe.transcript[j]!.scene === line.scene; j++) {
        const r = probe.transcript[j]!.role;
        if (!participants.includes(r)) participants.push(r);
      }
      push({ type: "scene.entered", sceneId: line.scene, participants });
      current = line.scene;
    }
    push({ type: "utterance", roleId: line.role, text: line.text, channel: "text" });
  });
  if (current !== null) push({ type: "scene.exited", sceneId: current, reason: "facilitator_advance" });
  push({ type: "session.ended", reason: "script_complete" });
  return out;
}
