"use client";

import { useEffect, useReducer, useRef } from "react";
import { initialState, type PlayerScene, type SessionEvent, type SessionState } from "@acr/events";
import { applyConsoleEvent, viewFromReset, type ConsoleView } from "./console-view";
import { MESSAGES } from "./messages";
import type { EventSourceLike, SessionDeps } from "./use-session";

// The facilitator's live, read-only view of one running session. Like the player hook, the stream is the browser's native EventSource
// (it reconnects by itself with Last-Event-ID), so there is no reconnect loop here. The one thing this hook does itself is a resync: when
// the fold finds a hole in the sequence it closes the source and opens a fresh one with no Last-Event-ID, so the BFF joins from the start.
// Server text is only ever data (the view renders it as text).

/** Resyncs allowed before the view gives up (the fourth gap is the final `lost`). */
export const MAX_GAP_RESYNCS = 3;

/** Mirrors FacilitatorRosterEntry in src/server/wire.ts (client modules import no server module). */
export type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean };
export type ConsoleFinal = "ended" | "stopped" | "expired" | "busy" | "closed" | "lost";
export type ConsoleStreamUi = {
  /** connecting: no joined yet; live: joined; reconnecting: dropped, the browser is coming back. */
  conn: "connecting" | "live" | "reconnecting";
  final: { kind: ConsoleFinal; message: string } | null;
  channel: string | null;
  scenes: PlayerScene[];
  view: ConsoleView | null;
  roster: FacilitatorRosterEntry[];
  notice: string | null;
};
export type ConsoleStreamState = ConsoleStreamUi & { gaps: number; pendingGap: boolean; epoch: number };

const FINAL_MESSAGES: Record<ConsoleFinal, string> = {
  ended: MESSAGES.consoleEnded,
  stopped: MESSAGES.consoleStopped,
  expired: MESSAGES.consoleExpired,
  busy: MESSAGES.consoleBusy,
  closed: MESSAGES.consoleClosed,
  lost: MESSAGES.consoleLost,
};
const SERVER_FINALS = ["ended", "stopped", "expired", "busy"] as const;

type Action =
  | { type: "open" }
  | { type: "clear" }
  | { type: "joined"; channel: string; scenes: PlayerScene[] }
  | { type: "reset"; state: SessionState }
  | { type: "event"; event: SessionEvent }
  | { type: "roster"; entries: FacilitatorRosterEntry[] }
  | { type: "notice"; text: string }
  | { type: "dropped" }
  | { type: "final"; kind: ConsoleFinal };

export const initialConsoleState: ConsoleStreamState = { conn: "connecting", final: null, channel: null, scenes: [], view: null, roster: [], notice: null, gaps: 0, pendingGap: false, epoch: 0 };

export function consoleStreamReducer(s: ConsoleStreamState, a: Action): ConsoleStreamState {
  switch (a.type) {
    case "open":
      return { ...s, conn: "connecting", final: null, pendingGap: false };
    case "clear":
      return { ...initialConsoleState, epoch: s.epoch };
    case "joined":
      if (s.final) return s;
      // Never replaces the view: a joined also follows every ordinary reconnect; a reset says when the view must be replaced.
      return { ...s, conn: "live", channel: a.channel, scenes: a.scenes, notice: null };
    case "reset":
      if (s.final) return s;
      return { ...s, conn: "live", view: viewFromReset(a.state), pendingGap: false, notice: null };
    case "event": {
      if (s.final) return s;
      const label = (roleId: string) => s.roster.find((r) => r.roleId === roleId)?.name ?? roleId;
      const view = applyConsoleEvent(s.view, a.event, { scenes: s.scenes, label });
      if (view === s.view) return s;
      if (view !== null && view.gap) {
        if (s.pendingGap) return { ...s, view };
        const gaps = s.gaps + 1;
        if (gaps > MAX_GAP_RESYNCS) return s.final ? { ...s, view, gaps } : { ...s, view, gaps, pendingGap: true, final: { kind: "lost", message: FINAL_MESSAGES.lost } };
        return { ...s, view, gaps, pendingGap: true, epoch: s.epoch + 1 };
      }
      // An in-order event: the stream recovered, so earlier resyncs no longer count toward `lost`.
      return { ...s, view, gaps: 0, notice: null };
    }
    case "roster":
      if (s.final) return s;
      return { ...s, roster: a.entries };
    case "notice":
      if (s.final) return s;
      return { ...s, notice: a.text };
    case "dropped":
      return s.final ? s : { ...s, conn: "reconnecting" };
    case "final":
      return s.final ? s : { ...s, final: { kind: a.kind, message: FINAL_MESSAGES[a.kind] } };
  }
}

