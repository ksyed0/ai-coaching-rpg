"use client";

import { useEffect, useRef, useState } from "react";
import { postJson, type ApiResult } from "../../lib/api";
import {
  CONSOLE_COPY,
  failureText,
  parseCodes,
  shortId,
  splitWaiting,
  type CodeEntry,
  type Readiness as ReadinessData,
  type RosterEntry,
} from "../../lib/console-api";
import { isolate } from "../../lib/console-view";
import { roleLabel } from "../../lib/names";
import { useReadiness, type SetTimer } from "../../lib/use-readiness";
import { CodesPanel } from "./CodesPanel";
import { confirmCopy } from "../../lib/console-confirm";
import { aiErrorText, parseAiAnswer, setAiRoles } from "../../lib/console-ai";
import { AiRoleSwitch } from "./AiRoleSwitch";
import { ConfirmDialog, focusFallback } from "./ConfirmDialog";

// The facilitator's view of one session before and after the start: the model, who has joined, consented and connected (in words,
// never colour alone), a code reissue per role, and Start. Names come from the network and are rendered only as text nodes.

export type ReadinessProps = {
  sessionId: string;
  fetch?: typeof fetch;
  setTimer?: SetTimer;
  intervalMs?: number;
  /** Set once the session is running and the live stream is open: polling stops, status and roster come from here. */
  live?: { status: SessionStatus; roster: RosterEntry[] } | null;
  /** Called with each readiness answer. */
  onState?: (s: { launcherStatus: string; status: SessionStatus | null }) => void;
  /** Called when Start succeeded (or the session was already started). */
  onStarted?: () => void;
  /** The shell already shows the stopped message: the Restart button stays, the sentence is not repeated. */
  stoppedAnnounced?: boolean;
};
export type SessionStatus = "idle" | "running" | "ended";

type Confirm =
  | { kind: "role"; roleId: string; opener: HTMLElement }
  | { kind: "remove"; roleId: string; opener: HTMLElement }
  | { kind: "all"; opener: HTMLElement }
  | { kind: "to_ai"; roleId: string; opener: HTMLElement }
  | { kind: "to_human"; roleId: string; opener: HTMLElement };
type Shown = { seq: number; heading: string; codes: CodeEntry[] };

const yesNo = (v: boolean) => (v ? "Yes" : "No");
const url = (id: string, tail: string) =>
  `/api/v1/console/sessions/${encodeURIComponent(id)}/${tail}`;
/** The waiting sentences ("Waiting for: a, b" and "AI player not connected yet: Tech lead"), each only when it has roles; no final period. */
const waitingSentences = (humans: string[], ai: string[]): string =>
  [
    ...(humans.length > 0 ? [`Waiting for: ${humans.join(", ")}`] : []),
    ...(ai.length > 0 ? [`${CONSOLE_COPY.aiNotConnected} ${ai.map(roleLabel).join(", ")}`] : []),
  ].join(". ");

