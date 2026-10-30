"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";

// A modal confirmation. The first action (Cancel, the safe one) gets focus on open; Tab stays inside; Escape cancels; closing hands
// focus back to the control that opened it. While it is open the rest of the page is inert (not focusable, not read by assistive
// technology, not clickable), which `aria-modal` alone does not guarantee. Text is rendered as text.

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

/** Sets `inert` on every sibling of `node` and of each of its ancestors (so the chain holding the dialog stays live); returns the undo. */
function inertOutside(node: HTMLElement): () => void {
  const changed: Element[] = [];
  for (
    let at: HTMLElement | null = node;
    at && at !== document.documentElement;
    at = at.parentElement
  ) {
    for (const sib of at.parentElement?.children ?? []) {
      if (
        sib === at ||
        ["SCRIPT", "STYLE", "LINK", "TEMPLATE"].includes(sib.tagName) ||
        sib.hasAttribute("inert")
      )
        continue;
      sib.setAttribute("inert", "");
      changed.push(sib);
    }
  }
  // Only what this call set is undone: an element that was already inert stays so.
  return () => {
    for (const el of changed) el.removeAttribute("inert");
  };
}

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
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(
    opener ??
      (typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement | null)),
  );

  // Declared before the focus effect: on close the page is live again before focus goes back to the opener.
  useEffect(() => (root.current ? inertOutside(root.current) : undefined), []);

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
    <div className="dialog-backdrop" ref={root}>
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
