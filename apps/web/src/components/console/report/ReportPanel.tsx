"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  cancelEvaluate,
  fetchReportOverview,
  openReview,
  parseReportOverview,
  reportFailureText,
  startEvaluate,
  type ReportOverviewView,
} from "../../../lib/console-api";
import type { ApiResult } from "../../../lib/api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { realSetTimer, type SetTimer } from "../../../lib/use-readiness";
import { AuthorName, isAuthorName } from "./AuthorName";
import { EvaluateCard } from "./EvaluateCard";
import { EvaluateConfirmDialog } from "./EvaluateConfirmDialog";
import { RunSummaryView } from "./RunSummaryView";
import { SubjectList } from "./SubjectList";
import { SubjectView } from "./SubjectView";

// The Report panel of an ended session (US-0064, spec section 6): the typed author name, the evaluate card, the run summary, the subject
// list and one subject's view. The overview is polled every 2 s only while the stage is `evaluating` (the timer is injected so tests never
// sleep). Progress and refusals are announced on one polite status line; every refusal is a fixed sentence.

export const POLL_MS = 2_000;

export type ReportPanelProps = { sessionId: string; fetch?: typeof fetch; setTimer?: SetTimer };

export function ReportPanel({ sessionId, fetch: fetchImpl, setTimer = realSetTimer }: ReportPanelProps) {
  const headingId = useId();
  const [overview, setOverview] = useState<ReportOverviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<{ opener: HTMLElement } | null>(null);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await fetchReportOverview(sessionId, fetchImpl);
    if (!alive.current) return;
    if (!r.ok) {
      setLoadError(reportFailureText(r));
      return;
    }
    const parsed = parseReportOverview(r.data);
    setLoadError(parsed === null ? REPORT_CONSOLE.unreadable : null);
    if (parsed !== null) setOverview(parsed);
  }, [sessionId, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  // One poll after each answer, and only while the evaluation runs; a new answer (or leaving the page) cancels the one scheduled.
  useEffect(() => {
    if (overview?.stage !== "evaluating") return;
    return setTimer(() => void load(), POLL_MS);
  }, [overview, load, setTimer]);

  const author = isAuthorName(name) ? name : null;

  async function act(call: Promise<ApiResult>, done: string) {
    setPending(true);
    setMessage("");
    const r = await call;
    if (!alive.current) return;
    setPending(false);
    setConfirm(null);
    setMessage(r.ok ? done : reportFailureText(r));
    await load();
  }

  return (
    <section className="card stack report-panel" aria-labelledby={headingId}>
      <h2 className="s" id={headingId}>
        Report
      </h2>
      <p className="small muted" role="status" aria-live="polite" tabIndex={-1} data-focus-fallback="report">
        {message}
      </p>
      <AuthorName value={name} onChange={setName} />
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
      {overview === null ? null : (
        <>
          <EvaluateCard
            overview={overview}
            canWrite={author !== null}
            pending={pending}
            onEvaluate={(opener) => setConfirm({ opener })}
            onCancel={() => void act(cancelEvaluate(sessionId, fetchImpl), REPORT_CONSOLE.cancelled)}
            onOpen={() => {
              if (author !== null) void act(openReview(sessionId, author, fetchImpl), REPORT_CONSOLE.opened);
            }}
          />
          {overview.summary !== null ? <RunSummaryView summary={overview.summary} /> : null}
          {overview.stage === "in_review" && overview.subjects.length > 0 ? (
            <SubjectList subjects={overview.subjects} selected={selected} onSelect={setSelected} />
          ) : null}
          {overview.stage === "in_review" && selected !== null ? (
            <SubjectView key={selected} sessionId={sessionId} subject={selected} author={author} {...(fetchImpl ? { fetch: fetchImpl } : {})} onChanged={() => void load()} />
          ) : null}
        </>
      )}
      {confirm !== null && overview?.upTo != null && author !== null ? (
        <EvaluateConfirmDialog
          upTo={overview.upTo}
          name={author}
          pending={pending}
          opener={confirm.opener}
          onCancel={() => setConfirm(null)}
          onConfirm={(n) => void act(startEvaluate(sessionId, n, author, fetchImpl), REPORT_CONSOLE.started)}
        />
      ) : null}
    </section>
  );
}
