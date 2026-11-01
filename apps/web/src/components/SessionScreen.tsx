"use client";

import { useState } from "react";
import { realClock, type Clock } from "../lib/clock";
import { MESSAGES } from "../lib/messages";
import { roleLabel } from "../lib/names";
import { useSession, type EventSourceCtor, type SessionDeps } from "../lib/use-session";
import type { ActionResult } from "../lib/api";
import { AppHeader } from "./AppHeader";
import { BriefPanel } from "./BriefPanel";
import { ConsentPanel } from "./ConsentPanel";
import { Roster } from "./Roster";
import { SayBox } from "./SayBox";
import { SceneStatus } from "./SceneStatus";
import type { StatusKind } from "./StatusChip";
import { TitleBlock } from "./TitleBlock";
import { Transcript } from "./Transcript";

// The participant's page for one session: lobby (consent and the room), then the scene, then the end. It opens the stream first;
// consent and every other action go over that stream's runtime connection, so they are offered only once `joined` has arrived.

export type SessionScreenProps = { sessionId: string; deps?: Partial<SessionDeps> & { clock?: Clock } };

const browserDeps = (): SessionDeps => ({
  EventSource: globalThis.EventSource as unknown as EventSourceCtor,
  fetch: (input, init) => globalThis.fetch(input, init),
});

export function SessionScreen({ sessionId, deps = {} }: SessionScreenProps) {
  // Fixed for the page's life: a new EventSource constructor would reopen the stream.
  const [resolved] = useState(() => ({ ...browserDeps(), ...deps, clock: deps.clock ?? realClock }));
  const s = useSession(sessionId, resolved);
  const { conn, final, joined, view, roster, notice } = s.state;

  const status: StatusKind = conn === "reconnecting" ? "reconnecting"
    : !view ? "connecting"
    : view.status === "ended" || final?.kind === "ended" ? "ended"
    : view.status === "idle" ? "lobby"
    : view.paused ? "paused" : "running";

  return (
    <>
      <AppHeader status={final && final.kind !== "ended" ? undefined : status} roleId={joined?.roleId} />
      <main className="page">
        {/* The end keeps what was said readable (Scene shows the end notice above the transcript); other finals replace the page. */}
        {final && (final.kind === "ended" && joined && view) ? (
          <Scene state={s.state} clock={resolved.clock} onSay={s.say} />
        ) : final ? (
          <FinalScreen kind={final.kind} message={final.message} />
        ) : (
          <>
            {conn === "reconnecting" ? <p className="banner warn" role="status">{MESSAGES.reconnecting}</p> : null}
            {notice ? <p className="banner warn" role="status">{notice}</p> : null}
            {!joined || !view ? (
              <>
                <TitleBlock title="Your session" lede="Opening the live connection to the room." />
                <p className="body muted" role="status">{MESSAGES.connecting}</p>
              </>
            ) : view.status === "idle" ? (
              <Lobby joined={joined} roster={roster} onConsent={s.consent} onWithdraw={s.withdraw} onLeave={s.leave} />
            ) : (
              <Scene state={s.state} clock={resolved.clock} onSay={s.say} />
            )}
          </>
        )}
      </main>
    </>
  );
}

/** A final state with nothing worth keeping on screen. No retry button: each of these is final (the browser must not come back). */
function FinalScreen({ kind, message }: { kind: string; message: string }) {
  const title = kind === "ended" ? "The session has ended" : kind === "left" ? "You have left" : kind === "superseded" ? "Open in another tab" : kind === "closed" ? "Connection closed" : "Signed out";
  return (
    <>
      <TitleBlock title={title} lede="This page no longer updates." />
      <div className="body">
        <p className="banner warn" role="status">{message}</p>
      </div>
    </>
  );
}

type Joined = NonNullable<ReturnType<typeof useSession>["state"]["joined"]>;
type Action = () => Promise<ActionResult>;

