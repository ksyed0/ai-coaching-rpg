"use client";

import { REPORT_CONSOLE } from "../../../lib/messages";
import { ConfirmDialog, focusFallback } from "../ConfirmDialog";

// The confirmation before an evaluate spends money: the server's own bound (`confirm.upTo`) and the typed name. Confirm sends the bound
// back unchanged; the server refuses a different number. ConfirmDialog traps focus and returns it.

export type EvaluateConfirmDialogProps = {
  upTo: number;
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  onConfirm: (confirmedCalls: number) => void;
  onCancel: () => void;
};

export function EvaluateConfirmDialog({ upTo, name, pending, opener, onConfirm, onCancel }: EvaluateConfirmDialogProps) {
  return (
    <ConfirmDialog
      title={REPORT_CONSOLE.confirmTitle}
      description={REPORT_CONSOLE.confirmCalls(upTo)}
      confirmLabel="Evaluate"
      tone="primary"
      pending={pending}
      opener={opener}
      describeBody
      fallbackFocus={focusFallback("report")}
      onCancel={onCancel}
      onConfirm={() => onConfirm(upTo)}
    >
      <p>{REPORT_CONSOLE.confirmNoRefund}</p>
      <p>{REPORT_CONSOLE.confirmAuthor(name)}</p>
    </ConfirmDialog>
  );
}
