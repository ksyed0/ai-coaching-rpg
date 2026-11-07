"use client";

import { useId, useState } from "react";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { ConfirmDialog, focusFallback } from "../ConfirmDialog";

// The shared body of the amend and withdraw confirmations: who sees the subject, a required reason, the last refusal and the typed name.
// The reason lives in the dialog, which stays open on a refusal, so a stale, busy or invalid answer never loses what was typed.

export type ReasonDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger" | "primary";
  audienceIntro: string;
  audience: string[];
  reasonLabel: string;
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

export function ReasonDialog(p: ReasonDialogProps) {
  const id = useId();
  const [reason, setReason] = useState("");
  const empty = reason.trim() === "";
  return (
    <ConfirmDialog
      title={p.title}
      description={p.description}
      confirmLabel={p.confirmLabel}
      tone={p.tone}
      pending={p.pending}
      confirmDisabled={empty}
      opener={p.opener}
      fallbackFocus={focusFallback("report")}
      onCancel={p.onCancel}
      onConfirm={() => {
        if (!empty) p.onConfirm(reason);
      }}
    >
      <div>
        <span className="small muted">{p.audienceIntro}</span>
        <ul className="console-list small">
          {p.audience.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
      <div className="field">
        <label htmlFor={`${id}-reason`}>{p.reasonLabel}</label>
        <textarea id={`${id}-reason`} className="t" rows={3} required value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <p className="err" aria-live="polite">
        {p.error}
      </p>
      <p>{REPORT_CONSOLE.confirmAuthor(p.name)}</p>
    </ConfirmDialog>
  );
}
