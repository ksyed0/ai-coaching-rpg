"use client";

import { useId, useMemo } from "react";
import type { Clock } from "../../lib/clock";
import { talkRows } from "../../lib/console-view";
import { MESSAGES } from "../../lib/messages";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";
import { SceneStatus } from "../SceneStatus";
import { ConsoleTimeline } from "./ConsoleTimeline";
import { WordsSpoken } from "./WordsSpoken";

// The facilitator's read-only live view of a session: status, scene and timer, the transcript with notices and alerts, and words spoken.
// It sends nothing and has no control. All runtime text below is rendered as text children only.

export type LiveViewProps = { ui: ConsoleStreamUi; clock: Clock };

export function LiveView({ ui, clock }: LiveViewProps) {
  const id = useId();
  const { view } = ui;
  const state = view?.state ?? null;
  const names = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of ui.roster) if (r.name !== undefined && r.name !== "") out[r.roleId] = r.name;
    return out;
  }, [ui.roster]);
  const playerRoles = useMemo(
    () => new Set(Object.entries(state?.roles ?? {}).filter(([, r]) => r.kind === "player").map(([k]) => k)),
    [state?.roles],
  );
  const rows = useMemo(() => (state ? talkRows(state) : []), [state]);

  const status = !state || state.status === "idle" ? "Not started" : state.status === "ended" ? "Ended" : state.paused ? "Paused" : "Running";
  const cur = state?.currentScene ?? null;
  const index = cur ? ui.scenes.findIndex((s) => s.id === cur.id) : -1;
  const sceneView = {
    paused: state?.paused ?? false,
    pausedSince: state?.pausedSince ?? null,
    scene: cur && { id: cur.id, enteredAt: cur.enteredAt, pausedMs: cur.pausedMs },
  };

  return (
    <div className="liveview">
      <section aria-labelledby={id} className="card">
        <div className="listhead">
          <h2 className="s" id={id}>Live session</h2>
          <span className={status === "Running" ? "pill ok" : status === "Paused" ? "pill warn" : "pill mut"}>{status}</span>
        </div>
        {ui.conn === "reconnecting" ? <p className="banner warn" role="status">{MESSAGES.consoleReconnecting}</p> : null}
        {ui.notice ? <p className="banner warn" role="status">{ui.notice}</p> : null}
        {ui.final ? <p className="banner warn" role="status">{ui.final.message}</p> : null}
        <SceneStatus scene={index >= 0 ? ui.scenes[index] : undefined} index={index} count={ui.scenes.length} view={sceneView} clock={clock} />
      </section>
      <div>
        <h2 className="s">Transcript and notices</h2>
        <ConsoleTimeline entries={view?.timeline ?? []} names={names} playerRoles={playerRoles} />
      </div>
      <WordsSpoken rows={rows} names={names} />
    </div>
  );
}
