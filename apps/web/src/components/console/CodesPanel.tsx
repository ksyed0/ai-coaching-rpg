"use client";

import { useState } from "react";
import type { CodeEntry } from "../../lib/console-api";
import { roleLabel } from "../../lib/names";

// Join codes, shown once. They live in this component's state only: never any browser storage, the URL, the
// history or a cookie. "I have copied the codes" empties the state, so nothing is left in the page. Codes are rendered as text.

export type CodesPanelProps = {
  codes: CodeEntry[];
  /** Called after the codes were cleared, so the parent drops its own reference too. */
  onDismiss?: () => void;
  heading?: string;
};

type CopyState = "copied" | "failed";

export function CodesPanel({
  codes: initial,
  onDismiss,
  heading = "Join codes",
}: CodesPanelProps) {
  const [codes, setCodes] = useState<CodeEntry[]>(initial);
  const [copy, setCopy] = useState<Record<string, CopyState>>({});

  if (codes.length === 0) return null;

  async function copyCode(c: CodeEntry) {
    let state: CopyState = "failed";
    try {
      const clip =
        typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(c.code);
        state = "copied";
      }
    } catch {
      /* the clipboard may be blocked: the code stays selectable */
    }
    setCopy((prev) => ({ ...prev, [c.roleId]: state }));
  }

  function dismiss() {
    setCodes([]);
    setCopy({});
    onDismiss?.();
  }

  return (
    <section className="card stack" aria-labelledby="codes-h">
      <h2 className="s" id="codes-h">
        {heading}
      </h2>
      <p className="banner warn" role="alert">
        These codes are shown once and cannot be shown again.
      </p>
      <ul className="codes">
        {codes.map((c) => (
          <li className="code-row" key={c.roleId}>
            <span className="code-role">{roleLabel(c.roleId)}</span>
            <code className="mono code-value">{c.code}</code>
            <button
              className="btn"
              type="button"
              aria-label={`Copy code for ${roleLabel(c.roleId)}`}
              onClick={() => void copyCode(c)}
            >
              Copy
            </button>
            <span className="small muted" role="status">
              {copy[c.roleId] === "copied"
                ? "Copied."
                : copy[c.roleId] === "failed"
                  ? "Could not copy. Select the code and copy it by hand."
                  : ""}
            </span>
          </li>
        ))}
      </ul>
      <div>
        <button className="btn pri" type="button" onClick={dismiss}>
          I have copied the codes
        </button>
      </div>
    </section>
  );
}
