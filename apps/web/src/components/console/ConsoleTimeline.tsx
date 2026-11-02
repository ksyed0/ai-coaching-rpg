"use client";

import { useLayoutEffect, useRef } from "react";
import type { TimelineEntry } from "../../lib/console-view";
import { MESSAGES } from "../../lib/messages";
import { roleLabel } from "../../lib/names";

// The facilitator's transcript with the Game Master's notices and the alerts, in order. Every word of it is untrusted and is rendered as
// text; a name sits in <bdi> so a right-to-left override cannot reorder what follows. Like the player transcript it follows the newest
// entry unless the reader has scrolled up. Only additions are announced (aria-relevant), and entries keep their key so none is re-rendered.

export type ConsoleTimelineProps = { entries: TimelineEntry[]; names: Record<string, string>; playerRoles: ReadonlySet<string> };

const FOLLOW_SLACK_PX = 40;

function Entry({ e, names, playerRoles }: { e: TimelineEntry; names: Record<string, string>; playerRoles: ReadonlySet<string> }) {
  if (e.kind === "line") {
    const roleId = e.roleId ?? "";
    const named = Object.hasOwn(names, roleId);
    const ai = !playerRoles.has(roleId);
    return (
      <li className="msg">
        <div className="h">
          <b><bdi>{named ? names[roleId] : roleLabel(roleId)}</bdi></b>
          {ai ? <span className="pill ai">AI</span> : null}
          {ai || named ? <span className="muted"><bdi>{roleLabel(roleId)}</bdi></span> : null}
        </div>
        <p className="line">{e.text}</p>
      </li>
    );
  }
  if (e.kind === "alert") {
    const warning = e.level === "warning";
    return (
      <li className={warning ? "msg alert warn" : "msg alert"}>
        <span className={warning ? "pill warn" : "pill mut"}>{warning ? "Warning:" : "Alert:"}</span>{" "}
        <span className="line">{e.text}</span>
      </li>
    );
  }
  // The "earlier notices are not shown" entry (seq 0) is the viewer's own, not an event: no prefix.
  if (e.seq === 0) return <li className="msg note muted"><span className="line">{e.text}</span></li>;
  const gm = e.text.startsWith("Game Master");
  return (
    <li className={gm ? "gm" : "msg note"}>
      {gm ? null : <b>Facilitator </b>}
      <span className="line">{e.text}</span>
    </li>
  );
}

export function ConsoleTimeline({ entries, names, playerRoles }: ConsoleTimelineProps) {
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const last = entries.at(-1)?.seq;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [last, entries.length]);
  const onScroll = () => {
    const el = list.current!;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };
  return (
    <>
      <ol ref={list} className="card tstream" tabIndex={0} aria-label="Transcript and notices" aria-live="polite" aria-relevant="additions" onScroll={onScroll}>
        {entries.map((e) => <Entry key={e.seq} e={e} names={names} playerRoles={playerRoles} />)}
      </ol>
      {entries.length === 0 ? <p className="muted">{MESSAGES.consoleNothingYet}</p> : null}
    </>
  );
}
