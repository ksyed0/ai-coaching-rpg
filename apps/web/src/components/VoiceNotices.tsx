"use client";

import { VOICE_NOTICES, type VoiceNoticeCode } from "../lib/messages";

// US-0071 (A1b Task 14): this participant's private voice notices, announced politely. ONE region that stays mounted for the page's life
// (a region that is remounted with its text is often not announced); the latest notice is an inner span keyed by its count, so the same
// code twice replaces the span's text node and is announced again. Only the page's own fixed sentences are shown.

export function VoiceNotices({ notice }: { notice: { code: VoiceNoticeCode; n: number } | null }) {
  return (
    <div className="voice-notices" role="status" aria-live="polite">
      {notice ? <span key={notice.n}>{VOICE_NOTICES[notice.code]}</span> : null}
    </div>
  );
}
