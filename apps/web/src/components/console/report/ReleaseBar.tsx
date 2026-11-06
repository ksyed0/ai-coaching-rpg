"use client";

import { useId, useState } from "react";
import type { ReportSubjectRow } from "../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { subjectLabel } from "./SubjectList";

// The release bar (spec section 6, part B): the subjects that can be released now (draft or amending, nothing blocking) each have a box
// to tick; one that still has open items says why and cannot be ticked. "Release selected" and "Release everything" open the release
// dialog with an explicit list of subjects: "everything" is the full list of releasable subjects shown here, never an `all` flag.

/**
 * What still blocks a subject's release, as the server's gate has it (review/gate.ts releaseProblems): criteria to review or to score by
 * hand, and a stale summary. Open disputes and a stale group table do not block a release (re-releasing the group refreshes its table).
 */
export function releaseBlockers(r: ReportSubjectRow): string[] {
  const out: string[] = [];
  for (const c of new Set([...r.openCriteria, ...r.scoreByHand])) out.push(r.scoreByHand.includes(c) ? REPORT_CONSOLE.byHand(c) : REPORT_CONSOLE.needsReview(c));
  if (r.summaryStale) out.push(REPORT_CONSOLE.summaryOpen);
  return out;
}

/** Draft or amending: a release can be asked for. */
export const canBeReleased = (r: ReportSubjectRow): boolean => r.state === "draft" || r.state === "amending";
/** Draft or amending with nothing blocking. */
export const isReleasable = (r: ReportSubjectRow): boolean => canBeReleased(r) && releaseBlockers(r).length === 0;

export type ReleaseBarProps = {
  subjects: ReportSubjectRow[];
  canWrite: boolean;
  pending: boolean;
  onRelease: (ids: string[], opener: HTMLElement) => void;
};

export function ReleaseBar({ subjects, canWrite, pending, onRelease }: ReleaseBarProps) {
  const id = useId();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const candidates = subjects.filter(canBeReleased);
  if (candidates.length === 0) return null;
  const releasable = candidates.filter(isReleasable).map((r) => r.id);
  // a subject that is no longer releasable (another tab, a reload) drops out of the selection
  const chosen = releasable.filter((s) => ticked.has(s));
  const toggle = (s: string, on: boolean) => setTicked((t) => {
    const n = new Set(t);
    if (on) n.add(s);
    else n.delete(s);
    return n;
  });
  return (
    <section className="card soft stack report-release" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>Release</h3>
      <ul className="console-list stack">
        {candidates.map((r) => {
          const blockers = releaseBlockers(r);
          const label = subjectLabel(r.id);
          return (
            <li key={r.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(r.id)}
                  disabled={blockers.length > 0}
                  aria-describedby={blockers.length > 0 ? `${id}-${r.id}-why` : undefined}
                  onChange={(e) => toggle(r.id, e.target.checked)}
                />
                <span>{label}</span>
              </label>
              {blockers.length > 0 ? (
                <p className="small muted" id={`${id}-${r.id}-why`}>
                  {REPORT_CONSOLE.notReady(blockers.join("; "))}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className="rowactions">
        <button className="btn" type="button" disabled={!canWrite || pending || chosen.length === 0} onClick={(e) => onRelease(chosen, e.currentTarget)}>
          Release selected…
        </button>
        <button className="btn pri" type="button" disabled={!canWrite || pending || releasable.length === 0} onClick={(e) => onRelease(releasable, e.currentTarget)}>
          Release everything…
        </button>
      </div>
    </section>
  );
}
