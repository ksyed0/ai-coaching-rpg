import { readdir } from "node:fs/promises";
import path from "node:path";
import { isFileSafeId, isSafeId } from "@acr/events";
import { JoinCodes } from "../engine/join-codes.js";
import {
  MAX_CODES_FILE_BYTES,
  codesFileName,
} from "../engine/join-code-file.js";
import { readRegularCapped } from "../util/read-regular.js";
import { loadDrafts, type Drafts } from "./draft.js";
import {
  ReviewCorruptError,
  ReviewIllegalError,
  ReviewRefusedError,
} from "./errors.js";
import { sha256 } from "./hash.js";
import { checkOpened, currentView, type View } from "./fold.js";
import {
  readReview,
  sealEntries,
  withReviewLock,
  writeEvents,
} from "./review-log.js";
import {
  LIMITS,
  POLICY_VERSION,
  REVIEW_SCHEMA,
  ZERO_HASH,
  type Body,
  type Entry,
  type ReviewEvent,
} from "./types.js";

export type Loaded = {
  dir: string;
  drafts: Drafts;
  events: ReviewEvent[];
  tailHash: string;
  view: View;
};
export type OpenMeta = {
  by: string;
  now: () => number;
  sessionLogText?: string;
  codes?: Record<string, unknown> | null;
};

function fold(
  drafts: Drafts,
  events: ReviewEvent[],
  onIllegal: (m: string) => Error,
  malformedIsCorrupt = false,
): View {
  try {
    return currentView(drafts, events);
  } catch (e) {
    if (e instanceof ReviewIllegalError) throw onIllegal(e.message);
    // events already on disk that make the fold throw a TypeError are damage, not a bug in the caller
    if (malformedIsCorrupt && e instanceof TypeError)
      throw new ReviewCorruptError(
        "the review log is not valid: malformed event",
      );
    throw e;
  }
}

function checkActor(a: Entry["actor"]): void {
  const ok =
    a.kind === "system" ||
    (a.kind === "facilitator" && isSafeId(a.by)) ||
    (a.kind === "participant" &&
      isFileSafeId(a.role) &&
      isSafeId(a.attestedBy));
  if (!ok)
    throw new ReviewRefusedError("the actor on this command is not valid");
}

/** Reads the log, verifies every recorded draft file hash, folds. Throws ReviewRefusedError when no review is open, ReviewCorruptError for any damage. */
export async function loadReview(dir: string): Promise<Loaded> {
  const { events, tailHash } = await readReview(dir);
  const opened = events[0];
  if (!opened)
    throw new ReviewRefusedError(
      "no review is open here; run `pnpm moderate open <reports-dir> --by <name>` first",
    );
  if (opened.type !== "review.opened")
    throw new ReviewCorruptError(
      "review.jsonl does not start with review.opened",
    );
  try {
    checkOpened(opened as unknown as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ReviewIllegalError)
      throw new ReviewCorruptError(`the review log is not valid: ${e.message}`);
    throw e;
  }
  const drafts = await loadDrafts(dir, new Set(Object.keys(opened.files)));
  for (const [name, hash] of Object.entries(opened.files)) {
    if (drafts.files[name] === undefined)
      throw new ReviewCorruptError(
        `the draft file ${name} is missing; the review is bound to the files it opened with`,
      );
    if (drafts.files[name] !== hash)
      throw new ReviewCorruptError(
        `the draft file ${name} changed after the review was opened`,
      );
  }
  const view = fold(
    drafts,
    events,
    (m) => new ReviewCorruptError(`the review log is not valid: ${m}`),
    true,
  );
  return { dir, drafts, events, tailHash, view };
}

/** The one write path: lock, load and verify, build entries from the current view, validate them by folding, then append in one write. */
export async function applyCommand(
  dir: string,
  now: () => number,
  build: (l: Loaded) => Entry[],
): Promise<{ loaded: Loaded; appended: ReviewEvent[] }> {
  return withReviewLock(dir, async () => {
    const loaded = await loadReview(dir);
    const entries = build(loaded);
    for (const en of entries) checkActor(en.actor);
    if (entries.length === 0) return { loaded, appended: [] };
    if (loaded.events.length + entries.length > LIMITS.events)
      throw new ReviewRefusedError("this review has reached its event limit");
    const sealed = sealEntries(loaded.events, loaded.tailHash, entries, now);
    const view = fold(
      loaded.drafts,
      [...loaded.events, ...sealed],
      (m) => new ReviewRefusedError(m),
    );
    await writeEvents(dir, sealed);
    return {
      loaded: {
        ...loaded,
        events: [...loaded.events, ...sealed],
        tailHash: sha256(JSON.stringify(sealed.at(-1))),
        view,
      },
      appended: sealed,
    };
  });
}

