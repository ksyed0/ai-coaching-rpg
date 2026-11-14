"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ActionResult } from "../lib/api";

// The line the player says to the room. Disabled (with the reason in words) while paused, before the scene, after the end and while
// the stream is reconnecting. While a line is on its way the input stays enabled (so it keeps the keyboard focus) but read-only and
// busy, the button is disabled, and a ref guard makes a double submit send one.
//
// US-0082: typing "@" (at the start or after a space) opens a list of the OTHER roles of the current scene (`candidates`). Choosing one
// (Enter, Tab or a click; arrows move, Escape closes) puts "@Role title " in the line and directs it at that role (`to`). The line stays
// public: everyone in the scene still sees it. Deleting the "@Role title" from the text drops the direction. One addressee per line.

export type AddressCandidateUi = { roleId: string; label: string; detail: string };

const TRIGGER = /(^|\s)@([^\s@]*)$/u;

export function SayBox({ disabledReason, onSay, candidates = [] }: { disabledReason: string | null; onSay: (text: string, to?: string) => Promise<ActionResult>; candidates?: AddressCandidateUi[] }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [to, setTo] = useState<AddressCandidateUi | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const disabled = disabledReason !== null;
  const q = (query ?? "").toLowerCase();
  const options = query === null ? [] : candidates.filter((c) => c.label.toLowerCase().startsWith(q) || c.roleId.toLowerCase().startsWith(q));
  const open = options.length > 0;
  const current = open ? Math.min(active, options.length - 1) : -1;

  function change(value: string) {
    setText(value);
    // The direction goes with its "@Role title": once the text no longer holds it, the line is for everyone again.
    if (to !== null && !value.includes(`@${to.label}`)) setTo(null);
    const m = candidates.length > 0 ? TRIGGER.exec(value) : null;
    setQuery(m ? m[2]! : null);
    setActive(0);
  }

  function choose(c: AddressCandidateUi) {
    const m = TRIGGER.exec(text);
    const head = m ? text.slice(0, m.index + m[1]!.length) : text;
    setText(`${head}@${c.label} `);
    setTo(c);
    setQuery(null);
    input.current?.focus();
  }

  function keyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((current + 1) % options.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((current - 1 + options.length) % options.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choose(options[current]!); }
    else if (e.key === "Escape") { e.preventDefault(); setQuery(null); }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const line = text.trim();
    if (busy.current || disabledReason !== null || line.length === 0) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const r = to !== null && line.includes(`@${to.label}`) ? await onSay(line, to.roleId) : await onSay(line);
      if (r.ok) { setText(""); setTo(null); setQuery(null); }
      else setError(r.message);
    } finally {
      busy.current = false;
      setPending(false);
      // A click on Say put the focus on the button, which the pending state disabled (focus fell to the body): back to the input.
      if (typeof document !== "undefined" && document.activeElement === document.body) input.current?.focus();
    }
  }

  const optionId = (i: number) => `${listId}-o${i}`;
  return (
    <form className="say-form" onSubmit={submit}>
      <div className="say">
        <label htmlFor="say-line" className="sr-only">Say something</label>
        <input ref={input} className="t" id="say-line" name="line" value={text} maxLength={2000} autoComplete="off" placeholder={candidates.length > 0 ? "Say something to the room (type @ to address someone)" : "Say something to the room"}
          disabled={disabled} readOnly={pending} aria-busy={pending} aria-describedby={disabledReason ? "say-why" : undefined}
          {...(candidates.length > 0 ? { role: "combobox", "aria-autocomplete": "list" as const, "aria-expanded": open, "aria-controls": listId, ...(open ? { "aria-activedescendant": optionId(current) } : {}) } : {})}
          onChange={(e) => change(e.target.value)} onKeyDown={keyDown} />
        <button className="btn pri" type="submit" disabled={disabled || pending}>Say</button>
      </div>
      {candidates.length > 0 ? (
        <ul className="addr-list" id={listId} role="listbox" aria-label="Address someone in the scene" hidden={!open}>
          {options.map((c, i) => (
            <li key={c.roleId} id={optionId(i)} role="option" aria-selected={i === current} className={i === current ? "addr-opt on" : "addr-opt"}
              onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
              <bdi>{c.label}</bdi> <span className="muted small"><bdi>{c.detail}</bdi></span>
            </li>
          ))}
        </ul>
      ) : null}
      {to !== null ? <p className="hint muted" id="say-to">To <bdi>{to.label}</bdi>: everyone in the scene still sees the line.</p> : null}
      {disabledReason ? <p className="hint muted" id="say-why">{disabledReason}</p> : null}
      {error ? <p className="err" role="alert">{error}</p> : null}
    </form>
  );
}
