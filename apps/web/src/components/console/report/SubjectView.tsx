"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  acceptItem,
  commentOn,
  editCriterion,
  fetchReportSubject,
  parseReportSubject,
  reportFailureText,
  type ReportSubjectDetail,
} from "../../../lib/console-api";
import type { ApiResult } from "../../../lib/api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { CriterionRow, type EditInput } from "./CriterionRow";
import { subjectLabel } from "./SubjectList";

// One subject's report for the facilitator: the criteria (levels with edit and accept), the summary (accept), the comments so far and a
// comment box. Every write carries the typed name; without a valid one nothing is enabled. A refusal is one fixed sentence; what was typed
// stays (a stale edit or a refused comment loses nothing). Every string from the report is rendered as a React text node.

export type SubjectViewProps = {
  sessionId: string;
  subject: string;
  /** The valid typed name, or null (then every write is disabled). */
  author: string | null;
  fetch?: typeof fetch;
  /** After a successful write (the panel refreshes its subject list). */
  onChanged?: () => void;
};

export function SubjectView({ sessionId, subject, author, fetch: fetchImpl, onChanged }: SubjectViewProps) {
  const id = useId();
  const [view, setView] = useState<ReportSubjectDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [comment, setComment] = useState("");
  const [about, setAbout] = useState("");
  const [feedback, setFeedback] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await fetchReportSubject(sessionId, subject, fetchImpl);
    if (!alive.current) return;
    if (!r.ok) {
      setLoadError(reportFailureText(r));
      return;
    }
    const parsed = parseReportSubject(r.data);
    setLoadError(parsed === null ? REPORT_CONSOLE.unreadable : null);
    if (parsed !== null) setView(parsed);
  }, [sessionId, subject, fetchImpl]);

  useEffect(() => {
    setView(null);
    void load();
  }, [load]);

  /** Runs a write; null when it succeeded (then the view reloads), else the fixed sentence (on the status line unless `inRow`: the row shows it). */
  async function run(call: Promise<ApiResult>, inRow = false): Promise<string | null> {
    setPending(true);
    setMessage("");
    const r = await call;
    if (!alive.current) return null;
    setPending(false);
    if (!r.ok) {
      const text = reportFailureText(r);
      if (!inRow) setMessage(text);
      return text;
    }
    setMessage(REPORT_CONSOLE.saved);
    onChanged?.();
    await load();
    return null;
  }

  const canWrite = author !== null;
  const by = author ?? "";
  const edit = (criterion: string) => (input: EditInput) => run(editCriterion(sessionId, subject, { criterion, ...input, by }, fetchImpl), true);
  const accept = (criterion: string) => void run(acceptItem(sessionId, subject, { criterion, by }, fetchImpl));
  async function sendComment() {
    if (!canWrite || comment.trim() === "") return;
    const refusal = await run(commentOn(sessionId, subject, { text: comment, ...(about !== "" ? { criterion: about } : {}), ...(feedback ? { feedback: true as const } : {}), by }, fetchImpl));
    if (refusal === null) {
      setComment("");
      setFeedback(false);
    }
  }
  const nameOf = (criterion: string) => view?.criteria.find((c) => c.id === criterion)?.name ?? criterion;
  const label = subjectLabel(subject);

  return (
    <section className="card stack report-subject" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{label}</h3>
      <p className="small muted" aria-live="polite">
        {message}
      </p>
      {loadError !== null ? (
        <div className="stack">
          <p className="banner warn">{loadError}</p>
          <div>
            <button className="btn" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {view === null ? null : (
        <>
          {!canWrite ? <p className="small muted">{REPORT_CONSOLE.nameNeeded}</p> : null}
          <div>
            {/* Reload shows the latest levels without clearing an open form (a stale refusal asks for this). */}
            <button className="btn" type="button" disabled={pending} onClick={() => void load()}>
              Reload the levels
            </button>
          </div>
          <ul className="console-list stack">
            {view.criteria.map((c) => (
              <CriterionRow key={c.id} criterion={c} canWrite={canWrite} pending={pending} onEdit={edit(c.id)} onAccept={() => accept(c.id)} />
            ))}
          </ul>

          <div className="stack">
            <h4>Summary</h4>
            {view.summary.strengths.length > 0 ? (
              <ul className="plain">
                {view.summary.strengths.map((s, i) => (
                  <li key={i} className="report-text">{`Strength: ${s}`}</li>
                ))}
              </ul>
            ) : null}
            {view.summary.developments.length > 0 ? (
              <ul className="plain">
                {view.summary.developments.map((s, i) => (
                  <li key={i} className="report-text">{`To develop: ${s}`}</li>
                ))}
              </ul>
            ) : null}
            {view.summary.actions.length > 0 ? (
              <ul className="plain">
                {view.summary.actions.map((a, i) => (
                  <li key={i} className="report-text">{`Action (${a.lo}): ${a.text}`}</li>
                ))}
              </ul>
            ) : null}
            <div>
              <button className="btn" type="button" disabled={!canWrite || pending} onClick={() => void run(acceptItem(sessionId, subject, { summary: true, by }, fetchImpl))}>
                Accept the summary
              </button>
            </div>
          </div>

          {view.comments.length > 0 ? (
            <div className="stack">
              <h4>Comments</h4>
              <ul className="console-list">
                {view.comments.map((c, i) => (
                  <li key={i} className="small">
                    <span className="muted">{`${c.visibility === "feedback" ? "Feedback to the participant" : "Internal"}${c.criterion === undefined ? "" : `, ${nameOf(c.criterion)}`}: `}</span>
                    <span className="report-text">{c.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      <div className="stack">
        <div className="field">
          <label htmlFor={`${id}-comment`}>Comment</label>
          <textarea id={`${id}-comment`} className="t" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        {view !== null && view.criteria.length > 0 ? (
          <div className="field">
            <label htmlFor={`${id}-about`}>About</label>
            <select id={`${id}-about`} className="t" value={about} onChange={(e) => setAbout(e.target.value)}>
              <option value="">The whole report</option>
              {view.criteria.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} />
          <span>Show this to the participant as feedback</span>
        </label>
        <div>
          <button className="btn" type="button" disabled={!canWrite || pending || comment.trim() === ""} onClick={() => void sendComment()}>
            Add comment
          </button>
        </div>
      </div>
    </section>
  );
}
