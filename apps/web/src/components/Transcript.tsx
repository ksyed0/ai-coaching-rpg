import type { PlayerLine } from "@acr/events";
import { roleLabel } from "../lib/names";

// The scene's lines. Every line and name is untrusted text and rendered as text. A speaker that is not a player seat is an AI character.

export type TranscriptProps = { lines: PlayerLine[]; selfRole: string; names: Record<string, string>; playerRoles: ReadonlySet<string> };

export function Transcript({ lines, selfRole, names, playerRoles }: TranscriptProps) {
  if (lines.length === 0) return <p className="muted card tstream">Nothing has been said yet.</p>;
  return (
    <ol className="card tstream" aria-live="polite" aria-relevant="additions">
      {lines.map((l) => {
        const self = l.roleId === selfRole;
        const ai = !self && !playerRoles.has(l.roleId);
        const name = self ? "You" : Object.hasOwn(names, l.roleId) ? names[l.roleId]! : roleLabel(l.roleId);
        return (
          <li className="msg" key={l.seq}>
            <div className="h">
              <b>{name}</b>
              {ai ? <span className="pill ai">AI</span> : null}
              {ai || self || Object.hasOwn(names, l.roleId) ? <span className="muted">{roleLabel(l.roleId)}</span> : null}
            </div>
            <p className="line">{l.text}</p>
          </li>
        );
      })}
    </ol>
  );
}
