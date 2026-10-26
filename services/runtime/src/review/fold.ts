import { isFileSafeId, isSafeId } from "@acr/events";
import {
  aggregateObjectives,
  INVALID,
  type CriterionScore,
  type LoResult,
} from "../evaluator/aggregate.js";
import type { DraftCriterion, DraftSubject, Drafts } from "./draft.js";
import { ReviewIllegalError } from "./errors.js";
import { releaseProblems } from "./gate.js";
import { sha256 } from "./hash.js";
import { parsePrincipal } from "./policy.js";
import { cpLen, isDirty, isDraftFileName } from "./text.js";
import {
  GROUP,
  LIMITS,
  POLICY_VERSION,
  REVIEW_SCHEMA,
  CARRIED_MODERATION,
  CARRIED_PARTICIPANT,
  type Actor,
  type CurrentLevel,
  type Level,
  type Outcome,
  type ReviewEvent,
  type Summary,
  type Visibility,
} from "./types.js";

export type CriterionView = {
  id: string;
  name: string;
  ai: CurrentLevel;
  current: CurrentLevel;
  needsReview: boolean;
  status: "clear" | "needs_review" | "accepted" | "edited";
  edits: {
    seq: number;
    from: CurrentLevel;
    to: Level;
    reason: string;
    by: string;
  }[];
  rationale: string;
  rationaleEdits: { seq: number; reason: string; by: string }[];
  acceptedBy: string | null;
  self: { level: Level; note?: string; seq: number } | null;
};
export type CommentView = {
  seq: number;
  criterion?: string;
  text: string;
  visibility: Visibility;
  by: string;
};
export type ResponseView = {
  seq: number;
  role: string;
  criterion?: string;
  text: string;
  dispute: boolean;
  /** The released version the response answers (the latest at the time it was made). */
  version: number;
  resolution: {
    seq: number;
    outcome: Outcome;
    reason: string;
    by: string;
  } | null;
};
export type GroupTable = {
  objectives: {
    id: string;
    statement: string;
    byRole: Record<string, LoResult | null>;
    team: LoResult | null;
  }[];
};
export type Snapshot = {
  version: number;
  criteria: CriterionView[];
  summary: Summary | null;
  summaryEdited: boolean;
  /** Who edited or accepted the summary up to this release: frozen, so a later amendment cannot change a released version. */
  summaryBy: string[];
  objectives: LoResult[];
  table: GroupTable | null;
};
export type SubjectView = {
  id: string;
  kind: "participant" | "group";
  evaluationOk: boolean;
  state: "draft" | "released" | "amending" | "withdrawn";
  criteria: CriterionView[];
  summary: Summary | null;
  summaryEdited: boolean;
  summaryStale: boolean;
  /** Facilitators who edited or accepted the summary. */
  summaryBy: string[];
  objectives: LoResult[];
  versions: number[];
  /** The versions released out of an amendment (report.amended, then report.released) in THIS review. */
  amendedVersions: number[];
  snapshot: Snapshot | null;
  comments: CommentView[];
  responses: ResponseView[];
  tableStale: boolean;
  /**
   * The player has seen a released version (here, or in a review this one superseded), so a blind self-rating is no longer
   * possible: self.rated is refused from then on, except for the ratings carried from before that release.
   */
  selfClosed: boolean;
  exports: {
    seq: number;
    version: number;
    principal: string;
    destination: string;
    by: string;
  }[];
};
export type View = {
  opened: Extract<ReviewEvent, { type: "review.opened" }>;
  subjects: Map<string, SubjectView>;
  superseded: string | null;
  lastSeq: number;
};

export const who = (a: Actor): string =>
  a.kind === "facilitator"
    ? a.by
    : a.kind === "participant"
      ? `${a.role} (attested by ${a.attestedBy})`
      : "system";
const levelOf = (c: DraftCriterion): CurrentLevel =>
  c.invalid ? "invalid" : c.score;
