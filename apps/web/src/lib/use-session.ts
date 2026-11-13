"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { applyPlayerEvent, initPlayerView, type PlayerScene, type PlayerView, type PlayerSnapshot, type SessionEvent } from "@acr/events";
import { postJson, type ActionResult } from "./api";
import { isVoiceNoticeCode, MESSAGES, type VoiceNoticeCode } from "./messages";
import { activityAfterEvent, applyActivity, toActivity, type ActivityMap } from "./activity";

// One participant's live session in the browser. The stream is the browser's native EventSource on /api/v1/stream: it reconnects by
// itself after the server's `retry:` and keeps Last-Event-ID, so this hook never runs a reconnect loop of its own. It only closes the
// source on a final event (superseded, signed_out, removed, ended, expired, ai_filled), so the browser does not come back. Identity is the HttpOnly cookie,
// which this code never reads.

/** Lines kept in the browser; older ones drop off (the transcript is copied on each line, so it must stay bounded). */
export const MAX_TRANSCRIPT_LINES = 1_000;

export type EventSourceLike = {
  readyState: number;
  close(): void;
  addEventListener(type: string, fn: (e: MessageEvent) => void): void;
  onerror: ((e: Event) => void) | null;
};
export type EventSourceCtor = new (url: string) => EventSourceLike;
export type SessionDeps = { EventSource: EventSourceCtor; fetch: typeof fetch };

export type PeerRosterEntry = { roleId: string; name?: string; ready: boolean; ai?: true };
export type Consent = { noticeVersion: string; notice: string; given: boolean };
/** The joined fields the page uses (the BFF already picked them; the credential never reaches the browser). */
export type Joined = { roleId: string; brief?: string; privateFacts?: string[]; consent?: Consent; scenes: PlayerScene[]; logIdentity?: string; voice?: SeatVoice };

/** US-0071: this seat's voice state as the runtime sends it (`joined.voice`, a `voice` answer). */
export type VoiceState = "none" | "voice" | "text_only" | "off";
export type SeatVoice = { state: VoiceState; muted: boolean };
export type VoiceChoiceValue = "voice" | "text_only";

export type FinalKind = "superseded" | "signed_out" | "removed" | "ended" | "expired" | "left" | "closed" | "ai_filled";
export type SessionUi = {
  /** connecting: no joined yet; live: joined; reconnecting: dropped, the browser is coming back. */
  conn: "connecting" | "live" | "reconnecting";
  final: { kind: FinalKind; message: string } | null;
  joined: Joined | null;
  view: PlayerView | null;
  roster: PeerRosterEntry[];
  notice: string | null;
  /** US-0071: this seat's voice state; null when the runtime sent none (voice not enabled, or an AI seat): the page shows no voice UI. */
  voice: SeatVoice | null;
  /** The latest private voice notice; `n` counts up on every notice, so a repeated code is announced again. */
  voiceNotice: { code: VoiceNoticeCode; n: number } | null;
  /** The latest of voice_unavailable / voice_available: whether the runtime can capture speech at all (state, not a toast). */
  voiceUnavailable: boolean;
  /** US-0071: counts the `joined` frames (each one is a fresh runtime connection): the voice client reconnects and re-posts its mute on each. */
  joins: number;
  /** US-0082: who is composing a reply (the transient `activity` events), per role; never stored, cleared on a fresh joined. */
  activity: ActivityMap;
};

const FINAL_MESSAGES: Record<FinalKind, string> = {
  superseded: MESSAGES.superseded,
  signed_out: MESSAGES.signedOut,
  removed: MESSAGES.removed,
  ended: MESSAGES.sessionEnded,
  expired: MESSAGES.expired,
  left: MESSAGES.left,
  closed: MESSAGES.streamClosed,
  ai_filled: MESSAGES.aiFilled,
};
const CLOSING_EVENTS = ["superseded", "signed_out", "removed", "ended", "expired", "ai_filled"] as const;

type Action =
  | { type: "open" }
  | { type: "joined"; joined: Joined; state: PlayerSnapshot }
  | { type: "reset"; view: PlayerView }
  | { type: "event"; event: SessionEvent }
  | { type: "roster"; entries: PeerRosterEntry[] }
  | { type: "notice"; text: string }
  | { type: "dropped" }
  | { type: "final"; kind: FinalKind }
  | { type: "consented" }
  | { type: "voice"; voice: SeatVoice }
  | { type: "voice_notice"; code: VoiceNoticeCode }
  | { type: "activity"; roleId: string; state: "thinking" | "idle"; at: number };

