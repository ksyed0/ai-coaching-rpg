"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PlayerScene, PlayerView } from "@acr/events";
import { endsWhenText, exitWhy, SCENE_COPY } from "../lib/scene-copy";

// US-0080: an INFORM-ONLY dialog when a scene this page was watching ends. The next scene is already running underneath (its clock and
// the AI characters do not wait), so the dialog is not modal: the transcript keeps updating behind it and the say box keeps its draft.
// It opens only for a scene exit the live page received (`view.lastExit`, never set from a snapshot), so a late join or a reload shows
// none. A facilitator's End session has its own banner, so `facilitator_end` opens nothing.

const SAY_INPUT_ID = "say-line"; // SayBox's input: where the focus goes back to when nothing better is left

export type SceneEndedDialogProps = {
  view: Pick<PlayerView, "lastExit" | "scene" | "status" | "ended">;
  /** The scenes this player takes part in, in script order (`joined.scenes`). */
  scenes: PlayerScene[];
  /** The session ended (the view says so, or the stream's final event did). */
  ended: boolean;
};

const canFocus = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && el !== document.body && !(el as HTMLInputElement).disabled;

export function SceneEndedDialog({ view, scenes, ended }: SceneEndedDialogProps) {
  const id = useId();
  const [dismissed, setDismissed] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const continueBtn = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<Element | null>(null);
  const exit = view.lastExit;

  const complete = ended && view.ended?.reason === "script_complete";
  // Open for a live exit not yet dismissed; never for End session, and not once the session ended any other way (the end banner says it).
  const open = exit !== null && exit.seq !== dismissed && exit.reason !== "facilitator_end" && (!ended || complete);

  // A new exit opens the dialog. The focus moves into it only when nothing holds it (the page body) and the say box holds no draft: a
  // person typing keeps their place and their keys (the say box is disabled for a moment between scenes, which can drop its focus).
  const seq = open ? exit.seq : null;
  useEffect(() => {
    if (seq === null) return;
    const at = document.activeElement;
    returnTo.current = at;
    const say = document.getElementById(SAY_INPUT_ID);
    const draft = say instanceof HTMLInputElement && say.value.trim() !== "";
    if ((at === null || at === document.body) && !draft) continueBtn.current?.focus();
  }, [seq]);

  function close() {
    if (exit) setDismissed(exit.seq);
    const at = document.activeElement;
    // Only when the focus is in the dialog or on the page: a person who moved on keeps their place.
    if (at !== null && at !== document.body && !box.current?.contains(at)) return;
    const back = returnTo.current;
    const target = canFocus(back) && !box.current?.contains(back) ? back : document.getElementById(SAY_INPUT_ID);
    if (canFocus(target)) target.focus();
  }

  // Escape closes it from anywhere on the page (it is not modal, so the focus may be in the say box).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const i = exit ? scenes.findIndex((s) => s.id === exit.sceneId) : -1;
  const exited = i >= 0 ? scenes[i] : undefined;
  const title = exited ? `Scene ${i + 1} of ${scenes.length} has ended: ${exited.title}` : SCENE_COPY.otherReason;
  const why = exit ? exitWhy(exit.reason, exited) : "";
  // The next scene: the one now running for this player, else the next one in this player's list (a scene the player is not in may run first).
  const nowIdx = view.scene ? scenes.findIndex((s) => s.id === view.scene!.id) : -1;
  const nextIdx = nowIdx >= 0 ? nowIdx : i >= 0 && i + 1 < scenes.length ? i + 1 : -1;
  const next = nextIdx >= 0 ? scenes[nextIdx] : undefined;

  return (
    <>
      {/* Always mounted so the announcement is read politely; it holds only the stable part (the title and why), never the next scene. */}
      <p className="sr-only" role="status">{open ? `${title}. ${why}` : ""}</p>
      {open ? (
        <div className="scene-ended card stack" role="dialog" aria-modal="false" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} ref={box}>
          <h2 className="dialog-title" id={`${id}-t`}>{title}</h2>
          <p id={`${id}-d`}>{why}</p>
          {complete ? (
            <div className="stack">
              <h3 className="next-h">{SCENE_COPY.sessionComplete}</h3>
              <p>{SCENE_COPY.complete}</p>
            </div>
          ) : next ? (
            <div className="stack">
              <h3 className="next-h">{SCENE_COPY.nextHeading}: Scene {nextIdx + 1} of {scenes.length}: {next.title}</h3>
              <p className="objective">{SCENE_COPY.objective} {next.goal}</p>
              <p className="ends">{SCENE_COPY.endsWhen} {endsWhenText(next)}</p>
              <p className="muted small">{nowIdx >= 0 ? SCENE_COPY.nextStarted : SCENE_COPY.nextWaiting}</p>
            </div>
          ) : (
            <p>{SCENE_COPY.noMoreScenes}</p>
          )}
          <div className="dialog-actions">
            <button className="btn pri" type="button" ref={continueBtn} onClick={close}>{SCENE_COPY.continue}</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
