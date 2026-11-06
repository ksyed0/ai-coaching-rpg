"use client";

import { useId } from "react";
import type { ReportRunSummaryView } from "../../../lib/console-api";
import { roleLabel } from "../../../lib/names";

// How the run went, before anything is released (AC-0339): scenes the Game Master ended, fallback lines against real replies, and the
// facilitator alerts with their reasons. Counts and sanitised reasons only, shown as text.

export function RunSummaryView({ summary }: { summary: ReportRunSummaryView }) {
  const id = useId();
  return (
    <section className="card soft stack" aria-labelledby={id}>
      <h3 className="s" id={id}>
        How the run went
      </h3>
      <ul className="console-list">
        <li>{`Scenes ended by the Game Master: ${summary.scenesEndedByGm}`}</li>
        <li>{`Fallback replies: ${summary.fallbackReplies} of ${summary.npcReplies} character replies`}</li>
        {summary.byCharacter.map((c) => (
          <li className="small" key={c.roleId}>
            {`${c.name}: ${c.fallbackReplies} fallback of ${c.replies} replies`}
          </li>
        ))}
      </ul>
      {summary.alerts.length === 0 ? (
        <p className="small muted">No facilitator alerts.</p>
      ) : (
        <ul className="console-list">
          {summary.alerts.map((a, i) => (
            <li className="small" key={i}>
              {`${a.level === "warning" ? "Warning" : "Info"}${a.role === null ? "" : `, ${roleLabel(a.role)}`}: ${a.reason}${a.fallback ? " (a fallback line was used)" : ""}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
