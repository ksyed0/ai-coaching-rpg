"use client";

import { useRef, useState } from "react";
import { postJson } from "../../lib/api";
import {
  CONSOLE_COPY,
  failureText,
  parseCodes,
  shortId,
  type CodeEntry,
  type Readiness as ReadinessData,
} from "../../lib/console-api";
import { roleLabel } from "../../lib/names";
import { useReadiness, type SetTimer } from "../../lib/use-readiness";
import { CodesPanel } from "./CodesPanel";
import { ConfirmDialog } from "./ConfirmDialog";

// The facilitator's view of one session before and after the start: the model, who has joined, consented and connected (in words,
// never colour alone), a code reissue per role, and Start. Names come from the network and are rendered only as text nodes.

export type ReadinessProps = {
  sessionId: string;
  fetch?: typeof fetch;
  setTimer?: SetTimer;
  intervalMs?: number;
};

type Confirm =
  | { kind: "role"; roleId: string; opener: HTMLElement }
  | { kind: "all"; opener: HTMLElement };
type Shown = { seq: number; heading: string; codes: CodeEntry[] };

const yesNo = (v: boolean) => (v ? "Yes" : "No");
const url = (id: string, tail: string) =>
  `/api/v1/console/sessions/${encodeURIComponent(id)}/${tail}`;

export function Readiness({
  sessionId,
  fetch: fetchImpl,
  setTimer,
  intervalMs,
}: ReadinessProps) {
  const { data, reconnecting, signedOut, refresh } = useReadiness(sessionId, {
    fetch: fetchImpl,
    ...(setTimer ? { setTimer } : {}),
    ...(intervalMs ? { intervalMs } : {}),
  });
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [working, setWorking] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const busy = useRef(false);
  // Every issue gets its own number, so a new code is never shown by a panel that still holds the previous one.
  const seq = useRef(0);
  const show = (heading: string, codes: CodeEntry[]) =>
    setShown({ seq: ++seq.current, heading, codes });

  async function act<T>(
    run: () => ReturnType<typeof postJson>,
    onOk: (d: unknown) => T | void,
  ) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    const r = await run();
    busy.current = false;
    setWorking(false);
    if (!r.ok) {
      setError(failureText(r));
      return;
    }
    onOk(r.data);
    refresh();
  }

  async function reissue(roleId: string) {
    await act(
      () => postJson(url(sessionId, "reissue"), { roleId }, fetchImpl),
      (d) => {
        const o = (typeof d === "object" && d !== null ? d : {}) as Record<
          string,
          unknown
        >;
        if (typeof o.code === "string")
          show(`New code for ${roleLabel(roleId)}`, [{ roleId, code: o.code }]);
      },
    );
    setConfirm(null);
  }
  async function reissueAll() {
    await act(
      () => postJson(url(sessionId, "reissue-all"), {}, fetchImpl),
      (d) => {
        const o = (typeof d === "object" && d !== null ? d : {}) as Record<
          string,
          unknown
        >;
        show("New codes for every role", parseCodes(o.codes));
      },
    );
    setConfirm(null);
  }
  async function restart() {
    await act(
      () => postJson(url(sessionId, "restart"), {}, fetchImpl),
      (d) => {
        const o = (typeof d === "object" && d !== null ? d : {}) as Record<
          string,
          unknown
        >;
        const codes = parseCodes(o.codes);
        if (codes.length > 0) show("New join codes", codes);
      },
    );
  }
  async function start() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    const r = await postJson(url(sessionId, "start"), {}, fetchImpl);
    busy.current = false;
    setWorking(false);
    if (r.ok) {
      setStartedHere(true);
      refresh();
      return;
    }
    if (r.status === 409) {
      const d = (
        typeof r.data === "object" && r.data !== null ? r.data : null
      ) as { reason?: unknown; missing?: unknown } | null;
      if (d?.reason === "seats_not_ready") {
        const missing = Array.isArray(d.missing)
          ? d.missing.filter((m): m is string => typeof m === "string")
          : [];
        setError(
          missing.length > 0
            ? `${CONSOLE_COPY.notReady} Waiting for: ${missing.join(", ")}`
            : CONSOLE_COPY.notReady,
        );
      } else {
        // 409 without the gate's detail is "already started": the goal is reached, so it reads as started.
        setStartedHere(true);
      }
      refresh();
      return;
    }
    setError(failureText(r));
  }

  if (signedOut) {
    return (
      <p className="banner warn" role="alert">
        You have been signed out. <a href="/console">Sign in again.</a>
      </p>
    );
  }
  if (!data) {
    return reconnecting ? (
      <p className="banner warn" role="status">
        The session cannot be reached right now. Reconnecting…
      </p>
    ) : (
      <p className="muted" role="status">
        Loading the session…
      </p>
    );
  }
  return (
    <View
      sessionId={sessionId}
      data={data}
      reconnecting={reconnecting}
      working={working}
      startedHere={startedHere}
      error={error}
      shown={shown}
      confirm={confirm}
      onAskRole={(roleId, opener) =>
        setConfirm({ kind: "role", roleId, opener })
      }
      onAskAll={(opener) => setConfirm({ kind: "all", opener })}
      onCancel={() => setConfirm(null)}
      onReissue={(id) => void reissue(id)}
      onReissueAll={() => void reissueAll()}
      onStart={() => void start()}
      onRestart={() => void restart()}
      onDismissCodes={() => setShown(null)}
    />
  );
}

