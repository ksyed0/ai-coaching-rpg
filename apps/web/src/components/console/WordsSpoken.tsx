"use client";

import { useId } from "react";
import type { TalkRow } from "../../lib/console-view";
import { roleLabel } from "../../lib/names";

// Words and lines per role, as counts. Players first; AI characters in a second table, as context. No row of this section carries a
// clock: it is a count, not a measure of quality. Names are untrusted text inside <bdi>.

export type WordsSpokenProps = { rows: TalkRow[]; names: Record<string, string>; /** US-0060: roles an AI player holds (from the state's aiRoles). */ aiPlayers?: ReadonlySet<string> };

function Table({ label, rows, names, aiPlayers }: { label: string; rows: TalkRow[]; names: Record<string, string>; aiPlayers: ReadonlySet<string> }) {
  const id = useId();
  return (
    <div>
      <h3 className="s" id={id}>{label}</h3>
      <div className="tablewrap">
        <table className="grid" aria-labelledby={id}>
          <thead><tr><th scope="col">Role</th><th scope="col">Words</th><th scope="col">Lines</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.roleId}>
                <th scope="row">
                  {aiPlayers.has(r.roleId) ? (
                    <>
                      <b>AI player</b> <span className="pill ai">AI</span> <span className="muted"><bdi>{roleLabel(r.roleId)}</bdi></span>
                    </>
                  ) : (
                    <>
                      <bdi>{Object.hasOwn(names, r.roleId) ? names[r.roleId] : roleLabel(r.roleId)}</bdi>
                      {Object.hasOwn(names, r.roleId) ? <span className="muted"> <bdi>{roleLabel(r.roleId)}</bdi></span> : null}
                    </>
                  )}
                </th>
                <td>{r.words}</td>
                <td>{r.lines}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function WordsSpoken({ rows, names, aiPlayers = new Set() }: WordsSpokenProps) {
  const id = useId();
  const players = rows.filter((r) => r.kind === "player");
  const ai = rows.filter((r) => r.kind !== "player");
  return (
    <section aria-labelledby={id} className="card">
      <h2 className="s" id={id}>Words spoken</h2>
      <p className="muted small">Words and lines typed per role. A count, not a measure of quality.</p>
      {players.length > 0 ? <Table label="Players" rows={players} names={names} aiPlayers={aiPlayers} /> : null}
      {ai.length > 0 ? <Table label="AI characters (context)" rows={ai} names={names} aiPlayers={aiPlayers} /> : null}
    </section>
  );
}
