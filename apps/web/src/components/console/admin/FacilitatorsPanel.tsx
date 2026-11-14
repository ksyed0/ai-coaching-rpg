"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getJson, postJson, type ApiResult } from "../../../lib/api";
import { failureText, parseAccounts, parseIssued, type AdminAccount } from "../../../lib/console-api";
import { MESSAGES } from "../../../lib/messages";
import { ConfirmDialog } from "../ConfirmDialog";
import { CredentialsPanel } from "./CredentialsPanel";

// US-0083: the admin's list of facilitator accounts. Each row offers only the actions its status allows (Resend for invited, Reset
// password for active, Revoke for invited or active, Reinstate for revoked), each behind a confirmation. Create, resend, reset and
// reinstate answer with a one-time temporary password, which is handed to CredentialsPanel and kept nowhere else. The BFF writes its
// own error text for these routes; a missing or over-long one falls back to a fixed sentence.

export type FacilitatorsPanelProps = { fetch?: typeof fetch };

type Action = "resend" | "reset" | "revoke" | "reinstate";

const ACTIONS: Record<AdminAccount["status"], Action[]> = {
  invited: ["resend", "revoke"],
  active: ["reset", "revoke"],
  revoked: ["reinstate"],
};

const ACTION_COPY: Record<Action, { label: string; title: (n: string) => string; description: string; pending: string }> = {
  resend: {
    label: "Resend",
    title: (n) => `Resend the invitation to ${n}?`,
    description: "This replaces their temporary password with a new one. The old one stops working.",
    pending: "Resending…",
  },
  reset: {
    label: "Reset password",
    title: (n) => `Reset the password for ${n}?`,
    description: "This signs them out and gives them a new temporary password. They must choose a new password when they sign in.",
    pending: "Resetting…",
  },
  revoke: {
    label: "Revoke",
    title: (n) => `Revoke ${n}?`,
    description:
      "They are signed out and cannot sign in again until you reinstate them. Their running sessions keep running and stay reachable only by an admin.",
    pending: "Revoking…",
  },
  reinstate: {
    label: "Reinstate",
    title: (n) => `Reinstate ${n}?`,
    description: "They can sign in again with a new temporary password, which they must change at their first sign-in.",
    pending: "Reinstating…",
  },
};

const STATUS = {
  invited: { text: "Invited", tone: "warn" },
  active: { text: "Active", tone: "ok" },
  revoked: { text: "Revoked", tone: "mut" },
} as const;

/** The BFF's own sentence for a refusal it wrote (a conflict or a bad field); otherwise the console's fixed text. */
function adminFailure(r: Extract<ApiResult, { ok: false }>): string {
  if ((r.status === 409 || r.status === 400) && r.message !== "") return r.message;
  if (r.status === 404) return "That account was not found. The list has been refreshed.";
  return failureText(r);
}

type Shown = { seq: number; login: string; name: string; password: string };

