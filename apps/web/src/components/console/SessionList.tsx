"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, postJson } from "../../lib/api";
import {
  failureText,
  parseAccounts,
  parseCodes,
  parseSessions,
  type AdminAccount,
  shortId,
  type CodeEntry,
  type ListedSession,
} from "../../lib/console-api";
import { CodesPanel } from "./CodesPanel";

// The facilitator's sessions: a short id, the scenario and the state in words. Open for a running or stopped session, Restart only
// for a stopped one; an ended session has no actions. Codes returned by a restart (a fresh lobby) are shown once.

export type SessionListProps = {
  fetch?: typeof fetch;
  /** US-0083: an admin also sees each session's owner and can assign it; a facilitator sees neither. */
  role?: "admin" | "facilitator";
  /** A shared-secret sign-in acts as admin for sessions but cannot manage accounts, so it gets no owner controls. */
  legacy?: boolean;
};

const LABEL = {
  running: { text: "Running", tone: "ok" },
  stopped: { text: "Stopped", tone: "warn" },
  ended: { text: "Ended", tone: "mut" },
} as const;

export function SessionList({ fetch: fetchImpl, role = "facilitator", legacy = false }: SessionListProps) {
  const admin = role === "admin" && !legacy;
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [shown, setShown] = useState<{
    seq: number;
    sessionId: string;
    codes: CodeEntry[];
  } | null>(null);
  // US-0083 (admin only): the accounts an owner is chosen from, the choice made in each row and the one assignment in flight.
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<string | null>(null);
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

  useEffect(() => {
    if (!admin) return;
    void (async () => {
      const r = await getJson("/api/v1/console/admin/accounts", fetchImpl);
      if (r.ok) {
        setAccounts(parseAccounts(r.data));
        setAccountsError(false);
      } else setAccountsError(true);
    })();
  }, [admin, fetchImpl]);

  const active = (accounts ?? []).filter((a) => a.status === "active");
  const ownerName = (owner: string | undefined) =>
    owner === undefined ? "Unassigned" : (accounts?.find((a) => a.id === owner)?.name ?? "Unknown account");
  /** The current owner when it is not an active account (revoked, invited, gone): it stays an option so the select shows the truth. */
  const inactiveOwner = (owner: string | undefined): { id: string; label: string } | null => {
    if (owner === undefined || accounts === null || active.some((a) => a.id === owner)) return null;
    const a = accounts.find((x) => x.id === owner);
    return { id: owner, label: a ? `${a.name} (${a.status})` : "Unknown account" };
  };

  async function assign(id: string, current: string | undefined) {
    if (busy.current) return;
    busy.current = true;
    setAssigning(id);
    setActionError(null);
    const value = choice[id] ?? current ?? "";
    const r = await postJson(
      `/api/v1/console/sessions/${encodeURIComponent(id)}/owner`,
      { owner: value === "" ? null : value },
      fetchImpl,
    );
    busy.current = false;
    setAssigning(null);
    if (!r.ok) {
      setActionError(r.status === 400 && r.message !== "" ? r.message : failureText(r));
      return;
    }
    setChoice((prev) => {
      const { [id]: _done, ...rest } = prev;
      return rest;
    });
    await load();
  }

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
          sessionId={shown.sessionId}
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
      {admin && accountsError ? (
        <p className="err" role="alert">
          The list of accounts could not be loaded, so sessions cannot be assigned.
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
                {admin ? <th scope="col">Owner</th> : null}
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
                  {admin ? (
                    <td>
                      <bdi>{ownerName(s.owner)}</bdi>
                      <span className="rowactions">
                        <select
                          className="t"
                          aria-label={`Owner of session ${shortId(s.sessionId)}`}
                          value={choice[s.sessionId] ?? s.owner ?? ""}
                          disabled={assigning !== null}
                          onChange={(e) => setChoice((prev) => ({ ...prev, [s.sessionId]: e.target.value }))}
                        >
                          <option value="">Unassigned</option>
                          {inactiveOwner(s.owner) ? (
                            <option value={s.owner}>{inactiveOwner(s.owner)!.label}</option>
                          ) : null}
                          {active.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="btn"
                          type="button"
                          disabled={assigning !== null}
                          aria-label={`Assign session ${shortId(s.sessionId)}`}
                          onClick={() => void assign(s.sessionId, s.owner)}
                        >
                          {assigning === s.sessionId ? "Assigning…" : "Assign"}
                        </button>
                      </span>
                    </td>
                  ) : null}
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
