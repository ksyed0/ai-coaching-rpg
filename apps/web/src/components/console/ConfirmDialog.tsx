"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// A modal confirmation. The first action (Cancel, the safe one) gets focus on open; Tab stays inside; Escape cancels; closing hands
// focus back to the control that opened it, while that control can take it (in the document, shown, not disabled); otherwise (BUG-0022)
// to `fallbackFocus`, the message that now tells the user what happened. Focus is only moved when it is on the page or inside the
// closed dialog, never when the user has put it somewhere else. While it is open the rest of the page is inert (not focusable, not read by assistive
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
  /** Fields or a preview between the description and the actions (inside the focus trap). */
  children?: ReactNode;
  /** True when the body is a read-only preview (inject content, whisper text): it joins the dialog's accessible description. */
  describeBody?: boolean;
  /** `danger` (default) or `primary`: the look of the confirm button only. */
  tone?: "danger" | "primary";
  /** Where focus goes on close when the opener is gone, hidden or disabled: a message element (`tabIndex={-1}`), see `focusFallback`. */
  fallbackFocus?: () => HTMLElement | null;
};

/** Marks a message element that can take focus when a dialog's opener cannot: `data-focus-fallback="<name>"` plus `tabIndex={-1}`. */
export const FOCUS_FALLBACK_ATTR = "data-focus-fallback";

/** A `fallbackFocus` that finds, at close time, the first of the named marked elements that has text (an empty live region is skipped). */
export function focusFallback(...names: string[]): () => HTMLElement | null {
  return () => {
    for (const name of names) {
      for (const el of document.querySelectorAll<HTMLElement>(`[${FOCUS_FALLBACK_ATTR}="${CSS.escape(name)}"]`))
        if ((el.textContent ?? "").trim() !== "") return el;
    }
    return null;
  };
}

/** True when `el` is in the document, shown and not disabled. (`aria-disabled` stays focusable on purpose.) */
function canTakeFocus(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected || (el as HTMLButtonElement).disabled || el.closest("[hidden], [inert]")) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

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
  children,
  describeBody = false,
  tone = "danger",
  fallbackFocus,
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

  // The latest callback, read at close time (the caller's message may only exist by then).
  const fallback = useRef(fallbackFocus);
  fallback.current = fallbackFocus;

  useEffect(() => {
    cancelBtn.current?.focus();
    const target = returnTo.current;
    const dialog = root.current;
    return () => {
      const at = document.activeElement;
      // Only when focus is on the page or was inside this dialog (which is gone now): a user who moved on keeps their place.
      if (at !== null && at !== document.body && !dialog?.contains(at)) return;
      (canTakeFocus(target) ? target : fallback.current?.())?.focus();
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
        aria-describedby={describeBody ? `${id}-d ${id}-b` : `${id}-d`}
        ref={box}
        onKeyDown={onKeyDown}
      >
        <h2 className="dialog-title" id={`${id}-t`}>
          {title}
        </h2>
        <p id={`${id}-d`}>{description}</p>
        {children === undefined ? null : (
          <div className="stack" id={`${id}-b`}>
            {children}
          </div>
        )}
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
            className={tone === "primary" ? "btn pri" : "btn danger"}
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