export function FacilitatorsPanel({ fetch: fetchImpl }: FacilitatorsPanelProps) {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ account: AdminAccount; action: Action } | null>(null);
  const [pending, setPending] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<"admin" | "facilitator">("facilitator");
  const [formError, setFormError] = useState<string | null>(null);
  const seq = useRef(0); // a new issue never reuses a panel that still holds an older password
  const busy = useRef(false);

  const load = useCallback(async () => {
    const r = await getJson("/api/v1/console/admin/accounts", fetchImpl);
    if (r.ok) {
      setAccounts(parseAccounts(r.data));
      setLoadError(null);
    } else setLoadError(adminFailure(r));
  }, [fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  function show(data: unknown): boolean {
    const issued = parseIssued(data);
    if (!issued) return false;
    setShown({ seq: ++seq.current, login: issued.account.login, name: issued.account.name, password: issued.temporaryPassword });
    return true;
  }

  async function runAction(account: AdminAccount, action: Action) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError(null);
    const r = await postJson(`/api/v1/console/admin/accounts/${encodeURIComponent(account.id)}/${action}`, {}, fetchImpl);
    busy.current = false;
    setPending(false);
    setConfirming(null);
    if (!r.ok) {
      setActionError(adminFailure(r));
      if (r.status === 404 || r.status === 409) await load();
      return;
    }
    if (action === "revoke") setShown(null);
    else if (!show(r.data)) setActionError(MESSAGES.generic);
    await load();
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    if (name.trim() === "" || login.trim() === "") return setFormError("Enter a name and an email address.");
    busy.current = true;
    setPending(true);
    setFormError(null);
    const r = await postJson("/api/v1/console/admin/accounts", { login: login.trim(), name: name.trim(), role }, fetchImpl);
    busy.current = false;
    setPending(false);
    if (!r.ok) return setFormError(adminFailure(r));
    if (!show(r.data)) setFormError(MESSAGES.generic);
    setName("");
    setLogin("");
    setRole("facilitator");
    await load();
  }

  return (
    <div className="stack">
      {shown ? (
        <CredentialsPanel
          key={shown.seq}
          login={shown.login}
          name={shown.name}
          temporaryPassword={shown.password}
          onDismiss={() => setShown(null)}
        />
      ) : null}

      <form className="card stack" onSubmit={(e) => void create(e)} noValidate>
        <h2 className="s">New facilitator</h2>
        <div className="field">
          <label className="f" htmlFor="new-fac-name">
            Name
          </label>
          <input
            className="t"
            id="new-fac-name"
            name="name"
            value={name}
            maxLength={200}
            autoComplete="off"
            required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="f" htmlFor="new-fac-login">
            Email (their login)
          </label>
          <input
            className="t"
            id="new-fac-login"
            name="login"
            type="email"
            value={login}
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            required
            onChange={(e) => setLogin(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="f" htmlFor="new-fac-role">
            Role
          </label>
          <select
            className="t"
            id="new-fac-role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "facilitator")}
          >
            <option value="facilitator">Facilitator</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <p className="err" role="alert">
          {formError}
        </p>
        <div>
          <button className="btn pri" type="submit" disabled={pending}>
            Create facilitator
          </button>
        </div>
      </form>

      <div className="card stack">
        <h2 className="s">Facilitators</h2>
        {actionError ? (
          <p className="err" role="alert">
            {actionError}
          </p>
        ) : null}
        {loadError ? (
          <p className="err" role="alert">
            {loadError}
          </p>
        ) : null}
        {accounts === null ? (
          loadError ? (
            <div>
              <button className="btn" type="button" onClick={() => void load()}>
                Try again
              </button>
            </div>
          ) : (
            <p className="muted" role="status">
              Loading facilitators…
            </p>
          )
        ) : accounts.length === 0 ? (
          <p className="muted">No accounts yet</p>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <caption className="sr-only">Facilitator accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Login</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <th scope="row">
                      <bdi>{a.name}</bdi>
                    </th>
                    <td>
                      <span className="mono">{a.login}</span>
                    </td>
                    <td>{a.role === "admin" ? "Admin" : "Facilitator"}</td>
                    <td>
                      <span className={`pill ${STATUS[a.status].tone}`}>{STATUS[a.status].text}</span>
                    </td>
                    <td>
                      <span className="rowactions">
                        {ACTIONS[a.status].map((action) => (
                          <button
                            key={action}
                            className="btn"
                            type="button"
                            disabled={pending}
                            aria-label={`${ACTION_COPY[action].label} ${a.name}`}
                            onClick={() => setConfirming({ account: a, action })}
                          >
                            {ACTION_COPY[action].label}
                          </button>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirming ? (
        <ConfirmDialog
          title={ACTION_COPY[confirming.action].title(confirming.account.name)}
          description={ACTION_COPY[confirming.action].description}
          confirmLabel={pending ? ACTION_COPY[confirming.action].pending : ACTION_COPY[confirming.action].label}
          tone={confirming.action === "revoke" ? "danger" : "primary"}
          pending={pending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void runAction(confirming.account, confirming.action)}
        />
      ) : null}
    </div>
  );
}
