import { roleLabel } from "../lib/names";
import { StatusChip, type StatusKind } from "./StatusChip";

// The SceneCoach.ai wordmark with the session context (state and role), as in the mockups' app header.

export function Wordmark() {
  return (
    <span className="wm">
      <svg className="mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
        <rect x="2" y="4" width="20" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M2 9h20" stroke="currentColor" strokeWidth="2" />
        <path d="M9 14l5 2.5-5 2.5z" fill="currentColor" />
      </svg>
      <b>SceneCoach</b>
      <span className="ai">.ai</span>
    </span>
  );
}

export function AppHeader({ status, roleId }: { status?: StatusKind; roleId?: string }) {
  return (
    <header className="apphdr">
      <Wordmark />
      <div className="ctx">
        {status ? <StatusChip status={status} /> : null}
        {roleId ? <span className="pill mut">{roleLabel(roleId)}</span> : null}
      </div>
    </header>
  );
}
