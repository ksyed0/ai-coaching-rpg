"use client";

import { useEffect, useId, useRef, useState } from "react";
import { exportReport, reportFailureText, type ReportSubjectRow } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { subjectLabel } from "./SubjectList";

// Export a released report as Markdown (spec section 5, part B). The subject is a released or amending role, the group, or the index (a
// view of the group); the views offered are exactly those the runtime's export gate allows (`viewsOf`, BUG-0033): the facilitator's of a
// released subject, a player's own report, and each player's view of the group and the index (an amending subject exports its last
// released version, in a participant's view only). The export is a POST (control records it first);
// the answer is saved as a file through a Blob link and never opened or rendered. A refusal shows the fixed sentence and saves nothing.

/** How long the Blob URL stays valid after the click: revoking it at once can cancel the download (Firefox, older Safari). */
export const REVOKE_AFTER_MS = 30_000;

/**
 * Saves `text` as a download named `fileName` (a Blob URL on a hidden link that is clicked and removed; never opened as a page). The URL
 * is revoked `REVOKE_AFTER_MS` later through `later` (injected in tests).
 */
export function saveMarkdown(text: string, fileName: string, later: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms)): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  later(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

const exportedState = (r: ReportSubjectRow | undefined): boolean => r?.state === "released" || r?.state === "amending";

/** The subjects that can be exported in some view: released and amending ones, and the index once the group is one of them. */
export function exportable(rows: ReportSubjectRow[]): string[] {
  const out = rows.filter(exportedState).map((r) => r.id);
  return out.includes("group") ? [...out, "index"] : out;
}

type Audience = "facilitator" | `participant:${string}`;

/**
 * The views of one subject that the runtime's export gate allows (BUG-0033; exportGate in services/runtime/src/moderation/write-b.ts and
 * canView in review/policy.ts), the index following the group: the facilitator's of a RELEASED subject; for an amending one, none (it is
 * refused as not released). A participant's of a released or amending subject (its last released version): a player's own report for
 * that player only; the group and the index for every player subject of the review, whatever that player's own state.
 */
export function viewsOf(subject: string, rows: ReportSubjectRow[]): Audience[] {
  const audited = subject === "index" ? "group" : subject;
  const r = rows.find((x) => x.id === audited);
  if (!exportedState(r)) return [];
  const views: Audience[] = r!.state === "released" ? ["facilitator"] : [];
  if (audited !== "group") return [...views, `participant:${subject}`];
  return [...views, ...rows.filter((x) => x.id !== "group").map((x): Audience => `participant:${x.id}`)];
}

const optionLabel = (s: string): string => (s === "index" ? "Index of the reports" : subjectLabel(s));
const reportName = (s: string): string => (s === "index" ? "Index of the reports" : s === "group" ? "Group report" : `${subjectLabel(s)}'s report`);
/** The accessible name of one view: the report and who it is for. */
function viewLabel(s: string, a: Audience): string {
  if (a === "facilitator") return REPORT_CONSOLE.exportFacilitatorView(reportName(s));
  const player = subjectLabel(a.slice("participant:".length));
  return s === "group" ? REPORT_CONSOLE.exportPlayerGroupView(reportName(s), player) : REPORT_CONSOLE.exportPlayerView(reportName(s), player);
}

export type ExportMenuProps = {
  sessionId: string;
  subjects: ReportSubjectRow[];
  author: string | null;
  /** Preselects a subject (a row's Export) and takes focus. */
  initial?: string;
  fetch?: typeof fetch;
  /** Injected in tests; saves the file in the browser by default. */
  save?: (text: string, fileName: string) => void;
};

export function ExportMenu({ sessionId, subjects, author, initial, fetch: fetchImpl, save = saveMarkdown }: ExportMenuProps) {
  const id = useId();
  const options = exportable(subjects);
  const [subject, setSubject] = useState(initial !== undefined && options.includes(initial) ? initial : (options[0] ?? ""));
  const [audience, setAudience] = useState<Audience | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const select = useRef<HTMLSelectElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (initial !== undefined) select.current?.focus();
    return () => {
      alive.current = false;
    };
    // only on mount: a row's Export remounts this menu with its subject
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (options.length === 0) return null;
  const current = options.includes(subject) ? subject : options[0]!;
  const views = viewsOf(current, subjects);
  const view: Audience | undefined = audience !== null && views.includes(audience) ? audience : views[0];
  const amending = subjects.find((r) => r.id === (current === "index" ? "group" : current))?.state === "amending";

  async function download() {
    if (author === null || pending || view === undefined) return;
    setPending(true);
    setMessage("");
    const r = await exportReport(sessionId, { subject: current, audience: view, by: author }, fetchImpl);
    if (!alive.current) return;
    setPending(false);
    if (!r.ok) {
      setMessage(reportFailureText(r));
      return;
    }
    save(r.text, r.fileName);
    setMessage(REPORT_CONSOLE.exported(r.fileName));
  }

  return (
    <section className="card soft stack report-export" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Export</h3>
      <div className="field">
        <label htmlFor={`${id}-subject`}>Report to export</label>
        <select id={`${id}-subject`} ref={select} className="t" value={current} onChange={(e) => { setSubject(e.target.value); setAudience(null); }}>
          {options.map((s) => (
            <option key={s} value={s}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-view`}>View</label>
        {/* `?? ""` keeps the select controlled: `view` is undefined only when a subject has no allowed view (never offered). */}
        <select id={`${id}-view`} className="t" value={view ?? ""} onChange={(e) => setAudience(e.target.value as Audience)}>
          {views.map((a) => (
            <option key={a} value={a}>
              {viewLabel(current, a)}
            </option>
          ))}
        </select>
      </div>
      {amending ? <p className="small muted">{REPORT_CONSOLE.exportAmending}</p> : null}
      <p className="small muted" aria-live="polite">
        {message}
      </p>
      <div>
        <button className="btn" type="button" disabled={author === null || pending || view === undefined} onClick={() => void download()}>
          Download
        </button>
      </div>
    </section>
  );
}
