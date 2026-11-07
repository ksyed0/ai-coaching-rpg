"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  amendSubject,
  blockedOf,
  cancelEvaluate,
  fetchReportOverview,
  openReview,
  parseReleased,
  parseReportOverview,
  releaseSubjects,
  reportFailureText,
  startEvaluate,
  withdrawSubject,
  type ReportOverviewView,
} from "../../../lib/console-api";
import type { ApiResult } from "../../../lib/api";
import { REPORT_CONSOLE } from "../../../lib/messages";
import { audienceOf } from "../../../lib/report-audience";
import { realSetTimer, type SetTimer } from "../../../lib/use-readiness";
import { AmendDialog } from "./AmendDialog";
import { AuthorName, isAuthorName } from "./AuthorName";
import { EvaluateCard } from "./EvaluateCard";
import { EvaluateConfirmDialog } from "./EvaluateConfirmDialog";
import { ExportMenu, exportable } from "./ExportMenu";
import { ReleaseBar, releaseBlockers } from "./ReleaseBar";
import { ReleaseDialog } from "./ReleaseDialog";
import { RunSummaryView } from "./RunSummaryView";
import { SubjectList, subjectLabel } from "./SubjectList";
import { SubjectView } from "./SubjectView";
import { WithdrawDialog } from "./WithdrawDialog";

// The Report panel of an ended session (US-0064, spec section 6): the typed author name, the evaluate card, the run summary, the subject
// list and one subject's view; after the review is open (part B) the release bar, the per-subject actions after release (amend,
// withdraw, release again) with their dialogs, and the export menu. A refused release, amend or withdraw keeps its dialog open with what
// was typed and the fixed sentence (a `blocked` release lists the subjects the server named). The overview is polled every 2 s only while the last known stage is `evaluating`, a failed read included
// (the timer is injected so tests never sleep). Evaluate progress is announced by the card's own polite progress list; action results and
// refusals by the panel's polite status line. Every refusal is a fixed sentence. Each overview read is numbered: an answer older than
// the newest one applied is ignored (BUG-0032). Outside `evaluating`, a failed read is retried once after RETRY_MS on the same injected
// timer, then waits for Try again.

export const POLL_MS = 2_000;
/** The delay of the one automatic retry of a failed overview read outside `evaluating` (BUG-0032). */
export const RETRY_MS = 3_000;

export type ReportPanelProps = {
  sessionId: string;
  fetch?: typeof fetch;
  setTimer?: SetTimer;
  /** Saves an exported report (injected in tests). */
  save?: (text: string, fileName: string) => void;
};

type Moderation =
  | { kind: "release"; ids: string[]; opener: HTMLElement }
  | { kind: "amend" | "withdraw"; id: string; opener: HTMLElement };

