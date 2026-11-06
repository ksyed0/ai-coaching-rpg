"use client";

import { useId, useState } from "react";
import type { ReportResponse, ResolveOutcome } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";

// The participant's open disputes on this report, each with its response text (as text) and a resolve form: an outcome and a reason
// (shown to the participant), both required. `amended` is offered only once an amendment has produced a new released version after the
// dispute (the server's rule, review/fold.ts amendedSince): amend the report, release it again, then resolve it as amended. A refused
// resolve keeps what was typed.

/** Whether the report was released again after `seq` (a response needs a release, so a later release is an amended one). */
export const amendedAfter = (versions: readonly number[], seq: number): boolean => versions.some((v) => v > seq);

export type ResolveDisputePanelProps = {
  responses: ReportResponse[];
  versions: number[];
  canWrite: boolean;
  pending: boolean;
  criterionName: (id: string) => string;
  /** Resolves to null when saved, else the fixed sentence of the refusal. */
  onResolve: (seq: number, outcome: ResolveOutcome, reason: string) => Promise<string | null>;
};

export function ResolveDisputePanel({ responses, versions, canWrite, pending, criterionName, onResolve }: ResolveDisputePanelProps) {
  const open = responses.filter((r) => r.dispute && r.resolution === undefined);
  if (open.length === 0) return null;
  return (
    <div className="stack report-disputes">
      <h4>Open disputes</h4>
      <ul className="console-list stack">
        {open.map((r) => (
          <DisputeRow key={r.seq} response={r} amended={amendedAfter(versions, r.seq)} canWrite={canWrite} pending={pending} criterionName={criterionName} onResolve={onResolve} />
        ))}
      </ul>
    </div>
  );
}

function DisputeRow({ response: r, amended, canWrite, pending, criterionName, onResolve }: {
  response: ReportResponse; amended: boolean; canWrite: boolean; pending: boolean; criterionName: (id: string) => string;
  onResolve: ResolveDisputePanelProps["onResolve"];
}) {
  const id = useId();
  const [outcome, setOutcome] = useState<ResolveOutcome | "">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const chosen = outcome === "amended" && !amended ? "" : outcome;
  const ready = chosen !== "" && reason.trim() !== "" && canWrite && !pending;

  async function resolve() {
    if (!ready) return;
    setError("");
    const refusal = await onResolve(r.seq, chosen, reason);
    if (refusal !== null) setError(refusal);
  }

  return (
    <li className="card soft stack">
      <p className="small muted">{r.criterion === undefined ? "About the whole report" : `About ${criterionName(r.criterion)}`}</p>
      <p className="report-text">{r.text}</p>
      <div className="field">
        <label htmlFor={`${id}-outcome`}>Outcome</label>
        <select id={`${id}-outcome`} className="t" value={chosen} onChange={(e) => setOutcome(e.target.value as ResolveOutcome | "")}>
          <option value="">Choose an outcome</option>
          <option value="upheld">Upheld</option>
          {amended ? <option value="amended">Amended</option> : null}
          <option value="declined">Declined</option>
        </select>
      </div>
      {!amended ? <p className="small muted">{REPORT_CONSOLE.amendFirst}</p> : null}
      <div className="field">
        <label htmlFor={`${id}-reason`}>Reason shown to the participant (required)</label>
        <textarea id={`${id}-reason`} className="t" rows={2} required value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <p className="err" aria-live="polite">
        {error}
      </p>
      <div>
        <button className="btn" type="button" disabled={!ready} onClick={() => void resolve()}>
          Resolve
        </button>
      </div>
    </li>
  );
}
