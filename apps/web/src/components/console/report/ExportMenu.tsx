"use client";

import { useEffect, useId, useRef, useState } from "react";
import { exportReport, reportFailureText, type ReportSubjectRow } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { subjectLabel } from "./SubjectList";

// Export a released report as Markdown (spec section 5, part B). The subject is a released role, the group, or the index (a view of the
// released group); the view is the facilitator's, or for a role the participant's own. The export is a POST (control records it first);
// the answer is saved as a file through a Blob link and never opened or rendered. A refusal shows the fixed sentence and saves nothing.

/** Saves `text` as a download named `fileName` (a Blob URL on a hidden link that is clicked and removed; never opened as a page). */
export function saveMarkdown(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The subjects that can be exported for the facilitator: released ones, and the index once the group is released. */
export function exportable(rows: ReportSubjectRow[]): string[] {
  const out = rows.filter((r) => r.state === "released").map((r) => r.id);
  return out.includes("group") ? [...out, "index"] : out;
}

const optionLabel = (s: string): string => (s === "index" ? "Index of the reports" : subjectLabel(s));
type Audience = "facilitator" | `participant:${string}`;

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
  const [audience, setAudience] = useState<Audience>("facilitator");
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
  const personal = current !== "group" && current !== "index";
  const view: Audience = personal && audience === `participant:${current}` ? audience : "facilitator";

  async function download() {
    if (author === null || pending) return;
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
        <select id={`${id}-subject`} ref={select} className="t" value={current} onChange={(e) => { setSubject(e.target.value); setAudience("facilitator"); }}>
          {options.map((s) => (
            <option key={s} value={s}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-view`}>View</label>
        <select id={`${id}-view`} className="t" value={view} onChange={(e) => setAudience(e.target.value as Audience)}>
          <option value="facilitator">The facilitator's view</option>
          {personal ? <option value={`participant:${current}`}>{`${subjectLabel(current)}'s own view`}</option> : null}
        </select>
      </div>
      <p className="small muted" aria-live="polite">
        {message}
      </p>
      <div>
        <button className="btn" type="button" disabled={author === null || pending} onClick={() => void download()}>
          Download
        </button>
      </div>
    </section>
  );
}
