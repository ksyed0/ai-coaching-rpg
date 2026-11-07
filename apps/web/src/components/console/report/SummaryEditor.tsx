"use client";

import { useEffect, useId, useRef, useState } from "react";
import { editSummary, reportFailureText } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";

// Edit-summary (US-0066): one textarea per list, one entry per line, a required reason. The server REPLACES the whole summary, so the
// boxes open pre-filled with the current entries and every list is always sent: an untouched box re-posts its entries unchanged. An
// actions line is `LO-ID: text`, split on the first colon; whether the id is one of the report's objectives is the server's call. The
// limits (50 entries a list, 400 characters an entry, a 16 KB body) are checked before sending; any refusal is one fixed sentence and
// what was typed stays. Entries are shown only as textarea values (text, never HTML).

type Summary = { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] };

export type SummaryEditorProps = {
  sessionId: string;
  subject: string;
  /** The valid typed name, or null (then Save is disabled). */
  author: string | null;
  summary: Summary;
  /** False for a released or withdrawn report: nothing is rendered. */
  editable: boolean;
  fetch?: typeof fetch;
  /** After a successful save (the view reads the subject again). */
  onChanged?: () => void;
};

/** The BFF's and control's limits (console-report-handlers.ts MAX_ITEMS and MAX_TEXT_BODY_BYTES; LIMITS.item in the runtime). */
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 400;
const MAX_BODY_BYTES = 16 * 1024;

const lines = (v: string): string[] => v.split(/\r\n?|\n/).map((l) => l.trim()).filter((l) => l !== "");
/** Characters as the runtime counts them (code points, so an emoji is one). */
const chars = (s: string): number => [...s].length;

type Draft = { strengths: string; developments: string; actions: string; reason: string };
const draftOf = (s: Summary): Draft => ({
  strengths: s.strengths.join("\n"), developments: s.developments.join("\n"), actions: s.actions.map((a) => `${a.lo}: ${a.text}`).join("\n"), reason: "",
});

/** The body to send, or the fixed sentence that refuses it. */
function check(d: Draft, by: string): { body: Parameters<typeof editSummary>[2] } | { refusal: string } {
  const actions: { lo: string; text: string }[] = [];
  for (const line of lines(d.actions)) {
    const at = line.indexOf(":");
    const lo = at < 0 ? "" : line.slice(0, at).trim();
    const text = at < 0 ? "" : line.slice(at + 1).trim();
    if (lo === "" || text === "") return { refusal: REPORT_CONSOLE.summaryActionLine };
    actions.push({ lo, text });
  }
  const strengths = lines(d.strengths);
  const developments = lines(d.developments);
  if (strengths.length + developments.length + actions.length === 0) return { refusal: REPORT_CONSOLE.summaryEmpty };
  if ([strengths, developments, actions].some((l) => l.length > MAX_ITEMS)) return { refusal: REPORT_CONSOLE.summaryTooMany };
  if ([...strengths, ...developments, ...actions.map((a) => a.text)].some((t) => chars(t) > MAX_ITEM_CHARS)) return { refusal: REPORT_CONSOLE.summaryTooLong };
  const body = { reason: d.reason, strengths, developments, actions, by };
  if (new TextEncoder().encode(JSON.stringify(body)).length > MAX_BODY_BYTES) return { refusal: REPORT_CONSOLE.summaryTooLarge };
  return { body };
}

export function SummaryEditor({ sessionId, subject, author, summary, editable, fetch: fetchImpl, onChanged }: SummaryEditorProps) {
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  if (!editable) return null;
  const ready = draft !== null && draft.reason.trim() !== "" && author !== null && !pending;

  async function save() {
    if (draft === null || !ready || author === null) return;
    const c = check(draft, author);
    if ("refusal" in c) {
      setError(c.refusal);
      return;
    }
    setError("");
    setPending(true);
    const r = await editSummary(sessionId, subject, c.body, fetchImpl);
    if (!alive.current) return;
    setPending(false);
    if (!r.ok) {
      setError(reportFailureText(r));
      return;
    }
    setDraft(null);
    onChanged?.();
  }

  if (draft === null) {
    return (
      <div>
        <button className="btn" type="button" disabled={pending} onClick={() => { setError(""); setDraft(draftOf(summary)); }}>
          {REPORT_CONSOLE.summaryEdit}
        </button>
      </div>
    );
  }

  const box = (key: keyof Draft, label: string, rows: number) => (
    <div className="field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <textarea id={`${id}-${key}`} className="t" rows={rows} value={draft[key]} required={key === "reason"} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
    </div>
  );

  return (
    <div className="card soft stack report-summary-editor">
      <p className="small muted">{REPORT_CONSOLE.summaryReplaces}</p>
      {box("strengths", REPORT_CONSOLE.strengthsLabel, 4)}
      {box("developments", REPORT_CONSOLE.developmentsLabel, 4)}
      {box("actions", REPORT_CONSOLE.actionsLabel, 4)}
      {box("reason", REPORT_CONSOLE.summaryReasonLabel, 2)}
      <p className="err" role="alert">
        {error}
      </p>
      <div className="rowactions">
        <button className="btn pri" type="button" disabled={!ready} onClick={() => void save()}>
          Save the summary
        </button>
        <button className="btn" type="button" disabled={pending} onClick={() => { setDraft(null); setError(""); }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
