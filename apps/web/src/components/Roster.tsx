import type { PeerRosterEntry } from "../lib/use-session";
import { roleLabel } from "../lib/names";

// Who is in the room: each player seat's display name (typed by that person; shown as text) or its role, and its state in words.

export function Roster({ entries, selfRole }: { entries: PeerRosterEntry[]; selfRole: string }) {
  if (entries.length === 0) return <p className="muted">No one is listed yet.</p>;
  return (
    <ul className="card roster">
      {entries.map((e) => {
        const state = e.ready ? { label: "Ready", tone: "ok" } : e.name !== undefined ? { label: "Joined", tone: "warn" } : { label: "Not joined", tone: "mut" };
        return (
          <li className="seat" key={e.roleId}>
            <span className="who">
              <b>{e.name ?? roleLabel(e.roleId)}</b>
              {e.name !== undefined ? <span className="muted"> {roleLabel(e.roleId)}</span> : null}
              {e.roleId === selfRole ? <span className="muted"> (you)</span> : null}
            </span>
            <span className={`pill ${state.tone}`}>{state.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
