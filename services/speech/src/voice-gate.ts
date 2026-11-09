import type { ControlToWorker } from "./protocol.js";

type VoiceStateMessage = Extract<ControlToWorker, { type: "voice_state" }>;

/**
 * US-0070 (EPIC-0003 voice A1a): the worker's half of the privacy invariant (the runtime checks again on every line). A track may be
 * segmented and transcribed ONLY while its role is a listed holder with `recording: true` and the session is neither paused nor ended.
 * Before the first `voice_state` nothing records (overview C6: after a runtime restart the worker waits for control to push the state).
 * Role ids are looked up in a Map, never on a plain object, so `__proto__` and friends are just unknown roles.
 * US-0071 (A1b Task 7): with a LiveKit ingest each holder also has its seat GENERATION (control's HMAC of role and participant); a frame
 * is used only when it carries exactly that generation (TrackPipeline.push). A file-ingest state has none, and its frames none.
 */
type Rec = { participantId: string; generation?: string };
export class VoiceGate {
  private recording = new Map<string, Rec>();
  private pausedNow = false;
  private endedNow = false;

  /** Replaces the state; returns the roles that were recording before and are not now, or record for another participant now. */
  update(s: VoiceStateMessage): { stopped: string[] } {
    const before = this.recording;
    const next = new Map<string, Rec>();
    if (!s.paused && !s.ended) for (const h of s.holders) if (h.recording) next.set(h.roleId, h.generation === undefined ? { participantId: h.participantId } : { participantId: h.participantId, generation: h.generation });
    this.recording = next;
    this.pausedNow = s.paused;
    this.endedNow = s.ended;
    const stopped: string[] = [];
    for (const [roleId, was] of before) {
      const now = next.get(roleId);
      if (now === undefined || now.participantId !== was.participantId || now.generation !== was.generation) stopped.push(roleId);
    }
    return { stopped };
  }

  /** The participant (and, with LiveKit, the seat generation) a role records for, or null (not a recording holder, paused, ended, or no state yet). */
  recordingFor(roleId: string): { participantId: string; generation?: string } | null {
    const r = this.recording.get(roleId);
    return r === undefined ? null : { ...r };
  }

  get paused(): boolean { return this.pausedNow; }
  get ended(): boolean { return this.endedNow; }
}
