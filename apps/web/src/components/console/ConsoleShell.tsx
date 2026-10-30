"use client";

import { useState } from "react";
import { postJson } from "../../lib/api";

// The signed-in console. This slice is the shell only: who is signed in, a way out and the empty list.

export type ConsoleShellProps = {
  name: string;
  fetch?: typeof fetch;
  refresh?: () => void;
};

const reload = () => window.location.reload();

export function ConsoleShell({
  name,
  fetch: fetchImpl,
  refresh = reload,
}: ConsoleShellProps) {
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    await postJson("/api/v1/console/logout", undefined, fetchImpl);
    refresh();
  }
  return (
    <div className="stack">
      <div className="card stack">
        <p>Signed in as {name}</p>
        <div>
          <button
            className="btn"
            type="button"
            disabled={pending}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </div>
      <div className="card soft">
        <h2 className="s">Sessions</h2>
        <p className="muted">No sessions yet</p>
      </div>
    </div>
  );
}
