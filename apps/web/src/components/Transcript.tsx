"use client";

import { useLayoutEffect, useRef } from "react";
import type { PlayerLine } from "@acr/events";
import { roleLabel } from "../lib/names";

// The scene's lines. Every line and name is untrusted text and rendered as text. A speaker that is not a player seat is an AI character.
// The list scrolls by itself to a new line unless the reader has scrolled up to read; it is focusable so a keyboard can scroll it.

export type TranscriptProps = { lines: PlayerLine[]; selfRole: string; names: Record<string, string>; playerRoles: ReadonlySet<string> };

/** How close to the bottom (px) still counts as "at the bottom". */
const FOLLOW_SLACK_PX = 40;

export function Transcript({ lines, selfRole, names, playerRoles }: TranscriptProps) {
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);
  const last = lines.at(-1)?.seq;
  useLayoutEffect(() => {
    const el = list.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [last]);
  const onScroll = () => {
    const el = list.current!;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };

  if (lines.length === 0) return <p className="muted card tstream">Nothing has been said yet.</p>;
  return (
    <ol ref={list} className="card tstream" tabIndex={0} aria-label="Transcript" aria-live="polite" aria-relevant="additions" onScroll={onScroll}>
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
