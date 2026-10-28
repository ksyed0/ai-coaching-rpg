"use client";

import { useRef, useState, type FormEvent } from "react";
import { postJson } from "../lib/api";
import { MESSAGES } from "../lib/messages";
import { roleLabel } from "../lib/names";

// Join by the per-role code and a display name. The code goes to the BFF once and is never kept; the BFF answers with an HttpOnly
// cookie this code never sees. Every refusal reads the same. One request at a time: the button is disabled while it is pending.

export type JoinFormProps = { sessionId: string; roleId: string; fetch?: typeof fetch; navigate?: (url: string) => void };

const goTo = (url: string) => window.location.assign(url);

function refusal(status: number, code: string): string {
  if (status === 401) return MESSAGES.joinRefused;
  if (code === "bad_name") return MESSAGES.badName;
  if (status === 503 || status === 0) return MESSAGES.unavailable;
  return MESSAGES.generic;
}

export function JoinForm({ sessionId, roleId, fetch: fetchImpl, navigate = goTo }: JoinFormProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    const displayName = name.trim();
    // Counted in code points like the server (no maxLength attribute: it counts UTF-16 units and would cut an emoji name short).
    if (displayName.length === 0 || [...displayName].length > 60) { setError(MESSAGES.badName); return; }
    if (code.trim().length === 0) { setError(MESSAGES.joinRefused); return; }
    busy.current = true;
    setPending(true);
    setError(null);
    const r = await postJson("/api/v1/join", { sessionId, role: roleId, joinCode: code.trim(), displayName }, fetchImpl);
    if (r.ok) { navigate(`/session/${encodeURIComponent(sessionId)}`); return; } // stays pending: the page is going away
    busy.current = false;
    setPending(false);
    setError(refusal(r.status, r.code));
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="field">
        <span className="f">Your role</span>
        <span className="value">{roleLabel(roleId)}</span>
      </div>
      <div className="field">
        <label className="f" htmlFor="join-name">Your name</label>
        <input className="t" id="join-name" name="displayName" value={name} autoComplete="name" required aria-describedby="join-name-help"
          onChange={(e) => setName(e.target.value)} />
        <p className="muted small" id="join-name-help">Shown to the others in the room and on your report. You type it; the facilitator does not enter names for you.</p>
      </div>
      <div className="field">
        <label className="f" htmlFor="join-code">Your join code</label>
        <input className="t mono" id="join-code" name="joinCode" value={code} maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false} required
          aria-describedby="join-code-help" onChange={(e) => setCode(e.target.value)} />
        <p className="muted small" id="join-code-help">From your facilitator. It is checked once; this browser then keeps a sign-in for this session only.</p>
      </div>
      {error ? <p className="err" role="alert">{error}</p> : null}
      <div>
        <button className="btn pri" type="submit" disabled={pending}>Join</button>
      </div>
    </form>
  );
}
