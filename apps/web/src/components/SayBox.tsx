"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ActionResult } from "../lib/api";

// The line the player says to the room. Disabled (with the reason in words) while paused, before the scene, after the end and while
// the stream is reconnecting. While a line is on its way the input stays enabled (so it keeps the keyboard focus) but read-only and
// busy, the button is disabled, and a ref guard makes a double submit send one.

export function SayBox({ disabledReason, onSay }: { disabledReason: string | null; onSay: (text: string) => Promise<ActionResult> }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const disabled = disabledReason !== null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const line = text.trim();
    if (busy.current || disabledReason !== null || line.length === 0) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const r = await onSay(line);
      if (r.ok) setText("");
      else setError(r.message);
    } finally {
      busy.current = false;
      setPending(false);
      // A click on Say put the focus on the button, which the pending state disabled (focus fell to the body): back to the input.
      if (typeof document !== "undefined" && document.activeElement === document.body) input.current?.focus();
    }
  }

  return (
    <form className="say-form" onSubmit={submit}>
      <div className="say">
        <label htmlFor="say-line" className="sr-only">Say something</label>
        <input ref={input} className="t" id="say-line" name="line" value={text} maxLength={2000} autoComplete="off" placeholder="Say something to the room"
          disabled={disabled} readOnly={pending} aria-busy={pending} aria-describedby={disabledReason ? "say-why" : undefined}
          onChange={(e) => setText(e.target.value)} />
        <button className="btn pri" type="submit" disabled={disabled || pending}>Say</button>
      </div>
      {disabledReason ? <p className="hint muted" id="say-why">{disabledReason}</p> : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </form>
  );
}