export const initialUi: SessionUi = { conn: "connecting", final: null, joined: null, view: null, roster: [], notice: null, voice: null, voiceNotice: null, voiceUnavailable: false, joins: 0, activity: {} };

const capped = (v: PlayerView): PlayerView => (v.transcript.length > MAX_TRANSCRIPT_LINES ? { ...v, transcript: v.transcript.slice(-MAX_TRANSCRIPT_LINES) } : v);

export function sessionReducer(s: SessionUi, a: Action): SessionUi {
  switch (a.type) {
    case "open":
      return { ...s, conn: "connecting", final: null };
    case "joined": {
      // A fresh joined is the runtime's truth for this seat's voice: its state and mute (a released holder comes back unmuted), and
      // "available" (the runtime tells a voice holder who binds while voice is unavailable right after joined).
      const voice = a.joined.voice ?? null;
      // A first join, or another log: start from the snapshot. A rejoin of the same log keeps the view; the replayed events follow
      // (and a reset follows when the replay could not be complete).
      const sameLog = s.joined !== null && s.joined.logIdentity === a.joined.logIdentity;
      const view = s.view !== null && sameLog ? s.view : capped(initPlayerView(a.state));
      // US-0082: a fresh connection starts with no indicator (the runtime re-sends who is thinking right after joined).
      return { ...s, conn: "live", joined: a.joined, view, notice: null, voice, voiceUnavailable: false, joins: s.joins + 1, activity: {} };
    }
    case "reset":
      return { ...s, conn: "live", view: capped(a.view), notice: null };
    case "event":
      // The stream moved on: a server error notice from before is stale.
      return s.view === null ? s : { ...s, view: capped(applyPlayerEvent(s.view, a.event)), notice: null, activity: activityAfterEvent(s.activity, a.event) };
    case "activity":
      return { ...s, activity: applyActivity(s.activity, { roleId: a.roleId, state: a.state }, a.at) };
    case "roster":
      return { ...s, roster: a.entries };
    case "notice":
      return { ...s, notice: a.text };
    case "dropped":
      return s.final ? s : { ...s, conn: "reconnecting" };
    case "final":
      return s.final ? s : { ...s, final: { kind: a.kind, message: FINAL_MESSAGES[a.kind] } };
    case "consented":
      return s.joined?.consent ? { ...s, joined: { ...s.joined, consent: { ...s.joined.consent, given: true } } } : s;
    case "voice":
      return { ...s, voice: a.voice };
    case "voice_notice": {
      const voiceUnavailable = a.code === "voice_unavailable" ? true : a.code === "voice_available" ? false : s.voiceUnavailable;
      return { ...s, voiceNotice: { code: a.code, n: (s.voiceNotice?.n ?? 0) + 1 }, voiceUnavailable };
    }
  }
}

// ---- parsing what the stream sends (the BFF is trusted for shape, but the page must not crash on a bad frame) ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parse(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try { return JSON.parse(data) as unknown; } catch { return null; }
}

const VOICE_STATES: readonly string[] = ["none", "voice", "text_only", "off"] satisfies VoiceState[];
/** Only the four states; `muted` only when it is a boolean (false otherwise). Anything else gives no voice: the page shows no voice UI. */
function toVoice(v: unknown): SeatVoice | null {
  if (!isObj(v) || typeof v.state !== "string" || !VOICE_STATES.includes(v.state)) return null;
  return { state: v.state as VoiceState, muted: v.muted === true };
}

