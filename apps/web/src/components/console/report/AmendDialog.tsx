"use client";

import { REPORT_CONSOLE } from "../../../lib/messages";
import { ReasonDialog } from "./ReasonDialog";
import { subjectLabel } from "./SubjectList";

// Amend a released report (AC-0338): names the subject and its audience; a reason is required. The participants keep the released
// version until the amended one is released.

export type AmendDialogProps = {
  subject: { id: string; audience: string[] };
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

export function AmendDialog({ subject, ...rest }: AmendDialogProps) {
  return (
    <ReasonDialog
      {...rest}
      title={REPORT_CONSOLE.amendTitle(subjectLabel(subject.id))}
      description={REPORT_CONSOLE.amendIntro}
      confirmLabel="Amend"
      tone="primary"
      audienceIntro={REPORT_CONSOLE.seenBy}
      audience={subject.audience}
      reasonLabel="Reason for the amendment (required)"
    />
  );
}
