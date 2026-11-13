"use client";

import { useState } from "react";
import { postJson } from "../../lib/api";
import { SessionList } from "./SessionList";

// The signed-in console. This slice is the shell: who is signed in, a way out and the session list.

export type ConsoleShellProps = {
  name: string;
  /** US-0083: an admin sees the owners of sessions; only an admin ACCOUNT (not `legacy`) gets the Admin page link. */
  role?: "admin" | "facilitator";
  legacy?: boolean;
  fetch?: typeof fetch;
  refresh?: () => void;
};

const reload = () => window.location.reload();

export function ConsoleShell({
  name,
  role = "facilitator",
  legacy = false,
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
        <div className="rowactions">
          {role === "admin" && !legacy ? <a href="/console/admin">Admin</a> : null}
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
        <SessionList fetch={fetchImpl} role={role} />
      </div>
    </div>
  );
}
