"use client";

import type { ReportSubjectRow, ReportSubjectState } from "../../../lib/console-api";
import { roleLabel } from "../../../lib/names";

// One row per role and the group: the subject's OWN state and the items still open for it. There is no report-wide "released" state;
// each subject is released, amended or withdrawn on its own. State is a word, never colour only.

const STATE_LABEL: Record<ReportSubjectState, string> = { draft: "Draft", released: "Released", amending: "Amending", withdrawn: "Withdrawn" };
const STATE_PILL: Record<ReportSubjectState, string> = { draft: "pill warn", released: "pill ok", amending: "pill warn", withdrawn: "pill mut" };

export const subjectLabel = (id: string): string => (id === "group" ? "Group" : roleLabel(id));

/**
 * Criteria still to review or to score by hand (each once: release blocks on both, and an accepted criterion of a failed evaluation or
 * with an invalid level still blocks), open disputes, and a stale summary or table.
 */
export const openItems = (r: ReportSubjectRow): number =>
  new Set([...r.openCriteria, ...r.scoreByHand]).size + r.openDisputes + (r.summaryStale ? 1 : 0) + (r.tableStale ? 1 : 0);

/**
 * The actions after release, per subject state: released has Amend, Withdraw and Export; amending has Withdraw and Release (its edit tools are in the
 * subject view, opened by Review); withdrawn has none (control exports only a released report). Every action needs the typed name.
 */
export type SubjectActions = {
  canWrite: boolean;
  pending: boolean;
  onAmend: (id: string, opener: HTMLElement) => void;
  onWithdraw: (id: string, opener: HTMLElement) => void;
  onExport: (id: string) => void;
  onRelease: (id: string, opener: HTMLElement) => void;
};

export type SubjectListProps = { subjects: ReportSubjectRow[]; selected: string | null; onSelect: (id: string) => void; actions?: SubjectActions };

export function SubjectList({ subjects, selected, onSelect, actions }: SubjectListProps) {
  return (
    <ul className="codes report-subjects">
      {subjects.map((r) => {
        const label = subjectLabel(r.id);
        const n = openItems(r);
        return (
          <li className="code-row" key={r.id}>
            <span className="code-role">{label}</span>
            <span className={STATE_PILL[r.state]}>{STATE_LABEL[r.state]}</span>
            <span className="small">{n === 0 ? "No open items" : n === 1 ? "1 open item" : `${n} open items`}</span>
            <button className="btn" type="button" aria-label={`Review ${label}`} aria-pressed={selected === r.id} onClick={() => onSelect(r.id)}>
              Review
            </button>
            {actions !== undefined ? <RowActions row={r} label={label} actions={actions} /> : null}
          </li>
        );
      })}
    </ul>
  );
}

function RowActions({ row: r, label, actions: a }: { row: ReportSubjectRow; label: string; actions: SubjectActions }) {
  const off = !a.canWrite || a.pending;
  if (r.state === "released")
    return (
      <>
        <button className="btn" type="button" disabled={off} aria-label={`Amend ${label}`} onClick={(e) => a.onAmend(r.id, e.currentTarget)}>
          Amend…
        </button>
        <button className="btn danger" type="button" disabled={off} aria-label={`Withdraw ${label}`} onClick={(e) => a.onWithdraw(r.id, e.currentTarget)}>
          Withdraw…
        </button>
        <button className="btn" type="button" disabled={off} aria-label={`Export ${label}`} onClick={() => a.onExport(r.id)}>
          Export
        </button>
      </>
    );
  if (r.state === "amending")
    return (
      <>
        <button className="btn danger" type="button" disabled={off} aria-label={`Withdraw ${label}`} onClick={(e) => a.onWithdraw(r.id, e.currentTarget)}>
          Withdraw…
        </button>
        <button className="btn" type="button" disabled={off} aria-label={`Release ${label}`} onClick={(e) => a.onRelease(r.id, e.currentTarget)}>
          Release…
        </button>
      </>
    );
  return null;
}
