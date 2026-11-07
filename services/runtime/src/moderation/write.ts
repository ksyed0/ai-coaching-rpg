/**
 * Moderation writes, part A (EPIC-0002, slice 2c-3): open, edit, accept, comment and edit-summary, moved out of the `pnpm moderate`
 * handlers so the control service runs the same gate rules and hash chain in-process. Each builds exactly the entries the CLI built,
 * under the review lock (`applyCommand`). Free text is cleaned here with the CLI's limits, in the CLI's order; `by` must already be
 * a clean safe id (the store refuses anything else). Errors are thrown as the review layer's, messages unchanged, so the CLI prints
 * today's text; the control service wraps calls in `toModResult`.
 */
import { isSafeId } from "@acr/events";
import { loadDrafts } from "../review/draft.js";
import { need, shownName } from "../review/cli-util.js";
import { ReviewRefusedError, ReviewUsageError } from "../review/errors.js";
import { sha256 } from "../review/hash.js";
import {
  applyCommand,
  openReview,
  readCodesRecord,
  type Loaded,
} from "../review/store.js";
import { cleanText, isDraftFileName } from "../review/text.js";
import {
  LIMITS,
  type Actor,
  type CurrentLevel,
  type Entry,
  type Level,
} from "../review/types.js";
import type { Base, ExpectLevel } from "./types.js";

const EXPECTS: readonly string[] = ["1", "2", "3", "4", "na", "invalid"];
const lvl = (l: unknown): string => (l === null ? "na" : String(l));
const shown = (c: CurrentLevel): string =>
  c === "invalid" ? "invalid" : lvl(c);
const actorOf = (o: { by: string }): Actor => ({
  kind: "facilitator",
  by: o.by,
});

export type OpenInput = {
  dir: string;
  by: string;
  now: () => number;
  sessionLogText?: string;
  codesDir: string;
};

/** `open`, returning the loaded review (the CLI prints the session id and the legacy note from it). */
export async function openReviewLoaded(o: OpenInput): Promise<Loaded> {
  const d = await loadDrafts(o.dir);
  // openReview would refuse a stray file with an unnamed message; name it (sanitised, bounded) so the facilitator can act.
  for (const name of Object.keys(d.files)) {
    if (!isDraftFileName(name))
      throw new ReviewRefusedError(
        `${shownName(name)} is not a generated report file; move it out of the reports directory and run open again`,
      );
  }
  const codes = await readCodesRecord(o.codesDir, d.sessionId);
  return openReview(o.dir, {
    by: o.by,
    now: o.now,
    ...(o.sessionLogText !== undefined
      ? { sessionLogText: o.sessionLogText }
      : {}),
    codes,
  });
}

/** Opens the review of a draft directory, bound to its files, the session log text (when given) and the join-code record. */
export async function openFacilitatorReview(
  o: OpenInput,
): Promise<{ subjects: number }> {
  const l = await openReviewLoaded(o);
  return { subjects: l.view.subjects.size };
}

/** Sets a criterion's level (and optionally its rationale). With `expect`, refused (`stale`) unless the level is still that one. */
export async function editScore(
  o: Base & {
    subject: string;
    criterion: string;
    level: Level;
    reason: string;
    rationale?: string;
    expect?: ExpectLevel;
  },
): Promise<void> {
  const { subject, criterion, expect } = o;
  const to = o.level;
  if (!(to === null || to === 1 || to === 2 || to === 3 || to === 4))
    throw new ReviewUsageError("--level needs 1, 2, 3, 4 or na (not observed)");
  const reason = cleanText(
    String(o.reason ?? ""),
    LIMITS.reason,
    "--reason",
    o.secrets,
  );
  const rationale =
    typeof o.rationale === "string"
      ? cleanText(o.rationale, LIMITS.text, "--rationale", o.secrets)
      : undefined;
  if (expect !== undefined && !EXPECTS.includes(expect))
    throw new ReviewUsageError("--expect needs 1, 2, 3, 4, na or invalid");
  const actor = actorOf(o);
  await applyCommand(o.dir, o.now, (l) => {
    const sv = need(l.view.subjects.get(subject), "subject");
    const cv = need(
      sv.criteria.find((x) => x.id === criterion),
      "criterion",
    );
    if (expect !== undefined && expect !== shown(cv.current))
      throw new ReviewRefusedError(
        `${criterion} is currently ${shown(cv.current)}, not ${expect}; nothing was changed`,
        "stale",
      );
    const entries: Entry[] = [
      {
        actor,
        body: {
          type: "score.edited",
          subject,
          criterion,
          from: cv.current,
          to,
          reason,
        },
      },
    ];
    if (rationale !== undefined)
      entries.push({
        actor,
        body: {
          type: "rationale.edited",
          subject,
          criterion,
          fromHash: sha256(cv.rationale),
          text: rationale,
          reason,
        },
      });
    return entries;
  });
}

