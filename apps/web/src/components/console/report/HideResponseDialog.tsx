"use client";

import { REPORT_CONSOLE } from "../../../lib/messages";
import { ReasonDialog } from "./ReasonDialog";

// Hide one participant response (US-0069): shows the exact text being hidden, says it cannot be undone and the participant is not told,
// and requires a reason (at most 500 characters, counted live). There is no unhide, so this guards against a misclick.

export const MAX_HIDE_REASON = 500;

export type HideResponseDialogProps = {
  response: { seq: number; text: string };
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  error: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

export function HideResponseDialog({ response, ...rest }: HideResponseDialogProps) {
  return (
    <ReasonDialog
      {...rest}
      title={REPORT_CONSOLE.hideTitle(response.seq)}
      description={REPORT_CONSOLE.hideIrreversible}
      confirmLabel="Hide"
      tone="danger"
      audienceIntro={REPORT_CONSOLE.hideIntro}
      audience={[response.text]}
      reasonLabel={REPORT_CONSOLE.hideReasonLabel}
      maxLength={MAX_HIDE_REASON}
    />
  );
}
