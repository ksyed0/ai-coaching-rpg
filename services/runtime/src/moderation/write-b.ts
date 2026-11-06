/**
 * Moderation writes, part B (EPIC-0002, slice 2c-3): release, amend, withdraw, resolve and export, moved out of the
 * `pnpm moderate` handlers so the control service runs the same gate rules and hash chain in-process. Each builds exactly the
 * entries the CLI built, under the review lock (`applyCommand`). Errors are thrown as the review layer's, messages unchanged, so
 * the CLI prints today's text; the control service wraps calls in `toModResult`. `by` must already be a clean safe id.
 */
import { isSafeId } from "@acr/events";
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { cleanLine, need, shownName } from "../review/cli-util.js";
import { ReviewRefusedError, ReviewUsageError } from "../review/errors.js";
import { amendedSince } from "../review/fold.js";
import { releaseProblems } from "../review/gate.js";
import { renderReviewIndex } from "../review/index-view.js";
import { canView, parsePrincipal, type Principal } from "../review/policy.js";
import { applyCommand, loadReview, type Loaded } from "../review/store.js";
import { cleanText } from "../review/text.js";
import {
  GROUP,
  LIMITS,
  type Actor,
  type ReviewEvent,
} from "../review/types.js";
import {
  participantGroupReport,
  renderSubjectMarkdown,
  snapshotReport,
  viewReport,
} from "../review/view.js";
import type { Base } from "./types.js";

const actorOf = (o: { by: string }): Actor => ({
  kind: "facilitator",
  by: o.by,
});
const reasonOf = (o: Base & { reason: string }): string =>
  cleanText(String(o.reason ?? ""), LIMITS.reason, "--reason", o.secrets);

/** The refusal text of `release`. The top-level error is cut at 400 characters, so keep whole (capped) lines and say how many were left out. */
export function releaseRefusal(problems: string[]): string {
  const shown: string[] = [];
  let len = 60; // "refused: nothing was released:" plus the line markers and the "... and N more" tail
  for (const raw of problems) {
    const p = raw.length > 110 ? `${raw.slice(0, 107)}...` : raw;
    if (shown.length > 0 && len + p.length + 5 > 340) break;
    shown.push(p);
    len += p.length + 5;
  }
  const more = problems.length - shown.length;
  return `nothing was released:\n  ${shown.join("\n  ")}${more > 0 ? `\n  ... and ${more} more; run status for the full list` : ""}`;
}

/** Whether a release or withdrawal left the released group's per-role table out of date (it was not before). */
export const groupTableStaleAfter = (
  before: Loaded,
  after: Loaded,
): boolean => {
  const b = before.view.subjects.get(GROUP);
  const a = after.view.subjects.get(GROUP);
  return a?.tableStale === true && b?.tableStale !== true;
};

export type ReleaseOutcome = {
  released: string[];
  version: number;
  groupTableStale: boolean;
};

/**
 * `release`, all-or-nothing, for the ids `pick` chooses from the locked view (the CLI's `--all` picks every draft or amending
 * subject). Refused with every problem in one message; the code is `unknown_subject` when any id is unknown, else
 * `not_editable` when any subject is not draft or amending, else `blocked` (gate problems) with the blocked subject ids.
 */
export async function releaseWith(
  o: Base,
  pick: (l: Loaded) => string[],
): Promise<ReleaseOutcome> {
  const actor = actorOf(o);
  let before!: Loaded;
  const { appended, loaded } = await applyCommand(o.dir, o.now, (l) => {
    before = l;
    const ids = pick(l);
    if (ids.length === 0)
      throw new ReviewRefusedError(
        "nothing was released: no subject is waiting for release",
      );
    const problems: string[] = [];
    let unknown = false,
      notEditable = false;
    const blocked: string[] = [];
    for (const id of ids) {
      const sv = l.view.subjects.get(id);
      if (!sv) {
        unknown = true;
        problems.push(`${shownName(id)}: unknown subject`);
        continue;
      }
      if (sv.state !== "draft" && sv.state !== "amending") {
        notEditable = true;
        problems.push(`${id}: is ${sv.state}`);
        continue;
      }
      const gate = releaseProblems(sv);
      if (gate.length) blocked.push(id);
      for (const p of gate) problems.push(`${id}: ${p}`);
    }
    if (problems.length)
      throw unknown
        ? new ReviewRefusedError(releaseRefusal(problems), "unknown_subject")
        : notEditable
          ? new ReviewRefusedError(releaseRefusal(problems), "not_editable")
          : new ReviewRefusedError(
              releaseRefusal(problems),
              "blocked",
              blocked,
            );
    return [{ actor, body: { type: "report.released", subjects: ids } }];
  });
  const e = appended[0] as Extract<ReviewEvent, { type: "report.released" }>;
  return {
    released: [...e.subjects],
    version: e.seq,
    groupTableStale: groupTableStaleAfter(before, loaded),
  };
}