// ---- parsing what the stream sends: the page must not crash on a bad frame ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(data: unknown): unknown {
  if (typeof data !== "string") return null;
  try { return JSON.parse(data) as unknown; } catch { return null; }
}

const isScene = (x: unknown): x is PlayerScene =>
  isObj(x) && typeof x.id === "string" && typeof x.title === "string" && typeof x.goal === "string" && typeof x.timeBoxMinutes === "number";

const toState = (d: unknown): SessionState | null => {
  if (!isObj(d) || !isObj(d.state)) return null;
  const st = d.state;
  return typeof st.lastSeq === "number" && Array.isArray(st.transcript) ? ({ ...initialState(), ...st } as SessionState) : null;
};

const isEntry = (e: unknown): e is FacilitatorRosterEntry =>
  isObj(e) && typeof e.roleId === "string" && typeof e.joined === "boolean" && typeof e.consented === "boolean" && typeof e.connected === "boolean" && (e.name === undefined || typeof e.name === "string");

export const consoleStreamUrl = (sessionId: string) => `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/stream`;

export function useConsoleStream(sessionId: string, deps: SessionDeps, o: { enabled?: boolean } = {}): ConsoleStreamUi {
  const enabled = o.enabled ?? true;
  const [ui, dispatch] = useReducer(consoleStreamReducer, initialConsoleState);
  const { epoch } = ui;
  const esRef = useRef<EventSourceLike | null>(null);
  const openedRef = useRef<{ sessionId: string; epoch: number } | null>(null);
  const { EventSource: ES } = deps;

  useEffect(() => {
    if (!enabled) return;
    // Only a resync (same session, epoch bumped by the reducer) keeps the state; any other open (first, re-enabled, another session) starts clean.
    const last = openedRef.current;
    if (last !== null && !(last.sessionId === sessionId && epoch === last.epoch + 1)) dispatch({ type: "clear" });
    openedRef.current = { sessionId, epoch };
    dispatch({ type: "open" });
    const es = new ES(consoleStreamUrl(sessionId));
    esRef.current = es;
    let finished = false;
    const finish = (kind: ConsoleFinal) => {
      finished = true;
      es.close();
      dispatch({ type: "final", kind });
    };
    const on = (type: string, fn: (d: unknown) => void) => es.addEventListener(type, (e) => { if (!finished) fn(parse(e.data)); });

    on("joined", (d) => {
      if (!isObj(d) || typeof d.channel !== "string") return;
      dispatch({ type: "joined", channel: d.channel, scenes: Array.isArray(d.scenes) ? d.scenes.filter(isScene) : [] });
    });
    on("reset", (d) => { const st = toState(d); if (st) dispatch({ type: "reset", state: st }); });
    on("event", (d) => { if (isObj(d)) dispatch({ type: "event", event: d as unknown as SessionEvent }); });
    on("roster", (d) => {
      if (isObj(d) && Array.isArray(d.entries) && d.entries.every(isEntry)) dispatch({ type: "roster", entries: d.entries });
    });
    // A server-sent `event: error` carries JSON; the browser's own connection error (also named "error") carries no data.
    on("error", (d) => { if (isObj(d)) dispatch({ type: "notice", text: MESSAGES.consoleServerError }); });
    on("reconnecting", () => dispatch({ type: "dropped" }));
    for (const kind of SERVER_FINALS) on(kind, () => finish(kind));
    es.onerror = (e) => {
      if (finished) return;
      // A server-sent `event: error` also lands here (a MessageEvent on an open stream): a notice, handled above, not a connection problem.
      if (es.readyState === 1 || (typeof MessageEvent !== "undefined" && e instanceof MessageEvent)) return;
      // CLOSED: the browser gave up after an HTTP error it does not show us (401, 403, 406, 503). No retry loop of our own.
      if (es.readyState === 2) finish("closed");
      else dispatch({ type: "dropped" });
    };
    return () => { finished = true; es.close(); if (esRef.current === es) esRef.current = null; };
  }, [ES, sessionId, enabled, epoch]);

  // Close paths: `finish` closes the source for finals the server sends and for `closed`; this effect covers the final the reducer reaches
  // itself (`lost`), which no handler sees. Unmount, `enabled` false and a resync are closed by the effect cleanup above.
  useEffect(() => { if (ui.final) esRef.current?.close(); }, [ui.final]);

  return ui;
}
