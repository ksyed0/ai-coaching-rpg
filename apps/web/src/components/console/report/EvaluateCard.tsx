"use client";

import type { ReportOverviewView } from "../../../lib/console-api";
import { REPORT_CONSOLE, REPORT_REFUSALS } from "../../../lib/messages";

// Where the evaluation stands: not ended, ready (Evaluate opens the confirmation), running (progress lines from control's allowlist and
// Cancel), failed (one fixed sentence per reason, and Evaluate again when control offers the bound), drafted but not open (Open), an
// orphan folder (the ROLLBACK step), or done. Every write but Cancel needs a valid typed name; Cancel stops spending, so it never waits for one.

export type EvaluateCardProps = {
  overview: ReportOverviewView;
  /** A valid author name is typed. */
  canWrite: boolean;
  pending: boolean;
  onEvaluate: (opener: HTMLElement) => void;
  onCancel: () => void;
  onOpen: () => void;
};

export function EvaluateCard({ overview: o, canWrite, pending, onEvaluate, onCancel, onOpen }: EvaluateCardProps) {
  const evaluate =
    o.upTo !== null && !o.orphan && (o.stage === "not_evaluated" || o.stage === "failed") ? (
      <div>
        <button className="btn pri" type="button" disabled={!canWrite || pending} onClick={(e) => onEvaluate(e.currentTarget)}>
          Evaluate…
        </button>
      </div>
    ) : null;
  return (
    <div className="stack report-evaluate">
      {o.stage === "not_ended" ? <p>{REPORT_REFUSALS.not_ended}</p> : null}
      {o.stage === "not_evaluated" && !o.orphan ? <p>{REPORT_CONSOLE.ready}</p> : null}
      {o.stage === "failed" ? <p className="banner warn">{REPORT_CONSOLE.failed[o.job.reason ?? "error"]}</p> : null}
      {o.orphan ? <p className="banner warn">{REPORT_CONSOLE.orphan}</p> : null}
      {evaluate}
      {o.stage === "evaluating" ? (
        <>
          <p>{REPORT_CONSOLE.running}</p>
          {o.job.progress.length > 0 ? (
            <ol className="console-list report-progress small mono">
              {o.job.progress.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ol>
          ) : null}
          <div>
            <button className="btn danger" type="button" disabled={pending} onClick={onCancel}>
              Cancel evaluation
            </button>
          </div>
          <p className="small muted">{REPORT_CONSOLE.confirmNoRefund}</p>
        </>
      ) : null}
      {o.stage === "ready_to_open" ? (
        <>
          <p>{REPORT_CONSOLE.readyToOpen}</p>
          <div>
            <button className="btn pri" type="button" disabled={!canWrite || pending} onClick={onOpen}>
              Open the review
            </button>
          </div>
        </>
      ) : null}
      {o.stage === "in_review" ? <p>{`${REPORT_CONSOLE.done}${o.job.modelCalls === null ? "" : REPORT_CONSOLE.doneCalls(o.job.modelCalls)}`}</p> : null}
    </div>
  );
}