/** Releases the listed subjects (a non-empty list; duplicates count once), all or nothing. */
export async function releaseSubjects(
  o: Base & { subjects: string[] },
): Promise<{ released: string[]; groupTableStale: boolean }> {
  if (!Array.isArray(o.subjects) || o.subjects.length === 0)
    throw new ReviewUsageError("release needs <subject>... or --all");
  const ids = [...new Set(o.subjects.map(String))];
  const r = await releaseWith(o, () => ids);
  return { released: r.released, groupTableStale: r.groupTableStale };
}

/** Reopens a released report for edits (participants keep seeing the last release). A reason is required. */
export async function amendSubject(
  o: Base & { subject: string; reason: string },
): Promise<void> {
  const actor = actorOf(o);
  const reason = reasonOf(o);
  const { subject } = o;
  await applyCommand(o.dir, o.now, (l) => {
    const sv = need(l.view.subjects.get(subject), "subject");
    return [
      {
        actor,
        body: {
          type: "report.amended",
          subject,
          reason,
          basedOn: sv.versions.at(-1) ?? 0,
        },
      },
    ];
  });
}

/** Takes a released report back for good. A reason is required. */
export async function withdrawSubject(
  o: Base & { subject: string; reason: string },
): Promise<{ groupTableStale: boolean }> {
  const actor = actorOf(o);
  const reason = reasonOf(o);
  const { subject } = o;
  let before!: Loaded;
  const { loaded } = await applyCommand(o.dir, o.now, (l) => {
    before = l;
    need(l.view.subjects.get(subject), "subject");
    return [{ actor, body: { type: "report.withdrawn", subject, reason } }];
  });
  return { groupTableStale: groupTableStaleAfter(before, loaded) };
}

/** Closes a dispute. `amended` is refused (`needs_amend`) unless the report has a new released version since the response. */
export async function resolveDispute(
  o: Base & {
    seq: number;
    outcome: "upheld" | "amended" | "declined";
    reason: string;
  },
): Promise<void> {
  const { seq, outcome } = o;
  if (!Number.isInteger(seq) || seq < 1 || seq > 999_999_999)
    throw new ReviewUsageError(
      "resolve needs the response number shown by status",
    );
  const actor = actorOf(o);
  const reason = reasonOf(o);
  if (outcome !== "upheld" && outcome !== "amended" && outcome !== "declined")
    throw new ReviewUsageError("--outcome needs upheld, amended or declined");
  await applyCommand(o.dir, o.now, (l) => {
    const found = [...l.view.subjects.values()]
      .flatMap((sv) => sv.responses.map((r) => ({ sv, r })))
      .find((x) => x.r.seq === seq);
    if (!found)
      throw new ReviewRefusedError(
        "there is no response with that number; run status for the open disputes",
      );
    if (!found.r.dispute)
      throw new ReviewRefusedError(
        "that response is not a dispute, so there is nothing to resolve",
      );
    if (found.r.resolution)
      throw new ReviewRefusedError("that dispute is already resolved");
    if (outcome === "amended" && !amendedSince(found.sv, seq))
      throw new ReviewRefusedError(
        `${found.sv.id}'s report has no new released version since the response; run amend, make the change and release again, then resolve the dispute as amended`,
        "needs_amend",
      );
    return [
      {
        actor,
        body: { type: "dispute.resolved", response: seq, outcome, reason },
      },
    ];
  });
}

/** One export request, as both the CLI and the console make it. */
export type ExportTarget = {
  subject: string;
  principal: Principal;
  isIndex: boolean;
  /** The subject the export event names: the index is recorded under the group (its state follows the group's). */
  audited: string;
  role: string | null;
};

export function exportTarget(
  subject: string,
  principal: Principal,
): ExportTarget {
  const isIndex = subject === "index";
  return {
    subject,
    principal,
    isIndex,
    audited: isIndex ? GROUP : subject,
    role: principal.startsWith("participant:")
      ? principal.slice("participant:".length)
      : null,
  };
}

/**
 * Who may export what, against one loaded view. Messages are constants: nothing from the request is echoed. Only a released
 * subject (an `amending` one is refused for a facilitator export); a participant only through `canView`.
 */