/** Opens the review on a draft directory: binds it to the files, the session instance and the join-code record as they are now. */
export async function openReview(dir: string, meta: OpenMeta): Promise<Loaded> {
  return withReviewLock(dir, async () => {
    const existing = await readReview(dir);
    if (existing.events.length > 0)
      throw new ReviewRefusedError("a review is already open here");
    const released = await siblingReleased(dir);
    if (released !== null)
      throw new ReviewRefusedError(
        `an earlier evaluation of this session (${released}) was already released; use \`pnpm moderate supersede <old> <new>\` to move on`,
      );
    if (!isSafeId(meta.by))
      throw new ReviewRefusedError(
        "--by must be 1 to 64 letters, digits, _ or -",
      );
    const drafts = await loadDrafts(dir);
    const codes = meta.codes ?? null;
    if (codes !== null) {
      if (codes.sessionId !== drafts.sessionId)
        throw new ReviewRefusedError(
          "the join codes record belongs to another session",
        );
      if (
        typeof codes.scenarioSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(codes.scenarioSha256)
      )
        throw new ReviewRefusedError(
          "the join codes record has no valid scenario hash",
        );
    }
    const body: Body = {
      type: "review.opened",
      schema: REVIEW_SCHEMA,
      policyVersion: POLICY_VERSION,
      legacy: drafts.legacy,
      session: {
        id: drafts.sessionId,
        logSha256:
          meta.sessionLogText !== undefined
            ? sha256(meta.sessionLogText)
            : null,
        startedAt: drafts.startedAt,
      },
      scenario: {
        id: drafts.scenarioId,
        sha256:
          typeof codes?.scenarioSha256 === "string"
            ? codes.scenarioSha256
            : null,
      },
      rubricHash: drafts.rubricHash,
      files: drafts.files,
      codes,
    };
    const sealed = sealEntries(
      [],
      ZERO_HASH,
      [{ actor: { kind: "facilitator", by: meta.by }, body }],
      meta.now,
    );
    fold(drafts, sealed, (m) => new ReviewRefusedError(m));
    await writeEvents(dir, sealed);
    return loadReview(dir);
  });
}

