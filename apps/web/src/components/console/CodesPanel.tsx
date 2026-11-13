"use client";

import { useId, useState } from "react";
import type { CodeEntry } from "../../lib/console-api";
import { roleLabel } from "../../lib/names";

// Join codes, shown once. They live in this component's state only: never any browser storage, the URL, the
// history or a cookie. "I have copied the codes" empties the state, so nothing is left in the page. Codes are rendered as text.

export type CodesPanelProps = {
  codes: CodeEntry[];
  /** Called after the codes were cleared, so the parent drops its own reference too. */
  onDismiss?: () => void;
  heading?: string;
  /** The session the codes belong to. With it, each role also shows its join link (no code in it: the code is typed). */
  sessionId?: string;
};

type CopyState = "copied" | "failed";

export function CodesPanel({
  codes: initial,
  onDismiss,
  heading = "Join codes",
  sessionId,
}: CodesPanelProps) {
  const headingId = useId();
  const [codes, setCodes] = useState<CodeEntry[]>(initial);
  const [copy, setCopy] = useState<Record<string, CopyState>>({});

  if (codes.length === 0) return null;

  async function copyText(key: string, text: string) {
    let state: CopyState = "failed";
    try {
      const clip =
        typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(text);
        state = "copied";
      }
    } catch {
      /* the clipboard may be blocked: the text stays selectable */
    }
    setCopy((prev) => ({ ...prev, [key]: state }));
  }
  const copyCode = (c: CodeEntry) => copyText(c.roleId, c.code);
  /** The player's join link: the page's own origin, the session and the role. It holds no secret (the code is typed by the player). */
  const joinUrl = (c: CodeEntry): string | null =>
    sessionId && typeof window !== "undefined"
      ? `${window.location.origin}/join?session=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(c.roleId)}`
      : null;

  function dismiss() {
    setCodes([]);
    setCopy({});
    onDismiss?.();
  }

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 className="s" id={headingId}>
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
            {joinUrl(c) !== null ? (
              <span className="code-link">
                <span className="small muted">Join link</span>
                <code className="mono small code-url">{joinUrl(c)}</code>
                <button
                  className="btn"
                  type="button"
                  aria-label={`Copy join link for ${roleLabel(c.roleId)}`}
                  onClick={() => void copyText(`${c.roleId}:link`, joinUrl(c)!)}
                >
                  Copy link
                </button>
                <span className="small muted" role="status">
                  {copy[`${c.roleId}:link`] === "copied"
                    ? "Copied."
                    : copy[`${c.roleId}:link`] === "failed"
                      ? "Could not copy. Select the link and copy it by hand."
                      : ""}
                </span>
              </span>
            ) : null}
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
