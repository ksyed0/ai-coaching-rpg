"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MESSAGES } from "../lib/messages";
import { LEVEL_FLOOR_DBFS, LevelHistory, micLevel, type AudioContextLike, type Caf, type MediaStreamLike, type Raf } from "../lib/mic-level";

// US-0071 (A1b Task 15): the lobby's microphone check, offered once voice is the saved choice. The microphone is asked for ONLY by the
// click on "Check my microphone" (never on load); the AudioContext is created and resumed inside that click (iOS needs the gesture).
// The level and its words are plain text, never a live region (they change ten times a second). "Stop the check" and "Join with voice"
// (through `register`) stop every track: one microphone capture at a time.

export type MicCheckDeps = {
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStreamLike>;
  audioContext: () => AudioContextLike;
  raf: Raf;
  caf: Caf;
};

type Running = { stream: MediaStreamLike; ctx: AudioContextLike; stopLevel: () => void };
type Phase = "idle" | "asking" | "running";

export function MicCheck({ deps, register }: { deps: MicCheckDeps; register: (stop: (() => void) | null) => void }) {
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [level, setLevel] = useState(LEVEL_FLOOR_DBFS);
  const [words, setWords] = useState<string>(MESSAGES.micNoSound);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Running | null>(null);
  /** Bumped by every stop: a stream that arrives after the check was stopped (or the page left) is released at once. */
  const attempt = useRef(0);
  const mounted = useRef(true);
  const registerRef = useRef(register);
  registerRef.current = register;

  function stop() {
    attempt.current++;
    const r = running.current;
    running.current = null;
    if (r) {
      r.stopLevel();
      for (const t of r.stream.getTracks()) t.stop();
      void r.ctx.close().catch(() => undefined);
    }
    registerRef.current(null);
    if (mounted.current) setPhase("idle");
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
    // stop reads refs only
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function start() {
    if (phase !== "idle") return;
    // Inside the click: create and resume the audio context before anything is awaited.
    const ctx = deps.audioContext();
    void ctx.resume().catch(() => undefined);
    const mine = ++attempt.current;
    setError(null);
    setPhase("asking");
    deps.getUserMedia({ audio: true }).then((stream) => {
      if (mine !== attempt.current) {
        for (const t of stream.getTracks()) t.stop();
        void ctx.close().catch(() => undefined);
        return;
      }
      const history = new LevelHistory();
      const stopLevel = micLevel(ctx, stream, (db, t) => {
        history.add(t, db);
        setLevel(db);
        setWords(history.words());
      }, deps.raf, deps.caf);
      running.current = { stream, ctx, stopLevel };
      setLevel(LEVEL_FLOOR_DBFS);
      setWords(MESSAGES.micNoSound);
      setPhase("running");
      registerRef.current(stop);
    }, (err: unknown) => {
      void ctx.close().catch(() => undefined);
      if (mine !== attempt.current) return;
      const name = err instanceof Error ? err.name : "";
      setError(name === "NotAllowedError" || name === "SecurityError" ? MESSAGES.micDenied : MESSAGES.micFailed);
      setPhase("idle");
    });
  }

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 className="s" id={`${id}-h`}>Microphone check</h2>
      <p className="muted small">{MESSAGES.micHeadset}</p>
      {phase === "running" ? (
        <>
          <p>{MESSAGES.micSpeak}</p>
          <label htmlFor={`${id}-m`}>{MESSAGES.micLevelLabel}</label>
          <meter id={`${id}-m`} className="mic-meter" min={LEVEL_FLOOR_DBFS} max={0} low={-60} high={-40} optimum={-20} value={level} />
          <p className="mic-words"><b>{words}</b></p>
          <button className="btn" type="button" onClick={stop}>{MESSAGES.micStopCheck}</button>
        </>
      ) : (
        <button className="btn" type="button" aria-busy={phase === "asking" || undefined} onClick={start}>{MESSAGES.micCheck}</button>
      )}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </section>
  );
}
