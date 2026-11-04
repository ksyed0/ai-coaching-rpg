"use client";

import { useEffect, useRef, useState } from "react";
import { realClock, type Clock } from "../../lib/clock";
import { useConsoleStream } from "../../lib/use-console-stream";
import type { SetTimer } from "../../lib/use-readiness";
import type { EventSourceCtor, SessionDeps } from "../../lib/use-session";
import { focusFallback } from "./ConfirmDialog";
import { ConsoleControls } from "./ConsoleControls";
import { LiveView } from "./LiveView";
import { Readiness, type SessionStatus } from "./Readiness";

// One session on /console/<id>: the readiness view (lobby) until the session is running or Start succeeded, then the live view (live).
// This component alone owns the stream's final message: it is shown once, above both views, and survives a return to the lobby.

export type SessionConsoleProps = {
  sessionId: string;
  deps?: Partial<SessionDeps & { setTimer: SetTimer; clock: Clock }>;
};

const browserDeps = (): SessionDeps => ({
  EventSource: globalThis.EventSource as unknown as EventSourceCtor,
  fetch: (input, init) => globalThis.fetch(input, init),
});

export function SessionConsole({ sessionId, deps = {} }: SessionConsoleProps) {
  // Fixed for the page's life: a new EventSource constructor would reopen the stream.
  const [resolved] = useState(() => ({ ...browserDeps(), ...deps, clock: deps.clock ?? realClock }));
  const [mode, setMode] = useState<"lobby" | "live">("lobby");
  const ui = useConsoleStream(sessionId, resolved, { enabled: mode === "live" });
  // The final the user has moved past (a restarted session no longer says it stopped).
  const [dismissed, setDismissed] = useState<object | null>(null);

  const final = ui.final;
  useEffect(() => {
    if (final?.kind === "stopped") setMode("lobby");
  }, [final]);

  // The ended final removes the controls, and with them the End session button that may still hold focus (the command's answer can
  // come before the final): focus that fell to the page goes to the banner. Focus anywhere else is left alone.
  const endedFinal = final?.kind === "ended";
  // Only on the change to ended: a mount that starts ended (or any other re-render) never moves focus.
  const wasEnded = useRef(endedFinal);
  useEffect(() => {
    const became = endedFinal && !wasEnded.current;
    wasEnded.current = endedFinal;
    if (!became) return;
    const at = document.activeElement;
    if (at === null || at === document.body) focusFallback("final")()?.focus();
  }, [endedFinal]);

  const onState = (s: { launcherStatus: string; status: SessionStatus | null }) => {
    if (s.status === "running") setMode("live");
    else if (s.launcherStatus === "running" && final?.kind === "stopped") setDismissed(final);
  };

  const live = mode === "live" ? { status: final?.kind === "ended" ? ("ended" as SessionStatus) : (ui.view?.state.status ?? ("running" as SessionStatus)), roster: ui.roster } : null;
  return (
    <div className="stack">
      <div role="status">
        {final && final !== dismissed ? (
          // tabIndex -1: focus can be moved here (BUG-0022) when the control that was focused goes away with the session.
          <p className="banner warn" tabIndex={-1} data-focus-fallback="final">
            {final.message}
          </p>
        ) : null}
      </div>
      <Readiness
        sessionId={sessionId}
        fetch={resolved.fetch}
        {...(deps.setTimer ? { setTimer: deps.setTimer } : {})}
        live={live}
        stoppedAnnounced={final?.kind === "stopped" && final !== dismissed}
        onState={onState}
        onStarted={() => setMode("live")}
      />
      {mode === "live" ? (
        <LiveView
          ui={ui}
          clock={resolved.clock}
          controls={
            final === null ? (
              <ConsoleControls sessionId={sessionId} ui={ui} fetch={resolved.fetch} />
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}