type ViewProps = {
  sessionId: string;
  data: ReadinessData;
  reconnecting: boolean;
  working: boolean;
  startedHere: boolean;
  error: string | null;
  shown: Shown | null;
  confirm: Confirm | null;
  onAskRole: (roleId: string, opener: HTMLElement) => void;
  onAskAll: (opener: HTMLElement) => void;
  onCancel: () => void;
  onReissue: (roleId: string) => void;
  onReissueAll: () => void;
  onStart: () => void;
  onRestart: () => void;
  onDismissCodes: () => void;
};

function View(p: ViewProps) {
  const { data } = p;
  const ended = data.launcherStatus === "ended" || data.status === "ended";
  const stopped = data.launcherStatus === "stopped";
  const unreachable = data.launcherStatus === "running" && data.status === null;
  const idle = data.status === "idle";
  const running = data.status === "running";
  const started = p.startedHere || data.status === "running";
  const reason = !idle
    ? null
    : data.roster.length === 0
      ? "Nobody has joined yet"
      : data.canStart
        ? null
        : data.missing.length > 0
          ? `Waiting for: ${data.missing.join(", ")}`
          : "Waiting for everyone to join and consent";

  return (
    <div className="stack">
      <div className="card stack">
        <p>
          <b>Session {shortId(p.sessionId)}</b>
        </p>
        <p className="muted">
          {data.modelLabel ? `Model: ${data.modelLabel}` : "Model: not shown"}
        </p>
        <p>
          <a href="/console">Back to sessions</a>
        </p>
      </div>

      {p.reconnecting ? (
        <p className="banner warn" role="status">
          Reconnecting… The page keeps trying by itself.
        </p>
      ) : null}
      {unreachable ? (
        <p className="banner warn" role="status">
          The session cannot be reached right now. Reconnecting…
        </p>
      ) : null}
      {ended ? (
        <p className="banner warn" role="status">
          This session has ended.
        </p>
      ) : null}
      {stopped ? (
        <div className="banner warn stack" role="status">
          <p>The session service stopped this session.</p>
          <div>
            <button
              className="btn"
              type="button"
              disabled={p.working}
              onClick={p.onRestart}
            >
              Restart
            </button>
          </div>
        </div>
      ) : null}
      {started && !ended ? (
        <p className="banner ok" role="status">
          {CONSOLE_COPY.started}
        </p>
      ) : null}
      <p className="err" role="alert">
        {p.error}
      </p>

      {p.shown ? (
        <CodesPanel
          key={p.shown.seq}
          codes={p.shown.codes}
          heading={p.shown.heading}
          onDismiss={p.onDismissCodes}
        />
      ) : null}

      <section className="card stack" aria-labelledby="roster-h">
        <h2 className="s" id="roster-h">
          Who is in the room
        </h2>
        {data.roster.length === 0 ? (
          <p className="muted">
            {stopped || ended || unreachable
              ? "The roster is not available right now."
              : "Nobody has joined yet"}
          </p>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <caption className="sr-only">Roster</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Name</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Consented</th>
                  <th scope="col">Connected</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {data.roster.map((e) => (
                  <tr key={e.roleId}>
                    <th scope="row">{roleLabel(e.roleId)}</th>
                    <td>
                      {e.name !== undefined && e.name !== "" ? e.name : "—"}
                    </td>
                    <td>
                      <State on={e.joined} />
                    </td>
                    <td>
                      <State on={e.consented} />
                    </td>
                    <td>
                      <State on={e.connected} />
                    </td>
                    <td>
                      <button
                        className="btn"
                        type="button"
                        disabled={!(idle || running) || p.working}
                        aria-label={`Reissue code for ${roleLabel(e.roleId)}`}
                        onClick={(ev) =>
                          p.onAskRole(e.roleId, ev.currentTarget)
                        }
                      >
                        Reissue code
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {idle ? (
          <p className="muted small">
            Codes issued earlier are not shown again. Reissue a role to get a
            new code.
          </p>
        ) : null}
      </section>

      {idle || started ? (
        <div className="card stack">
          <div className="actions">
            <button
              className="btn pri"
              type="button"
              disabled={!idle || !data.canStart || p.working}
              aria-describedby={reason ? "start-reason" : undefined}
              onClick={p.onStart}
            >
              Start
            </button>
            {reason ? (
              <p className="muted" id="start-reason">
                {reason}
              </p>
            ) : null}
          </div>
          <div className="actions">
            <button
              className="btn"
              type="button"
              disabled={!idle || p.working}
              onClick={(ev) => p.onAskAll(ev.currentTarget)}
            >
              Reissue all codes
            </button>
            {!idle ? (
              <p className="muted small">
                Codes can no longer be reissued for all roles once the session
                has started.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {p.confirm?.kind === "role" ? (
        <ConfirmDialog
          title={`Reissue the code for ${roleLabel(p.confirm.roleId)}?`}
          description={
            running
              ? `The old code stops working. The next person who joins with the new code takes over this seat and keeps its existing consent. The new code is shown once. This affects the ${roleLabel(p.confirm.roleId)} role only.`
              : `The old code and this person's seat stop working. The new code is shown once. This affects the ${roleLabel(p.confirm.roleId)} role only.`
          }
          confirmLabel="Reissue code"
          pending={p.working}
          opener={p.confirm.opener}
          onCancel={p.onCancel}
          onConfirm={() =>
            p.onReissue((p.confirm as { roleId: string }).roleId)
          }
        />
      ) : null}
      {p.confirm?.kind === "all" ? (
        <ConfirmDialog
          title="Reissue all codes?"
          description="Every code, credential and consent is cleared. Everyone who has joined is signed out and must join and consent again with a new code. The new codes are shown once."
          confirmLabel="Reissue all codes"
          pending={p.working}
          opener={p.confirm.opener}
          onCancel={p.onCancel}
          onConfirm={p.onReissueAll}
        />
      ) : null}
    </div>
  );
}

function State({ on }: { on: boolean }) {
  return (
    <span className={`pill ${on ? "ok" : "mut"}`}>
      <span aria-hidden="true">{on ? "✓ " : "– "}</span>
      {yesNo(on)}
    </span>
  );
}