export function exportGate(t: ExportTarget, l: Loaded) {
  const sv = need(l.view.subjects.get(t.audited), "subject");
  if (t.role !== null && l.view.subjects.get(t.role)?.kind !== "participant")
    throw new ReviewRefusedError("that participant is not in this review");
  if (t.principal === "facilitator") {
    if (sv.state !== "released")
      throw new ReviewRefusedError(
        `${t.isIndex ? GROUP : t.subject} is ${sv.state}; only a released report is exported`,
        "not_released",
      );
  } else {
    const access = canView({
      principal: t.principal,
      subject: t.subject,
      state: sv.state,
      versions: sv.versions.length,
      view: t.isIndex ? "index" : "report",
      superseded: l.view.superseded !== null,
      policyVersion: l.view.opened.policyVersion,
    });
    if (!access.allowed)
      throw new ReviewRefusedError(
        `export refused: ${access.why}`,
        access.why === "not released" ? "not_released" : undefined,
      );
  }
  return sv;
}

/** As strict as `show`: per line, hidden and control characters out, secrets and machine paths redacted (tables and tabs stay). */
export const tidy = (md: string, secrets: string[]): string =>
  `${md
    .split("\n")
    .map((line) => cleanLine(line, secrets))
    .join("\n")
    .trimEnd()}\n`;

/** The audience's report object of a (non-index) subject, from one loaded view. */
export function exportedReport(
  t: ExportTarget,
  cur: Loaded,
): ParticipantReport | GroupReport {
  const draftOf = (n: string) =>
    cur.drafts.subjects.get(n)!.raw as unknown as
      ParticipantReport | GroupReport;
  if (t.role === null)
    return snapshotReport(draftOf(t.subject), cur.view, t.subject);
  const line =
    t.subject === GROUP
      ? "Visibility: the players of this session and the facilitator"
      : "Visibility: you and the facilitator";
  const legacy = cur.view.opened.legacy;
  return t.subject === GROUP
    ? participantGroupReport(
        draftOf(t.subject) as GroupReport,
        cur.view,
        t.role,
        line,
        legacy,
      )
    : viewReport(draftOf(t.subject), cur.view, t.subject, {
        audience: "released",
        line,
        legacy,
      });
}

/** The audience's Markdown of the subject (or the index), tidied, from one loaded view. */
export function exportedMarkdown(
  t: ExportTarget,
  cur: Loaded,
  secrets: string[],
): string {
  if (t.isIndex)
    return tidy(
      renderReviewIndex(
        cur,
        t.role === null
          ? { audience: "facilitator" }
          : { audience: "participant", role: t.role },
        secrets,
      ),
      secrets,
    );
  return tidy(renderSubjectMarkdown(exportedReport(t, cur), secrets), secrets);
}

/** The export event of one target against the locked view: the latest released version, the given destination label. */
export function exportEntry(
  o: { by: string },
  t: ExportTarget,
  sv: { versions: number[] },
  destination: string,
) {
  return {
    actor: actorOf(o),
    body: {
      type: "report.exported" as const,
      subject: t.audited,
      version: sv.versions.at(-1)!,
      principal: t.principal,
      destination,
    },
  };
}

const CONSOLE_DESTINATION = "console-download";

/**
 * The console's export: records the export event (destination `console-download`) first, then renders the audience's Markdown
 * from the view that holds that event. Writes no file. `subject` is a role, `group` or `index`; audience `facilitator` or
 * `participant:<role>`.
 */
export async function exportReport(
  o: Base & {
    subject: string;
    audience: "facilitator" | `participant:${string}`;
  },
): Promise<{ fileName: string; markdown: string }> {
  const subject = String(o.subject ?? "");
  if (!isSafeId(subject)) throw new ReviewUsageError("export needs <subject>");
  const principal =
    typeof o.audience === "string" ? parsePrincipal(o.audience) : null;
  if (
    principal === null ||
    (principal !== "facilitator" && !principal.startsWith("participant:"))
  )
    throw new ReviewUsageError("--for needs facilitator or participant:<role>");
  const t = exportTarget(subject, principal);
  exportGate(t, await loadReview(o.dir));
  // The audit event comes first (P17): a record of an export that then failed is safer than an export nobody recorded.
  const { loaded } = await applyCommand(o.dir, o.now, (cur) => [
    exportEntry(o, t, exportGate(t, cur), CONSOLE_DESTINATION),
  ]);
  return {
    fileName: t.isIndex ? "report-index.md" : `report-${subject}.md`,
    markdown: exportedMarkdown(t, loaded, o.secrets),
  };
}
