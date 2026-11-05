"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "../lib/api";
import { MESSAGES } from "../lib/messages";

// Opens a report link. The token is in the URL fragment (never sent to a server by the browser): this reads it once, removes it from the
// address bar before anything is awaited, posts it to the BFF, and goes to /report. The BFF answers with an HttpOnly cookie this code never
// sees. The token lives in one module variable only: not in storage, not in a URL, not in any message. React StrictMode runs the effect
// twice and the second run sees an empty fragment, so the first run's token and request are kept and reused.

export type ReportEnterProps = { fetch?: typeof fetch; navigate?: (url: string) => void };
type Phase = "opening" | "refused" | "throttled" | "retry";

const goTo = (url: string) => window.location.assign(url);

let token: string | undefined; // undefined: the fragment has not been read yet
let inFlight: Promise<Phase | "done"> | null = null;

function outcome(r: Awaited<ReturnType<typeof postJson>>): Phase | "done" {
  if (r.ok) return "done";
  if (r.status === 404 || r.status === 400) return "refused";
  if (r.status === 429) return "throttled";
  return "retry";
}

export function ReportEnter({ fetch: fetchImpl, navigate = goTo }: ReportEnterProps) {
  const [phase, setPhase] = useState<Phase>("opening");
  const heading = useRef<HTMLHeadingElement>(null);

  function attempt(): Promise<Phase | "done"> {
    if (token === undefined || token === "") return Promise.resolve("refused");
    return postJson("/api/v1/report/enter", { token }, fetchImpl).then(outcome);
  }

  // `alive` is per effect run: StrictMode's discarded first run must not navigate a second time.
  function settle(p: Promise<Phase | "done">, alive: () => boolean) {
    void p.then((o) => {
      if (!alive()) return;
      if (o === "done") { navigate("/report"); return; } // stays "opening": the page is going away
      if (o === "refused") token = ""; // a dead link is not worth keeping
      setPhase(o);
    });
  }

  const current = useRef<symbol | null>(null);
  const mine = (id: symbol) => () => current.current === id;

  useEffect(() => {
    const id = Symbol("run");
    current.current = id;
    if (token === undefined) token = window.location.hash.replace(/^#/, "");
    // Before anything is awaited: the fragment must not stay in the address bar or the history entry.
    window.history.replaceState(null, "", window.location.pathname);
    if (inFlight === null) inFlight = attempt();
    settle(inFlight, mine(id));
    return () => { current.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { heading.current?.focus(); }, [phase]);

  function again() {
    setPhase("opening");
    inFlight = attempt();
    const id = Symbol("again");
    current.current = id;
    settle(inFlight, mine(id));
  }

  const text = phase === "opening" ? MESSAGES.reportOpening : phase === "refused" ? MESSAGES.reportRefused
    : phase === "throttled" ? MESSAGES.reportEnterThrottled : MESSAGES.reportEnterRetry;
  return (
    <>
      <div className="tb">
        <h1 ref={heading} tabIndex={-1}>Open your report</h1>
      </div>
      <div className="body narrow">
        <p className={phase === "opening" ? "muted" : "banner warn"} role="status">{text}</p>
        {phase === "throttled" || phase === "retry" ? (
          <p><button className="btn pri" type="button" onClick={again}>Try again</button></p>
        ) : null}
        <noscript><p className="banner warn">{MESSAGES.reportNoScript}</p></noscript>
      </div>
    </>
  );
}
