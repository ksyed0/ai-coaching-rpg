"use client";

import { useEffect, useRef, useState } from "react";
import { realClock, type Clock } from "../lib/clock";
import { MESSAGES } from "../lib/messages";
import { roleLabel } from "../lib/names";
import { useSession, type EventSourceCtor, type SessionDeps, type SessionUi, type VoiceChoiceValue } from "../lib/use-session";
import type { ActionResult } from "../lib/api";
import type { AudioContextLike, Caf, MediaStreamLike, Raf } from "../lib/mic-level";
import { tokenFetcher, VoiceClient, type BrowserRoom } from "../lib/voice-client";
import { MicButton, useVoiceClientState } from "./MicButton";
import { MicCheck } from "./MicCheck";
import { AppHeader } from "./AppHeader";
import { BriefPanel } from "./BriefPanel";
import { ConsentPanel } from "./ConsentPanel";
import { Roster } from "./Roster";
import { SceneEndedDialog } from "./SceneEndedDialog";
import { SceneTalk } from "./SceneTalk";
import { SceneStatus } from "./SceneStatus";
import type { StatusKind } from "./StatusChip";
import { TitleBlock } from "./TitleBlock";
import { Transcript } from "./Transcript";
import { VoiceChoice } from "./VoiceChoice";
import { VoiceNotices } from "./VoiceNotices";

// The participant's page for one session: lobby (consent and the room), then the scene, then the end. It opens the stream first;
// consent and every other action go over that stream's runtime connection, so they are offered only once `joined` has arrived.

/** US-0071: what the voice UI needs from the browser, injectable for tests. */
export type VoiceDeps = {
  /** Whether this page can open a microphone at all: a secure context (https, or a loopback address) with mediaDevices. */
  secure: () => boolean;
  /** The LiveKit room; the default loads livekit-client by a dynamic import, on the first "Join with voice" only. */
  loadRoom: () => Promise<BrowserRoom>;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStreamLike>;
  audioContext: () => AudioContextLike;
  raf: Raf;
  caf: Caf;
};
export type SessionScreenProps = {
  sessionId: string;
  /** US-0071: whether the web server has LiveKit (`config.livekitUrl !== undefined`, from the server component); nothing else of the config. */
  voiceTransport?: boolean;
  deps?: Partial<SessionDeps> & { clock?: Clock; voice?: Partial<VoiceDeps> };
};

const browserDeps = (): SessionDeps => ({
  EventSource: globalThis.EventSource as unknown as EventSourceCtor,
  fetch: (input, init) => globalThis.fetch(input, init),
});

const browserVoice = (): VoiceDeps => ({
  secure: () => typeof window !== "undefined" && window.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === "function",
  loadRoom: () => import("../lib/livekit-room-browser").then((m) => m.createBrowserRoom()),
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  audioContext: () => new AudioContext(),
  raf: (fn) => requestAnimationFrame(fn),
  caf: (id) => cancelAnimationFrame(id),
});

