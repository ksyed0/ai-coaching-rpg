import type { ControlToWorker } from "./protocol.js";

type VoiceStateMessage = Extract<ControlToWorker, { type: "voice_state" }>;

/**
 * US-0070 (EPIC-0003 voice A1a): the worker's half of the privacy invariant (the runtime checks again on every line). A track may be
 * segmented and transcribed ONLY while its role is a listed holder with `recording: true` and the session is neither paused nor ended.
 * Before the first `voice_state` nothing records (overview C6: after a runtime restart the worker waits for control to push the state).
 * Role ids are looked up in a Map, never on a plain object, so `__proto__` and friends are just unknown roles.
 */
export class VoiceGate {
  private recording = new Map<string, string>();
  private pausedNow = false;
  private endedNow = false;

  /** Replaces the state; returns the roles that were recording before and are not now, or record for another participant now. */
  update(s: VoiceStateMessage): { stopped: string[] } {
    const before = this.recording;
    const next = new Map<string, string>();
    if (!s.paused && !s.ended) for (const h of s.holders) if (h.recording) next.set(h.roleId, h.participantId);
    this.recording = next;
    this.pausedNow = s.paused;
    this.endedNow = s.ended;
    const stopped: string[] = [];
    for (const [roleId, participantId] of before) if (next.get(roleId) !== participantId) stopped.push(roleId);
    return { stopped };
  }

  /** The participant a role records for, or null (not a recording holder, paused, ended, or no state yet). */
  recordingFor(roleId: string): { participantId: string } | null {
    const participantId = this.recording.get(roleId);
    return participantId === undefined ? null : { participantId };
  }

  get paused(): boolean { return this.pausedNow; }
  get ended(): boolean { return this.endedNow; }
}
