import type { PlayerView } from "@acr/events";
import { roleLabel } from "../lib/names";

// The player's own brief, private facts and the updates sent to them during the session: all untrusted text, rendered as text.

export type BriefPanelProps = { roleId: string; brief?: string; privateFacts?: string[]; injects: PlayerView["injects"] };

export function BriefPanel({ roleId, brief, privateFacts, injects }: BriefPanelProps) {
  return (
    <section aria-labelledby="brief-h">
      <h2 className="s" id="brief-h">Your brief</h2>
      <div className="card soft">
        <b>{roleLabel(roleId)}</b>
        <p className="prose">{brief ?? "No brief for this role."}</p>
        {privateFacts && privateFacts.length > 0 ? (
          <>
            <h3 className="s">Only you know</h3>
            <ul className="plain">{privateFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </>
        ) : null}
        {injects.length > 0 ? (
          <>
            <h3 className="s">Updates</h3>
            <ul className="plain">
              {injects.map((x) => (
                <li className="gm" key={x.seq}>
                  {/* BUG-0023: a facilitator whisper to this player. The label is text (colour is not the signal); the colon is for screen readers. */}
                  {x.private ? <><span className="pill mut">Private</span><span className="sr-only">: </span></> : null}
                  {x.content}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
  );
}