export function SessionScreen({ sessionId, voiceTransport = false, deps = {} }: SessionScreenProps) {
  // Fixed for the page's life: a new EventSource constructor would reopen the stream.
  const [resolved] = useState(() => ({ ...browserDeps(), ...deps, clock: deps.clock ?? realClock, voice: { ...browserVoice(), ...deps.voice } }));
  const s = useSession(sessionId, resolved);
  const { conn, final, joined, view, roster, notice } = s.state;
  const voice = useVoice(sessionId, s, resolved);
  const voiceUi: VoiceUi = { ui: s.state, voiceTransport, deps: resolved.voice, ...voice };
  // US-0080: the scene-ended dialog the person closed, kept here because the end of the session remounts the scene view.
  const [dismissedExit, setDismissedExit] = useState<number | null>(null);
  const exitDialog: ExitDialog = { dismissed: dismissedExit, onDismiss: setDismissedExit };

  const status: StatusKind = conn === "reconnecting" ? "reconnecting"
    : !view ? "connecting"
    : view.status === "ended" || final?.kind === "ended" ? "ended"
    : view.status === "idle" ? "lobby"
    : view.paused ? "paused" : "running";

  return (
    <>
      <AppHeader status={final && final.kind !== "ended" ? undefined : status} roleId={joined?.roleId} />
      <main className="page">
        {/* US-0071: one polite region for the private voice notices, mounted once for the page (lobby, scene and end alike). */}
        {s.state.voice ? <VoiceNotices notice={s.state.voiceNotice} /> : null}
        {/* The end keeps what was said readable (Scene shows the end notice above the transcript); other finals replace the page. */}
        {final && (final.kind === "ended" && joined && view) ? (
          <Scene state={s.state} clock={resolved.clock} onSay={s.say} voice={voiceUi} exitDialog={exitDialog} />
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
              <Lobby joined={joined} roster={roster} onConsent={s.consent} onWithdraw={s.withdraw} onLeave={s.leave} voice={voiceUi} />
            ) : (
              <Scene state={s.state} clock={resolved.clock} onSay={s.say} voice={voiceUi} exitDialog={exitDialog} />
            )}
          </>
        )}
      </main>
    </>
  );
}