/** Accepts the AI draft's level of one criterion. */
export async function acceptCriterion(
  o: Base & { subject: string; criterion: string },
): Promise<void> {
  const actor = actorOf(o);
  await applyCommand(o.dir, o.now, () => [
    {
      actor,
      body: {
        type: "score.accepted",
        subject: o.subject,
        criterion: o.criterion,
      },
    },
  ]);
}

/** Accepts the subject's summary as it stands (clears "may be out of date"). */
export async function acceptSummary(
  o: Base & { subject: string },
): Promise<void> {
  const actor = actorOf(o);
  await applyCommand(o.dir, o.now, () => [
    { actor, body: { type: "summary.accepted", subject: o.subject } },
  ]);
}

/** Adds a comment: internal by default, or feedback the participant sees once the report is released. */
export async function commentOn(
  o: Base & {
    subject: string;
    text: string;
    criterion?: string;
    feedback?: boolean;
  },
): Promise<void> {
  const actor = actorOf(o);
  const text = cleanText(
    String(o.text ?? ""),
    LIMITS.text,
    "--text",
    o.secrets,
  );
  const { subject, criterion } = o;
  await applyCommand(o.dir, o.now, () => [
    {
      actor,
      body: {
        type: "comment.added",
        subject,
        ...(criterion !== undefined ? { criterion } : {}),
        text,
        visibility: o.feedback === true ? "feedback" : "internal",
      },
    },
  ]);
}

/**
 * Replaces the whole summary. An action whose `lo` is empty is refused as `--action needs <lo>:<text>` (the CLI passes an empty
 * `lo` for an argument without one, so the refusal comes at the same point as before); `lo` is trimmed and must be one of the
 * report's learning objectives.
 */
export async function editSummary(
  o: Base & {
    subject: string;
    reason: string;
    strengths?: string[];
    developments?: string[];
    actions?: { lo: string; text: string }[];
  },
): Promise<void> {
  const actor = actorOf(o);
  const { subject } = o;
  const reason = cleanText(
    String(o.reason ?? ""),
    LIMITS.reason,
    "--reason",
    o.secrets,
  );
  const items = (v: unknown, what: string): string[] =>
    (Array.isArray(v) ? v : []).map((t) =>
      cleanText(String(t), LIMITS.item, what, o.secrets),
    );
  const summary = {
    strengths: items(o.strengths, "--strength"),
    development_points: items(o.developments, "--development"),
    // the 400-character cap applies to the action text, not to the `LO:` prefix plus the text
    next_actions: (Array.isArray(o.actions) ? o.actions : []).map((a) => {
      const lo = typeof a?.lo === "string" ? a.lo : "";
      if (lo.length < 1)
        throw new ReviewUsageError("--action needs <lo>:<text>");
      return {
        lo: lo.trim(),
        action: cleanText(
          String(a.text ?? ""),
          LIMITS.item,
          "--action",
          o.secrets,
        ),
      };
    }),
  };
  if (
    !summary.strengths.length &&
    !summary.development_points.length &&
    !summary.next_actions.length
  )
    throw new ReviewUsageError(
      "edit-summary needs at least one --strength, --development or --action; it replaces the whole summary",
    );
  await applyCommand(o.dir, o.now, (l) => {
    const known = l.drafts.subjects.get(subject)?.objectives ?? [];
    for (const a of summary.next_actions)
      if (
        !isSafeId(a.lo) ||
        (known.length && !known.some((x) => x.id === a.lo))
      )
        throw new ReviewUsageError(
          "--action needs the id of one of the report's learning objectives before the colon",
        );
    return [
      { actor, body: { type: "summary.edited", subject, summary, reason } },
    ];
  });
}