export function ReportPanel({ sessionId, fetch: fetchImpl, setTimer = realSetTimer, save }: ReportPanelProps) {
  const headingId = useId();
  const [overview, setOverview] = useState<ReportOverviewView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState<{ opener: HTMLElement } | null>(null);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [moderation, setModeration] = useState<Moderation | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [blocked, setBlocked] = useState<string[]>([]);
  /** Bumped after a successful release, amend or withdraw, so the open subject view reads its subject again. */
  const [changes, setChanges] = useState(0);
  /** A row's Export: the subject the export menu starts on (it remounts per click). */
  const [exportFor, setExportFor] = useState<{ subject: string; n: number } | null>(null);
  /** Counts finished reads, a failed one included, so the poll is rescheduled after every answer. */
  const [reads, setReads] = useState(0);
  /** A failed read that is not itself the retry: one automatic retry is due (BUG-0032). */
  const [retryDue, setRetryDue] = useState(false);
  /** The number of the last read sent, and of the newest read whose answer was applied (BUG-0032). */
  const sent = useRef(0);
  const applied = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (retry = false) => {
    const mine = ++sent.current;
    const r = await fetchReportOverview(sessionId, fetchImpl);
    if (!alive.current) return;
    setReads((n) => n + 1);
    // An answer older than one already applied is stale (a write's refresh beside a poll can answer in either order): ignored.
    if (mine < applied.current) return;
    applied.current = mine;
    const parsed = r.ok ? parseReportOverview(r.data) : null;
    setRetryDue(parsed === null && !retry);
    if (!r.ok) {
      setLoadError(reportFailureText(r));
      return;
    }
    setLoadError(parsed === null ? REPORT_CONSOLE.unreadable : null);
    if (parsed !== null) setOverview(parsed);
  }, [sessionId, fetchImpl]);

  useEffect(() => {
    void load();
  }, [load]);

  // One poll after each answer (a failed or unreadable one too), and only while the last known stage is `evaluating`; a new answer (or
  // leaving the page) cancels the one scheduled.
  useEffect(() => {
    if (overview?.stage !== "evaluating") return;
    return setTimer(() => void load(), POLL_MS);
  }, [overview, reads, load, setTimer]);

  // Outside `evaluating` (the poll covers that stage), a failed read is retried once after RETRY_MS; if the retry fails too, the
  // fixed sentence and Try again stay.
  useEffect(() => {
    if (!retryDue || overview?.stage === "evaluating") return;
    return setTimer(() => {
      setRetryDue(false);
      void load(true);
    }, RETRY_MS);
  }, [retryDue, overview, load, setTimer]);

  const author = isAuthorName(name) ? name : null;

  async function act(call: Promise<ApiResult>, done: string) {
    setPending(true);
    setMessage("");
    const r = await call;
    if (!alive.current) return;
    setPending(false);
    setConfirm(null);
    setMessage(r.ok ? done : reportFailureText(r));
    await load();
  }

  function openDialog(m: Moderation) {
    setDialogError("");
    setBlocked([]);
    setModeration(m);
  }

  /** A release, amend or withdraw: on success the dialog closes and the status line says what happened; a refusal keeps it open. */
  async function moderate(call: Promise<ApiResult>, done: (data: unknown) => string) {
    setPending(true);
    setMessage("");
    setDialogError("");
    const r = await call;
    if (!alive.current) return;
    setPending(false);
    if (!r.ok) {
      setDialogError(reportFailureText(r));
      setBlocked(blockedOf(r));
    } else {
      setModeration(null);
      setBlocked([]);
      setMessage(done(r.data));
    }
    await load();
    if (r.ok && alive.current) setChanges((n) => n + 1);
  }

  const rows = overview?.subjects ?? [];
  const row = (id: string) => rows.find((r) => r.id === id);
  const inReview = overview?.stage === "in_review";
  // The released group's per-role table is out of date (a player released or withdrawn after it), read from the group's own row so the
  // hint stays until the group is amended and released again, whatever the last action answered.
  const group = row("group");
  const tableStale = group?.tableStale === true && group.state === "released";

  return (
    <section className="card stack report-panel" aria-labelledby={headingId}>
      <h2 className="s" id={headingId}>
        Report
      </h2>
      <p className="small muted" role="status" aria-live="polite" tabIndex={-1} data-focus-fallback="report">
        {message}
      </p>
      <AuthorName value={name} onChange={setName} />
      {loadError !== null ? (
        <div className="stack">
          <p className="banner warn">{loadError}</p>
          <div>
            <button className="btn" type="button" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {overview === null ? null : (
        <>
          <EvaluateCard
            overview={overview}
            canWrite={author !== null}
            pending={pending}
            onEvaluate={(opener) => setConfirm({ opener })}
            onCancel={() => void act(cancelEvaluate(sessionId, fetchImpl), REPORT_CONSOLE.cancelled)}
            onOpen={() => {
              if (author !== null) void act(openReview(sessionId, author, fetchImpl), REPORT_CONSOLE.opened);
            }}
          />
          {overview.summary !== null ? <RunSummaryView summary={overview.summary} /> : null}
          {tableStale ? <p className="banner warn">{REPORT_CONSOLE.groupTableStale}</p> : null}
          {inReview && overview.subjects.length > 0 ? (
            <SubjectList
              subjects={overview.subjects} selected={selected} onSelect={setSelected}
              actions={{
                canWrite: author !== null, pending,
                onAmend: (id, opener) => openDialog({ kind: "amend", id, opener }),
                onWithdraw: (id, opener) => openDialog({ kind: "withdraw", id, opener }),
                onRelease: (id, opener) => openDialog({ kind: "release", ids: [id], opener }),
                onExport: (subject) => setExportFor((e) => ({ subject, n: (e?.n ?? 0) + 1 })),
              }}
            />
          ) : null}
          {inReview ? (
            <ReleaseBar subjects={overview.subjects} canWrite={author !== null} pending={pending} onRelease={(ids, opener) => openDialog({ kind: "release", ids, opener })} />
          ) : null}
          {inReview && exportable(overview.subjects).length > 0 ? (
            <ExportMenu
              key={exportFor?.n ?? 0} sessionId={sessionId} subjects={overview.subjects} author={author}
              {...(exportFor !== null ? { initial: exportFor.subject } : {})} {...(fetchImpl ? { fetch: fetchImpl } : {})} {...(save ? { save } : {})}
            />
          ) : null}
          {overview.stage === "in_review" && selected !== null ? (
            <SubjectView
              key={selected} sessionId={sessionId} subject={selected} author={author}
              evaluationOk={overview.subjects.find((s) => s.id === selected)?.evaluationOk ?? false} {...(fetchImpl ? { fetch: fetchImpl } : {})} onChanged={() => void load()} refresh={changes} />
          ) : null}
        </>
      )}
      {confirm !== null && overview?.upTo != null && author !== null ? (
        <EvaluateConfirmDialog
          upTo={overview.upTo}
          name={author}
          pending={pending}
          opener={confirm.opener}
          onCancel={() => setConfirm(null)}
          onConfirm={(n) => void act(startEvaluate(sessionId, n, author, fetchImpl), REPORT_CONSOLE.started)}
        />
      ) : null}
      {moderation !== null && author !== null && inReview ? (
        moderation.kind === "release" ? (
          <ReleaseDialog
            subjects={moderation.ids.map((id) => {
              const r = row(id);
              return { id, audience: audienceOf(id), blockers: r === undefined ? [REPORT_CONSOLE.blockerMissing] : releaseBlockers(r) };
            })}
            name={author} pending={pending} opener={moderation.opener} error={dialogError} blocked={blocked}
            onCancel={() => setModeration(null)}
            onConfirm={() => void moderate(releaseSubjects(sessionId, moderation.ids, author, fetchImpl), (d) => {
              const released = parseReleased(d);
              return released === null ? REPORT_CONSOLE.saved : REPORT_CONSOLE.released(released.released.map(subjectLabel).join(", "));
            })}
          />
        ) : moderation.kind === "amend" ? (
          <AmendDialog
            subject={{ id: moderation.id, audience: audienceOf(moderation.id) }}
            name={author} pending={pending} opener={moderation.opener} error={dialogError}
            onCancel={() => setModeration(null)}
            onConfirm={(reason) => void moderate(amendSubject(sessionId, moderation.id, reason, author, fetchImpl), () => REPORT_CONSOLE.amended)}
          />
        ) : (
          <WithdrawDialog
            subject={{ id: moderation.id, audience: audienceOf(moderation.id) }}
            name={author} pending={pending} opener={moderation.opener} error={dialogError}
            onCancel={() => setModeration(null)}
            onConfirm={(reason) => void moderate(withdrawSubject(sessionId, moderation.id, reason, author, fetchImpl), () => REPORT_CONSOLE.withdrawn)}
          />
        )
      ) : null}
    </section>
  );
}
