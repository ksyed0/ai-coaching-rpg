import { CONSOLE_VOICE } from "../../lib/console-voice";

// US-0071 (A1b Task 16): whether a voice seat speaks now, as a word with an aria-hidden icon (never colour alone). It changes several
// times a second in a busy room, so it is never placed in a live region and never announced: a screen reader user reads it on demand.

export function SpeakingIndicator({ speaking }: { speaking: boolean }) {
  return speaking ? (
    <span className="pill ok speaking">
      <span aria-hidden="true">{"🎙 "}</span>
      {CONSOLE_VOICE.speaking}
    </span>
  ) : (
    <span className="pill mut">
      <span aria-hidden="true">{"– "}</span>
      {CONSOLE_VOICE.quiet}
    </span>
  );
}
