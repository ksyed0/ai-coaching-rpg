"use client";

import { useRef, useState } from "react";
import type { ActionResult } from "../lib/api";

// The versioned notice and the agreement to it (consent is required before play). The notice is server text, rendered as text.

export type ConsentPanelProps = {
  noticeVersion: string; notice: string; given: boolean;
  onConsent: () => Promise<ActionResult>; onWithdraw: () => Promise<ActionResult>;
};

export function ConsentPanel({ noticeVersion, notice, given, onConsent, onWithdraw }: ConsentPanelProps) {
  const [agreed, setAgreed] = useState(false);
  // True only when this person agreed to the text shown here, in this panel. A seat whose consent was adopted earlier (a rebind) never
  // saw this text, so it is not told it agreed to this notice version.
  const [agreedHere, setAgreedHere] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // Consent that is taken away (given turns false) ends "agreed here": a later adoption from outside is not this person's agreement.
  const [wasGiven, setWasGiven] = useState(given);
  if (wasGiven !== given) {
    setWasGiven(given);
    if (!given) setAgreedHere(false);
  }

  /** `flag`: what a success means for "agreed here" (true for the consent action, false for the withdrawal). */
  async function run(action: () => Promise<ActionResult>, flag?: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const r = await action();
      if (!r.ok) setError(r.message);
      else if (flag !== undefined) setAgreedHere(flag);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section className="card" aria-labelledby="consent-h">
      <h2 className="s" id="consent-h">Consent, notice {noticeVersion}</h2>
      <p className="prose">{notice}</p>
      {given ? (
        <>
          <p className="ok-text">
            {agreedHere ? `You agreed to notice ${noticeVersion}.` : "This seat agreed to a consent notice earlier. The text above is the current notice."} You can withdraw before the start; your seat is then freed.
          </p>
          <button className="btn" type="button" disabled={pending} onClick={() => run(onWithdraw, false)}>Leave and withdraw consent</button>
        </>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I have read this notice and agree to take part.</span>
          </label>
          <button className="btn pri" type="button" disabled={!agreed || pending} onClick={() => run(onConsent, true)}>I agree</button>
        </>
      )}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </section>
  );
}
