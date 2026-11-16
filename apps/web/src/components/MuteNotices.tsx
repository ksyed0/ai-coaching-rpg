"use client";

import { MESSAGES, seatMuteLine } from "../lib/messages";
import { roleLabel } from "../lib/names";
import type { MuteNotice, SeatVoice } from "../lib/use-session";

// A3A: what the facilitator's mute looks like on a participant's page. ONE polite region that stays mounted for the page's life (a region
// that is remounted with its text is often not announced); the latest announcement is an inner span keyed by its count. Only changes that
// ARRIVE LIVE are announced: a join with the seat already muted shows the state in a plain paragraph instead (never in the region).
// Other seats are named by role label only, never a person's name and never the facilitator's name.

export function MuteNotices({ voice, notice }: { voice: SeatVoice | null; notice: (MuteNotice & { n: number }) | null }) {
  const text = notice === null ? null
    : notice.kind === "seat" ? seatMuteLine(roleLabel(notice.roleId), notice.muted)
    : notice.kind === "self_muted" ? MESSAGES.muteSelf : MESSAGES.muteSelfAgain;
  // The state of this seat: shown whenever it is muted by the facilitator and the seat chose voice, announced or not.
  const heldMuted = voice?.state === "voice" && voice.mutedBy === "facilitator";
  return (
    <>
      <div className="voice-notices" role="status" aria-live="polite">
        {notice && text ? <span key={notice.n}>{text}</span> : null}
      </div>
      {heldMuted && notice?.kind !== "self_muted" ? <p className="banner warn">{MESSAGES.muteSelf}</p> : null}
    </>
  );
}
