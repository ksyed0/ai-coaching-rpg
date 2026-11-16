"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { audioFailureText, deleteAudio, fetchAudioList, playClip, type AudioListView, type ClipView, type DeleteScope, type DeleteView } from "../../lib/console-api";
import { AUDIO_CONSOLE, AUDIO_REFUSALS } from "../../lib/messages";
import { roleLabel } from "../../lib/names";
import type { VoicePanelEntry } from "./VoicePanel";

// A2b-2: the facilitator's Recordings panel for an ended session. Clips are grouped by seat; one plays at a time through one <audio>
// element fed from an object URL (the play route is a Blob fetch, never a media URL). Delete is an inline confirmation, not a modal.
// Every delete outcome reloads the list, so what control did delete shows as deleted, and only a `done` answer ever says "Deleted".
// Names are untrusted text inside <bdi>. Control's own text is never shown: only the fixed sentences in lib/messages.

type Phase = { k: "loading" } | { k: "ready"; data: AudioListView } | { k: "live" } | { k: "account_required" } | { k: "failed"; code: string };
type Reason = "facilitator" | "participant_request";
type Confirm = { scope: DeleteScope; who: string; count: number; ms: number; reason: Reason; opener: HTMLElement };
type Msg = { kind: "status" | "alert"; text: string; pending?: string[]; retry?: { scope: DeleteScope; reason: Reason } };

const key = (c: { role: string; segment: string }) => `${c.role}/${c.segment}`;
const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const pendingText = (reason: string): string => (Object.hasOwn(AUDIO_CONSOLE.pendingReason, reason) ? AUDIO_CONSOLE.pendingReason[reason as keyof typeof AUDIO_CONSOLE.pendingReason] : "try again later");
const isRole = (s: DeleteScope): s is { kind: "role"; role: string } => s.kind === "role";

