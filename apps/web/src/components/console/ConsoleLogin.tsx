"use client";

import { useRef, useState, type FormEvent } from "react";
import { postJson } from "../../lib/api";
import { MESSAGES } from "../../lib/messages";

// The facilitator's sign-in: the shared secret and a name. The secret goes to the BFF once, is cleared from the field after any
// answer and is never rendered back or stored; the BFF answers with an HttpOnly cookie this code never sees. A wrong secret and an
// empty name get the same neutral refusal from the server, so the page itself asks for a name before it sends anything.

export type ConsoleLoginProps = {
  fetch?: typeof fetch;
  navigate?: (url: string) => void;
};

const goTo = (url: string) => window.location.assign(url);

const COPY = {
  needName: "Enter your name.",
  needSecret: "Enter the facilitator secret.",
  refused: "That did not work. Check the secret and the name and try again.",
  throttled: "Too many attempts. Wait a minute and try again.",
} as const;

function refusal(status: number): string {
  if (status === 401) return COPY.refused;
  if (status === 429) return COPY.throttled;
  if (status === 503 || status === 0) return MESSAGES.unavailable;
  return MESSAGES.generic;
}

export function ConsoleLogin({
  fetch: fetchImpl,
  navigate = goTo,
}: ConsoleLoginProps) {
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    const who = name.trim();
    if (who.length === 0) {
      setError(COPY.needName);
      return;
    }
    if (secret.length === 0) {
      setError(COPY.needSecret);
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    const r = await postJson(
      "/api/v1/console/login",
      { secret, name: who },
      fetchImpl,
    );
    if (r.ok) {
      navigate("/console");
      return;
    } // stays pending: the page is going away
    busy.current = false;
    setSecret("");
    setPending(false);
    setError(refusal(r.status));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="field">
        <label className="f" htmlFor="console-secret">
          Facilitator secret
        </label>
        <input
          className="t"
          id="console-secret"
          name="secret"
          type="password"
          value={secret}
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="f" htmlFor="console-name">
          Your name
        </label>
        <input
          className="t"
          id="console-name"
          name="name"
          value={name}
          autoComplete="name"
          required
          aria-describedby="console-name-help"
          onChange={(e) => setName(e.target.value)}
        />
        <p className="muted small" id="console-name-help">
          Recorded next to anything you do in a session. Participants do not see
          it.
        </p>
      </div>
      <p className="err" aria-live="polite">
        {error}
      </p>
      <div>
        <button className="btn pri" type="submit" disabled={pending}>
          Sign in
        </button>
      </div>
    </form>
  );
}