const scoreOf = (l: CurrentLevel): CriterionScore =>
  l === "invalid" ? INVALID : l;

function needsReview(c: DraftCriterion, incomplete: Set<string>): boolean {
  if (c.invalid || incomplete.has(c.id)) return true;
  if (c.flags.length > 0 || c.flag_codes.length > 0) return true;
  if (c.score === null) return false; // Not observed with nothing to flag: no score to defend (P6)
  return c.confidence !== "high";
}

function initSubject(d: DraftSubject): SubjectView {
  // a duplicate would shadow its twin in every lookup and block the release forever
  if (new Set(d.criteria.map((c) => c.id)).size !== d.criteria.length)
    throw new ReviewIllegalError(
      `the draft of ${d.id} has a criterion id twice`,
    );
  const incomplete = new Set(
    d.objectives.filter((o) => o.incomplete).flatMap((o) => o.criteria),
  );
  const sv: SubjectView = {
    id: d.id,
    kind: d.kind,
    evaluationOk: d.evaluationOk,
    state: "draft",
    summary: d.summary,
    summaryEdited: false,
    summaryStale: false,
    summaryBy: [],
    objectives: [],
    versions: [],
    amendedVersions: [],
    snapshot: null,
    comments: [],
    responses: [],
    tableStale: false,
    selfClosed: false,
    exports: [],
    criteria: d.criteria.map((c) => {
      const nr = needsReview(c, incomplete);
      return {
        id: c.id,
        name: c.name,
        ai: levelOf(c),
        current: levelOf(c),
        needsReview: nr,
        status: nr ? "needs_review" : "clear",
        edits: [],
        rationale: c.rationale,
        rationaleEdits: [],
        acceptedBy: null,
        self: null,
      };
    }),
  };
  recompute(sv, d);
  return sv;
}

function recompute(sv: SubjectView, d: DraftSubject): void {
  sv.objectives = aggregateObjectives(
    d.objectives.map((o) => ({
      id: o.id,
      statement: o.statement,
      rubric_criteria: o.criteria,
    })),
    new Map(sv.criteria.map((c) => [c.id, scoreOf(c.current)])),
  );
}

export function groupTable(
  drafts: Drafts,
  subjects: Map<string, SubjectView>,
): GroupTable | null {
  const g = drafts.subjects.get(GROUP);
  const cov = (
    g?.raw.lo_coverage as
      { objectives?: { id: string; statement: string }[] } | undefined
  )?.objectives;
  if (!g || !Array.isArray(cov)) return null;
  // loadDrafts checks this; the fold re-checks so it stays total on drafts built any other way
  if (
    !cov.every(
      (o: unknown) =>
        isRec(o) && typeof o.id === "string" && typeof o.statement === "string",
    )
  )
    throw new ReviewIllegalError("the group draft's lo_coverage is invalid");
  const roles = [...subjects.values()].filter((s) => s.kind === "participant");
  const team = subjects.get(GROUP)!;
  return {
    objectives: cov.map((o) => ({
      id: o.id,
      statement: o.statement,
      byRole: Object.fromEntries(
        roles.map((r) => [
          r.id,
          (r.state === "withdrawn"
            ? undefined
            : r.snapshot?.objectives.find((x) => x.id === o.id)) ?? null,
        ]),
      ),
      team: team.objectives.find((x) => x.id === o.id) ?? null,
    })),
  };
}

function takeSnapshot(
  sv: SubjectView,
  version: number,
  table: GroupTable | null,
): Snapshot {
  return {
    version,
    criteria: structuredClone(sv.criteria),
    summary: structuredClone(sv.summary),
    summaryEdited: sv.summaryEdited,
    summaryBy: [...sv.summaryBy],
    objectives: structuredClone(sv.objectives),
    table: structuredClone(table),
  };
}
/**
 * A dispute may be resolved 'amended' only once an amendment PRODUCED a new released version after it (raised during an open
 * amendment, the re-release counts). An amendment still open, or withdrawn before its release, is not an amended report.
 */