export function AudioPanel({ sessionId, fetch: f, roster }: { sessionId: string; fetch: typeof fetch; roster: readonly VoicePanelEntry[] }) {
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ k: "loading" });
  const [msg, setMsg] = useState<Msg | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<{ key: string; url: string; label: string } | null>(null);
  const alive = useRef(true);
  const fetching = useRef(false);
  const urlRef = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmBox = useRef<HTMLDivElement>(null);
  const refocus = useRef<DeleteScope | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await fetchAudioList(f, sessionId);
    if (!alive.current) return;
    if (r.ok) {
      setFlipped(new Set());
      setPhase({ k: "ready", data: r.data });
    } else if (r.code === "account_required") setPhase({ k: "account_required" });
    else if (r.code === "session_live") setPhase({ k: "live" });
    else setPhase({ k: "failed", code: r.code });
  }, [f, sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // After a delete's reload: the seat's button when it is still there, otherwise the heading.
  useEffect(() => {
    const scope = refocus.current;
    if (scope === null || phase.k === "loading") return;
    refocus.current = null;
    const sel = isRole(scope) ? `[data-seat-delete="${CSS.escape(scope.role)}"]` : "[data-all-delete]";
    (document.querySelector<HTMLElement>(sel) ?? heading.current)?.focus();
  }, [phase]);

  useEffect(() => {
    if (confirm !== null) confirmBox.current?.focus();
  }, [confirm]);

  useEffect(() => {
    if (current !== null) void audio.current?.play?.()?.catch?.(() => undefined);
  }, [current]);

  const seatName = (role: string) => roster.find((e) => e.roleId === role && e.ai !== true)?.name;
  const hasVoiceSeat = roster.some((e) => e.ai !== true && e.voice !== undefined);

  async function play(c: ClipView, label: string) {
    if (fetching.current) return;
    fetching.current = true;
    setMsg(null);
    audio.current?.pause?.();
    try {
      const r = await playClip(f, sessionId, c.role, c.segment);
      if (!alive.current) return;
      if (!r.ok) {
        if (r.code === "audio_deleted") setFlipped((s) => new Set(s).add(key(c)));
        else setMsg({ kind: "alert", text: audioFailureText(r.code) });
        setCurrent(null);
        if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        return;
      }
      const url = URL.createObjectURL(r.blob);
      if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      setCurrent({ key: key(c), url, label });
    } finally {
      fetching.current = false;
    }
  }

  async function runDelete(scope: DeleteScope, reason: Reason) {
    setBusy(true);
    setMsg(null);
    setConfirm(null);
    const r: DeleteView = await deleteAudio(f, sessionId, scope, reason);
    if (!alive.current) return;
    refocus.current = scope;
    const retry = { scope, reason };
    if (r.state === "done") setMsg({ kind: "status", text: AUDIO_CONSOLE.deleted(r.deleted) });
    else if (r.state === "pending") setMsg({ kind: "alert", text: AUDIO_REFUSALS.delete_pending, pending: r.pending.map((p) => pendingText(p.reason)), retry });
    else if (r.state === "live") setMsg({ kind: "status", text: AUDIO_CONSOLE.stillEnding, retry });
    else if (r.code === "account_required") setMsg(null);
    else setMsg({ kind: "alert", text: audioFailureText(r.code ?? "generic") });
    if (r.state === "refused" && r.code === "account_required") {
      setPhase({ k: "account_required" });
      setBusy(false);
      return;
    }
    await load();
    if (alive.current) setBusy(false);
  }

  if (phase.k === "loading") return null;
  if (phase.k === "ready" && phase.data.clips.length === 0 && !hasVoiceSeat) return null;

  const clips = phase.k === "ready" ? [...phase.data.clips].sort((a, b) => a.startMs - b.startMs) : [];
  const availability = (c: ClipView) => (flipped.has(key(c)) ? "deleted" : c.audio);
  const roles = [...new Set(clips.map((c) => c.role))];
  const live = clips.filter((c) => availability(c) === "available");
  const span = (cs: ClipView[]) => cs.reduce((t, c) => t + (c.endMs - c.startMs), 0);

  const askDelete = (scope: DeleteScope, who: string, cs: ClipView[], opener: HTMLElement) => setConfirm({ scope, who, count: cs.length, ms: span(cs), reason: "facilitator", opener });

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 className="s" id={headingId} ref={heading} tabIndex={-1}>{AUDIO_CONSOLE.heading}</h2>
      <p className="muted small">{AUDIO_CONSOLE.logged}</p>
      <div role="status" className="small">
        {msg?.kind === "status" ? (
          <>
            <p>{msg.text}</p>
            {msg.retry ? <RetryButton disabled={busy} onClick={() => void runDelete(msg.retry!.scope, msg.retry!.reason)} /> : null}
          </>
        ) : null}
      </div>
      {msg?.kind === "alert" ? (
        <div role="alert" className="stack">
          <p className="banner warn">{msg.text}</p>
          {msg.pending ? <ul>{msg.pending.map((p, i) => <li key={i}>Not deleted yet: {p}</li>)}</ul> : null}
          {msg.retry ? <RetryButton disabled={busy} onClick={() => void runDelete(msg.retry!.scope, msg.retry!.reason)} /> : null}
        </div>
      ) : null}

      {phase.k === "account_required" ? <p className="banner warn" role="status">{AUDIO_CONSOLE.needsAccount}</p> : null}
      {phase.k === "live" ? (
        <div className="stack" role="status">
          <p>{AUDIO_CONSOLE.stillEnding}</p>
          <RetryButton disabled={false} onClick={() => void load()} />
        </div>
      ) : null}
      {phase.k === "failed" ? (
        <div className="stack" role="alert">
          <p className="banner warn">{audioFailureText(phase.code)}</p>
          <RetryButton disabled={false} onClick={() => void load()} />
        </div>
      ) : null}

      {phase.k === "ready" ? (
        <>
          {phase.data.textUnavailable ? <p className="muted small">{AUDIO_CONSOLE.textUnavailable}</p> : null}
          {phase.data.tooLongForText ? <p className="muted small">{AUDIO_CONSOLE.tooLongForText}</p> : null}
          {clips.length === 0 ? <p className="muted">{AUDIO_CONSOLE.none}</p> : null}
          {roles.map((role) => {
            const cs = clips.filter((c) => c.role === role);
            const mine = cs.filter((c) => availability(c) === "available");
            const name = seatName(role);
            const who = name !== undefined && name !== "" ? name : roleLabel(role);
            return (
              <div className="stack" key={role}>
                <h3 className="code-role">
                  {name !== undefined && name !== "" ? <><bdi>{name}</bdi> <span className="muted">(<bdi>{roleLabel(role)}</bdi>)</span></> : <bdi>{roleLabel(role)}</bdi>}
                </h3>
                {mine.length > 0 ? (
                  <div>
                    <button className="btn" type="button" data-seat-delete={role} disabled={busy} aria-label={`Delete audio for ${who}`} onClick={(e) => askDelete({ kind: "role", role }, who, mine, e.currentTarget)}>
                      Delete this seat&apos;s audio
                    </button>
                  </div>
                ) : null}
                <ul className="codes">
                  {cs.map((c) => {
                    const label = `${who}, ${mmss(c.startMs)}`;
                    const state = availability(c);
                    return (
                      <li className="code-row" key={key(c)}>
                        <span className="mono">{mmss(c.startMs)}</span>
                        <span>{c.text !== undefined && c.text !== "" ? c.text : AUDIO_CONSOLE.noTranscript}</span>
                        {state === "available" ? (
                          <button className="btn" type="button" aria-label={`Play clip, ${label}`} onClick={() => void play(c, label)}>
                            {current?.key === key(c) ? "Playing" : "Play"}
                          </button>
                        ) : (
                          <span className="muted small">{state === "deleted" ? AUDIO_CONSOLE.audioDeleted : AUDIO_CONSOLE.audioMissing}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {live.length > 0 ? (
            <div>
              <button className="btn" type="button" data-all-delete disabled={busy} onClick={(e) => askDelete({ kind: "session" }, "", live, e.currentTarget)}>
                Delete all audio
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {current !== null ? <audio ref={audio} controls src={current.url} aria-label={`Recording, ${current.label}`} /> : null}

      {confirm ? (
        <div role="group" aria-label="Confirm delete" className="stack" tabIndex={-1} ref={confirmBox}>
          <p>{isRole(confirm.scope) ? AUDIO_CONSOLE.confirmRole(confirm.count, confirm.ms, confirm.who) : AUDIO_CONSOLE.confirmSession(confirm.count, confirm.ms)}</p>
          <fieldset>
            <legend>Reason</legend>
            {(["facilitator", "participant_request"] as const).map((r) => (
              <label key={r}>
                <input type="radio" name={`${headingId}-reason`} value={r} checked={confirm.reason === r} onChange={() => setConfirm({ ...confirm, reason: r })} /> {AUDIO_CONSOLE.reasonLabel[r]}
              </label>
            ))}
          </fieldset>
          <div className="rowactions">
            <button className="btn danger" type="button" disabled={busy} onClick={() => void runDelete(confirm.scope, confirm.reason)}>
              Delete audio
            </button>
            <button className="btn" type="button" onClick={() => { const o = confirm.opener; setConfirm(null); o.focus(); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RetryButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button className="btn" type="button" disabled={disabled} onClick={onClick}>
      Retry
    </button>
  );
}
