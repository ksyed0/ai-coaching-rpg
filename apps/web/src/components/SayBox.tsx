"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ActionResult } from "../lib/api";

// The line the player says to the room. Disabled (with the reason in words) while paused, before the scene and after the end, and
// while a line is on its way, so a double submit sends one.

export function SayBox({ disabledReason, onSay }: { disabledReason: string | null; onSay: (text: string) => Promise<ActionResult> }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const disabled = disabledReason !== null || pending;

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
    }
  }

  return (
    <form className="say-form" onSubmit={submit}>
      <div className="say">
        <label htmlFor="say-line" className="sr-only">Say something</label>
        <input className="t" id="say-line" name="line" value={text} maxLength={2000} autoComplete="off" placeholder="Say something to the room"
          disabled={disabled} aria-describedby={disabledReason ? "say-why" : undefined} onChange={(e) => setText(e.target.value)} />
        <button className="btn pri" type="submit" disabled={disabled}>Say</button>
      </div>
      {disabledReason ? <p className="hint muted" id="say-why">{disabledReason}</p> : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </form>
  );
}