export const amendedSince = (sv: SubjectView, responseSeq: number): boolean =>
  // Only releases out of an amendment count, never a position: a carried response has a small seq, and the first release of
  // a re-run comes out of draft, not out of an amendment, so it is not an amended report.
  sv.amendedVersions.some((v) => v > responseSeq);

const isReleased = (sv: SubjectView): boolean =>
  sv.state === "released" || sv.state === "amending";

/** The current state: drafts plus the review log, folded. Pure and total: a view, or ReviewIllegalError. */
const HEX64 = /^[0-9a-f]{64}$/;
const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hexOrNull = (v: unknown): boolean =>
  v === null || (typeof v === "string" && HEX64.test(v));

/** The shape of review.opened, checked before anything is trusted. Messages never echo the payload. */
export function checkOpened(o: Record<string, unknown>): void {
  const bad = (m: string): never => {
    throw new ReviewIllegalError(`review.opened: ${m}`);
  };
  const a = o.actor as Record<string, unknown> | undefined;
  if (!a || a.kind !== "facilitator" || !isSafeId(a.by as string))
    bad("the opener must be a facilitator with a safe id");
  if (o.schema !== REVIEW_SCHEMA) bad("unknown schema");
  if (o.policyVersion !== POLICY_VERSION) bad("unknown policy version");
  if (typeof o.legacy !== "boolean") bad("legacy must be true or false");
  const s = o.session;
  if (
    !isRec(s) ||
    !isSafeId(s.id as string) ||
    !hexOrNull(s.logSha256) ||
    typeof s.startedAt !== "string" ||
    s.startedAt.length > 64
  )
    bad("the session field is invalid");
  const sc = o.scenario;
  if (!isRec(sc) || !isSafeId(sc.id as string) || !hexOrNull(sc.sha256))
    bad("the scenario field is invalid");
  if (o.rubricHash !== null && typeof o.rubricHash !== "string")
    bad("the rubric hash is invalid");
  if (typeof o.rubricHash === "string" && o.rubricHash.length > 128)
    bad("the rubric hash is invalid");
  const f = o.files;
  if (!isRec(f)) bad("files must be an object");
  const names = Object.entries(f as Record<string, unknown>);
  if (names.length === 0 || names.length > 200) bad("files has a bad size");
  for (const [n, h] of names) {
    if (!isDraftFileName(n)) bad("a file name is not safe");
    if (typeof h !== "string" || !HEX64.test(h)) bad("a file hash is invalid");
  }
  const c = o.codes;
  if (c !== null && !isRec(c)) bad("codes must be an object or null");
  const closed = o.selfClosed;
  if (
    closed !== undefined &&
    (!Array.isArray(closed) ||
      closed.length > 200 ||
      !closed.every((r) => isFileSafeId(r as string)) ||
      new Set(closed).size !== closed.length)
  )
    bad("selfClosed must be a list of player ids");
}

/** An actor as the log may hold it: a facilitator with a safe id, a participant role attested by one, or the system. */
function actorOk(a: unknown): boolean {
  if (!isRec(a)) return false;
  if (a.kind === "facilitator") return isSafeId(a.by as string);
  if (a.kind === "participant")
    return isFileSafeId(a.role as string) && isSafeId(a.attestedBy as string);
  return a.kind === "system";
}

