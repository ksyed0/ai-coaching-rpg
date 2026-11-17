"use client";

import { useState } from "react";
import type { ReportResponse } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { HideResponseDialog } from "./HideResponseDialog";

// Every participant response on this report (not only disputes), each with a Hide button. A hidden response is shown in words as hidden,
// with the reason, who and when, and never its text. Hiding cannot be undone, so it goes through a confirm dialog. Text is rendered as text.

export type ResponsesPanelProps = {
  responses: ReportResponse[];
  canWrite: boolean;
  pending: boolean;
  criterionName: (id: string) => string;
  /** The typed name the hide is recorded under (shown in the dialog). */
  author?: string;
  /** Resolves to null when saved, else the fixed sentence of the refusal. */
  onHide: (seq: number, reason: string) => Promise<string | null>;
};

const when = (ms: number) => new Date(ms).toLocaleString();
/** `<time>` needs a valid date; an out-of-range value would make toISOString throw. */
const iso = (ms: number): string | undefined => (Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined);

export function ResponsesPanel({ responses, canWrite, pending, criterionName, author = "", onHide }: ResponsesPanelProps) {
  const [open, setOpen] = useState<{ response: { seq: number; text: string }; opener: HTMLElement } | null>(null);
  const [error, setError] = useState("");
  if (responses.length === 0) return null;

  async function confirm(reason: string) {
    if (open === null) return;
    setError("");
    const refusal = await onHide(open.response.seq, reason);
    if (refusal === null) setOpen(null);
    else setError(refusal);
  }

  return (
    <div className="stack report-responses">
      <h4>{REPORT_CONSOLE.responsesHeading}</h4>
      {!canWrite ? <p className="small muted">{REPORT_CONSOLE.nameNeeded}</p> : null}
      <ul className="console-list stack">
        {responses.map((r) => (
          <li key={r.seq} className="card soft stack">
            <p className="small muted">{`Response ${r.seq}: ${r.criterion === undefined ? "About the whole report" : `About ${criterionName(r.criterion)}`}`}</p>
            {r.hidden !== undefined ? (
              <p className="report-text">
                <strong>{REPORT_CONSOLE.hiddenBy}</strong>
                {". "}
                {REPORT_CONSOLE.hiddenDetail(r.hidden.reason, r.hidden.by)}
                {" on "}
                <time dateTime={iso(r.hidden.at)}>{when(r.hidden.at)}</time>
              </p>
            ) : (
              <>
                <p className="report-text">{r.text}</p>
                <div>
                  <button
                    className="btn"
                    type="button"
                    disabled={!canWrite || pending}
                    aria-label={REPORT_CONSOLE.hideButton(r.seq)}
                    onClick={(e) => {
                      setError("");
                      setOpen({ response: { seq: r.seq, text: r.text ?? "" }, opener: e.currentTarget });
                    }}
                  >
                    Hide
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      {open !== null ? (
        <HideResponseDialog
          response={open.response}
          name={author}
          pending={pending}
          opener={open.opener}
          error={error}
          onConfirm={(reason) => void confirm(reason)}
          onCancel={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
