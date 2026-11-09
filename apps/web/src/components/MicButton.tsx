"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ActionResult } from "../lib/api";
import { MESSAGES } from "../lib/messages";
import type { VoiceClient, VoiceClientState } from "../lib/voice-client";

// US-0071 (A1b Task 15): "Join with voice", then a Mute button whose label NEVER changes ("Mute microphone"; aria-pressed carries the
// state) and "Stop using voice". The microphone state is always shown in words with an aria-hidden icon, never colour alone, and the
// words are honest: "recording" only when the runtime would record (connected, not muted, started, not paused, in a scene, voice
// available). Focus moves to the Mute button when it replaces "Join with voice"; when joining fails it stays on "Join with voice".

export type MicWordsInput = { state: VoiceClientState; muted: boolean; started: boolean; paused: boolean; inScene: boolean; unavailable: boolean };

/** The microphone state in words, from the client's state and what the page already knows of the session. */
export function micWords(o: MicWordsInput): string {
  if (o.state !== "live" && o.state !== "muted") return MESSAGES.micNotConnected;
  if (o.state === "muted" || o.muted) return MESSAGES.micMuted;
  if (o.unavailable) return MESSAGES.micUnavailableWords;
  if (!o.started) return MESSAGES.micNotStarted;
  if (o.paused) return MESSAGES.micPausedWords;
  if (!o.inScene) return MESSAGES.micBetweenScenes;
  return MESSAGES.micRecording;
}

/** Re-renders on every VoiceClient change. */
export function useVoiceClientState(client: VoiceClient): VoiceClientState {
  useSyncExternalStore((fn) => client.subscribe(fn), () => client.version, () => 0);
  return client.state;
}

export type MicButtonProps = {
  client: VoiceClient;
  started: boolean;
  paused: boolean;
  inScene: boolean;
  /** The latest of voice_unavailable / voice_available. */
  unavailable: boolean;
  /** The runtime holds this seat muted (`joined.voice.muted`, a `voice` answer). */
  serverMuted: boolean;
  /** Stops the mic check, then joins (SessionScreen). */
  onJoin: () => Promise<ActionResult>;
  /** Posts the opt-out; called only after the room was left. */
  onOptOut: () => Promise<ActionResult>;
};

const ICON: Record<string, string> = { [MESSAGES.micRecording]: "●", [MESSAGES.micMuted]: "×", [MESSAGES.micNotConnected]: "○" };

export function MicButton({ client, started, paused, inScene, unavailable, serverMuted, onJoin, onOptOut }: MicButtonProps) {
  const state = useVoiceClientState(client);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const muteRef = useRef<HTMLButtonElement>(null);
  /** Set by a join from the button: the Mute button that replaces it takes the focus once. */
  const focusMute = useRef(false);

  const connected = state === "live" || state === "muted";
  const muted = state === "muted" || (state === "live" && serverMuted);
  const words = micWords({ state, muted, started, paused, inScene, unavailable });

  useEffect(() => {
    if (connected && focusMute.current) { focusMute.current = false; muteRef.current?.focus(); }
  }, [connected]);

  async function run(action: () => Promise<ActionResult>, onOk?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      const r = await action();
      if (r.ok) onOk?.();
      else if (r.message) setError(r.message);
    } finally {
      busy.current = false;
    }
  }

  // The flag is set before the join starts: the effect above moves the focus when the Mute button appears; a failed join clears it
  // (focus stays on "Join with voice", which is never unmounted or disabled while joining).
  const join = () => run(async () => {
    focusMute.current = true;
    const r = await onJoin();
    if (!r.ok) focusMute.current = false;
    return r;
  });
  const toggleMute = () => run(() => (muted ? client.unmute() : client.mute()));
  const stop = () => run(async () => { await client.leave(); return onOptOut(); });

  // The failure sentence of the client itself (a dropped room, voice off) is shown with the button; an action's own error beside it.
  const failure = state === "failed" ? client.message : null;
  return (
    <div className="mic">
      <p className="mic-state"><span aria-hidden="true">{`${ICON[words] ?? "◐"} `}</span>{words}</p>
      {connected ? (
        <div className="actions">
          <button ref={muteRef} className="btn" type="button" aria-pressed={muted} onClick={toggleMute}>{MESSAGES.voiceMute}</button>
          <button className="btn" type="button" onClick={stop}>{MESSAGES.voiceStop}</button>
        </div>
      ) : client.voiceOff ? null : (
        // Never disabled while connecting: a disabled button drops the focus; the busy guard sends one join.
        <button className="btn pri" type="button" aria-busy={state === "connecting" || undefined} onClick={join}>{MESSAGES.voiceJoin}</button>
      )}
      {failure ? <p className="err" role="alert">{failure}</p> : error && error !== failure ? <p className="err" role="alert">{error}</p> : null}
    </div>
  );
}
