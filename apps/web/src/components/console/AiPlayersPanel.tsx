"use client";

import { useEffect, useId, useRef, useState } from "react";
import { aiErrorText, fetchIntents, HINT_MAX, INTENT_TRIGGERS, intentOutcome, promptAi, type IntentView } from "../../lib/console-ai";
import { isolate } from "../../lib/console-view";
import { roleLabel } from "../../lib/names";
import type { ActivityEntry, ActivityMap } from "../../lib/activity";
import { AiTurnState } from "./AiTurnState";

// US-0060: the facilitator's AI players panel in the live view. A row per AI role: a private hint (shown to nobody but this page and the
// prompt route: never in a transcript line), the Prompt button, and a disclosure of the player's recent turns. Everything that came from
// the network (a hint, in the recent turns) is rendered as text, bidi-isolated.

export type AiPlayersPanelProps = {
  sessionId: string;
  channel: string | null;
  aiRoles: string[];
  running: boolean;
  /** The session is paused: the engine refuses a prompt, so the button is off with a reason. */
  paused?: boolean;
  /** The current scene's participants (`null`: no scene). Left out: not restricted. A role outside it cannot be prompted. */
  sceneRoles?: string[] | null;
  fetch?: typeof fetch;
  /** US-0082: the transient turn reports per role (Thinking / Waiting / how a turn ended); left out: no state is shown. */
  activity?: ActivityMap;
};

export function AiPlayersPanel({ sessionId, channel, aiRoles, running, paused = false, sceneRoles, fetch: fetchImpl, activity }: AiPlayersPanelProps) {
  const headingId = useId();
  if (aiRoles.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="stack">
      <h2 className="s" id={headingId}>
        AI players
      </h2>
      <ul className="stack">
        {aiRoles.map((roleId) => (
          <Row
            key={roleId}
            sessionId={sessionId}
            roleId={roleId}
            channel={channel}
            running={running}
            paused={paused}
            inScene={sceneRoles === undefined || (sceneRoles !== null && sceneRoles.includes(roleId))}
            {...(fetchImpl ? { fetchImpl } : {})}
            {...(activity ? { turn: Object.hasOwn(activity, roleId) ? activity[roleId]! : null } : {})}
          />
        ))}
      </ul>
    </section>
  );
}

const WHEN: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

function Row({ sessionId, roleId, channel, running, paused, inScene, fetchImpl, turn }: { sessionId: string; roleId: string; channel: string | null; running: boolean; paused: boolean; inScene: boolean; fetchImpl?: typeof fetch; /** US-0082: undefined = not shown; null = no report yet. */ turn?: ActivityEntry | null }) {
  // Why Prompt is off while the session is running (the engine would refuse it); a pause is named first.
  const blocked = !running ? null : paused ? "Resume the session before you prompt an AI player." : !inScene ? "This AI player is not in the current scene." : null;
  const label = roleLabel(roleId);
  const id = useId();
  const [hint, setHint] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<{ entries: IntentView[] } | { message: string } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const wasPending = useRef(false);
  // Counted as the control side will see it (NFKC, trimmed): expanding characters such as "ﬁ", "½" or U+FDFA count for what they become.
  const count = Array.from(hint.normalize("NFKC").trim()).length;
  const asked = useRef(0);

  // A button that was focused becomes disabled while the request is in flight, and focus would fall to the page: put it back.
  useEffect(() => {
    // Only when focus was lost to the page (or is still on the button): never pull it back from the hint field the user moved to.
    const at = document.activeElement;
    if (wasPending.current && !pending && (at === null || at === document.body || at === btn.current)) btn.current?.focus();
    wasPending.current = pending;
  }, [pending]);

  async function prompt() {
    if (busy.current || !running || channel === null || blocked !== null) return;
    setStatus("");
    setError("");
    if (count > HINT_MAX) {
      setError(`The hint is too long: at most ${HINT_MAX} characters.`);
      return;
    }
    busy.current = true;
    setPending(true);
    const r = await promptAi(sessionId, roleId, channel, hint.trim(), fetchImpl);
    busy.current = false;
    setPending(false);
    if (!r.ok) {
      setError(aiErrorText(r));
      return;
    }
    setHint("");
    setStatus("Prompt sent. The AI player will answer shortly.");
  }

  async function toggle() {
    const next = !open;
    const mine = ++asked.current; // a slower, older answer never overwrites a newer one (or one that arrives after closing)
    setOpen(next);
    if (!next) return;
    setTurns(null);
    const r = await fetchIntents(sessionId, roleId, fetchImpl);
    if (mine !== asked.current) return;
    setTurns(r.ok ? { entries: r.entries } : { message: r.message });
  }

  return (
    <li className="card stack">
      <p>
        <b>{label}</b> <span className="pill ai">AI</span>
        {turn !== undefined ? <> <AiTurnState entry={turn ?? undefined} /></> : null}
      </p>
      <div className="field">
        <label className="f" htmlFor={`${id}-h`}>
          {`Hint for the AI player for ${label} (optional, only you see it)`}
        </label>
        <input
          className="t"
          id={`${id}-h`}
          type="text"
          value={hint}
          autoComplete="off"
          aria-describedby={`${id}-c`}
          onChange={(e) => setHint(e.target.value)}
        />
        <p className="muted small" id={`${id}-c`}>
          {`${count} of ${HINT_MAX}`}
        </p>
      </div>
      <div className="actions">
        <button
          className="btn pri"
          type="button"
          ref={btn}
          disabled={!running || channel === null || blocked !== null || pending}
          aria-describedby={blocked !== null ? `${id}-r` : undefined}
          aria-label={`Prompt the AI player for ${label}`}
          onClick={() => void prompt()}
        >
          Prompt AI player
        </button>
        <button
          className="btn"
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-t`}
          aria-label={`${open ? "Hide" : "Show"} recent turns for ${label}`}
          onClick={() => void toggle()}
        >
          {open ? "Hide recent turns" : "Show recent turns"}
        </button>
      </div>
      {blocked !== null ? (
        <p className="muted small" id={`${id}-r`}>
          {blocked}
        </p>
      ) : null}
      <div aria-live="polite">{status ? <p className="banner ok">{status}</p> : null}</div>
      <div role="alert">{error ? <p className="err">{error}</p> : null}</div>
      <div id={`${id}-t`}>
        {open ? (
          turns === null ? (
            <p className="muted" role="status">
              Loading…
            </p>
          ) : "message" in turns ? (
            <p className="err">{turns.message}</p>
          ) : turns.entries.length === 0 ? (
            <p className="muted">No turns yet.</p>
          ) : (
            <ol className="stack">
              {turns.entries.map((e, i) => (
                <li key={i}>
                  <time dateTime={new Date(e.ts).toISOString()}>{new Date(e.ts).toLocaleTimeString([], WHEN)}</time>{" "}
                  <span>{INTENT_TRIGGERS[e.trigger]}</span> <span>{intentOutcome(e)}</span>
                  {e.hint !== undefined ? <> <span>Hint: {isolate(e.hint)}</span></> : null}
                </li>
              ))}
            </ol>
          )
        ) : null}
      </div>
    </li>
  );
}
