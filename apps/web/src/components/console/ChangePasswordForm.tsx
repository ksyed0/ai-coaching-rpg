"use client";

import { useRef, useState, type FormEvent } from "react";
import { postJson } from "../../lib/api";
import { MESSAGES } from "../../lib/messages";

// Changing the account's own password: the forced change after a temporary password, or a voluntary one. The three values go to the BFF
// once and are cleared from the fields after any answer; nothing is stored, logged or put in a URL. The mismatch and length checks run
// here first and send nothing (the server still enforces its own rules).

/** The shortest new password; the server's weak-password check is the real gate. */
export const MIN_PASSWORD_LENGTH = 10;

export type ChangePasswordFormProps = {
  /** Called after the server accepted the change (the page goes to /console). */
  onDone?: () => void;
  fetch?: typeof fetch;
};

const goToConsole = () => window.location.assign("/console");

const COPY = {
  needCurrent: "Enter your current password.",
  tooShort: `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`,
  mismatch: "The two new passwords do not match.",
  wrong: "The current password is not right.",
  weak: "Choose a longer password that is not easy to guess.",
  throttled: "Too many attempts. Wait a minute and try again.",
  signedOut: "Your sign-in ended. Sign in again to change your password.",
} as const;

function refusal(r: { status: number; code: string }): string {
  if (r.status === 403 && r.code === "wrong_password") return COPY.wrong;
  if (r.status === 400 && r.code === "weak_password") return COPY.weak;
  if (r.status === 429) return COPY.throttled;
  if (r.status === 401) return COPY.signedOut;
  if (r.status === 502 || r.status === 503 || r.status === 0) return MESSAGES.unavailable;
  return MESSAGES.generic;
}

export function ChangePasswordForm({ onDone = goToConsole, fetch: fetchImpl }: ChangePasswordFormProps) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    if (current.length === 0) return setError(COPY.needCurrent);
    if (next.length < MIN_PASSWORD_LENGTH) return setError(COPY.tooShort);
    if (next !== repeat) return setError(COPY.mismatch);
    busy.current = true;
    setPending(true);
    setError(null);
    const r = await postJson("/api/v1/console/password", { current, next }, fetchImpl);
    if (r.ok) {
      onDone();
      return;
    } // stays pending: the page is going away
    busy.current = false;
    setCurrent("");
    setNext("");
    setRepeat("");
    setPending(false);
    setError(refusal(r));
  }

  return (
    <form className="card stack" method="post" onSubmit={submit} noValidate>
      <div className="field">
        <label className="f" htmlFor="change-current">
          Current (temporary) password
        </label>
        <input
          className="t"
          id="change-current"
          name="current"
          type="password"
          value={current}
          autoComplete="current-password"
          spellCheck={false}
          required
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="f" htmlFor="change-next">
          New password
        </label>
        <input
          className="t"
          id="change-next"
          name="next"
          type="password"
          value={next}
          autoComplete="new-password"
          spellCheck={false}
          required
          aria-describedby="change-next-help"
          onChange={(e) => setNext(e.target.value)}
        />
        <p className="muted small" id="change-next-help">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="field">
        <label className="f" htmlFor="change-repeat">
          Repeat
        </label>
        <input
          className="t"
          id="change-repeat"
          name="repeat"
          type="password"
          value={repeat}
          autoComplete="new-password"
          spellCheck={false}
          required
          onChange={(e) => setRepeat(e.target.value)}
        />
      </div>
      <p className="err" aria-live="polite">
        {error}
      </p>
      <div>
        <button className="btn pri" type="submit" disabled={pending}>
          Change password
        </button>
      </div>
    </form>
  );
}
