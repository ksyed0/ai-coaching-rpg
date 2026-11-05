"use client";

import { useEffect, useState } from "react";
import type { PlayerScene, PlayerView } from "@acr/events";
import { formatRemaining, remainingMs, type Clock } from "../lib/clock";

// The current scene's title, goal and time left. The time comes from the view (enteredAt, pausedMs, pausedSince) and the scene's
// time box, read against an injected clock; it freezes while the scene is paused.

const TICK_MS = 1_000;

function useNow(clock: Clock): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.every(TICK_MS, () => setNow(clock.now())), [clock]);
  return now;
}

export type SceneStatusProps = {
  scene: PlayerScene | undefined; index: number; count: number;
  view: Pick<PlayerView, "paused" | "pausedSince" | "scene">; clock: Clock;
};

export function SceneStatus({ scene, index, count, view, clock }: SceneStatusProps) {
  const now = useNow(clock);
  if (!scene || !view.scene) {
    return <div className="top"><b>Between scenes</b></div>;
  }
  const left = remainingMs({ timeBoxMinutes: scene.timeBoxMinutes, enteredAt: view.scene.enteredAt, pausedMs: view.scene.pausedMs, paused: view.paused, pausedSince: view.pausedSince }, now);
  return (
    <div className="top">
      <div className="scene">
        <b>Scene {index + 1} of {count}: {scene.title}</b>
        <p className="muted small">Goal: {scene.goal}</p>
      </div>
      <div className="clock">
        {view.paused ? <span className="pill warn">Paused</span> : null}
        <span className="timer" role="timer"><span className="sr-only">Time left in scene: </span><span className="timer-value">{formatRemaining(left)}</span></span>
      </div>
    </div>
  );
}
