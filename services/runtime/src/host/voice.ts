/**
 * US-0070 (EPIC-0003 voice A1a): the host's voice helpers that need no host internals. `buildVoiceSeats` is what the runtime reports to
 * the control service as `voice_seats` (overview section 2), and control forwards it to the speech worker as `voice_state`: the worker
 * segments and transcribes ONLY a track whose holder has `recording: true` (the privacy invariant; the host checks again on every line).
 */
export type VoiceHolder = { roleId: string; participantId: string; recording: boolean };
export type VoiceSeats = { paused: boolean; ended: boolean; holders: VoiceHolder[] };
export type VoiceState = "none" | "voice" | "text_only" | "off";

/**
 * Every HUMAN player role that has a holder, in the scenario's player order (never an AI seat, never an AI character), with `recording`
 * true only when the seat's voice state is `voice`. Pure over what the host passes in.
 */
export function buildVoiceSeats(o: {
  playerRoles: readonly string[]; holderOf: (roleId: string) => string | undefined; isAi: (roleId: string) => boolean;
  stateOf: (roleId: string) => VoiceState; paused: boolean; ended: boolean;
}): VoiceSeats {
  const holders: VoiceHolder[] = [];
  for (const roleId of o.playerRoles) {
    if (o.isAi(roleId)) continue;
    const participantId = o.holderOf(roleId);
    if (participantId === undefined) continue;
    holders.push({ roleId, participantId, recording: o.stateOf(roleId) === "voice" });
  }
  return { paused: o.paused, ended: o.ended, holders };
}
