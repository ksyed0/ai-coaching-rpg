"use client";

import { REPORT_CONSOLE } from "../../../lib/messages";
import { ReasonDialog } from "./ReasonDialog";
import { subjectLabel } from "./SubjectList";

// Withdraw a released report (AC-0338): names the subject and the audience that loses it, says it cannot be undone, and requires a reason.

export type WithdrawDialogProps = {
  subject: { id: string; audience: string[] };
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

export function WithdrawDialog({ subject, ...rest }: WithdrawDialogProps) {
  return (
    <ReasonDialog
      {...rest}
      title={REPORT_CONSOLE.withdrawTitle(subjectLabel(subject.id))}
      description={REPORT_CONSOLE.withdrawIrreversible}
      confirmLabel="Withdraw"
      tone="danger"
      audienceIntro={REPORT_CONSOLE.withdrawHidden}
      audience={subject.audience}
      reasonLabel="Reason for withdrawing (required)"
    />
  );
}
