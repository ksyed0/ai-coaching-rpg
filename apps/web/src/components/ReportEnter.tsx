"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "../lib/api";
import { clearDraft } from "../lib/report-draft";
import { MESSAGES } from "../lib/messages";

// Opens a report link. The token is in the URL fragment (never sent to a server by the browser): this reads it once, removes it from the
// address bar before anything is awaited, posts it to the BFF, and goes to /report. The BFF answers with an HttpOnly cookie this code never
// sees. The token lives in one module variable only: not in storage, not in a URL, not in any message. React StrictMode runs the effect
// twice and the second run sees an empty fragment, so the first run's token and request are kept and reused. Once the exchange has
// succeeded both are dropped before the page navigates. A new fragment on the same document (the same page opened again from a link)
// is a new attempt. The page leaves with location.replace, so /report/enter (which a Back button would reload without its fragment) is
// not left in the history; a visit with no fragment at all (Back, a restored page, a bare URL) just goes on to /report, where an
// existing cookie decides what is shown.

export type ReportEnterProps = { fetch?: typeof fetch; navigate?: (url: string) => void };
type Phase = "idle" | "opening" | "refused" | "throttled" | "retry";

/** Replaces the current history entry, so the link page is not a Back target. `loc` is a test seam. */
export const replaceWith = (url: string, loc: Pick<Location, "replace"> = window.location) => loc.replace(url);

let token: string | undefined; // undefined: the fragment has not been read yet
let inFlight: Promise<Phase | "done"> | null = null;

function outcome(r: Awaited<ReturnType<typeof postJson>>): Phase | "done" {
  if (r.ok) return "done";
  if (r.status === 404 || r.status === 400) return "refused";
  if (r.status === 429) return "throttled";
  return "retry";
}

export function ReportEnter({ fetch: fetchImpl, navigate = replaceWith }: ReportEnterProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const heading = useRef<HTMLHeadingElement>(null);

  function attempt(): Promise<Phase | "done"> {
    if (token === undefined || token === "") return Promise.resolve("refused");
    return postJson("/api/v1/report/enter", { token }, fetchImpl).then(outcome);
  }

  // `alive` is per effect run: StrictMode's discarded first run must not navigate a second time.
  function settle(p: Promise<Phase | "done">, alive: () => boolean) {
    void p.then((o) => {
      if (!alive()) return;
      if (o === "done") {
        // The token has done its job: drop it (and the finished request) before leaving, so nothing here holds it any longer.
        // A link was really entered (not a bare visit): the new link must never show another link's draft.
        if (token !== undefined && token !== "") clearDraft();
        token = undefined;
        inFlight = null;
        navigate("/report"); // stays "opening": the page is going away
        return;
      }
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
    // No fragment at the first read: nothing to exchange. Go on to /report (a valid cookie shows the report, none shows the refusal).
    if (inFlight === null) inFlight = token === "" ? Promise.resolve("done") : attempt();
    setPhase((p) => (p === "idle" ? "opening" : p));
    settle(inFlight, mine(id));
    // A new non-empty fragment on this document (another link opened in the same tab) is a new attempt with its own token.
    const onHashChange = () => {
      const next = window.location.hash.replace(/^#/, "");
      if (next === "") return;
      token = next;
      window.history.replaceState(null, "", window.location.pathname);
      const again = Symbol("hash");
      current.current = again;
      setPhase("opening");
      inFlight = attempt();
      settle(inFlight, mine(again));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      current.current = null;
    };
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

  // "idle": the server-rendered HTML and the first paint say nothing, so with script off only the no-script sentence is there.
  const text = phase === "idle" ? "" : phase === "opening" ? MESSAGES.reportOpening : phase === "refused" ? MESSAGES.reportRefused
    : phase === "throttled" ? MESSAGES.reportEnterThrottled : MESSAGES.reportEnterRetry;
  return (
    <>
      <div className="tb">
        <h1 ref={heading} tabIndex={-1}>Open your report</h1>
      </div>
      <div className="body narrow">
        <p className={phase === "opening" || phase === "idle" ? "muted" : "banner warn"} role="status">{text}</p>
        {phase === "throttled" || phase === "retry" ? (
          <p><button className="btn pri" type="button" onClick={again}>Try again</button></p>
        ) : null}
        <noscript><p className="banner warn">{MESSAGES.reportNoScript}</p></noscript>
      </div>
    </>
  );
}