function toJoined(d: unknown): { joined: Joined; state: PlayerSnapshot } | null {
  if (!isObj(d) || typeof d.roleId !== "string" || !isObj(d.state)) return null;
  const st = d.state;
  if (typeof st.lastSeq !== "number" || !Array.isArray(st.transcript)) return null;
  const c = d.consent;
  const consent = isObj(c) && typeof c.noticeVersion === "string" && typeof c.notice === "string" && typeof c.given === "boolean"
    ? { noticeVersion: c.noticeVersion, notice: c.notice, given: c.given } : undefined;
  const scenes = Array.isArray(d.scenes)
    ? d.scenes.filter((x): x is PlayerScene => isObj(x) && typeof x.id === "string" && typeof x.title === "string" && typeof x.goal === "string" && typeof x.timeBoxMinutes === "number")
    : [];
  const joined: Joined = {
    roleId: d.roleId, scenes,
    ...(typeof d.brief === "string" ? { brief: d.brief } : {}),
    ...(strings(d.privateFacts) ? { privateFacts: d.privateFacts } : {}),
    ...(consent ? { consent } : {}),
    ...(typeof d.logIdentity === "string" ? { logIdentity: d.logIdentity } : {}),
  };
  const voice = toVoice(d.voice);
  if (voice) joined.voice = voice;
  return { joined, state: st as unknown as PlayerSnapshot };
}

const toView = (d: unknown): PlayerView | null =>
  isObj(d) && typeof d.lastSeq === "number" && Array.isArray(d.transcript) && Array.isArray(d.injects) && typeof d.paused === "boolean" ? (d as unknown as PlayerView) : null;

// Default deny: only the four known fields are kept, and `ai` only when it is exactly true.
const toRoster = (d: unknown): PeerRosterEntry[] | null =>
  isObj(d) && Array.isArray(d.entries) && d.entries.every((e) => isObj(e) && typeof e.roleId === "string" && typeof e.ready === "boolean" && (e.name === undefined || typeof e.name === "string"))
    ? (d.entries as Record<string, unknown>[]).map((e) => ({
      roleId: e.roleId as string, ready: e.ready as boolean,
      ...(e.name !== undefined ? { name: e.name as string } : {}),
      ...(e.ai === true ? { ai: true as const } : {}),
    })) : null;

/** A 409 `no_stream` means the stream is between connections (the browser is reconnecting): say that, not "open the page first". */
const actionResult = (r: Awaited<ReturnType<typeof postJson>>): ActionResult =>
  r.ok ? { ok: true } : { ok: false, message: r.code === "no_stream" ? MESSAGES.reconnecting : r.message || MESSAGES.generic };

export const streamUrl = (sessionId: string) => `/api/v1/stream?session=${encodeURIComponent(sessionId)}`;

