"use client";

import { useId, useState } from "react";

// US-0083: a new or reissued account's login and temporary password, shown once. They live in this component's state only (the parent
// keeps nothing but whether to show the panel): never any browser storage, the URL, the history or a cookie. "I have shared these"
// empties the state, so nothing is left in the page. Both are rendered as text, never as markup.

export type CredentialsPanelProps = {
  login: string;
  name: string;
  temporaryPassword: string;
  /** Called after the credentials were cleared, so the parent drops its own reference too. */
  onDismiss: () => void;
};

type Which = "login" | "password";
type CopyState = "copied" | "failed";

export function CredentialsPanel({ login, name, temporaryPassword, onDismiss }: CredentialsPanelProps) {
  const headingId = useId();
  const [shown, setShown] = useState<{ login: string; name: string; password: string } | null>({
    login,
    name,
    password: temporaryPassword,
  });
  const [copy, setCopy] = useState<Partial<Record<Which, CopyState>>>({});

  if (shown === null) return null;

  async function copyText(which: Which, text: string) {
    let state: CopyState = "failed";
    try {
      const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(text);
        state = "copied";
      }
    } catch {
      /* the clipboard may be blocked: the text stays selectable */
    }
    setCopy((prev) => ({ ...prev, [which]: state }));
  }

  function dismiss() {
    setShown(null);
    setCopy({});
    onDismiss();
  }

  const status = (which: Which, what: string) =>
    copy[which] === "copied" ? "Copied." : copy[which] === "failed" ? `Could not copy the ${what}. Select it and copy it by hand.` : "";

  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 className="s" id={headingId}>
        Sign-in details
      </h2>
      <p className="banner warn" role="alert">
        Share these with <bdi>{shown.name}</bdi>. Shown once.
      </p>
      <ul className="codes">
        <li className="code-row">
          <span className="code-role">Login</span>
          <code className="mono code-value">{shown.login}</code>
          <button className="btn" type="button" aria-label="Copy login" onClick={() => void copyText("login", shown.login)}>
            Copy
          </button>
          <span className="small muted" role="status">
            {status("login", "login")}
          </span>
        </li>
        <li className="code-row">
          <span className="code-role">Temporary password</span>
          <code className="mono code-value">{shown.password}</code>
          <button
            className="btn"
            type="button"
            aria-label="Copy temporary password"
            onClick={() => void copyText("password", shown.password)}
          >
            Copy
          </button>
          <span className="small muted" role="status">
            {status("password", "password")}
          </span>
        </li>
      </ul>
      <p className="muted small">They must choose a new password the first time they sign in.</p>
      <div>
        <button className="btn pri" type="button" onClick={dismiss}>
          I have shared these
        </button>
      </div>
    </section>
  );
}
