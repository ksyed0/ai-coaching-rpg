"use client";

import { useEffect, useRef, useState } from "react";
import { putJson } from "../lib/api";
import { MESSAGES } from "../lib/messages";
import { clearDraft, loadDraft, saveDraft, type Draft, type DraftLevel } from "../lib/report-draft";

// The blind self-rating form of a draft report. It receives only the criteria (id, name), the generic scale and the participant's own
// earlier ratings: no evaluator data ever reaches it. Every participant string is rendered as a React text node or a controlled value.

export type RatingForm = {
  criteria: { id: string; name: string }[];
  scale: { level: number; label: string; meaning: string }[];
  existing: Record<string, { level: number | "na" | null; note?: string }>;
};
export type SelfRatingFormProps = {
  form: RatingForm;
  fetch?: typeof fetch;
  /** The re-read view the BFF returned after a save. */
  onSaved(view: unknown): void;
  /** The link was refused (404): the page shows its refused state. */
  onRefused?(): void;
};

const MAX_NOTE = 1500;
type Ratings = Draft["ratings"];
type Notice = { kind: "saved" | "error"; text: string } | null;

const isLevel = (v: unknown): v is 1 | 2 | 3 | 4 => v === 1 || v === 2 || v === 3 || v === 4;
const clip = (s: string) => { const cp = Array.from(s); return cp.length > MAX_NOTE ? cp.slice(0, MAX_NOTE).join("") : s; };
const count = (s: string) => Array.from(s).length;

/** The draft if there is one (for the criteria shown), else the participant's own ratings from the server. */
function initial(form: RatingForm): Ratings {
  const draft = loadDraft();
  const out: Ratings = {};
  for (const c of form.criteria) {
    const d = draft?.ratings[c.id];
    const e = form.existing[c.id];
    if (d) out[c.id] = { level: d.level, note: clip(d.note) };
    else if (draft === null && e) out[c.id] = { level: e.level === "na" ? "na" : isLevel(e.level) ? e.level : null, note: clip(e.note ?? "") };
    else out[c.id] = { level: null, note: "" };
  }
  return out;
}

function failureText(r: { status: number; data?: unknown; retryAfter?: number }): string {
  if (r.status === 413) return MESSAGES.ratingsTooLarge;
  if (r.status === 429) return r.retryAfter !== undefined ? MESSAGES.ratingsThrottledWait(r.retryAfter) : MESSAGES.ratingsThrottled;
  if (r.status === 400) return MESSAGES.ratingsInvalid;
  const state = typeof r.data === "object" && r.data !== null ? (r.data as { state?: unknown }).state : undefined;
  if (r.status === 503) return state === "busy" ? MESSAGES.ratingsBusy : MESSAGES.ratingsUnavailable;
  if (r.status === 409) return state === "closed" ? MESSAGES.reportClosed : state === "old_schema" ? MESSAGES.reportOldSchema : MESSAGES.ratingsNotOpen;
  return MESSAGES.ratingsUnavailable;
}

export function SelfRatingForm({ form, fetch: fetchImpl, onSaved, onRefused }: SelfRatingFormProps) {
  const [ratings, setRatings] = useState<Ratings>(() => initial(form));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const summary = useRef<HTMLDivElement>(null);
  const closed = useRef(false); // after `closed` the typed values stay in memory only: no draft is written again
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); // StrictMode re-runs effects
  useEffect(() => { if (notice?.kind === "error") summary.current?.focus(); }, [notice]);

  const touch = (id: string, patch: Partial<{ level: DraftLevel; note: string }>) => {
    const next: Ratings = { ...ratings, [id]: { ...(ratings[id] ?? { level: null, note: "" }), ...patch } };
    setRatings(next);
    setNotice((n) => (n?.kind === "saved" ? null : n));
    if (!closed.current) saveDraft({ ratings: next }); // written only after the participant touches a field
  };

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (saving) return;
    const payload = form.criteria.flatMap((c) => {
      const r = ratings[c.id];
      if (!r || r.level === null) return []; // untouched: omitted
      return [{ criterion: c.id, level: r.level === "na" ? null : r.level, ...(r.note !== "" ? { note: r.note } : {}) }];
    });
    setSaving(true);
    setNotice(null);
    const res = await putJson("/api/v1/report/self-ratings", { ratings: payload }, fetchImpl);
    if (!alive.current) return;
    setSaving(false);
    if (res.ok) {
      clearDraft();
      setNotice({ kind: "saved", text: MESSAGES.ratingsSaved });
      onSaved(res.data);
      return;
    }
    const state = typeof res.data === "object" && res.data !== null ? (res.data as { state?: unknown }).state : undefined;
    if (res.status === 404) {
      clearDraft();
      onRefused?.();
      return;
    }
    if (res.status === 409 && state === "closed") {
      closed.current = true;
      clearDraft();
    }
    setNotice({ kind: "error", text: failureText(res) });
  }

  return (
    <form className="stack no-print" onSubmit={submit} aria-busy={saving} noValidate>
      <p>{MESSAGES.ratingsIntro}</p>
      {form.criteria.map((c) => {
        const r = ratings[c.id] ?? { level: null, note: "" };
        const noteId = `note-${c.id}`;
        const countId = `count-${c.id}`;
        return (
          <fieldset className="card stack" key={c.id}>
            <legend>{c.name}</legend>
            {form.scale.map((s) => (
              <label key={s.level} className="choice">
                <input type="radio" name={`level-${c.id}`} checked={r.level === s.level} onChange={() => touch(c.id, { level: s.level as DraftLevel })} />{" "}
                <span>{s.label}</span> <span className="muted">{s.meaning}</span>
              </label>
            ))}
            <label className="choice">
              <input type="radio" name={`level-${c.id}`} checked={r.level === "na"} onChange={() => touch(c.id, { level: "na" })} />{" "}
              <span>{MESSAGES.ratingsNotObserved}</span>
            </label>
            <div className="field">
              <label htmlFor={noteId}>{MESSAGES.ratingsNoteLabel}</label>
              <textarea id={noteId} rows={3} value={r.note} aria-describedby={countId} onChange={(e) => touch(c.id, { note: clip(e.target.value) })} />
              <span id={countId} className="muted">{`${count(r.note).toLocaleString("en-US")} / ${MESSAGES_MAX}`}</span>
            </div>
          </fieldset>
        );
      })}
      {notice?.kind === "error" ? (
        <div ref={summary} tabIndex={-1} role="alert" className="banner warn">
          <strong>{MESSAGES.ratingsErrorTitle}</strong>
          <p>{notice.text}</p>
        </div>
      ) : null}
      <p role="status" className="muted">{saving ? MESSAGES.ratingsSaving : notice?.kind === "saved" ? notice.text : ""}</p>
      <p>
        <button className="btn pri" type="submit" disabled={saving} aria-busy={saving}>
          {saving ? MESSAGES.ratingsSaving : MESSAGES.ratingsSave}
        </button>
      </p>
    </form>
  );
}

const MESSAGES_MAX = MAX_NOTE.toLocaleString("en-US");
