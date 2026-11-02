"use client";

import type { SessionState } from "@acr/events";
import type { MouseEvent } from "react";
import type { ConsoleCommand } from "../../lib/console-commands";
import type { ConfirmSubject } from "../../lib/console-confirm";

// US-0059: pause, resume, move on and end now. Pause and Resume are ONE button whose label changes, so keyboard focus stays where it
// was. While a command is pending (or the next scene is already requested) a button is aria-disabled and ignores activation but stays
// focusable, so focus handed back by a dialog is never lost; `disabled` (really disabled) is for "not live" and "not running".

/** A confirmation a control asks `ConsoleControls` to open; `opener` is the control that gets focus back. */
export type ConfirmRequest = {
  subject: ConfirmSubject;
  command: ConsoleCommand;
  preview?: string;
  opener: HTMLElement;
};

export type SessionControlsProps = {
  state: SessionState | null;
  disabled: boolean;
  pending: boolean;
  onCommand: (c: ConsoleCommand) => void;
  onConfirm: (r: ConfirmRequest) => void;
  /** The title of the current scene (its id when the scenes carry none). */
  sceneTitle: string | null;
};

export function SessionControls({ state, disabled, pending, onCommand, onConfirm, sceneTitle }: SessionControlsProps) {
  const paused = state?.paused ?? false;
  const scene = state?.currentScene ?? null;
  const advancing = state?.advanceRequested ?? false;
  const canMove = scene !== null && !advancing;

  // Captures the scene id and title now, at the click that opens the confirmation (not when it is confirmed).
  const guard = (fn: (e: MouseEvent<HTMLButtonElement>) => void) => (e: MouseEvent<HTMLButtonElement>) => {
    if (pending) return;
    fn(e);
  };

  return (
    <div className="rowactions">
      <button
        type="button"
        className="btn"
        disabled={disabled}
        aria-disabled={pending ? "true" : undefined}
        onClick={guard(() => onCommand({ kind: paused ? "resume" : "pause" }))}
      >
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        type="button"
        className="btn"
        disabled={disabled}
        aria-disabled={pending || !canMove ? "true" : undefined}
        onClick={guard((e) => {
          if (!scene || advancing) return;
          onConfirm({
            subject: { kind: "advance", scene: sceneTitle ?? scene.id },
            command: { kind: "advance", expectSceneId: scene.id },
            opener: e.currentTarget,
          });
        })}
      >
        {advancing ? "Moving on…" : "Move on"}
      </button>
      <button
        type="button"
        className="btn danger"
        disabled={disabled}
        aria-disabled={pending ? "true" : undefined}
        onClick={guard((e) =>
          onConfirm({ subject: { kind: "end_now" }, command: { kind: "end_now" }, opener: e.currentTarget }),
        )}
      >
        End session
      </button>
    </div>
  );
}
