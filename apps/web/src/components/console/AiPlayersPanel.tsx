"use client";

import { useEffect, useId, useRef, useState } from "react";
import { aiErrorText, fetchIntents, HINT_MAX, INTENT_TRIGGERS, intentOutcome, promptAi, type IntentView } from "../../lib/console-ai";
import { isolate } from "../../lib/console-view";
import { roleLabel } from "../../lib/names";

// US-0060: the facilitator's AI players panel in the live view. A row per AI role: a private hint (shown to nobody but this page and the
// prompt route: never in a transcript line), the Prompt button, and a disclosure of the player's recent turns. Everything that came from
// the network (a hint, in the recent turns) is rendered as text, bidi-isolated.

export type AiPlayersPanelProps = {
  sessionId: string;
  channel: string | null;
  aiRoles: string[];
  running: boolean;
  fetch?: typeof fetch;
};

export function AiPlayersPanel({ sessionId, channel, aiRoles, running, fetch: fetchImpl }: AiPlayersPanelProps) {
  const headingId = useId();
  if (aiRoles.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="stack">
      <h2 className="s" id={headingId}>
        AI players
      </h2>
      <ul className="stack">
        {aiRoles.map((roleId) => (
          <Row key={roleId} sessionId={sessionId} roleId={roleId} channel={channel} running={running} {...(fetchImpl ? { fetchImpl } : {})} />
        ))}
      </ul>
    </section>
  );
}

const WHEN: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

function Row({ sessionId, roleId, channel, running, fetchImpl }: { sessionId: string; roleId: string; channel: string | null; running: boolean; fetchImpl?: typeof fetch }) {
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
  const count = Array.from(hint).length;

  // A button that was focused becomes disabled while the request is in flight, and focus would fall to the page: put it back.
  useEffect(() => {
    if (wasPending.current && !pending) btn.current?.focus();
    wasPending.current = pending;
  }, [pending]);

  async function prompt() {
    if (busy.current || !running || channel === null) return;
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
    setOpen(next);
    if (!next) return;
    setTurns(null);
    const r = await fetchIntents(sessionId, roleId, fetchImpl);
    setTurns(r.ok ? { entries: r.entries } : { message: r.message });
  }

  return (
    <li className="card stack">
      <p>
        <b>{label}</b> <span className="pill ai">AI</span>
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
          disabled={!running || channel === null || pending}
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
