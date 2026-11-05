"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson } from "../../lib/api";
import {
  failureText,
  parseCodes,
  parseSessions,
  shortId,
  type CodeEntry,
  type ListedSession,
} from "../../lib/console-api";
import { CodesPanel } from "./CodesPanel";

// The facilitator's sessions: a short id, the scenario and the state in words. Open for a running or stopped session, Restart only
// for a stopped one; an ended session has no actions. Codes returned by a restart (a fresh lobby) are shown once.

export type SessionListProps = { fetch?: typeof fetch };

const LABEL = {
  running: { text: "Running", tone: "ok" },
  stopped: { text: "Stopped", tone: "warn" },
  ended: { text: "Ended", tone: "mut" },
} as const;

export function SessionList({ fetch: fetchImpl }: SessionListProps) {
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shown, setShown] = useState<{
    seq: number;
    sessionId: string;
    codes: CodeEntry[];
  } | null>(null);
  const seq = useRef(0); // a new restart never reuses the panel that still holds older codes
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await getJson("/api/v1/console/sessions", fetchImpl);
    if (r.ok) {
      setSessions(parseSessions(r.data));
      setError(null);
    } else setError(failureText(r));
  }, [fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restart(id: string) {
    if (busy.current) return;
    busy.current = true;
    setRestarting(id);
    setActionError(null);
    const r = await postJson(
      `/api/v1/console/sessions/${encodeURIComponent(id)}/restart`,
      {},
      fetchImpl,
    );
    busy.current = false;
    setRestarting(null);
    if (!r.ok) {
      setActionError(failureText(r));
      return;
    }
    const d = (
      typeof r.data === "object" && r.data !== null ? r.data : {}
    ) as Record<string, unknown>;
    const codes = parseCodes(d.codes);
    setShown(
      codes.length > 0 ? { seq: ++seq.current, sessionId: id, codes } : null,
    );
    await load();
  }

  return (
    <div className="stack">
      <div className="listhead">
        <h2 className="s">Sessions</h2>
        <a className="btn pri" href="/console/new">
          New session
        </a>
      </div>
      {shown ? (
        <CodesPanel
          key={shown.seq}
          codes={shown.codes}
          heading={`New join codes for session ${shortId(shown.sessionId)}`}
          onDismiss={() => setShown(null)}
        />
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      {actionError ? (
        <p className="err" role="alert">
          {actionError}
        </p>
      ) : null}
      {sessions === null ? (
        error ? (
          <div>
            <button className="btn" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="muted" role="status">
            Loading sessions…
          </p>
        )
      ) : sessions.length === 0 ? (
        <p className="muted">No sessions yet</p>
      ) : (
        <div className="tablewrap">
          <table className="grid">
            <caption className="sr-only">Sessions</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Scenario</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.sessionId}>
                  <th scope="row">
                    <span className="mono">{shortId(s.sessionId)}</span>
                  </th>
                  <td>{s.scenarioId}</td>
                  <td>
                    <span className={`pill ${LABEL[s.status].tone}`}>
                      {LABEL[s.status].text}
                    </span>
                  </td>
                  <td>
                    <span className="rowactions">
                      {s.status !== "ended" ? (
                        <a
                          href={`/console/${encodeURIComponent(s.sessionId)}`}
                          aria-label={`Open session ${shortId(s.sessionId)}`}
                        >
                          Open
                        </a>
                      ) : null}
                      {s.status === "stopped" ? (
                        <button
                          className="btn"
                          type="button"
                          disabled={restarting !== null}
                          aria-label={`Restart session ${shortId(s.sessionId)}`}
                          onClick={() => void restart(s.sessionId)}
                        >
                          {restarting === s.sessionId
                            ? "Restarting…"
                            : "Restart"}
                        </button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