/** The session's join-code record (salt and hashes, never a code), validated, or null when there is none. */
export async function readCodesRecord(
  codesDir: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readRegularCapped(
      path.join(codesDir, codesFileName(sessionId)),
      MAX_CODES_FILE_BYTES,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReviewCorruptError("the join codes file cannot be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReviewCorruptError("the join codes file is not valid JSON");
  }
  try {
    JoinCodes.fromRecord(json);
  } catch {
    throw new ReviewCorruptError("the join codes file is not a valid record");
  }
  const rec = json as Record<string, unknown>;
  if (rec.sessionId !== sessionId)
    throw new ReviewCorruptError(
      "the join codes file belongs to another session",
    );
  return rec;
}

/** The name of another directory of the same session instance (same id and startedAt) whose review has a release and was not superseded, else null. */
export async function siblingReleased(dir: string): Promise<string | null> {
  const drafts = await loadDrafts(dir);
  const parent = path.dirname(dir);
  const me = path.basename(dir);
  for (const name of (await readdir(parent)).sort()) {
    if (
      name === me ||
      !(name === drafts.sessionId || name.startsWith(`${drafts.sessionId}-`))
    )
      continue;
    let read;
    try {
      read = await readReview(path.join(parent, name));
    } catch {
      continue;
    }
    const first = read.events[0];
    if (
      !first ||
      first.type !== "review.opened" ||
      first.session.id !== drafts.sessionId ||
      first.session.startedAt !== drafts.startedAt
    )
      continue;
    if (
      read.events.some((e) => e.type === "report.released") &&
      !read.events.some((e) => e.type === "review.superseded")
    )
      return name;
  }
  return null;
}

const CARRIED = new Set<string>([
  "score.edited",
  "rationale.edited",
  "summary.edited",
  "summary.accepted",
  "score.accepted",
  "comment.added",
]);

function stripEnvelope(e: ReviewEvent): Body {
  const { seq: _s, ts: _t, prev: _p, actor: _a, carriedFrom: _c, ...body } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
  return body as Body;
}

/**
 * Moves moderation from an earlier review of the same session to a re-run: subjects whose draft file is byte-identical
 * keep their moderation (copied as events marked carriedFrom); the rest start clean. Ruling P16: the new review is
 * written first, the old one is marked superseded last, so a crash leaves the old review live and never both closed.
 */
export async function supersedeReview(
  oldDir: string,
  newDir: string,
  o: { by: string; now: () => number },
): Promise<{ carried: string[]; fresh: string[] }> {
  if (!isSafeId(o.by))
    throw new ReviewRefusedError(
      "--by must be 1 to 64 letters, digits, _ or -",
    );
  return withReviewLock(oldDir, () =>
    withReviewLock(newDir, async () => {
      const old = await readReview(oldDir);
      const oldOpened = old.events[0];
      if (!oldOpened || oldOpened.type !== "review.opened")
        throw new ReviewRefusedError(
          "the earlier directory has no open review",
        );
      if (old.events.some((e) => e.type === "review.superseded"))
        throw new ReviewRefusedError(
          "the earlier review was already superseded",
        );
      const oldDrafts = await loadDrafts(
        oldDir,
        new Set(Object.keys(oldOpened.files)),
      );
      for (const [n, h] of Object.entries(oldOpened.files))
        if (oldDrafts.files[n] !== h)
          throw new ReviewCorruptError(
            `the draft file ${n} changed after the earlier review was opened`,
          );
      const newDrafts = await loadDrafts(newDir);
      if (
        newDrafts.sessionId !== oldDrafts.sessionId ||
        newDrafts.startedAt !== oldDrafts.startedAt
      )
        throw new ReviewRefusedError(
          "the two directories are not evaluations of the same session",
        );
      if ((await readReview(newDir)).events.length > 0)
        throw new ReviewRefusedError(
          "a review is already open on the new directory",
        );
      const identical = [...newDrafts.subjects.keys()].filter(
        (id) =>
          oldDrafts.files[`${id}.json`] !== undefined &&
          oldDrafts.files[`${id}.json`] === newDrafts.files[`${id}.json`],
      );
      const fresh = [...newDrafts.subjects.keys()].filter(
        (id) => !identical.includes(id),
      );
      const name = path.basename(oldDir);
      const opened: Entry = {
        actor: { kind: "facilitator", by: o.by },
        body: {
          type: "review.opened",
          schema: REVIEW_SCHEMA,
          policyVersion: POLICY_VERSION,
          legacy: newDrafts.legacy,
          session: { ...oldOpened.session },
          scenario: { ...oldOpened.scenario },
          rubricHash: newDrafts.rubricHash,
          files: newDrafts.files,
          codes: oldOpened.codes,
        },
      };
      const carried: Entry[] = old.events
        .filter(
          (e) =>
            CARRIED.has(e.type) &&
            identical.includes((e as { subject: string }).subject),
        )
        .map((e) => ({
          actor: e.actor,
          carriedFrom: name,
          body: stripEnvelope(e),
        }));
      if (1 + carried.length > LIMITS.events)
        throw new ReviewRefusedError("this review has reached its event limit");
      const sealedNew = sealEntries([], ZERO_HASH, [opened, ...carried], o.now);
      fold(
        newDrafts,
        sealedNew,
        (m) =>
          new ReviewRefusedError(
            `the carried-forward moderation does not apply: ${m}`,
          ),
      );
      const sealedOld = sealEntries(
        old.events,
        old.tailHash,
        [
          {
            actor: { kind: "facilitator", by: o.by },
            body: { type: "review.superseded", by: path.basename(newDir) },
          },
        ],
        o.now,
      );
      await writeEvents(newDir, sealedNew);
      try {
        await writeEvents(oldDir, sealedOld);
      } catch {
        throw new ReviewCorruptError(
          "the new review was opened but the old one could not be marked superseded; delete review.jsonl in the new directory (it holds only copies) and run supersede again",
        );
      }
      return { carried: identical, fresh };
    }),
  );
}
