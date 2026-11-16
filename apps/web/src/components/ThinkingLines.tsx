"use client";

import { useEffect, useState } from "react";
import { nextExpiryMs, thinkingRoles, type ActivityMap } from "../lib/activity";

// US-0082: "<name> is thinking..." for every AI that is composing a reply now. One polite live region, always mounted (so an addition is
// announced), never focusable. The line goes when the reply lands, the turn ends, the scene changes or, as a safety net for a lost "idle",
// ACTIVITY_EXPIRY_MS after it appeared. Names are untrusted text, rendered as text in <bdi>.

export type ThinkingLinesProps = {
  activity: ActivityMap;
  /** How a role is named and whether it gets the AI badge (the transcript's own rule). */
  label: (roleId: string) => { name: string; ai: boolean };
  /** Injected for tests; the page's clock otherwise. */
  now?: () => number;
};

export function ThinkingLines({ activity, label, now = Date.now }: ThinkingLinesProps) {
  const [, tick] = useState(0);
  const t = now();
  const roles = thinkingRoles(activity, t);
  const wait = nextExpiryMs(activity, t);
  useEffect(() => {
    if (wait === null) return undefined;
    const id = setTimeout(() => tick((n) => n + 1), wait + 1);
    return () => clearTimeout(id);
  }, [wait, activity]);
  return (
    // A plain polite live region (not role="status": the page's own status region keeps that role).
    <div className="thinking" aria-live="polite" data-testid="thinking">
      {roles.map((roleId) => {
        const l = label(roleId);
        return (
          <p className="muted small thinking-line" key={roleId}>
            <b><bdi>{l.name}</bdi></b>
            {l.ai ? <span className="pill ai">AI</span> : null}
            {" is thinking…"}
          </p>
        );
      })}
    </div>
  );
}
