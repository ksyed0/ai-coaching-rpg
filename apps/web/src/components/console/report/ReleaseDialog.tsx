"use client";

import { REPORT_CONSOLE } from "../../../lib/messages";
import { ConfirmDialog, focusFallback } from "../ConfirmDialog";
import { subjectLabel } from "./SubjectList";

// The release confirmation (AC-0338): each subject by name with its audience from the visibility policy (lib/report-audience.ts, never
// invented), and the open items that still block it. Confirm is disabled while any item blocks. After a `blocked` refusal it stays open
// and lists the subjects the server named. ConfirmDialog traps focus and returns it. Text is rendered as text.

export type ReleaseSubject = { id: string; audience: string[]; blockers: string[] };

export type ReleaseDialogProps = {
  subjects: ReleaseSubject[];
  name: string;
  pending: boolean;
  opener: HTMLElement | null;
  /** The fixed sentence of the last refusal, or "". */
  error: string;
  /** The subject ids a `blocked` refusal named. */
  blocked: string[];
  onConfirm: () => void;
  onCancel: () => void;
};

export function ReleaseDialog({ subjects, name, pending, opener, error, blocked, onConfirm, onCancel }: ReleaseDialogProps) {
  const blocks = subjects.length === 0 || subjects.some((s) => s.blockers.length > 0);
  return (
    <ConfirmDialog
      title={REPORT_CONSOLE.releaseTitle}
      description={REPORT_CONSOLE.releaseIntro}
      confirmLabel="Release"
      tone="primary"
      pending={pending}
      confirmDisabled={blocks}
      opener={opener}
      fallbackFocus={focusFallback("report")}
      onCancel={onCancel}
      onConfirm={() => {
        if (!blocks) onConfirm();
      }}
    >
      <ul className="console-list stack report-release-list">
        {subjects.map((s) => (
          <li key={s.id} className="stack">
            <strong>{subjectLabel(s.id)}</strong>
            <div>
              <span className="small muted">{REPORT_CONSOLE.seenBy}</span>
              <ul className="console-list small">
                {s.audience.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
            {s.blockers.length > 0 ? (
              <div className="banner warn">
                <span className="small">{REPORT_CONSOLE.stillOpen}</span>
                <ul className="console-list small">
                  {s.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {blocked.length > 0 ? <p className="banner warn">{REPORT_CONSOLE.blockedList(blocked.map(subjectLabel).join(", "))}</p> : null}
      <p className="err" aria-live="polite">
        {error}
      </p>
      <p>{REPORT_CONSOLE.confirmAuthor(name)}</p>
    </ConfirmDialog>
  );
}
