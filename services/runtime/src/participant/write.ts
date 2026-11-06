/**
 * The participant writes (EPIC-0002, slice 2c-2): self-ratings before release and responses after it. Text is cleaned BEFORE the
 * lock (an empty or all-hidden note means "no note"; empty or over-long response text is `invalid`). One `applyCommand` build per
 * call runs synchronously under the lock and sets a closure `outcome` for every refusal, returning no entries: a release that
 * lands between the caller's earlier read and the lock is therefore `closed`, never `unavailable`. Only a held review lock is
 * `busy`; any other thrown error is `unavailable`. No result carries a path, an id or a message.
 */
import { isFileSafeId } from "@acr/events";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { reviewStatus } from "../reports/index.js";
import { ReviewBusyError } from "../review/errors.js";
import { applyCommand, type Loaded } from "../review/store.js";
import { cleanText } from "../review/text.js";
import { LIMITS, REVIEW_SCHEMA, type Entry } from "../review/types.js";
import type {
  RatingInput,
  ResponseInput,
  ResponseResult,
  SelfRatingResult,
  SubmitCtx,
} from "./types.js";

type Refusal =
  | "closed"
  | "not_released"
  | "withdrawn"
  | "too_many"
  | "invalid"
  | "old_schema"
  | "none";
type Outcome = { k: "ok"; wrote: number } | { k: Refusal };

/** The live review dir for a valid session id and role, else null (the caller answers `none`/`unavailable`). */
async function locate(
  c: SubmitCtx,
): Promise<{ dir: string } | "none" | "unavailable"> {
  if (typeof c.role !== "string" || !isFileSafeId(c.role)) return "none";
  const st = await reviewStatus(c.reportsDir, c.sessionId);
  if (st.kind === "found") return { dir: st.dir };
  return st.kind;
}

const actorOf = (c: SubmitCtx) =>
  ({
    kind: "participant_session",
    v: 1,
    role: c.role,
    credentialId: c.credentialId,
  }) as const;

/** True only when the note is empty after stripping hidden characters and scrubbing; any other cleanText failure is over-length. */
const emptyNote = (raw: string, secrets: string[]): boolean =>
  scrubText(
    stripHidden(String(raw)).replace(/\r\n?/g, "\n").trim(),
    secrets,
  ).trim().length === 0;

/** The subject for this role in a live /2 review, or the refusal that applies. */
function subjectOf(l: Loaded, role: string) {
  if (l.view.opened.schema !== REVIEW_SCHEMA) return "old_schema" as const;
  if (l.view.superseded !== null) return "none" as const;
  const sv = l.view.subjects.get(role);
  if (!sv || sv.kind !== "participant") return "none" as const;
  return sv;
}

function mapError(e: unknown): { kind: "busy" } | { kind: "unavailable" } {
  return e instanceof ReviewBusyError
    ? { kind: "busy" }
    : { kind: "unavailable" };
}

