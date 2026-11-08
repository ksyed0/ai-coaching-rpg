"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "../lib/api";
import { MESSAGES } from "../lib/messages";

// The released report's response form: one criterion (or the whole report), the text, and whether it is a disagreement.
// Failure copy is fixed here, never the server's text. The text stays on any failure.

export const MAX_RESPONSES = 50;
const MAX_TEXT = 1500;
const MAX_TEXT_LABEL = MAX_TEXT.toLocaleString("en-US");
const WHOLE = "";

export type ResponseFormProps = {
  criteria: { id: string; name: string }[];
  used: number;
  fetch?: typeof fetch;
  /** The re-read view the BFF returned after the response was stored. */
  onSent(view: unknown): void;
  /** The link was refused (404): the page shows its refused state. */
  onRefused?(): void;
};
type Notice = { kind: "sent" | "error"; text: string } | null;

const count = (s: string) => Array.from(s).length;
const clip = (s: string) => { const cp = Array.from(s); return cp.length > MAX_TEXT ? cp.slice(0, MAX_TEXT).join("") : s; };

const stateOf = (data: unknown): unknown => (typeof data === "object" && data !== null ? (data as { state?: unknown }).state : undefined);

function failureText(r: { status: number; data?: unknown; retryAfter?: number }): string {
  if (r.status === 413) return MESSAGES.respondTooLarge;
  if (r.status === 429) return r.retryAfter !== undefined ? MESSAGES.respondThrottledWait(r.retryAfter) : MESSAGES.respondThrottled;
  if (r.status === 400) return MESSAGES.respondInvalid;
  const state = stateOf(r.data);
  if (r.status === 503) return state === "busy" ? MESSAGES.respondBusy : MESSAGES.respondUnavailable;
  if (r.status === 409) {
    if (state === "too_many") return MESSAGES.respondTooMany;
    if (state === "link_full") return MESSAGES.respondLinkFull;
    if (state === "old_schema") return MESSAGES.reportOldSchema;
    if (state === "not_released" || state === "withdrawn" || state === "closed") return MESSAGES.respondClosed;
  }
  return MESSAGES.respondUnavailable;
}

export function ResponseForm({ criteria, used, fetch: fetchImpl, onSent, onRefused }: ResponseFormProps) {
  const [criterion, setCriterion] = useState(WHOLE);
  const [text, setText] = useState("");
  const [dispute, setDispute] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // BUG-0030: this link has used its own budget; another try would be refused the same way until the facilitator issues a new link.
  const [linkFull, setLinkFull] = useState(false);
  const busy = useRef(false); // a second click in the same tick must not send again
  const summary = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (notice?.kind === "error") summary.current?.focus(); }, [notice]);

  const full = used >= MAX_RESPONSES || linkFull;
  const empty = text.trim() === "";

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (busy.current || empty || full) return;
    busy.current = true;
    setSending(true);
    setNotice(null);
    const res = await postJson("/api/v1/report/responses", { ...(criterion !== WHOLE ? { criterion } : {}), text, dispute }, fetchImpl);
    busy.current = false;
    if (!alive.current) return;
    setSending(false);
    if (res.ok) {
      setText("");
      setDispute(false);
      setCriterion(WHOLE);
      const d = res.data;
      if (typeof d === "object" && d !== null && (d as { state?: unknown }).state === "retry") {
        setNotice({ kind: "sent", text: MESSAGES.respondSentReload });
        return;
      }
      onSent(d);
      return;
    }
    if (res.status === 404) {
      onRefused?.();
      return;
    }
    if (res.status === 409 && stateOf(res.data) === "link_full") setLinkFull(true);
    setNotice({ kind: "error", text: failureText(res) });
  }

  return (
    <form className="card stack no-print" onSubmit={submit} aria-busy={sending} noValidate aria-labelledby="respond-h">
      <h2 className="s" id="respond-h">{MESSAGES.respondHeading}</h2>
      {used >= MAX_RESPONSES ? <p>{MESSAGES.respondTooMany}</p> : linkFull ? <p>{MESSAGES.respondLinkFull}</p> : null}
      <div className="field">
        <label htmlFor="respond-about">{MESSAGES.respondAbout}</label>
        <select id="respond-about" value={criterion} onChange={(e) => setCriterion(e.target.value)}>
          <option value={WHOLE}>{MESSAGES.respondWhole}</option>
          {criteria.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="respond-text">{MESSAGES.respondText}</label>
        <textarea id="respond-text" rows={4} value={text} aria-describedby="respond-count" onChange={(e) => setText(clip(e.target.value))} />
        <span id="respond-count" className="muted">{`${count(text).toLocaleString("en-US")} / ${MAX_TEXT_LABEL}`}</span>
      </div>
      <label className="choice">
        <input type="checkbox" checked={dispute} onChange={(e) => setDispute(e.target.checked)} />{" "}
        <span>{MESSAGES.respondDispute}</span>
      </label>
      {notice?.kind === "error" ? (
        <div ref={summary} tabIndex={-1} role="alert" className="banner warn">
          <strong>{MESSAGES.respondErrorTitle}</strong>
          <p>{notice.text}</p>
        </div>
      ) : null}
      <p role="status" className="muted">{sending ? MESSAGES.respondSending : notice?.kind === "sent" ? notice.text : ""}</p>
      <p>
        <button className="btn pri" type="submit" disabled={sending || empty || full} aria-busy={sending}>
          {sending ? MESSAGES.respondSending : MESSAGES.respondSend}
        </button>
      </p>
    </form>
  );
}
