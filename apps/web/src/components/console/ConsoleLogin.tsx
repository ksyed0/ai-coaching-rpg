"use client";

import { useRef, useState, type FormEvent } from "react";
import { postJson } from "../../lib/api";
import { MESSAGES } from "../../lib/messages";

// The facilitator's sign-in: a login and a password (US-0083), with the shared secret and a name behind a small disclosure while the
// legacy sign-in is still allowed. The secret goes to the BFF once, is cleared from the field after any
// answer and is never rendered back or stored; the BFF answers with an HttpOnly cookie this code never sees. A wrong secret and an
// empty name get the same neutral refusal from the server, so the page itself asks for a name before it sends anything.

export type ConsoleLoginProps = {
  /** Whether the shared-secret sign-in still works (the server page asks control); false hides the disclosure. */
  legacyAllowed?: boolean;
  fetch?: typeof fetch;
  navigate?: (url: string) => void;
};

const goTo = (url: string) => window.location.assign(url);

const COPY = {
  needLogin: "Enter your login.",
  needPassword: "Enter your password.",
  needName: "Enter your name.",
  needSecret: "Enter the facilitator secret.",
  accountRefused: "That did not work. Check the login and the password and try again.",
  expired: "This temporary password has expired. Ask an admin to resend it.",
  refused: "That did not work. Check the secret and the name and try again.",
  throttled: "Too many attempts. Wait a minute and try again.",
} as const;

function refusal(r: { status: number; code: string }, refused: string): string {
  if (r.status === 401) return r.code === "login_expired" ? COPY.expired : refused;
  if (r.status === 429) return COPY.throttled;
  if (r.status === 502 || r.status === 503 || r.status === 0) return MESSAGES.unavailable;
  return MESSAGES.generic;
}

/** Where a signed-in answer goes: an account that must change its password goes there first. */
function mustChange(data: unknown): boolean {
  return typeof data === "object" && data !== null && (data as { mustChange?: unknown }).mustChange === true;
}

export function ConsoleLogin({ legacyAllowed = false, fetch: fetchImpl, navigate = goTo }: ConsoleLoginProps) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  /** One request at a time; `after` runs only on an answer, which clears every secret field. */
  async function send(body: unknown, refused: string, onOk: (data: unknown) => void) {
    busy.current = true;
    setPending(true);
    setError(null);
    const r = await postJson("/api/v1/console/login", body, fetchImpl);
    if (r.ok) {
      onOk(r.data);
      return;
    } // stays pending: the page is going away
    busy.current = false;
    setPassword("");
    setSecret("");
    setPending(false);
    setError(refusal(r, refused));
  }

  async function submitAccount(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    const who = login.trim();
    if (who.length === 0) return setError(COPY.needLogin);
    if (password.length === 0) return setError(COPY.needPassword);
    await send({ login: who, password }, COPY.accountRefused, (data) => navigate(mustChange(data) ? "/console/password" : "/console"));
  }

  async function submitLegacy(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    const who = name.trim();
    if (who.length === 0) return setError(COPY.needName);
    if (secret.length === 0) return setError(COPY.needSecret);
    await send({ secret, name: who }, COPY.refused, () => navigate("/console"));
  }

  return (
    <div className="stack">
      <form className="card stack" method="post" onSubmit={submitAccount} noValidate>
        <div className="field">
          <label className="f" htmlFor="console-login">
            Login
          </label>
          <input
            className="t"
            id="console-login"
            name="login"
            value={login}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            onChange={(e) => setLogin(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="f" htmlFor="console-password">
            Password
          </label>
          <input
            className="t"
            id="console-password"
            name="password"
            type="password"
            value={password}
            autoComplete="current-password"
            spellCheck={false}
            required
            onChange={(e) => setPassword(e.target.value)}
          />
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
      {legacyAllowed ? (
        <details className="muted small">
          <summary>Use the shared secret instead</summary>
          <form className="card stack" method="post" onSubmit={submitLegacy} noValidate>
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
                Recorded next to anything you do in a session. Participants do not see it.
              </p>
            </div>
            <div>
              <button className="btn" type="submit" disabled={pending}>
                Sign in with the secret
              </button>
            </div>
          </form>
        </details>
      ) : null}
    </div>
  );
}
