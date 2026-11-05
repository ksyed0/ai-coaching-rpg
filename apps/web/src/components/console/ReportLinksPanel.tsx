"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  failureText,
  fetchReportLinks,
  issueReportLink,
  parseIssuedToken,
  parseReportLinks,
  reportLinkAction,
  REPORT_NOT_READY,
  REPORT_UNAVAILABLE,
  CONSOLE_COPY,
  type ReportLink,
  type ReportLinksView,
} from "../../lib/console-api";
import { roleLabel } from "../../lib/names";
import { ConfirmDialog, focusFallback } from "./ConfirmDialog";

// Participant report links, for an ended session. The facilitator issues, reissues and revokes one link per participant. A new link is
// shown once, in this component's state only: never browser storage, the URL, the console or a cookie. Dismissing it (or leaving the
// page) drops it. The list never carries a credential id or a token; only dates and flags.

export type ReportLinksPanelProps = { sessionId: string; fetch?: typeof fetch };

type Shown = { role: string; link: string };
type Confirm = { kind: "reissue" | "revoke"; role: string; opener: HTMLElement };

const when = (ms: number) => new Date(ms).toLocaleString();
const day = (ms: number) => new Date(ms).toLocaleDateString();

function statusOf(link: ReportLink | null): string {
  if (link === null) return "No link";
  if (link.revoked) return "Revoked";
  if (link.active) return `Link active until ${day(link.expiresAt)}`;
  return `Link expired on ${day(link.expiresAt)}`;
}

export function ReportLinksPanel({ sessionId, fetch: fetchImpl }: ReportLinksPanelProps) {
  const headingId = useId();
  const [data, setData] = useState<ReportLinksView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [shown, setShown] = useState<Shown | null>(null);
  const [copyNote, setCopyNote] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const r = await fetchReportLinks(sessionId, fetchImpl);
    if (!alive.current) return;
    if (!r.ok) {
      setLoadError(failureText(r));
      return;
    }
    const parsed = parseReportLinks(r.data);
    if (parsed === null) {
      setLoadError(CONSOLE_COPY.unreachable);
      return;
    }
    setLoadError(null);
    setData(parsed);
  }, [sessionId, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  function reveal(role: string, tokenData: unknown): boolean {
    const token = parseIssuedToken(tokenData);
    if (token === null) return false;
    setShown({ role, link: `${window.location.origin}/report/enter#${token}` });
    setCopyNote("");
    return true;
  }

  async function issue(role: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    const r = await issueReportLink(sessionId, role, fetchImpl);
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setMessage(r.status === 409 && r.message !== "" ? r.message : failureText(r));
      return;
    }
    if (!reveal(role, r.data)) setMessage(CONSOLE_COPY.unreachable);
    await load();
  }

  async function act(c: Confirm) {
    setBusy(true);
    setMessage("");
    const r = await reportLinkAction(sessionId, c.role, c.kind, fetchImpl);
    if (!alive.current) return;
    setBusy(false);
    setConfirm(null);
    if (!r.ok) {
      setMessage(r.status === 409 && r.message !== "" ? r.message : failureText(r));
      return;
    }
    if (c.kind === "reissue") {
      if (!reveal(c.role, r.data)) setMessage(CONSOLE_COPY.unreachable);
    } else {
      setShown((s) => (s?.role === c.role ? null : s));
      setMessage(`The link for ${roleLabel(c.role)} was revoked.`);
    }
    await load();
  }

  async function copy() {
    if (shown === null) return;
    try {
      const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        await clip.writeText(shown.link);
        setCopyNote("Copied.");
        return;
      }
    } catch {
      /* blocked: fall through to selecting the text */
    }
    input.current?.focus();
    input.current?.select();
    setCopyNote("Could not copy. The link is selected. Press Ctrl/Cmd+C to copy it.");
  }

  function dismiss() {
    setShown(null);
    setCopyNote("");
  }

  const ready = data?.state === "ready";
  return (
    <section className="card stack" aria-labelledby={headingId}>
      <h2 className="s" id={headingId}>
        Participant reports
      </h2>
      <p className="small muted" role="status" tabIndex={-1} data-focus-fallback="report-links">
        {message}
      </p>

      {shown ? (
        <div className="stack">
          <p className="banner warn">This link is shown only once. Anyone who has it can read this participant&apos;s report.</p>
          <div className="field">
            <label htmlFor={`${headingId}-link`}>Report link for {roleLabel(shown.role)}</label>
            <input id={`${headingId}-link`} className="t mono" type="text" readOnly value={shown.link} ref={input} onFocus={(e) => e.currentTarget.select()} />
          </div>
          <div className="rowactions">
            <button className="btn" type="button" onClick={() => void copy()}>
              Copy link
            </button>
            <button className="btn pri" type="button" onClick={dismiss}>
              I have copied the link
            </button>
            <span className="small muted" role="status">
              {copyNote}
            </span>
          </div>
        </div>
      ) : null}

      {loadError !== null ? (
        <div className="stack">
          <p className="banner warn">{loadError}</p>
          <div>
            <button className="btn" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {data?.state === "unavailable" ? (
        <div className="stack">
          <p className="banner warn">{REPORT_UNAVAILABLE}</p>
          <div>
            <button className="btn" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {data?.state === "not_ready" ? <p className="banner warn">{REPORT_NOT_READY}</p> : null}

      {data !== null && data.state !== "unavailable" && data.roles.length > 0 ? (
        <ul className="codes">
          {data.roles.map(({ role, link }) => {
            const label = roleLabel(role);
            const live = link !== null && link.active;
            return (
              <li className="code-row" key={role}>
                <h3 className="code-role">{label}</h3>
                <span>{statusOf(link)}</span>
                {link !== null && !link.revoked ? (
                  <span className="small muted">{link.lastUsedAt === undefined ? "Not opened yet" : `Last opened ${when(link.lastUsedAt)}`}</span>
                ) : null}
                {!live && ready ? (
                  <button className="btn" type="button" disabled={busy} aria-label={`Issue link for ${label}`} onClick={() => void issue(role)}>
                    Issue link
                  </button>
                ) : null}
                {live && ready ? (
                  <button className="btn" type="button" disabled={busy} aria-label={`Reissue link for ${label}`} onClick={(e) => setConfirm({ kind: "reissue", role, opener: e.currentTarget })}>
                    Reissue
                  </button>
                ) : null}
                {live ? (
                  <button className="btn" type="button" disabled={busy} aria-label={`Revoke link for ${label}`} onClick={(e) => setConfirm({ kind: "revoke", role, opener: e.currentTarget })}>
                    Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.kind === "reissue" ? `Reissue the link for ${roleLabel(confirm.role)}?` : `Revoke the link for ${roleLabel(confirm.role)}?`}
          description={
            confirm.kind === "reissue"
              ? "The old link stops working at once, and a new link is created. Send the new link to the participant."
              : "The participant loses access to their report at once. You can issue a new link later."
          }
          confirmLabel={confirm.kind === "reissue" ? "Reissue link" : "Revoke link"}
          tone={confirm.kind === "reissue" ? "primary" : "danger"}
          pending={busy}
          opener={confirm.opener}
          fallbackFocus={focusFallback("report-links")}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act(confirm)}
        />
      ) : null}
    </section>
  );
}