function Lobby({ joined, roster, onConsent, onWithdraw, onLeave }: { joined: Joined; roster: ReturnType<typeof useSession>["state"]["roster"]; onConsent: Action; onWithdraw: Action; onLeave: Action }) {
  const me = roster.find((e) => e.roleId === joined.roleId);
  const given = joined.consent?.given ?? false;
  return (
    <>
      <TitleBlock title="Join your session" lede="Confirm who you are, give consent, and wait for the facilitator to start." />
      <div className="body row">
        <div className="col col-main">
          <dl className="card seatcard">
            <dt>Your role</dt>
            <dd>{roleLabel(joined.roleId)}</dd>
            <dt>Your name</dt>
            <dd>{me?.name ?? "Not shown yet"}</dd>
          </dl>
          {joined.consent ? (
            <ConsentPanel noticeVersion={joined.consent.noticeVersion} notice={joined.consent.notice} given={given} onConsent={onConsent} onWithdraw={onWithdraw} />
          ) : null}
          {!given ? <LeaveButton onLeave={onLeave} /> : null}
        </div>
        <section className="col" aria-labelledby="room-h">
          <h2 className="s" id="room-h">Who is in the room</h2>
          <Roster entries={roster} selfRole={joined.roleId} />
          {given ? <p className="banner warn" role="status">{MESSAGES.waiting}</p> : null}
        </section>
      </div>
    </>
  );
}

function LeaveButton({ onLeave }: { onLeave: Action }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function leave() {
    setPending(true);
    setError(null);
    const r = await onLeave();
    setPending(false);
    if (!r.ok) setError(r.message);
  }
  return (
    <div className="actions">
      <button className="btn" type="button" disabled={pending} onClick={leave}>Leave</button>
      {error ? <p className="err" role="alert">{error}</p> : null}
    </div>
  );
}

function Scene({ state, clock, onSay }: { state: ReturnType<typeof useSession>["state"]; clock: Clock; onSay: (text: string) => Promise<ActionResult> }) {
  const joined = state.joined!;
  const view = state.view!;
  const ended = view.status === "ended" || state.final?.kind === "ended";
  const index = view.scene ? joined.scenes.findIndex((x) => x.id === view.scene!.id) : -1;
  const names: Record<string, string> = {};
  for (const e of state.roster) if (e.name !== undefined) names[e.roleId] = e.name;
  const playerRoles = new Set(state.roster.map((e) => e.roleId));
  playerRoles.add(joined.roleId);
  const disabledReason = ended ? MESSAGES.sessionEnded : state.conn !== "live" ? MESSAGES.sayOffline : view.paused ? MESSAGES.paused : !view.scene ? MESSAGES.notStarted : null;
  return (
    <>
      <TitleBlock title={ended ? "The session has ended" : "Play the scene"} lede={ended ? "This page no longer updates. What was said stays below." : "Talk to the room. Your brief and any updates stay beside the transcript."} />
      {ended ? <p className="banner warn" role="status">{MESSAGES.sessionEnded}</p> : <SceneStatus scene={index >= 0 ? joined.scenes[index] : undefined} index={index} count={joined.scenes.length} view={view} clock={clock} />}
      {ended && view.ended?.message ? <p className="body">Message from the facilitator: {view.ended.message}</p> : null}
      <div className="body row">
        <section className="col col-main" aria-labelledby="transcript-h">
          <h2 className="s" id="transcript-h">Transcript</h2>
          <Transcript lines={view.transcript} selfRole={joined.roleId} names={names} playerRoles={playerRoles} />
          {ended ? null : <SayBox disabledReason={disabledReason} onSay={onSay} />}
        </section>
        <div className="col">
          {joined.consent?.given ? (
            // Read-only: a seat that was already consented when this person joined (a rebind after a reissue) never saw the notice here.
            <details className="card">
              <summary>Consent notice</summary>
              <p className="prose">{joined.consent.notice}</p>
              <p className="muted small">Notice {joined.consent.noticeVersion}. The seat has agreed to it.</p>
            </details>
          ) : null}
          <BriefPanel roleId={joined.roleId} brief={joined.brief} privateFacts={joined.privateFacts} injects={view.injects} />
          <section aria-labelledby="room-h2">
            <h2 className="s" id="room-h2">Who is in the room</h2>
            <Roster entries={state.roster} selfRole={joined.roleId} />
          </section>
        </div>
      </div>
    </>
  );
}
