"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";

// A modal confirmation. The first action (Cancel, the safe one) gets focus on open; Tab stays inside; Escape cancels; closing hands
// focus back to the control that opened it. Text is rendered as text.

export type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  /** The control that opened the dialog (focus returns here). Defaults to whatever had focus when the dialog opened. */
  opener?: HTMLElement | null;
};

const FOCUSABLE =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  opener,
}: ConfirmDialogProps) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(
    opener ??
      (typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement | null)),
  );

  useEffect(() => {
    cancelBtn.current?.focus();
    const target = returnTo.current;
    return () => {
      if (target && target.isConnected) target.focus();
    };
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!pending) onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    const items = [
      ...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    ];
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !box.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (
      !e.shiftKey &&
      (active === last || !box.current?.contains(active))
    ) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog card stack"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        aria-describedby={`${id}-d`}
        ref={box}
        onKeyDown={onKeyDown}
      >
        <h2 className="dialog-title" id={`${id}-t`}>
          {title}
        </h2>
        <p id={`${id}-d`}>{description}</p>
        <div className="dialog-actions">
          <button
            className="btn"
            type="button"
            ref={cancelBtn}
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="btn danger"
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