export async function submitSelfRatings(
  c: SubmitCtx & { ratings: RatingInput[] },
): Promise<SelfRatingResult> {
  try {
    if (!Array.isArray(c.ratings) || c.ratings.length === 0)
      return { kind: "invalid" };
    const seen = new Set<string>();
    const wanted: {
      criterion: string;
      level: RatingInput["level"];
      note?: string;
    }[] = [];
    for (const r of c.ratings) {
      if (
        !r ||
        typeof r.criterion !== "string" ||
        seen.has(r.criterion) ||
        !(r.level === null || [1, 2, 3, 4].includes(r.level as number)) ||
        (r.note !== undefined && typeof r.note !== "string")
      )
        return { kind: "invalid" };
      seen.add(r.criterion);
      let note: string | undefined;
      if (r.note !== undefined) {
        try {
          note = cleanText(r.note, LIMITS.text, "note", c.secrets);
        } catch {
          if (!emptyNote(r.note, c.secrets)) return { kind: "invalid" };
          note = undefined; // empty or all-hidden: no note
        }
      }
      wanted.push({
        criterion: r.criterion,
        level: r.level,
        ...(note !== undefined ? { note } : {}),
      });
    }
    const where = await locate(c);
    if (typeof where === "string") return { kind: where };
    let outcome = { k: "none" } as Outcome;
    await applyCommand(where.dir, c.now, (l) => {
      const sv = subjectOf(l, c.role);
      if (typeof sv === "string") {
        outcome = { k: sv };
        return [];
      }
      if (sv.state !== "draft" || sv.versions.length > 0 || sv.selfClosed) {
        outcome = { k: "closed" };
        return [];
      }
      const changed: typeof wanted = [];
      for (const w of wanted) {
        const cr = sv.criteria.find((k) => k.id === w.criterion);
        if (!cr) {
          outcome = { k: "invalid" };
          return [];
        }
        if (!cr.self || cr.self.level !== w.level || cr.self.note !== w.note)
          changed.push(w);
      }
      const have = l.events.filter(
        (e) => e.type === "self.rated" && e.role === c.role,
      ).length;
      if (changed.length > 0 && have + changed.length > 10 * sv.criteria.length) {
        outcome = { k: "too_many" };
        return [];
      }
      outcome = { k: "ok", wrote: changed.length };
      return changed.map((w): Entry => ({
        actor: actorOf(c),
        body: {
          type: "self.rated",
          role: c.role,
          criterion: w.criterion,
          level: w.level,
          ...(w.note !== undefined ? { note: w.note } : {}),
        },
      }));
    });
    if (outcome.k === "ok") return { kind: "ok", wrote: outcome.wrote };
    if (outcome.k === "not_released" || outcome.k === "withdrawn")
      return { kind: "closed" };
    return { kind: outcome.k };
  } catch (e) {
    return mapError(e);
  }
}

export async function submitResponse(
  c: SubmitCtx & ResponseInput,
): Promise<ResponseResult> {
  try {
    if (
      typeof c.text !== "string" ||
      (c.criterion !== undefined && typeof c.criterion !== "string")
    )
      return { kind: "invalid" };
    let text: string;
    try {
      text = cleanText(c.text, LIMITS.text, "text", c.secrets);
    } catch {
      return { kind: "invalid" };
    }
    const dispute = c.dispute === true;
    const where = await locate(c);
    if (typeof where === "string") return { kind: where };
    let outcome = { k: "none" } as Outcome;
    await applyCommand(where.dir, c.now, (l) => {
      const sv = subjectOf(l, c.role);
      if (typeof sv === "string") {
        outcome = { k: sv };
        return [];
      }
      if (sv.state === "draft") {
        outcome = { k: "not_released" };
        return [];
      }
      if (sv.state === "withdrawn") {
        outcome = { k: "withdrawn" };
        return [];
      }
      if (
        c.criterion !== undefined &&
        !sv.criteria.some((k) => k.id === c.criterion)
      ) {
        outcome = { k: "invalid" };
        return [];
      }
      const last = sv.responses.at(-1);
      if (
        last &&
        last.criterion === c.criterion &&
        last.text === text &&
        last.dispute === dispute
      ) {
        outcome = { k: "ok", wrote: 0 };
        return [];
      }
      if (sv.responses.length >= LIMITS.responses) {
        outcome = { k: "too_many" };
        return [];
      }
      outcome = { k: "ok", wrote: 1 };
      return [
        {
          actor: actorOf(c),
          body: {
            type: "response.added",
            role: c.role,
            ...(c.criterion !== undefined ? { criterion: c.criterion } : {}),
            text,
            ...(dispute ? { dispute: true } : {}),
          },
        },
      ];
    });
    if (outcome.k === "ok") return { kind: "ok", wrote: outcome.wrote > 0 };
    if (outcome.k === "closed") return { kind: "none" };
    return { kind: outcome.k };
  } catch (e) {
    return mapError(e);
  }
}