export function useSession(sessionId: string, deps: SessionDeps) {
  const [ui, dispatch] = useReducer(sessionReducer, initialUi);
  const esRef = useRef<EventSourceLike | null>(null);
  const uiRef = useRef(ui);
  uiRef.current = ui;
  const { EventSource: ES, fetch: fetchImpl } = deps;

  // React StrictMode (development only) runs this effect twice: the first EventSource is closed at once by the cleanup.
  useEffect(() => {
    dispatch({ type: "open" });
    const es = new ES(streamUrl(sessionId));
    esRef.current = es;
    let finished = false;
    const finish = (kind: FinalKind) => {
      finished = true;
      es.close();
      dispatch({ type: "final", kind });
    };
    const on = (type: string, fn: (d: unknown) => void) => es.addEventListener(type, (e) => { if (!finished) fn(parse(e.data)); });

    on("joined", (d) => {
      const j = toJoined(d);
      if (!j) return;
      dispatch({ type: "joined", ...j });
      if (j.state.status === "ended") finish("ended");
    });
    on("reset", (d) => { const v = toView(d); if (v) dispatch({ type: "reset", view: v }); });
    on("event", (d) => { if (isObj(d)) dispatch({ type: "event", event: d as unknown as SessionEvent }); });
    on("roster", (d) => { const r = toRoster(d); if (r) dispatch({ type: "roster", entries: r }); });
    // A server-sent `event: error` carries JSON; the browser's own connection error (also named "error") carries no data.
    on("error", (d) => { if (isObj(d)) dispatch({ type: "notice", text: MESSAGES.serverError }); });
    // The BFF ends a stream with `reconnecting` when the runtime is away: the browser comes back after `retry` by itself.
    on("reconnecting", () => dispatch({ type: "dropped" }));
    // US-0071: this player's private voice notice; only the page's own known codes (an unknown one is never shown).
    on("voice_notice", (d) => { if (isObj(d) && isVoiceNoticeCode(d.code)) dispatch({ type: "voice_notice", code: d.code }); });
    // US-0082: who is composing a reply (transient; the page clears it itself after ACTIVITY_EXPIRY_MS).
    on("activity", (d) => { const a = toActivity(d); if (a) dispatch({ type: "activity", roleId: a.roleId, state: a.state, at: Date.now() }); });
    for (const kind of CLOSING_EVENTS) on(kind, () => finish(kind));
    es.onerror = (e) => {
      if (finished) return;
      // `onerror` handles every event named "error", so a server-sent `event: error` (a MessageEvent on an OPEN stream) lands here
      // too: that is a notice, handled above, not a connection problem.
      if (es.readyState === 1 || (typeof MessageEvent !== "undefined" && e instanceof MessageEvent)) return;
      // CLOSED: the browser gave up, which it does only on an HTTP error or a wrong content type (a dropped network stays
      // CONNECTING and retries). From this route that is a 401 (no, expired or foreign cookie), a 403 (cross-site), a 406 (not an
      // event stream) or a 503 (the stream cap is full), and EventSource does not say which. Some are fixed by a reload, so the page
      // says "reload, then ask your facilitator" (a real `signed_out` event keeps its own text); no retry loop of our own.
      if (es.readyState === 2) finish("closed");
      else dispatch({ type: "dropped" });
    };
    return () => { finished = true; es.close(); if (esRef.current === es) esRef.current = null; };
  }, [ES, sessionId]);

  const closeWith = useCallback((kind: FinalKind) => {
    esRef.current?.close();
    dispatch({ type: "final", kind });
  }, []);

  const consent = useCallback(async (): Promise<ActionResult> => {
    const c = uiRef.current.joined?.consent;
    if (!c) return { ok: false, message: MESSAGES.generic };
    const r = actionResult(await postJson("/api/v1/consent", { noticeVersion: c.noticeVersion }, fetchImpl));
    if (r.ok) dispatch({ type: "consented" });
    return r;
  }, [fetchImpl]);

  const withdraw = useCallback(async (): Promise<ActionResult> => {
    const r = actionResult(await postJson("/api/v1/consent", { withdraw: true }, fetchImpl));
    if (r.ok) closeWith("left");
    return r;
  }, [fetchImpl, closeWith]);

  const leave = useCallback(async (): Promise<ActionResult> => {
    const r = actionResult(await postJson("/api/v1/leave", undefined, fetchImpl));
    if (r.ok) closeWith("left");
    return r;
  }, [fetchImpl, closeWith]);

  const voicePost = useCallback(async (body: Record<string, unknown>): Promise<ActionResult> => {
    const r = await postJson("/api/v1/voice", body, fetchImpl);
    if (r.ok) {
      const v = toVoice(r.data);
      if (v) dispatch({ type: "voice", voice: v });
    }
    return actionResult(r);
  }, [fetchImpl]);

  /** `to` (US-0082): the role the line is directed at, chosen from the composer's @ list. */
  const say = useCallback(async (text: string, to?: string): Promise<ActionResult> => {
    const sceneId = uiRef.current.view?.scene?.id;
    return actionResult(await postJson("/api/v1/say", { text, ...(sceneId ? { expectSceneId: sceneId } : {}), ...(to !== undefined ? { to } : {}) }, fetchImpl));
  }, [fetchImpl]);

  /** US-0071: the voice choice. `voice` sends the notice version this seat consented to (the runtime checks it names voice). */
  const chooseVoice = useCallback(async (choice: VoiceChoiceValue): Promise<ActionResult> => {
    const { joined } = uiRef.current;
    if (!joined?.voice) return { ok: false, message: MESSAGES.generic };
    if (choice === "voice" && !joined.consent) return { ok: false, message: MESSAGES.generic };
    return voicePost(choice === "voice" ? { choice, noticeVersion: joined.consent!.noticeVersion } : { choice });
  }, [voicePost]);

  /** US-0071: tells the runtime this seat is muted (it then records nothing) or not; the page's own microphone is VoiceClient's. */
  const setMuted = useCallback((muted: boolean): Promise<ActionResult> => voicePost({ mute: muted }), [voicePost]);

  return { state: ui, consent, withdraw, leave, say, chooseVoice, setMuted };
}
