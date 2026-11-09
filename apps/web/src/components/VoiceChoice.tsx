"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { ActionResult } from "../lib/api";
import { MESSAGES } from "../lib/messages";
import type { VoiceChoiceValue, VoiceState } from "../lib/use-session";

// US-0071 (A1b Task 14): how this participant takes part, voice or text only. Two native radios in a fieldset with a legend (Tab enters
// the group once, the arrow keys move the selection, as native radios do) and a native submit button (Enter or Space on it, or Enter in
// a radio, saves). The saved state is shown in words with an aria-hidden icon. Nothing here touches the microphone: permission is asked
// only by the mic check and "Join with voice", after this choice is saved.

export type VoiceChoiceProps = {
  /** The saved state from the runtime (never "off": the page shows no choice then). */
  state: VoiceState;
  /** Whether the web server has LiveKit (`config.livekitUrl`); without it the voice option is disabled with the reason. */
  voiceTransport: boolean;
  /** Whether this page can open a microphone at all (a secure context with mediaDevices). */
  secure: boolean;
  onChoose: (choice: VoiceChoiceValue) => Promise<ActionResult>;
};

const STATE_WORDS: Record<VoiceState, { icon: string; words: string }> = {
  voice: { icon: "✓", words: MESSAGES.voiceStateOn },
  text_only: { icon: "–", words: MESSAGES.voiceStateText },
  none: { icon: "?", words: MESSAGES.voiceStateNone },
  off: { icon: "–", words: MESSAGES.voiceStateText },
};

const saved = (s: VoiceState): VoiceChoiceValue | null => (s === "voice" ? "voice" : s === "text_only" ? "text_only" : null);

export function VoiceChoice({ state, voiceTransport, secure, onChoose }: VoiceChoiceProps) {
  const id = useId();
  // The selection follows the saved state whenever the saved state changes (an answer, a fresh joined); a refusal puts it back.
  const [selected, setSelected] = useState<VoiceChoiceValue | null>(saved(state));
  const [shownFor, setShownFor] = useState(state);
  if (shownFor !== state) { setShownFor(state); setSelected(saved(state)); }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // One reason at most, the one that applies first: no transport (nothing on this page could connect), then the insecure context.
  const reason = !voiceTransport ? MESSAGES.voiceNoTransport : !secure ? MESSAGES.voiceInsecure : null;
  const reasonId = `${id}-why`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current || selected === null) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const r = await onChoose(selected);
      if (!r.ok) { setError(r.message); setSelected(saved(state)); }
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const shown = STATE_WORDS[state];
  return (
    <section className="card voice" aria-labelledby={`${id}-h`}>
      <h2 className="s" id={`${id}-h`}>Voice</h2>
      <p><span aria-hidden="true">{`${shown.icon} `}</span>{shown.words}</p>
      <form onSubmit={submit}>
        <fieldset className="stack">
          <legend>{MESSAGES.voiceChoiceTitle}</legend>
          <label className="check">
            <input type="radio" name={`${id}-choice`} value="voice" checked={selected === "voice"} disabled={reason !== null}
              aria-describedby={reason !== null ? reasonId : undefined} onChange={() => setSelected("voice")} />
            <span>{MESSAGES.voiceWith}</span>
          </label>
          <label className="check">
            <input type="radio" name={`${id}-choice`} value="text_only" checked={selected === "text_only"} onChange={() => setSelected("text_only")} />
            <span>{MESSAGES.voiceText}</span>
          </label>
          {reason !== null ? <p className="hint muted" id={reasonId}>{reason}</p> : null}
        </fieldset>
        {/* Not disabled while pending (it keeps the focus); the ref guard sends one choice. */}
        <button className="btn" type="submit" disabled={selected === null} aria-busy={pending || undefined}>{MESSAGES.voiceSave}</button>
      </form>
      {error ? <p className="err" role="alert">{error}</p> : null}
    </section>
  );
}
