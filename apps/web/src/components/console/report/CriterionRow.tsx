"use client";

import { useEffect, useId, useState } from "react";
import { expectOf, type ReportCriterion, type ReportExpect, type ReportLevel } from "../../../lib/console-api";

// One criterion: its level, review status, the participant's own rating, the rationale, the evidence and any flags, all as text; Accept;
// and Edit, an inline form whose reason is required. The edit names the level the form showed (`expect`) so two tabs cannot overwrite
// each other. A refused save keeps everything typed (a stale refusal included) and shows the fixed sentence. When a reload brings a new
// level while the form is open, the form now expects THAT level (so the next Save can succeed), keeps what was typed, and says which
// level the save now replaces.

const STATUS: Record<ReportCriterion["status"], string> = { needs_review: "Needs review", accepted: "Accepted", edited: "Edited", clear: "Clear" };
export const levelText = (l: ReportLevel | "invalid"): string => (l === null ? "Not observed" : l === "invalid" ? "No valid level" : `Level ${l}`);

export type EditInput = { level: ReportLevel; reason: string; rationale?: string; expect: ReportExpect };

export type CriterionRowProps = {
  criterion: ReportCriterion;
  canWrite: boolean;
  pending: boolean;
  /** The evaluation of this subject failed: the criterion is scored by hand (Edit), never accepted. */
  byHand?: boolean;
  /** Resolves to null when saved, or the fixed sentence of the refusal. */
  onEdit: (input: EditInput) => Promise<string | null>;
  onAccept: () => void;
};

const toLevel = (v: string): ReportLevel => (v === "na" ? null : (Number(v) as 1 | 2 | 3 | 4));

export function CriterionRow({ criterion: c, canWrite, pending, byHand = false, onEdit, onAccept }: CriterionRowProps) {
  const id = useId();
  const [form, setForm] = useState<{ expect: ReportExpect; level: string; reason: string; rationale: string } | null>(null);
  const [error, setError] = useState("");
  const shown = expectOf(c.current);
  const [replacing, setReplacing] = useState<string | null>(null);
  useEffect(() => {
    setForm((f) => (f === null || f.expect === shown ? f : { ...f, expect: shown }));
    setReplacing((r) => (form === null ? r : `Now ${levelText(c.current).toLowerCase()}: your save replaces it.`));
    // only on a change of the level shown
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  const ready = form !== null && form.level !== "" && form.reason.trim() !== "" && canWrite && !pending;

  async function save() {
    if (form === null || !ready) return;
    setError("");
    const refusal = await onEdit({
      level: toLevel(form.level), reason: form.reason, expect: form.expect, ...(form.rationale.trim() !== "" ? { rationale: form.rationale } : {}),
    });
    if (refusal === null) {
      setForm(null);
      setReplacing(null);
    }
    else setError(refusal);
  }

  return (
    <li className="report-criterion stack">
      <div className="rowactions">
        <h4 className="code-role">{c.name}</h4>
        <span>{levelText(c.current)}</span>
        <span className={c.status === "needs_review" ? "pill warn" : "pill mut"}>{STATUS[c.status]}</span>
        {c.selfLevel !== undefined ? <span className="small muted">{`Self-rating: ${c.selfLevel === null ? "not observed" : `level ${c.selfLevel}`}`}</span> : null}
      </div>
      {c.rationale !== "" ? <p className="report-text">{c.rationale}</p> : null}
      {c.evidence.length > 0 ? (
        <ul className="console-list small">
          {c.evidence.map((e, i) => (
            <li key={i}>
              <q className="report-text">{e.quote}</q>
              {e.scene !== undefined ? <span className="muted">{` (${e.scene})`}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {c.flags.length > 0 ? (
        <ul className="console-list small">
          {c.flags.map((f, i) => (
            <li key={i} className="muted">
              {f}
            </li>
          ))}
        </ul>
      ) : null}
      {form === null ? (
        <div className="rowactions">
          {/* release needs an invalid level, or any level of a failed evaluation, edited: accepting it would not unblock it */}
          {c.status === "needs_review" && c.current !== "invalid" && !byHand ? (
            <button className="btn" type="button" disabled={!canWrite || pending} aria-label={`Accept ${c.name}`} onClick={onAccept}>
              Accept
            </button>
          ) : null}
          <button
            className="btn" type="button" disabled={!canWrite || pending} aria-label={`Edit ${c.name}`}
            onClick={() => { setError(""); setReplacing(null); setForm({ expect: shown, level: shown === "invalid" ? "" : shown, reason: "", rationale: "" }); }}
          >
            Edit
          </button>
        </div>
      ) : (
        <div className="card soft stack">
          {replacing !== null ? <p className="banner warn">{replacing}</p> : null}
          <div className="field">
            <label htmlFor={`${id}-level`}>New level</label>
            <select id={`${id}-level`} className="t" value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
              {form.level === "" ? <option value="">Choose a level</option> : null}
              <option value="1">Level 1</option>
              <option value="2">Level 2</option>
              <option value="3">Level 3</option>
              <option value="4">Level 4</option>
              <option value="na">Not observed</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-reason`}>Reason (required)</label>
            <textarea id={`${id}-reason`} className="t" rows={2} value={form.reason} required onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-rationale`}>Rationale (optional)</label>
            <textarea id={`${id}-rationale`} className="t" rows={2} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} />
          </div>
          <p className="err" aria-live="polite">
            {error}
          </p>
          <div className="rowactions">
            <button className="btn pri" type="button" disabled={!ready} onClick={() => void save()}>
              Save
            </button>
            <button className="btn" type="button" onClick={() => { setForm(null); setError(""); setReplacing(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