export function Readiness({
  sessionId,
  fetch: fetchImpl,
  setTimer,
  intervalMs,
  live = null,
  onState,
  onStarted,
  stoppedAnnounced = false,
}: ReadinessProps) {
  const { data: polled, reconnecting, signedOut, refresh } = useReadiness(sessionId, {
    fetch: fetchImpl,
    enabled: live === null,
    ...(setTimer ? { setTimer } : {}),
    ...(intervalMs ? { intervalMs } : {}),
  });
  // Live: the last polled launcher status and model stay; status and roster come from the stream (the polled roster until it has one).
  const data: ReadinessData | null =
    polled && live
      ? {
          ...polled,
          status: live.status,
          roster: live.roster.length > 0 ? live.roster : polled.roster,
        }
      : polled;
  const polledRoster = useRef<RosterEntry[]>([]);
  polledRoster.current = data?.roster ?? [];
  const stateCb = useRef(onState);
  stateCb.current = onState;
  useEffect(() => {
    if (polled)
      stateCb.current?.({
        launcherStatus: polled.launcherStatus,
        status: polled.status,
      });
  }, [polled]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [working, setWorking] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const busy = useRef(false);
  // After a successful Remove the seat's row loses its Remove button (and with it the dialog's opener): focus moves to that row's
  // Reissue button once the refreshed roster has arrived, so it never falls to the page.
  const refocus = useRef<string | null>(null);
  // After a role switch (confirmed, refused or cancelled) focus goes back to that role's switch, found by its data attribute because the
  // roster re-renders under it.
  const refocusSwitch = useRef<string | null>(null);
  // Every issue gets its own number, so a new code is never shown by a panel that still holds the previous one.
  const seq = useRef(0);
  const show = (heading: string, codes: CodeEntry[]) =>
    setShown({ seq: ++seq.current, heading, codes });

  async function act<T>(
    run: () => ReturnType<typeof postJson>,
    onOk: (d: unknown) => T | void,
    errorText: (r: Extract<ApiResult, { ok: false }>) => string = failureText,
  ) {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    const r = await run();
    busy.current = false;
    setWorking(false);
    if (!r.ok) {
      setError(errorText(r));
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
  async function remove(roleId: string) {
    await act(
      () => postJson(url(sessionId, "remove"), { roleId }, fetchImpl),
      (d) => {
        const o = (typeof d === "object" && d !== null ? d : {}) as Record<
          string,
          unknown
        >;
        refocus.current = roleId;
        if (typeof o.code === "string")
          show(`New code for ${roleLabel(roleId)}`, [{ roleId, code: o.code }]);
      },
      // The BFF's own words for "already started" (the generic 409 text would say nothing about removing).
      (r) =>
        r.status === 409 && r.message !== "" ? r.message : failureText(r),
    );
    setConfirm(null);
  }
  /** Posts the WHOLE wanted AI set: the roster's current AI roles with this one added or taken out. */
  async function switchRole(roleId: string, toAi: boolean) {
    const current = polledRoster.current.filter((e) => e.ai === true).map((e) => e.roleId);
    const wanted = toAi ? [...current.filter((r) => r !== roleId), roleId] : current.filter((r) => r !== roleId);
    refocusSwitch.current = roleId;
    await act(
      () => setAiRoles(sessionId, wanted, fetchImpl),
      (d) => {
        // The answer is taken as a whole: no role that is AI now keeps a code on screen, and every code it returns is shown once.
        const answer = parseAiAnswer(d);
        const ai = new Set(answer.roles);
        const fresh = answer.codes.filter((c) => !ai.has(c.roleId));
        if (fresh.length > 0)
          show(fresh.length === 1 ? `New code for ${roleLabel(fresh[0]!.roleId)}` : "New codes", fresh);
        else
          setShown((cur) => {
            if (!cur) return cur;
            const left = cur.codes.filter((c) => !ai.has(c.roleId));
            return left.length === cur.codes.length ? cur : left.length === 0 ? null : { ...cur, seq: ++seq.current, codes: left };
          });
      },
      // A refused or unconfirmed change: the roster the message points to must be current.
      (r) => {
        refresh();
        return aiErrorText(r);
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
      if (onStarted) onStarted();
      else refresh();
      return;
    }
    if (r.status === 409) {
      const d = (
        typeof r.data === "object" && r.data !== null ? r.data : null
      ) as { reason?: unknown; missing?: unknown } | null;
      if (d?.reason === "seats_not_ready") {
        const strs = (v: unknown) =>
          Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
        // Humans and AI players are listed apart, split by the roster's `ai` flag (and the server's own aiWaiting).
        const w = splitWaiting(
          polledRoster.current,
          strs((d as { missing?: unknown }).missing),
          strs((d as { aiWaiting?: unknown }).aiWaiting),
        );
        const ws = waitingSentences(w.humans, w.ai);
        setError(ws === "" ? CONSOLE_COPY.notReady : `${CONSOLE_COPY.notReady} ${ws}`);
      } else if (d?.reason === "ai_notice") {
        // The BFF's own sentence (the server's notice does not mention AI players).
        setError(r.message !== "" ? r.message : failureText(r));
      } else {
        // 409 without the gate's detail is "already started": the goal is reached, so it reads as started.
        setStartedHere(true);
        onStarted?.();
      }
      refresh();
      return;
    }
    setError(failureText(r));
  }

  useEffect(() => {
    const roleId = refocus.current;
    if (roleId === null || !data) return;
    const sel = (a: string) => `[data-${a}="${CSS.escape(roleId)}"]`;
    if (document.querySelector(sel("remove"))) return; // the refreshed roster has not arrived yet
    const next = document.querySelector<HTMLElement>(sel("reissue"));
    if (!next) return;
    refocus.current = null;
    next.focus();
  }, [data]);

  useEffect(() => {
    const roleId = refocusSwitch.current;
    if (roleId === null || confirm !== null || !data) return;
    const el = document.querySelector<HTMLElement>(`[data-ai-switch="${CSS.escape(roleId)}"]`);
    if (!el || (el as HTMLButtonElement).disabled) return; // the refreshed roster has not arrived yet, or the request is still in flight
    refocusSwitch.current = null;
    el.focus();
  });

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
      reconnecting={reconnecting && live === null}
      isLive={live !== null}
      stoppedAnnounced={stoppedAnnounced}
      working={working}
      startedHere={startedHere}
      error={error}
      shown={shown}
      confirm={confirm}
      onAskRole={(roleId, opener) =>
        setConfirm({ kind: "role", roleId, opener })
      }
      onAskRemove={(roleId, opener) =>
        setConfirm({ kind: "remove", roleId, opener })
      }
      onAskAll={(opener) => setConfirm({ kind: "all", opener })}
      onAskSwitch={(roleId, toAi, opener) => {
        refocusSwitch.current = roleId;
        setConfirm({ kind: toAi ? "to_ai" : "to_human", roleId, opener });
      }}
      onSwitch={(roleId, toAi) => void switchRole(roleId, toAi)}
      onCancel={() => setConfirm(null)}
      onReissue={(id) => void reissue(id)}
      onRemove={(id) => void remove(id)}
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
  /** The shell owns the ended message while the live view is on. */
  isLive: boolean;
  stoppedAnnounced: boolean;
  working: boolean;
  startedHere: boolean;
  error: string | null;
  shown: Shown | null;
  confirm: Confirm | null;
  onAskRole: (roleId: string, opener: HTMLElement) => void;
  onAskRemove: (roleId: string, opener: HTMLElement) => void;
  onAskAll: (opener: HTMLElement) => void;
  onAskSwitch: (roleId: string, toAi: boolean, opener: HTMLElement) => void;
  onSwitch: (roleId: string, toAi: boolean) => void;
  onCancel: () => void;
  onReissue: (roleId: string) => void;
  onRemove: (roleId: string) => void;
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
  const waiting = splitWaiting(data.roster, data.missing, data.aiWaiting);
  const reason = !idle
    ? null
    : data.roster.length === 0
      ? "Nobody has joined yet"
      : data.canStart
        ? null
        : waiting.humans.length > 0 || waiting.ai.length > 0
          ? waitingSentences(waiting.humans, waiting.ai)
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
      {ended && !p.isLive ? (
        <p className="banner warn" role="status">
          This session has ended.
        </p>
      ) : null}
      {stopped ? (
        <div className="banner warn stack" role="status">
          {p.stoppedAnnounced ? null : <p>The session service stopped this session.</p>}
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
      <p className="err" role="alert" tabIndex={-1} data-focus-fallback="error">
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
                      {e.ai === true ? (
                        <>
                          <b>AI player</b> <span className="pill ai">AI</span>
                        </>
                      ) : e.name !== undefined && e.name !== "" ? (
                        e.name
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <State on={e.joined} />
                    </td>
                    <td>
                      {e.ai === true ? (
                        <span className="muted">Not needed</span>
                      ) : (
                        <State on={e.consented} />
                      )}
                    </td>
                    <td>
                      <State on={e.connected} />
                    </td>
                    <td>
                      {e.ai === true ? (
                        // The supervisor refuses reissue and remove for an AI role: no buttons.
                        <span className="muted">—</span>
                      ) : (<>
                      <button
                        className="btn"
                        type="button"
                        disabled={!(idle || running) || p.working}
                        data-reissue={e.roleId}
                        aria-label={`Reissue code for ${roleLabel(e.roleId)}`}
                        onClick={(ev) =>
                          p.onAskRole(e.roleId, ev.currentTarget)
                        }
                      >
                        Reissue code
                      </button>
                      {idle && e.joined ? (
                        <button
                          className="btn"
                          type="button"
                          disabled={p.working}
                          data-remove={e.roleId}
                          aria-label={
                            e.name
                              ? `Remove ${isolate(e.name)} from ${roleLabel(e.roleId)}`
                              : `Remove the participant from ${roleLabel(e.roleId)}`
                          }
                          onClick={(ev) =>
                            p.onAskRemove(e.roleId, ev.currentTarget)
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                      </>)}
                      {idle ? (
                        <AiRoleSwitch
                          roleId={e.roleId}
                          ai={e.ai === true}
                          {...(e.name ? { name: e.name } : {})}
                          joined={e.joined}
                          disabled={p.working}
                          onAsk={(opener) => p.onAskSwitch(e.roleId, e.ai !== true, opener)}
                        />
                      ) : null}
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
          fallbackFocus={focusFallback("error")}
          onCancel={p.onCancel}
          onConfirm={() =>
            p.onReissue((p.confirm as { roleId: string }).roleId)
          }
        />
      ) : null}
      {p.confirm?.kind === "remove" ? (
        <RemoveDialog
          roleId={p.confirm.roleId}
          name={data.roster.find((r) => r.roleId === (p.confirm as { roleId: string }).roleId)?.name}
          pending={p.working}
          opener={p.confirm.opener}
          onCancel={p.onCancel}
          onConfirm={() => p.onRemove((p.confirm as { roleId: string }).roleId)}
        />
      ) : null}
      {p.confirm?.kind === "to_ai" || p.confirm?.kind === "to_human" ? (
        <SwitchDialog
          roleId={p.confirm.roleId}
          toAi={p.confirm.kind === "to_ai"}
          entry={data.roster.find((r) => r.roleId === (p.confirm as { roleId: string }).roleId)}
          pending={p.working}
          opener={p.confirm.opener}
          onCancel={p.onCancel}
          onConfirm={() => p.onSwitch((p.confirm as { roleId: string }).roleId, p.confirm?.kind === "to_ai")}
        />
      ) : null}
      {p.confirm?.kind === "all" ? (
        <ConfirmDialog
          title="Reissue all codes?"
          description="Every code, credential and consent is cleared. Everyone who has joined is signed out and must join and consent again with a new code. The new codes are shown once."
          confirmLabel="Reissue all codes"
          pending={p.working}
          opener={p.confirm.opener}
          fallbackFocus={focusFallback("error")}
          onCancel={p.onCancel}
          onConfirm={p.onReissueAll}
        />
      ) : null}
    </div>
  );
}

function RemoveDialog(p: {
  roleId: string;
  name: string | undefined;
  pending: boolean;
  opener: HTMLElement;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = confirmCopy({
    kind: "remove",
    ...(p.name ? { name: p.name } : {}),
    role: roleLabel(p.roleId),
  });
  return (
    <ConfirmDialog
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      pending={p.pending}
      opener={p.opener}
      fallbackFocus={focusFallback("error")}
      onCancel={p.onCancel}
      onConfirm={p.onConfirm}
    />
  );
}

function SwitchDialog(p: {
  roleId: string;
  toAi: boolean;
  entry: RosterEntry | undefined;
  pending: boolean;
  opener: HTMLElement;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const role = roleLabel(p.roleId);
  const copy = confirmCopy(
    p.toAi
      ? { kind: "to_ai", role, joined: p.entry?.joined === true, ...(p.entry?.name ? { name: p.entry.name } : {}) }
      : { kind: "to_human", role },
  );
  return (
    <ConfirmDialog
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirmLabel}
      tone={copy.tone}
      pending={p.pending}
      opener={p.opener}
      fallbackFocus={focusFallback("error")}
      onCancel={p.onCancel}
      onConfirm={p.onConfirm}
    />
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
