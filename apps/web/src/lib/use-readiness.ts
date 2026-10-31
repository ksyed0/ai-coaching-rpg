"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "./api";
import { parseReadiness, type Readiness } from "./console-api";

// Polls the facilitator's readiness answer. The next poll is scheduled only after the previous one finished; the last good value is
// kept across failures (the page shows "Reconnecting" over it); failures back off 2 s, 4 s, 8 s ... up to 30 s and a success resets
// that. Polling stops when the session ended and when the facilitator is signed out. The timer is injected so tests never sleep.

/** Schedules `fn` after `ms`; returns the function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export const realSetTimer: SetTimer = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export const MAX_BACKOFF_MS = 30_000;

/** The wait after the n-th failure in a row (n >= 1): interval, 2x, 4x ... capped. */
export const backoffMs = (intervalMs: number, failures: number): number =>
  Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** (failures - 1));

export type UseReadinessOptions = {
  intervalMs?: number;
  setTimer?: SetTimer;
  fetch?: typeof fetch;
};
export type ReadinessState = {
  data: Readiness | null;
  reconnecting: boolean;
  signedOut: boolean;
  refresh: () => void;
};

export function useReadiness(
  sessionId: string,
  opts: UseReadinessOptions = {},
): ReadinessState {
  const { intervalMs = 2000, setTimer = realSetTimer, fetch: fetchImpl } = opts;
  const [data, setData] = useState<Readiness | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const pollNow = useRef<() => void>(() => {});
  // Options are read once per mount: a new timer or fetch must not restart the loop.
  const latest = useRef({ setTimer, fetchImpl, intervalMs });
  latest.current = { setTimer, fetchImpl, intervalMs };

  useEffect(() => {
    let alive = true;
    let failures = 0;
    let running = false;
    let cancel: (() => void) | null = null;
    const url = `/api/v1/console/sessions/${encodeURIComponent(sessionId)}/readiness`;

    const schedule = (ms: number) => {
      cancel = latest.current.setTimer(() => {
        cancel = null;
        void poll();
      }, ms);
    };
    async function poll(): Promise<void> {
      if (!alive || running) return;
      running = true;
      cancel?.();
      cancel = null;
      const r = await getJson(url, latest.current.fetchImpl);
      running = false;
      if (!alive) return;
      if (r.ok) {
        const parsed = parseReadiness(r.data);
        if (parsed) {
          failures = 0;
          setReconnecting(false);
          setData(parsed);
          if (parsed.launcherStatus === "ended" || parsed.status === "ended")
            return; // nothing more will change
          schedule(latest.current.intervalMs);
          return;
        }
      } else if (r.status === 401 || r.status === 403) {
        setSignedOut(true);
        setReconnecting(false);
        return;
      }
      failures += 1;
      setReconnecting(true);
      schedule(backoffMs(latest.current.intervalMs, failures));
    }
    pollNow.current = () => {
      void poll();
    };
    void poll();
    return () => {
      alive = false;
      cancel?.();
      cancel = null;
      pollNow.current = () => {};
    };
  }, [sessionId]);

  const refresh = useCallback(() => pollNow.current(), []);
  return { data, reconnecting, signedOut, refresh };
}
