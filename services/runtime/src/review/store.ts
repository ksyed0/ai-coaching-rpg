import path from "node:path";
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
import { currentView, type View } from "./fold.js";
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
): View {
  try {
    return currentView(drafts, events);
  } catch (e) {
    if (e instanceof ReviewIllegalError) throw onIllegal(e.message);
    throw e;
  }
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
    const drafts = await loadDrafts(dir);
    const codes = meta.codes ?? null;
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