/** A final state with nothing worth keeping on screen. No retry button: each of these is final (the browser must not come back). */
function FinalScreen({ kind, message }: { kind: string; message: string }) {
  const title = kind === "ended" ? "The session has ended" : kind === "left" ? "You have left" : kind === "superseded" ? "Open in another tab" : kind === "closed" ? "Connection closed" : kind === "removed" ? "Removed from the session" : kind === "ai_filled" ? "Role filled by an AI player" : "Signed out";
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

type VoiceUi = {
  ui: SessionUi; voiceTransport: boolean; deps: VoiceDeps; client: VoiceClient;
  onChoose: (c: VoiceChoiceValue) => Promise<ActionResult>; onJoin: () => Promise<ActionResult>; onOptOut: () => Promise<ActionResult>;
  registerCheck: (stop: (() => void) | null) => void;
};

/**
 * US-0071 (A1b Task 15): the page's voice connection. The VoiceClient object is cheap and made once; livekit-client itself is loaded
 * only by the first "Join with voice". It leaves the room on every final stream event, when the session ends in the view, on the
 * person's own leave and withdraw (both are final `left`), on `pagehide`, when the seat stops being a voice seat, when the session id
 * changes and on unmount; it leaves when the runtime stream drops, and on each fresh `joined` it reconnects once with a fresh token and
 * re-posts a local mute. The microphone is never opened here: only MicCheck's click and "Join with voice" open it.
 */
function useVoice(sessionId: string, s: ReturnType<typeof useSession>, deps: { fetch: typeof fetch; voice: VoiceDeps }) {
  const setMutedRef = useRef(s.setMuted);
  setMutedRef.current = s.setMuted;
  const [client] = useState(() => new VoiceClient({
    room: () => deps.voice.loadRoom(),
    fetchToken: tokenFetcher(deps.fetch),
    postMute: (muted) => setMutedRef.current(muted),
  }));
  const state = useVoiceClientState(client);
  const checkStop = useRef<(() => void) | null>(null);
  const { final, conn, joins, voice, view } = s.state;

  useEffect(() => { if (final) void client.leave(); }, [client, final]);
  useEffect(() => { if (view?.status === "ended") void client.leave(); }, [client, view?.status]);
  // No connection without the controls to see and stop it: the voice UI shows only for a consented voice seat.
  const consented = s.state.joined?.consent?.given === true;
  useEffect(() => { if (voice?.state !== "voice" || !consented) void client.leave(); }, [client, voice?.state, consented]);
  useEffect(() => { if (conn === "reconnecting") void client.dropped(); }, [client, conn]);
  useEffect(() => { if (joins > 0) void client.rejoined(); }, [client, joins]);
  useEffect(() => () => { void client.leave(); }, [client, sessionId]);
  useEffect(() => {
    const hide = () => { void client.leave(); };
    window.addEventListener("pagehide", hide);
    return () => window.removeEventListener("pagehide", hide);
  }, [client]);

  const chooseVoice = s.chooseVoice;
  return {
    client, state,
    // "Text only" while connected: leave the room first, then tell the runtime.
    onChoose: async (c: VoiceChoiceValue) => { if (c === "text_only") await client.leave(); return chooseVoice(c); },
    // One microphone capture at a time: the check's tracks are stopped before the join opens the microphone again.
    onJoin: () => { checkStop.current?.(); checkStop.current = null; return client.join(); },
    onOptOut: () => chooseVoice("text_only"),
    registerCheck: (stop: (() => void) | null) => { checkStop.current = stop; },
  };
}

/**
 * US-0071: the voice part of the lobby and the scene: only when the runtime sent this seat a voice state that is not `off`, and only once
 * the seat has consented (the opt-in needs the notice the seat agreed to). With voice not enabled this renders nothing.
 */
function VoiceArea({ v, lobby }: { v: VoiceUi; lobby: boolean }) {
  const textRef = useRef<HTMLInputElement>(null);
  const voice = v.ui.voice;
  if (!voice || voice.state === "off" || v.ui.joined?.consent?.given !== true) return null;
  const secure = v.deps.secure();
  const usable = voice.state === "voice" && secure && v.voiceTransport;
  const view = v.ui.view;
  const idle = v.client.state === "idle" || v.client.state === "failed";
  return (
    <>
      <VoiceChoice state={voice.state} voiceTransport={v.voiceTransport} secure={secure} onChoose={v.onChoose} textRef={textRef} />
      {usable && lobby && idle ? <MicCheck deps={v.deps} register={v.registerCheck} /> : null}
      {usable ? (
        <MicButton client={v.client} started={view !== null && view.status !== "idle"} paused={view?.paused ?? false} inScene={!!view?.scene}
          unavailable={v.ui.voiceUnavailable} serverMuted={voice.muted} onJoin={v.onJoin}
          // The Stop button disappears with the opt-out: the focus goes to the choice that is now saved.
          onOptOut={async () => { const r = await v.onOptOut(); if (r.ok) textRef.current?.focus(); return r; }} />
      ) : null}
    </>
  );
}

function Lobby({ joined, roster, onConsent, onWithdraw, onLeave, voice }: { joined: Joined; roster: ReturnType<typeof useSession>["state"]["roster"]; onConsent: Action; onWithdraw: Action; onLeave: Action; voice: VoiceUi }) {
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
          <VoiceArea v={voice} lobby />
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

type ExitDialog = { dismissed: number | null; onDismiss: (seq: number) => void };

function Scene({ state, clock, onSay, voice, exitDialog }: { state: ReturnType<typeof useSession>["state"]; clock: Clock; onSay: (text: string, to?: string) => Promise<ActionResult>; voice: VoiceUi; exitDialog: ExitDialog }) {
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
      {/* US-0080: inform-only, not modal: the next scene runs underneath and the say box keeps its draft. */}
      <SceneEndedDialog view={view} scenes={joined.scenes} ended={ended} {...exitDialog} />
      <div className="body row">
        <section className="col col-main" aria-labelledby="transcript-h">
          <h2 className="s" id="transcript-h">Transcript</h2>
          <Transcript lines={view.transcript} selfRole={joined.roleId} names={names} playerRoles={playerRoles} aiRoles={new Set(view.aiRoles)} />
          {ended ? null : <SceneTalk selfRole={joined.roleId} view={view} activity={state.activity} names={names} playerRoles={playerRoles} disabledReason={disabledReason} onSay={onSay} />}
        </section>
        <div className="col">
          {joined.consent?.given ? (
            // Read-only: a seat that was already consented when this person joined (a rebind after a reissue) never saw the notice here.
            <details className="card">
              <summary>Consent notice</summary>
              <p className="prose">{joined.consent.notice}</p>
              <p className="muted small">This seat agreed to a consent notice earlier. The text above is the current notice.</p>
            </details>
          ) : null}
          {ended ? null : <VoiceArea v={voice} lobby={false} />}
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