export function currentView(drafts: Drafts, events: ReviewEvent[]): View {
  const first = events[0];
  if (!first || first.type !== "review.opened")
    throw new ReviewIllegalError("the log does not start with review.opened");
  checkOpened(first as unknown as Record<string, unknown>);
  const ill = (e: ReviewEvent, m: string): never => {
    throw new ReviewIllegalError(
      `event ${typeof e.seq === "number" ? e.seq : "?"} (${typeof e.type === "string" ? e.type.slice(0, 40) : "?"}): ${m}`,
    );
  };
  const subjects = new Map<string, SubjectView>(
    [...drafts.subjects.values()].map((d) => [d.id, initSubject(d)]),
  );
  const subj = (e: ReviewEvent, id: unknown): SubjectView =>
    (typeof id === "string" ? subjects.get(id) : undefined) ??
    ill(e, "unknown subject");
  const crit = (e: ReviewEvent, sv: SubjectView, id: unknown): CriterionView =>
    (typeof id === "string"
      ? sv.criteria.find((c) => c.id === id)
      : undefined) ?? ill(e, "unknown criterion");
  const editable = (e: ReviewEvent, sv: SubjectView): void => {
    if (sv.state === "released" || sv.state === "withdrawn")
      ill(e, `${sv.id} is ${sv.state}; amend it first`);
  };
  const facilitator = (e: ReviewEvent): string =>
    e.actor.kind === "facilitator"
      ? e.actor.by
      : ill(e, "only a facilitator can do this");
  const reason = (e: ReviewEvent, r: unknown): string =>
    typeof r === "string" && cpLen(r) >= 1 && cpLen(r) <= LIMITS.reason
      ? r
      : ill(e, "a reason of 1 to 500 characters is required");
  const text = (e: ReviewEvent, t: unknown): string =>
    typeof t === "string" && cpLen(t) >= 1 && cpLen(t) <= LIMITS.text
      ? t
      : ill(e, "text of 1 to 1,500 characters is required");
  const items = (e: ReviewEvent, v: unknown): string[] =>
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every(
      (x) => typeof x === "string" && cpLen(x) >= 1 && cpLen(x) <= LIMITS.item,
    )
      ? (v as string[])
      : ill(e, "a summary list is invalid");
  const summary = (e: ReviewEvent, v: unknown): Summary => {
    const s = v as Record<string, unknown> | null;
    if (typeof s !== "object" || s === null || Array.isArray(s))
      return ill(e, "the summary is not an object");
    const na = s.next_actions;
    if (
      !Array.isArray(na) ||
      na.length > 50 ||
      !na.every(
        (a) =>
          typeof a === "object" &&
          a !== null &&
          typeof (a as { lo?: unknown }).lo === "string" &&
          typeof (a as { action?: unknown }).action === "string" &&
          cpLen((a as { lo: string }).lo) >= 1 &&
          cpLen((a as { lo: string }).lo) <= LIMITS.item &&
          cpLen((a as { action: string }).action) >= 1 &&
          cpLen((a as { action: string }).action) <= LIMITS.item,
      )
    )
      return ill(e, "the summary next actions are invalid");
    return {
      strengths: items(e, s.strengths),
      development_points: items(e, s.development_points),
      next_actions: (na as { lo: string; action: string }[]).map((a) => ({
        lo: a.lo,
        action: a.action,
      })),
    };
  };
  // players whose self-rating a superseded review already closed (each must be a player of these drafts)
  for (const r of first.selfClosed ?? []) {
    const sv = subjects.get(r);
    if (sv?.kind !== "participant")
      throw new ReviewIllegalError(
        "review.opened: selfClosed names a subject that is not a player",
      );
    sv.selfClosed = true;
  }
  let superseded: string | null = null;
  /** Copies written by supersede come directly after the opener; once anything else is logged, nothing more is carried. */
  let carrying = true;
  let expected = 1;
  /** Participant-attested events: the actor is the subject's own role, vouched for by a facilitator. */
  const attested = (e: ReviewEvent, role: unknown): void => {
    const a = e.actor;
    if (
      a.kind !== "participant" ||
      typeof role !== "string" ||
      a.role !== role ||
      typeof a.attestedBy !== "string" ||
      !isSafeId(a.attestedBy)
    )
      ill(e, "this is made by the participant and attested by the facilitator");
  };

  for (const e of events) {
    if (e.seq !== expected) ill(e, `expected seq ${expected}`);
    expected++;
    if (e.type === "review.opened") {
      if (e.seq !== 1) ill(e, "review.opened can only be the first event");
      continue;
    }
    if (superseded !== null)
      ill(e, "the review was superseded and is read-only");
    // Every actor, not only the opener's: the log on disk is untrusted, and `by` is rendered and compared later.
    if (!actorOk(e.actor)) ill(e, "the actor is not valid");
    const carried = e.carriedFrom !== undefined;
    if (carried) {
      if (!carrying) ill(e, "a carried event must directly follow the opener");
      if (!isSafeId(e.carriedFrom as string))
        ill(e, "carriedFrom must be a directory name");
      if (!CARRIED_MODERATION.has(e.type) && !CARRIED_PARTICIPANT.has(e.type))
        ill(e, "this event type is never carried");
    } else carrying = false;
    switch (e.type) {
      case "score.edited": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        const c = crit(e, sv, e.criterion);
        editable(e, sv);
        if (e.from !== c.current)
          ill(e, "from does not match the current level");
        if (e.to === c.current) ill(e, "the level is unchanged");
        if (!(
          e.to === null ||
          e.to === 1 ||
          e.to === 2 ||
          e.to === 3 ||
          e.to === 4
        ))
          ill(e, "to is not a level");
        c.edits.push({
          seq: e.seq,
          from: c.current,
          to: e.to,
          reason: reason(e, e.reason),
          by,
        });
        c.current = e.to;
        c.status = "edited";
        if (sv.summary !== null) sv.summaryStale = true;
        recompute(sv, drafts.subjects.get(sv.id)!);
        // No tableStale here: the group's frozen table reads player SNAPSHOTS only, so an edit changes it only once
        // that player is released (or withdrawn), which is where the flag is set.
        break;
      }
      case "rationale.edited": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        const c = crit(e, sv, e.criterion);
        editable(e, sv);
        if (sha256(c.rationale) !== e.fromHash)
          ill(e, "the rationale changed since it was read");
        c.rationaleEdits.push({ seq: e.seq, reason: reason(e, e.reason), by });
        c.rationale = text(e, e.text);
        break;
      }
      case "summary.edited": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        editable(e, sv);
        if (sv.summary === null) ill(e, "this subject has no summary");
        reason(e, e.reason);
        sv.summary = summary(e, e.summary);
        if (!sv.summaryBy.includes(by)) sv.summaryBy.push(by);
        sv.summaryEdited = true;
        sv.summaryStale = false;
        break;
      }
      case "summary.accepted": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        editable(e, sv);
        if (sv.summary === null) ill(e, "this subject has no summary");
        if (!sv.summaryBy.includes(by)) sv.summaryBy.push(by);
        sv.summaryStale = false;
        break;
      }
      case "score.accepted": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        const c = crit(e, sv, e.criterion);
        editable(e, sv);
        if (c.status === "accepted" || c.status === "edited")
          ill(e, `${c.id} is already ${c.status}`);
        c.status = "accepted";
        c.acceptedBy = by;
        break;
      }
      case "comment.added": {
        facilitator(e);
        const sv = subj(e, e.subject);
        if (e.criterion !== undefined) crit(e, sv, e.criterion);
        if (e.visibility !== "internal" && e.visibility !== "feedback")
          ill(e, "visibility must be internal or feedback");
        sv.comments.push({
          seq: e.seq,
          ...(e.criterion !== undefined ? { criterion: e.criterion } : {}),
          text: text(e, e.text),
          visibility: e.visibility,
          by: who(e.actor),
        });
        break;
      }
      case "review.superseded":
        facilitator(e);
        // the replacement directory's basename, as supersedeReview writes it
        if (!isSafeId(e.by))
          ill(
            e,
            "by must be a directory name of 1 to 64 letters, digits, _ or -",
          );
        superseded = e.by;
        break;
      case "report.released": {
        facilitator(e);
        if (
          !Array.isArray(e.subjects) ||
          e.subjects.length === 0 ||
          e.subjects.length > 50 ||
          new Set(e.subjects).size !== e.subjects.length
        )
          ill(e, "name each subject to release once");
        const svs = e.subjects.map((id) => subj(e, id));
        for (const sv of svs) {
          if (sv.state !== "draft" && sv.state !== "amending")
            ill(e, `${sv.id} is ${sv.state}`);
          const problems = releaseProblems(sv);
          if (problems.length)
            ill(e, `${sv.id} cannot be released: ${problems.join("; ")}`);
        }
        // Order matters: (1) mark released and clear the group's tableStale, (2) snapshot the players,
        // (3) only then build the group table from those snapshots, so it sees the players released in this event.
        const g = subjects.get(GROUP);
        for (const sv of svs) {
          if (sv.state === "amending") sv.amendedVersions.push(e.seq);
          sv.state = "released";
          sv.versions.push(e.seq);
          sv.selfClosed = true;
          if (sv.kind === "group") sv.tableStale = false;
        }
        // a player released alone after the group: the group's frozen table lacks this release
        if (g && g.versions.length > 0 && !svs.includes(g))
          if (svs.some((sv) => sv.kind === "participant")) g.tableStale = true;
        // players first, so a group released with them tabulates their just-released snapshots
        for (const sv of svs.filter((x) => x.kind !== "group"))
          sv.snapshot = takeSnapshot(sv, e.seq, null);
        for (const sv of svs.filter((x) => x.kind === "group"))
          sv.snapshot = takeSnapshot(sv, e.seq, groupTable(drafts, subjects));
        break;
      }
      case "report.amended": {
        facilitator(e);
        const sv = subj(e, e.subject);
        reason(e, e.reason);
        if (sv.state !== "released")
          ill(
            e,
            `${sv.id} is ${sv.state}; only a released report can be amended`,
          );
        if (e.basedOn !== sv.versions.at(-1))
          ill(e, "basedOn is not the current version of the report");
        sv.state = "amending";
        break;
      }
      case "report.withdrawn": {
        facilitator(e);
        const sv = subj(e, e.subject);
        reason(e, e.reason);
        if (!isReleased(sv))
          ill(
            e,
            `${sv.id} is ${sv.state}; only a released report can be withdrawn`,
          );
        sv.state = "withdrawn";
        // the group's frozen table still holds this player's row
        {
          const g = subjects.get(GROUP);
          if (sv.kind === "participant" && g && g.versions.length > 0)
            g.tableStale = true;
        }
        break;
      }
      case "report.exported": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        // An amending subject still has its last released snapshot, which participants keep seeing (P12): that is exportable.
        const exportable =
          sv.state === "released" ||
          (sv.state === "amending" && sv.versions.length > 0);
        if (!exportable)
          ill(e, `${sv.id} is ${sv.state}; only a released report is exported`);
        if (typeof e.version !== "number" || !sv.versions.includes(e.version))
          ill(e, "that version does not exist");
        // an export always writes the latest released snapshot, so a record of an older version cannot be produced
        if (e.version !== sv.versions.at(-1))
          ill(e, "that version is not the current released version");
        const short = (v: unknown): v is string =>
          typeof v === "string" && cpLen(v) >= 1 && cpLen(v) <= 64;
        if (!short(e.principal) || !short(e.destination))
          ill(e, "principal and destination need 1 to 64 characters");
        if (isDirty(e.destination))
          ill(e, "the destination contains control characters");
        // Principal grammar: facilitator | participant:<file-safe role id> naming a participant subject of this review.
        const pr = parsePrincipal(e.principal);
        const role = e.principal.startsWith("participant:")
          ? e.principal.slice("participant:".length)
          : null;
        if (
          pr === null ||
          (pr !== "facilitator" &&
            (role === null || subjects.get(role)?.kind !== "participant"))
        )
          ill(e, "the export principal is not valid for this review");
        // A facilitator export needs a released subject; a participant's personal export is of their own report only.
        if (pr === "facilitator" && sv.state !== "released")
          ill(e, "the export principal is not valid for this review");
        if (role !== null && sv.id !== GROUP && sv.id !== role)
          ill(e, "the export principal is not valid for this review");
        sv.exports.push({
          seq: e.seq,
          version: e.version,
          principal: e.principal,
          destination: e.destination,
          by,
        });
        break;
      }
      case "self.rated": {
        attested(e, e.role);
        const sv = subj(e, e.role);
        if (sv.kind !== "participant") ill(e, "only players rate themselves");
        // A rating carried from before a release in the superseded review stays; a new one after any release never.
        if (
          sv.versions.length > 0 ||
          sv.state !== "draft" ||
          (!carried && sv.selfClosed)
        )
          ill(e, `${sv.id}'s report was released; self-rating is closed`);
        const c = crit(e, sv, e.criterion);
        if (!(
          e.level === null ||
          e.level === 1 ||
          e.level === 2 ||
          e.level === 3 ||
          e.level === 4
        ))
          ill(e, "level must be 1 to 4 or not observed");
        c.self = {
          level: e.level,
          ...(e.note !== undefined ? { note: text(e, e.note) } : {}),
          seq: e.seq,
        };
        break;
      }
      case "response.added": {
        attested(e, e.role);
        const sv = subj(e, e.role);
        if (sv.kind !== "participant") ill(e, "only players respond");
        let ver: number;
        if (carried) {
          // answered a version of the superseded review; the player wrote it, so carrying it shows nothing new
          if (!Number.isSafeInteger(e.version) || (e.version as number) < 1)
            ill(e, "a carried response needs the version it answered");
          ver = e.version as number;
        } else {
          if (e.version !== undefined)
            ill(e, "a response's version is set by the log");
          const version = sv.versions.at(-1);
          ver =
            version === undefined || sv.state === "withdrawn"
              ? ill(e, `${sv.id}'s report is not released`)
              : version;
        }
        if (e.criterion !== undefined) crit(e, sv, e.criterion);
        if (e.dispute !== undefined && typeof e.dispute !== "boolean")
          ill(e, "dispute must be true or false");
        if (sv.responses.length >= LIMITS.responses)
          ill(e, `too many responses for ${sv.id}`);
        sv.responses.push({
          seq: e.seq,
          role: e.role,
          ...(e.criterion !== undefined ? { criterion: e.criterion } : {}),
          text: text(e, e.text),
          dispute: e.dispute === true,
          version: ver,
          resolution: null,
        });
        break;
      }
      case "dispute.resolved": {
        const by = facilitator(e);
        const found = [...subjects.values()]
          .flatMap((sv) => sv.responses.map((r) => ({ sv, r })))
          .find((x) => x.r.seq === e.response);
        if (!found) return ill(e, "no such response");
        if (!found.r.dispute) ill(e, "that response is not a dispute");
        if (found.r.resolution) ill(e, "that dispute is already resolved");
        if (
          e.outcome !== "upheld" &&
          e.outcome !== "amended" &&
          e.outcome !== "declined"
        )
          ill(e, "outcome must be upheld, amended or declined");
        // a carried 'amended' was checked in the superseded review, against versions this log does not hold
        if (
          e.outcome === "amended" &&
          !carried &&
          !amendedSince(found.sv, found.r.seq)
        )
          ill(
            e,
            "amend the report and release the new version first, then resolve the dispute as amended",
          );
        found.r.resolution = {
          seq: e.seq,
          outcome: e.outcome,
          reason: reason(e, e.reason),
          by,
        };
        break;
      }
      default:
        ill(e, "this event type is not supported yet");
    }
  }
  return { opened: first, subjects, superseded, lastSeq: expected - 1 };
}
