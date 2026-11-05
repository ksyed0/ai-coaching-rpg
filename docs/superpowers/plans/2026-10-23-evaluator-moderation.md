# Evaluator Moderation, Release, Visibility and Self-Assessment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a facilitator review, edit and release the AI-drafted evaluation reports with a full append-only history, restrict who can see them, and let participants rate themselves, respond and dispute.

**Architecture:** The AI draft files stay immutable. A new `review.jsonl` (`acr.review/1`) beside them holds every human action as a hash-chained event; a pure, total fold (`currentView`) turns drafts plus events into the current state; reports, status and exports are rendered from that view. One CLI, `pnpm moderate <subcommand> <reports-dir>`, follows the `pnpm calibrate` pattern. Access is decided by one pure function over a constant policy table.

**Tech Stack:** TypeScript (ESM, strict), Node 22 `node:fs`/`node:crypto`, `node:util` `parseArgs`, vitest, the existing `@acr/events` ids, `@acr/script`, `SessionLock` (`engine/log-files.ts`) and `safeMd`/`scrubText` helpers. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-22-evaluator-moderation-design.md` (merged in PR #45). The spec is the binding authority; where this plan rules on something the spec left open or corrects, the ruling is listed under "Plan rulings" and goes into the SDD ledger.

## Global Constraints

Every task's requirements include these.

- Draft files written by `pnpm evaluate` are never modified, by any new code. They stay schema `acr.report/1`; the S-16 check keeps passing. New draft fields are additive only.
- Files this feature creates are owner-only (mode `0o600`); directories `0o700`. `review.jsonl` is created exclusively, never followed through a symbolic link, `fdatasync`ed after every append and the directory is fsynced.
- `JsonlEventLog` and the session log code are NOT changed (spec section 3). `ReviewLog` is a separate small module.
- Limits: reason 1 to 500 characters; comment, response and note 1 to 1,500 characters; at most 10,000 events; `review.jsonl` read with a byte cap; `--by` validated like ids (`isSafeId`: 1 to 64 letters, digits, `_`, `-`).
- All free text is passed through `stripHidden` and `scrubText` (with the current secrets) BEFORE it is stored, and rendered through `safeMd`.
- Event order is by `seq`, never by timestamp. The clock is injected; no test asserts an absolute or elapsed time (AGENTS.md section 8).
- `currentView` is pure and total over any event list: it returns a view or throws `ReviewIllegalError`; it never returns a partial view.
- Exit codes: 0 success; 1 a refused action the user can fix (unresolved review items, compare-and-set mismatch, illegal state, lock held); 2 usage or input errors (bad flags, unreadable or corrupt files, hash mismatch). Messages never contain absolute paths, secrets or free text from other participants.
- Mock demos stay deterministic: showcase checks S-01 to S-16 and the counts 29 / 39 / 42 / 14 / 15 are unchanged. Only Task 13 adds S-17, and only with `--evaluate` (16 checks then).
- Policy: the constant policy table is versioned (`POLICY_VERSION = 1`). Only `facilitator` and `participant:<role>` are resolvable; `line_manager`, `ld`, `hr`, `sponsor` are table data and `canView` returns false for them in every shipped command.
- An agent never runs `release`, `amend` or `withdraw` unless the owner explicitly names the subjects (L-0019). Tests call the library functions or use a temporary directory, never a real reports directory.
- Process (AGENTS.md): commit format `[TYPE] ID: description` with the `Co-Authored-By` trailer from the session; each story is its own branch `feature/EPIC-0005-US-00NN-<slug>`, its own review loop and PR; CHANGELOG `[Unreleased]` entry and TC rows in the same PR; `npm run plan:generate` after RELEASE_PLAN/TEST_CASES changes; coverage at least 80% on new code; run new filesystem and lock tests once in a Linux container (AGENTS.md section 8) before the PR.

## Review Focus

Failure modes the spec implies that no single task's tests would otherwise cover. Each line has a test in the task named in brackets.

1. **Hostile free text** in `--reason`, `--text`, `--by`, response text and `--action`: hidden and bidirectional characters, Markdown and HTML injection, a pasted secret value, 100,000 characters. Expect: stored stripped and scrubbed, rendered escaped, rejected with exit 2 when over the limit. [Tasks 1, 6, 7]
2. **Two commands racing** (edit vs edit, edit vs release, release vs release) on one review. Expect: exactly one wins, the other exits 1 with a clear message; the log stays valid. [Tasks 5, 9]
3. **A damaged log or draft**: hand-edited line, deleted middle line, cut-off last line, symlinked `review.jsonl`, a draft file changed after `open`, a draft directory with an extra report added later. Expect: every command exits 2 and repairs nothing. [Tasks 2, 5]
4. **A participant's group report and index containing a peer's score** in any byte, in Markdown or JSON, including the learning-objective table and evidence lines. Expect: absent. [Tasks 11, 12]
5. **A re-run after a release**: `pnpm evaluate` again for the same session, then `open` on the new directory. Expect: refused unless `supersede`; the old review becomes read-only; byte-identical subjects carry their moderation forward, changed ones start clean. [Task 8]

## Plan rulings (spec gaps and corrections)

These are decisions the spec left to the plan stage (its section 14) or that the code reading corrected. Log each as `Ruling: ...` in the SDD ledger.

- **P1 CLI shape.** One CLI `pnpm moderate <subcommand> <reports-dir> ...` (the `pnpm calibrate` pattern) for every command, including `export`, `self-assess`, `respond` and `resolve`. The spec's `pnpm report export` and `pnpm self-assess` become subcommands. One lock-and-load path, one set of exit codes.
- **P2 Explicit `open`.** A review starts with `pnpm moderate open <reports-dir> --by <name> [--session-log <file>] [--codes-dir <dir>]`. Every other command refuses with "run open first" when no review exists. Reason: the session log and join-code file live outside the reports directory, so the binding needs explicit paths.
- **P3 Flag codes are derived, not threaded through `parse.ts`.** `flagCodesOf(flags: string[])` maps the existing flag texts to codes in one table in `report-model.ts` and is written into each criterion as `flag_codes`. A test runs `normaliseCriteria` over every flag-producing case and fails on an unmapped text. The gate rule is unchanged: any flag, any code.
- **P4 Mapped learning-objective ids need no new draft field.** The draft JSON already holds each objective's in-scope `criteria` (participant `learning_objectives[]`, group `learning_objectives[]` and `lo_coverage`). The fold feeds those to `aggregateObjectives`.
- **P5 Legacy draft** = any criterion lacking a `flag_codes` array.
- **P6 Not observed is clear.** A valid Not-observed criterion with no flag does not need review (no score to defend). Failed evaluations (every criterion Not observed with a flag, see `evaluate.ts`) need every criterion edited.
- **P7 Compare-and-set is user-visible through `--expect`.** `edit` takes an optional `--expect 1|2|3|4|na|invalid`; if given and different from the folded level inside the lock, exit 1 printing the current level. The event's `from` is always the folded level, and the fold re-checks it, so a forged log also fails.
- **P8 `accept --all-high` is dropped.** High-confidence unflagged criteria need no acceptance, so it would do nothing. `accept <subject> <criterion>` and `accept <subject> --summary` remain.
- **P9 New event `summary.accepted`** (the spec lists `accept --summary` but no event for it).
- **P10 A cut-off last line in `review.jsonl` is corruption** (exit 2), not a tolerated crash tail: the review log is small, the spec says no command repairs it.
- **P11 `show <subject>`** prints the facilitator's rendering of the current view to stdout (the spec renders views but names no read command). `export` writes the audited viewer-specific files.
- **P12 During an amendment participants keep seeing the last released version** (the fold stores a snapshot at each release); the amendment becomes visible when released again.
- **P13 Withdrawn is terminal** within a review. Re-doing a withdrawn subject means re-running the evaluation and `supersede`.
- **P14 The scenario hash in `review.opened`** is the `scenarioSha256` of the join-code record when `--codes-dir` finds one, else `null`.
- **P15 Story 2 ships `export --for facilitator` only**; story 3 widens `--for` through `canView`.
- **P16 Supersede write order.** `supersede` writes the new review first and marks the old one `review.superseded` last. If the second write fails the command exits 2 and says "the new review was opened but the old one could not be marked superseded; delete `review.jsonl` in the new directory (it holds only copies) and run supersede again".
- **P17 Export records first.** `export` appends `report.exported` and then writes the files; if the files fail the record stays and the command says so. An audit that over-reports is safer than an export nobody recorded.
- **P18 Group evidence keeps the speaker's role id.** The redaction removes peers' individual scores (spec section 6), not what was said in the shared session, which every participant took part in. An `index` export is audited as an export of the `group` subject (the event needs a released subject).
- **P19 Showcase counts.** Counts 29 / 39 / 42 / 14 are unchanged. The `--evaluate` showcase run (15 checks, 15 on the Friday scenario) becomes 16 with S-17; AC-0199 wording is updated in Task 13.

## Reserved ids (filed in the plan PR)

`US-0041`..`US-0044`; `TASK-0066`..`TASK-0069`; `AC-0209`..`AC-0234`; `TC-0049`..`TC-0056`. Next available after this plan: `US-0045`, `TASK-0070`, `AC-0235`, `TC-0057`. The stories and their acceptance criteria are in `docs/RELEASE_PLAN.md` (EPIC-0005). Story 1 = US-0041 (AC-0209..AC-0216), story 2 = US-0042 (AC-0217..AC-0222), story 3 = US-0043 (AC-0223..AC-0228), story 4 = US-0044 (AC-0229..AC-0234).

## File structure

New directory `services/runtime/src/review/` (one responsibility per file):

| File                | Responsibility                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `types.ts`          | event union, `Actor`, `Level`, limits, constants                                                        |
| `errors.ts`         | `ReviewUsageError` (2), `ReviewRefusedError` (1), `ReviewCorruptError` (2), `ReviewIllegalError` (fold) |
| `text.ts`           | `cleanText`, `cleanBy`, `parseLevel` (strip, scrub, limits)                                             |
| `hash.ts`           | `sha256`                                                                                                |
| `review-log.ts`     | read with chain check, `sealEntries`, `writeEvents`, `withReviewLock`                                   |
| `draft.ts`          | `loadDrafts`: validated, hashed view of the draft files                                                 |
| `gate.ts`           | `releaseProblems` (pure)                                                                                |
| `fold.ts`           | `currentView` (pure, total)                                                                             |
| `store.ts`          | `openReview`, `loadReview`, `applyCommand`, `supersedeReview`                                           |
| `view.ts`           | draft + subject view -> rendered report object (`viewReport`)                                           |
| `policy.ts`         | policy table, `canView`, redaction (story 3)                                                            |
| `cli.ts`, `main.ts` | `runModerate`, thin entry                                                                               |
| `__tests__/`        | one test file per module plus `fixtures.ts`                                                             |

Modified: `services/runtime/src/util/read-regular.ts` (new, extracted from `calibration/stamp.ts`), `calibration/stamp.ts`, `evaluator/report-model.ts`, `evaluator/report-md.ts`, `evaluator/report-write.ts`, `evaluator/method.ts`, `evaluator/__tests__/fixtures.ts`, `evaluator/__tests__/reports.test.ts`, `demo/showcase.ts` (+ showcase files, Task 13), `package.json`, `services/runtime/package.json`, `docs/EVALUATOR.md`, `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`.

---

# Story 1: US-0041 Review log and moderation

Branch `feature/EPIC-0005-US-0041-review-log` from `develop`. Tasks 1 to 8.

### Task 1: Foundations (shared safe read, types, errors, text cleaning)

**Files:**

- Create: `services/runtime/src/util/read-regular.ts`
- Modify: `services/runtime/src/calibration/stamp.ts` (use the shared reader)
- Create: `services/runtime/src/review/types.ts`, `errors.ts`, `hash.ts`, `text.ts`
- Test: `services/runtime/src/util/__tests__/read-regular.test.ts`, `services/runtime/src/review/__tests__/text.test.ts`

**Interfaces:**

- Produces: `readRegularCapped(file: string, max: number): Promise<string>` (rejects on symlink, non-regular file, over cap); `sha256(s: string | Buffer): string`; `cleanText(raw: string, max: number, what: string, secrets: string[]): string`; `cleanBy(raw: unknown): string`; `parseLevel(raw: unknown): 1|2|3|4|null` (`"na"` is null); the types and constants below.

- [ ] **Step 1: Write the failing tests**

`services/runtime/src/util/__tests__/read-regular.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRegularCapped } from "../read-regular.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-rr-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readRegularCapped", () => {
  it("reads a regular file within the cap", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    expect(await readRegularCapped(path.join(dir, "a.txt"), 10)).toBe("hello");
  });
  it("rejects a file over the cap, a directory and a missing file", async () => {
    await writeFile(path.join(dir, "big.txt"), "x".repeat(11));
    await expect(
      readRegularCapped(path.join(dir, "big.txt"), 10),
    ).rejects.toThrow();
    await mkdir(path.join(dir, "d"));
    await expect(readRegularCapped(path.join(dir, "d"), 10)).rejects.toThrow();
    await expect(
      readRegularCapped(path.join(dir, "none"), 10),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not follow a symbolic link", async () => {
    await writeFile(path.join(dir, "real.txt"), "secret");
    await symlink(path.join(dir, "real.txt"), path.join(dir, "link.txt"));
    await expect(
      readRegularCapped(path.join(dir, "link.txt"), 100),
    ).rejects.toThrow();
  });
});
```

`services/runtime/src/review/__tests__/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanBy, cleanText, parseLevel } from "../text.js";
import { ReviewUsageError } from "../errors.js";

describe("cleanText", () => {
  it("strips hidden characters and scrubs secrets before returning", () => {
    const out = cleanText(
      "ok\u202Etext \u200Bwith sk-secret-value-123",
      100,
      "--reason",
      ["sk-secret-value-123"],
    );
    expect(out).toBe("oktext with [redacted]");
  });
  it("refuses empty (after stripping) and over-long text, naming the option", () => {
    expect(() => cleanText("\u200B  ", 10, "--reason", [])).toThrow(
      /--reason must not be empty/,
    );
    expect(() => cleanText("x".repeat(11), 10, "--reason", [])).toThrow(
      /--reason is longer than 10 characters/,
    );
    expect(() => cleanText("x".repeat(100_000), 500, "--reason", [])).toThrow(
      ReviewUsageError,
    );
  });
  it("counts characters, not UTF-16 units", () => {
    expect(cleanText("😀".repeat(5), 5, "--reason", [])).toBe("😀".repeat(5));
  });
});
describe("cleanBy", () => {
  it("accepts ids and refuses everything else", () => {
    expect(cleanBy("Kamal")).toBe("Kamal");
    for (const bad of [
      "",
      "a b",
      "../x",
      "x".repeat(65),
      "a\u202Eb",
      undefined,
      3,
    ])
      expect(() => cleanBy(bad)).toThrow(/--by/);
  });
});
describe("parseLevel", () => {
  it("maps 1 to 4 and na", () => {
    expect([parseLevel("1"), parseLevel("4"), parseLevel("na")]).toEqual([
      1,
      4,
      null,
    ]);
    for (const bad of ["0", "5", "2.5", "", "N/A", undefined])
      expect(() => parseLevel(bad)).toThrow(/--level/);
  });
});
```

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/runtime exec vitest run src/util src/review/__tests__/text.test.ts` Expected: FAIL (modules not found).

- [ ] **Step 3: Implement.**

`services/runtime/src/util/read-regular.ts` (moved verbatim from `calibration/stamp.ts` lines 20 to 38, exported):

```ts
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Opened without following a symbolic link and without blocking on a pipe; on Windows O_NOFOLLOW does not exist. */
const OPEN_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);

/** Reads a small regular file from ONE handle: no check-then-use, no symbolic link, no pipe or device, at most `max` bytes. Rejects otherwise. */
export async function readRegularCapped(
  file: string,
  max: number,
): Promise<string> {
  const fh = await open(file, OPEN_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) throw new Error("not a regular file");
    const buf = Buffer.allocUnsafe(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, null);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    if (got > max) throw new Error("file too large");
    return buf.subarray(0, got).toString("utf8");
  } finally {
    await fh.close();
  }
}
```

In `calibration/stamp.ts` delete the local `OPEN_FLAGS` and `readRegularCapped` and add `import { readRegularCapped } from "../util/read-regular.js";`; remove imports that became unused (`constants`, `open`). Run the existing stamp tests: they must still pass unchanged.

`review/errors.ts`:

```ts
/** Bad flags or input the user can correct: exit 2. */
export class ReviewUsageError extends Error {
  readonly exit = 2;
  constructor(m: string) {
    super(m);
    this.name = "ReviewUsageError";
  }
}
/** A well-formed request the current state refuses (unresolved items, mismatch, illegal state, lock held): exit 1. */
export class ReviewRefusedError extends Error {
  readonly exit = 1;
  constructor(m: string) {
    super(m);
    this.name = "ReviewRefusedError";
  }
}
/** The log or a draft file is damaged or does not match: exit 2. Nothing repairs it. */
export class ReviewCorruptError extends Error {
  readonly exit = 2;
  constructor(m: string) {
    super(m);
    this.name = "ReviewCorruptError";
  }
}
/** The fold met an illegal sequence. On an existing log the store turns it into ReviewCorruptError; on new entries into ReviewRefusedError. */
export class ReviewIllegalError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ReviewIllegalError";
  }
}
```

`review/hash.ts`:

```ts
import { createHash } from "node:crypto";
export const sha256 = (s: string | Buffer): string =>
  createHash("sha256").update(s).digest("hex");
```

`review/types.ts`:

```ts
export const REVIEW_SCHEMA = "acr.review/1";
export const VIEW_SCHEMA = "acr.view/1";
export const POLICY_VERSION = 1;
export const GROUP = "group";
export const ZERO_HASH = "0".repeat(64);
export const REVIEW_FILE = "review.jsonl";
export const LIMITS = {
  reason: 500,
  text: 1500,
  item: 400,
  events: 10_000,
  logBytes: 16 * 1024 * 1024,
} as const;

/** A criterion level: 1 to 4, or null for Not observed. */
export type Level = 1 | 2 | 3 | 4 | null;
/** What a criterion currently holds: a level, Not observed, or an evaluator error. */
export type CurrentLevel = Level | "invalid";
export type Actor =
  | { kind: "facilitator"; by: string }
  | { kind: "participant"; role: string; attestedBy: string }
  | { kind: "system" };
export type Visibility = "internal" | "feedback";
export type Outcome = "upheld" | "amended" | "declined";
export type Summary = {
  strengths: string[];
  development_points: string[];
  next_actions: { lo: string; action: string }[];
};

export type Body =
  | {
      type: "review.opened";
      schema: typeof REVIEW_SCHEMA;
      policyVersion: number;
      legacy: boolean;
      session: { id: string; logSha256: string | null; startedAt: string };
      scenario: { id: string; sha256: string | null };
      rubricHash: string | null;
      files: Record<string, string>;
      codes: Record<string, unknown> | null;
    }
  | {
      type: "score.edited";
      subject: string;
      criterion: string;
      from: CurrentLevel;
      to: Level;
      reason: string;
    }
  | {
      type: "rationale.edited";
      subject: string;
      criterion: string;
      fromHash: string;
      text: string;
      reason: string;
    }
  | {
      type: "summary.edited";
      subject: string;
      summary: Summary;
      reason: string;
    }
  | { type: "summary.accepted"; subject: string }
  | { type: "score.accepted"; subject: string; criterion: string }
  | {
      type: "comment.added";
      subject: string;
      criterion?: string;
      text: string;
      visibility: Visibility;
    }
  | { type: "report.released"; subjects: string[] }
  | { type: "report.amended"; subject: string; reason: string; basedOn: number }
  | { type: "report.withdrawn"; subject: string; reason: string }
  | {
      type: "report.exported";
      subject: string;
      version: number;
      principal: string;
      destination: string;
    }
  | {
      type: "self.rated";
      role: string;
      criterion: string;
      level: Level;
      note?: string;
    }
  | {
      type: "response.added";
      role: string;
      criterion?: string;
      text: string;
      dispute?: boolean;
    }
  | {
      type: "dispute.resolved";
      response: number;
      outcome: Outcome;
      reason: string;
    }
  | { type: "review.superseded"; by: string };

/** A body plus who did it, before the log assigns seq, ts and prev. `carriedFrom` marks moderation copied from a superseded review. */
export type Entry = { actor: Actor; body: Body; carriedFrom?: string };
export type ReviewEvent = {
  seq: number;
  ts: number;
  prev: string;
  actor: Actor;
  carriedFrom?: string;
} & Body;
export type EventType = Body["type"];
```

`review/text.ts`:

```ts
import { isSafeId } from "@acr/events";
import { stripHidden } from "../calibration/hidden-chars.js";
import { scrubText } from "../demo/report.js";
import { ReviewUsageError } from "./errors.js";
import type { Level } from "./types.js";

/** Free text from a person: hidden characters stripped, secrets scrubbed, 1 to `max` characters. `what` names the option in the message. */
export function cleanText(
  raw: string,
  max: number,
  what: string,
  secrets: string[],
): string {
  const stripped = stripHidden(String(raw)).replace(/\r\n?/g, "\n").trim();
  if (Array.from(stripped).length > max)
    throw new ReviewUsageError(`${what} is longer than ${max} characters`);
  const text = scrubText(stripped, secrets).trim();
  if (text.length === 0)
    throw new ReviewUsageError(`${what} must not be empty`);
  return text;
}

/** A person's name as recorded in the log: validated like an id. */
export function cleanBy(raw: unknown): string {
  if (typeof raw !== "string" || !isSafeId(raw))
    throw new ReviewUsageError(
      "--by needs a name of 1 to 64 letters, digits, _ or -",
    );
  return raw;
}

export function parseLevel(raw: unknown): Level {
  if (raw === "na") return null;
  if (typeof raw === "string" && /^[1-4]$/.test(raw))
    return Number(raw) as 1 | 2 | 3 | 4;
  throw new ReviewUsageError("--level needs 1, 2, 3, 4 or na (not observed)");
}
```

- [ ] **Step 4: Run to verify they pass.** Same command, plus `pnpm --filter @acr/runtime exec vitest run src/calibration`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src
git commit -m "[feat] US-0041: review foundations (shared safe read, event types, text cleaning)"
```

### Task 2: The review log (hash-chained, locked, durable)

**Files:**

- Create: `services/runtime/src/review/review-log.ts`
- Test: `services/runtime/src/review/__tests__/review-log.test.ts`

**Interfaces:**

- Consumes: `Entry`, `ReviewEvent`, `LIMITS`, `ZERO_HASH`, `REVIEW_FILE` (Task 1); `sha256`; `ReviewCorruptError`, `ReviewRefusedError`; `SessionLock`, `SessionLockError` from `../engine/log-files.js`; `fsyncDir` from `../engine/event-log.js`; `readRegularCapped`.
- Produces:
  - `type ReviewRead = { events: ReviewEvent[]; tailHash: string }`
  - `readReview(dir: string): Promise<ReviewRead>` (`events: []`, `tailHash: ZERO_HASH` when no file; throws `ReviewCorruptError` for any damage)
  - `sealEntries(events: ReviewEvent[], tailHash: string, entries: Entry[], now: () => number): ReviewEvent[]` (pure)
  - `writeEvents(dir: string, sealed: ReviewEvent[]): Promise<void>` (caller holds the lock)
  - `withReviewLock<T>(dir: string, fn: () => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing tests** (`review-log.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readReview,
  sealEntries,
  withReviewLock,
  writeEvents,
} from "../review-log.js";
import { REVIEW_FILE, ZERO_HASH, type Entry } from "../types.js";
import { ReviewCorruptError, ReviewRefusedError } from "../errors.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-rl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fac = { kind: "facilitator", by: "kamal" } as const;
const comment = (text: string): Entry => ({
  actor: fac,
  body: {
    type: "comment.added",
    subject: "alice",
    text,
    visibility: "internal",
  },
});
const clock = () => {
  let t = 1000;
  return () => (t += 1);
};
async function append(entries: Entry[]) {
  const { events, tailHash } = await readReview(dir);
  const sealed = sealEntries(events, tailHash, entries, clock());
  await writeEvents(dir, sealed);
  return sealed;
}

describe("review log", () => {
  it("is empty when there is no file, and chains seq and prev from the zero hash", async () => {
    expect(await readReview(dir)).toEqual({ events: [], tailHash: ZERO_HASH });
    const sealed = await append([comment("a"), comment("b")]);
    expect(sealed.map((e) => e.seq)).toEqual([1, 2]);
    expect(sealed[0]!.prev).toBe(ZERO_HASH);
    expect(sealed[1]!.prev).not.toBe(ZERO_HASH);
    await append([comment("c")]);
    const read = await readReview(dir);
    expect(read.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
  it("creates the file owner-only", async () => {
    await append([comment("a")]);
    expect((await stat(path.join(dir, REVIEW_FILE))).mode & 0o777).toBe(0o600);
  });
  it("narrows a wider existing file to owner-only on append", async () => {
    await append([comment("a")]);
    await chmod(path.join(dir, REVIEW_FILE), 0o644);
    await append([comment("b")]);
    expect((await stat(path.join(dir, REVIEW_FILE))).mode & 0o777).toBe(0o600);
  });
  it("detects an edited line, a deleted middle line, a cut-off last line and garbage", async () => {
    await append([comment("a"), comment("b"), comment("c")]);
    const file = path.join(dir, REVIEW_FILE);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    await writeFile(
      file,
      [lines[0]!.replace('"a"', '"A"'), lines[1], lines[2]].join("\n") + "\n",
    );
    await expect(readReview(dir)).rejects.toThrow(/hash chain/);
    await writeFile(file, [lines[0], lines[2]].join("\n") + "\n");
    await expect(readReview(dir)).rejects.toThrow(/seq|chain/);
    await writeFile(file, lines.join("\n") + "\n" + '{"seq":4,"ts"');
    await expect(readReview(dir)).rejects.toThrow(/cut-off/);
    await writeFile(file, "not json\n");
    await expect(readReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it("does not follow a symbolic link and refuses a directory", async () => {
    await writeFile(path.join(dir, "real.jsonl"), "");
    await symlink(path.join(dir, "real.jsonl"), path.join(dir, REVIEW_FILE));
    await expect(readReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
    await expect(
      writeEvents(dir, sealEntries([], ZERO_HASH, [comment("a")], clock())),
    ).rejects.toThrow();
  });
  it("refuses more than the event cap", async () => {
    const sealed = sealEntries(
      [],
      ZERO_HASH,
      Array.from({ length: 10_001 }, () => comment("x")),
      clock(),
    );
    await writeFile(
      path.join(dir, REVIEW_FILE),
      sealed.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await expect(readReview(dir)).rejects.toThrow(/too many events/);
  });
  it("takes one lock at a time: a second holder is refused, and the lock is released afterwards", async () => {
    let inner: Promise<unknown> | undefined;
    await withReviewLock(dir, async () => {
      inner = withReviewLock(dir, async () => 1);
      await expect(inner).rejects.toBeInstanceOf(ReviewRefusedError);
    });
    await expect(withReviewLock(dir, async () => "again")).resolves.toBe(
      "again",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/review-log.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `review-log.ts`.**

```ts
import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { fsyncDir } from "../engine/event-log.js";
import { SessionLock, SessionLockError } from "../engine/log-files.js";
import { readRegularCapped } from "../util/read-regular.js";
import { ReviewCorruptError, ReviewRefusedError } from "./errors.js";
import { sha256 } from "./hash.js";
import {
  LIMITS,
  REVIEW_FILE,
  ZERO_HASH,
  type Entry,
  type ReviewEvent,
} from "./types.js";

export type ReviewRead = { events: ReviewEvent[]; tailHash: string };

const corrupt = (m: string) =>
  new ReviewCorruptError(
    `review.jsonl: ${m}; no command repairs it, restore it from a backup`,
  );
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isEventShape(e: unknown): e is ReviewEvent {
  if (!isObj(e)) return false;
  const a = e.actor;
  return (
    Number.isInteger(e.seq) &&
    typeof e.ts === "number" &&
    Number.isFinite(e.ts) &&
    typeof e.prev === "string" &&
    typeof e.type === "string" &&
    isObj(a) &&
    (a.kind === "facilitator" ||
      a.kind === "participant" ||
      a.kind === "system")
  );
}

/** Reads `<dir>/review.jsonl` through one handle (no symbolic link, regular file, byte cap) and checks seq and the hash chain. */
export async function readReview(dir: string): Promise<ReviewRead> {
  let text: string;
  try {
    text = await readRegularCapped(
      path.join(dir, REVIEW_FILE),
      LIMITS.logBytes,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT")
      return { events: [], tailHash: ZERO_HASH };
    throw corrupt(
      "cannot be read (a symbolic link, not a regular file, or too large)",
    );
  }
  if (text === "") return { events: [], tailHash: ZERO_HASH };
  if (!text.endsWith("\n")) throw corrupt("ends in a cut-off line");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > LIMITS.events) throw corrupt("has too many events");
  const events: ReviewEvent[] = [];
  let prev = ZERO_HASH;
  for (let i = 0; i < lines.length; i++) {
    let e: unknown;
    try {
      e = JSON.parse(lines[i]!);
    } catch {
      throw corrupt(`line ${i + 1} is not JSON`);
    }
    if (!isEventShape(e)) throw corrupt(`line ${i + 1} is not a review event`);
    if (e.seq !== i + 1)
      throw corrupt(`line ${i + 1}: seq ${e.seq} breaks the sequence`);
    if (e.prev !== prev)
      throw corrupt(`line ${i + 1}: the hash chain is broken`);
    prev = sha256(lines[i]!);
    events.push(e);
  }
  return { events, tailHash: prev };
}

/** Assigns seq, ts and prev to new entries after `events`. Pure; the line that is hashed is exactly the line that is written. */
export function sealEntries(
  events: ReviewEvent[],
  tailHash: string,
  entries: Entry[],
  now: () => number,
): ReviewEvent[] {
  const sealed: ReviewEvent[] = [];
  let prev = tailHash;
  for (const [i, en] of entries.entries()) {
    const e = {
      seq: events.length + i + 1,
      ts: now(),
      prev,
      actor: en.actor,
      ...(en.carriedFrom ? { carriedFrom: en.carriedFrom } : {}),
      ...en.body,
    } as ReviewEvent;
    sealed.push(e);
    prev = sha256(JSON.stringify(e));
  }
  return sealed;
}

/** Appends sealed events in ONE write, then fdatasync and a directory fsync. The caller holds the review lock and has validated the events. */
export async function writeEvents(
  dir: string,
  sealed: ReviewEvent[],
): Promise<void> {
  if (sealed.length === 0) return;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_APPEND |
    (fsConstants.O_NOFOLLOW ?? 0);
  let fh: FileHandle | null = null;
  try {
    fh = await open(path.join(dir, REVIEW_FILE), flags, 0o600);
    const st = await fh.stat();
    if (!st.isFile() || st.nlink > 1)
      throw new ReviewCorruptError(
        "review.jsonl is not a plain file with one link",
      );
    if ((st.mode & 0o077) !== 0) await fh.chmod(0o600);
    const buf = Buffer.from(
      sealed.map((e) => `${JSON.stringify(e)}\n`).join(""),
      "utf8",
    );
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
    await fh.datasync();
  } catch (err) {
    if (err instanceof ReviewCorruptError) throw err;
    throw new ReviewCorruptError(
      "review.jsonl could not be written; run status to check it before trying again",
    );
  } finally {
    await fh?.close().catch(() => undefined);
  }
  await fsyncDir(dir);
}

/** One writer at a time (the session lock primitive, file `review.lock`). A held lock is a refusal (exit 1), not a crash. */
export async function withReviewLock<T>(
  dir: string,
  fn: () => Promise<T>,
): Promise<T> {
  let lock: SessionLock;
  try {
    lock = SessionLock.acquire(dir, "review");
  } catch (err) {
    if (
      err instanceof SessionLockError &&
      (err.code === "locked" || err.code === "contention")
    )
      throw new ReviewRefusedError(
        "another moderate command is running on this review; try again in a moment",
      );
    throw err;
  }
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
```

If `SessionLock.acquire` is not async-safe for an in-process second holder (the `HELD` set), the test above is the proof; if it throws a different error code, adjust the mapped codes, do not weaken the test.

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0041: hash-chained review log with lock and durable append"
```

### Task 3: Draft flag codes and the draft loader

**Files:**

- Modify: `services/runtime/src/evaluator/report-model.ts` (`JsonCriterion.flag_codes`, `flagCodesOf`, `jsonCriterion`)
- Modify: `services/runtime/src/evaluator/__tests__/fixtures.ts`, `services/runtime/src/evaluator/__tests__/reports.test.ts` (extract the shared evaluation helper)
- Create: `services/runtime/src/review/draft.ts`
- Test: `services/runtime/src/evaluator/__tests__/flag-codes.test.ts`, `services/runtime/src/review/__tests__/draft.test.ts`, `services/runtime/src/review/__tests__/fixtures.ts`

**Interfaces:**

- Produces in `report-model.ts`: `type FlagCode = "invalid_score" | "not_reported" | "quotes_dropped" | "capped_no_quote" | "no_quote" | "capped_weak_quote" | "short_quotes_only" | "rating_language" | "no_rationale" | "evaluation_failed" | "other"`; `flagCodesOf(flags: string[]): FlagCode[]`; `JsonCriterion` gains `flag_codes: FlagCode[]` (and `moderation?` in Task 6).
- Produces in `fixtures.ts` (evaluator): `sampleAnswers`, `sampleProvider(over?)`, `sampleEvaluation(over?)` moved out of `reports.test.ts` unchanged in behaviour.
- Produces in `draft.ts`:

```ts
export type DraftCriterion = {
  id: string;
  name: string;
  score: 1 | 2 | 3 | 4 | null;
  level_label: string;
  confidence: "high" | "medium" | "low" | null;
  rationale: string;
  flags: string[];
  flag_codes: string[];
  invalid: boolean;
};
export type DraftObjective = {
  id: string;
  statement: string;
  criteria: string[];
  incomplete: boolean;
};
export type DraftSubject = {
  id: string;
  kind: "participant" | "group";
  file: string;
  evaluationOk: boolean;
  criteria: DraftCriterion[];
  objectives: DraftObjective[];
  summary: Summary | null;
  raw: Record<string, unknown>;
};
export type Drafts = {
  sessionId: string;
  scenarioId: string;
  startedAt: string;
  rubricHash: string | null;
  legacy: boolean;
  subjects: Map<string, DraftSubject>;
  files: Record<string, string>;
};
export function loadDrafts(
  dir: string,
  only?: ReadonlySet<string>,
): Promise<Drafts>;
```

`files` maps every `*.md` and `*.json` file name (except `review.*`) to its SHA-256. `only` restricts hashing and parsing to those names.

- [ ] **Step 1: Extract the shared evaluation helper (behaviour-preserving).** Move `crit`, `answers`, `provider` and `evaluate` from `reports.test.ts` lines 13 to 29 into `fixtures.ts` as exported `sampleAnswers`, `sampleProvider(over)`, `sampleEvaluation(over)`; import them in `reports.test.ts`. Run `pnpm --filter @acr/runtime exec vitest run src/evaluator` first (PASS before, PASS after, same test count).

- [ ] **Step 2: Write the failing flag-code tests** (`flag-codes.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { flagCodesOf } from "../report-model.js";
import { normaliseCriteria } from "../parse.js";
import { sampleRubrics } from "./fixtures.js";

describe("flagCodesOf", () => {
  it("maps every flag text parse.ts can produce to a specific code, never other", () => {
    const rubric = sampleRubrics()[0]!.criteria;
    const verify = () => null; // nothing verifies: drops quotes, caps scores
    const cases: unknown[] = [
      [
        {
          id: rubric[0]!.id,
          score: 4,
          rationale: "r",
          evidence: [{ seq: 1, quote: "a quote that does not exist" }],
        },
      ],
      [{ id: rubric[0]!.id, score: 2, rationale: "r", evidence: [] }],
      [{ id: rubric[0]!.id, score: 3, rationale: "", evidence: [] }],
      [{ id: rubric[0]!.id, score: 9 }],
      [],
    ];
    const seen = new Set<string>();
    for (const raw of cases)
      for (const c of normaliseCriteria(raw, rubric, verify as never).criteria)
        for (const code of flagCodesOf(c.flags)) seen.add(code);
    expect(seen.has("other")).toBe(false);
    expect([...seen]).toEqual(
      expect.arrayContaining([
        "quotes_dropped",
        "capped_no_quote",
        "no_quote",
        "no_rationale",
        "invalid_score",
        "not_reported",
      ]),
    );
  });
  it("maps the remaining texts and unknown text to other", () => {
    expect(
      flagCodesOf([
        "capped from 3 to 2: no verified quote of at least 15 characters and 3 words",
      ]),
    ).toEqual(["capped_weak_quote"]);
    expect(
      flagCodesOf(["only short quotes (they can support a 1 or 2 only)"]),
    ).toEqual(["short_quotes_only"]);
    expect(
      flagCodesOf(["a quote contains rating language: read it with care"]),
    ).toEqual(["rating_language"]);
    expect(flagCodesOf(["something new"])).toEqual(["other"]);
    expect(flagCodesOf([])).toEqual([]);
  });
});
```

If `sampleRubrics()` does not return an array whose first element has `.criteria`, adapt the first lines to the fixture's actual shape (read `fixtures.ts`), keeping the assertions.

- [ ] **Step 3: Implement the codes in `report-model.ts`.** Add after the imports:

```ts
export type FlagCode =
  | "invalid_score"
  | "not_reported"
  | "quotes_dropped"
  | "capped_no_quote"
  | "no_quote"
  | "capped_weak_quote"
  | "short_quotes_only"
  | "rating_language"
  | "no_rationale"
  | "evaluation_failed"
  | "other";

/** The code of each flag text `parse.ts` and `evaluate.ts` emit (P3: one table; the test above fails on an unmapped text). First match wins. */
const FLAG_CODES: [RegExp, FlagCode][] = [
  [/^not reported by the evaluator/, "not_reported"],
  [/the criterion is invalid$/, "invalid_score"],
  [/could not be verified against the recording/, "quotes_dropped"],
  [/^capped from \d to 2: no verified quote$/, "capped_no_quote"],
  [/^capped from \d to 2: no verified quote of at least/, "capped_weak_quote"],
  [/^no verified quote$/, "no_quote"],
  [/^only short quotes/, "short_quotes_only"],
  [/rating language/, "rating_language"],
  [/^no rationale given/, "no_rationale"],
  [/^evaluation failed|^the evaluation failed/i, "evaluation_failed"],
];
export function flagCodesOf(flags: string[]): FlagCode[] {
  return flags.map(
    (f) => FLAG_CODES.find(([re]) => re.test(f))?.[1] ?? "other",
  );
}
```

Check the text `evaluate.ts` line 77 passes as `flag` (read the callers) and adjust the last regexp to match it; add that case to the test. Then add `flag_codes: FlagCode[];` to `JsonCriterion` and `flag_codes: flagCodesOf(c.flags),` inside `jsonCriterion`. Update any existing test that deep-equals a `JsonCriterion` (grep `dropped_quotes` in tests) to include `flag_codes`.

- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/evaluator` Expected: PASS.

- [ ] **Step 5: Write the failing draft loader tests.** First create `review/__tests__/fixtures.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

/** A real draft directory written by `writeReports` (alice, bob, group). Returns the directory and the output root. */
export async function makeDraftDir(
  over: Record<string, unknown> = {},
): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "acr-rv-"));
  const result = await sampleEvaluation(over);
  const w = await writeReports(result, {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  return { root, dir: w.dir };
}
export const fixedClock = (start = 1_800_000_000_000) => {
  let t = start;
  return () => (t += 1000);
};
```

`draft.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadDrafts } from "../draft.js";
import { makeDraftDir } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadDrafts", () => {
  it("loads alice, bob and group from a real draft directory", async () => {
    const d = await loadDrafts(dir);
    expect([...d.subjects.keys()].sort()).toEqual(["alice", "bob", "group"]);
    expect(d.sessionId).toBe("sess1");
    expect(d.legacy).toBe(false);
    expect(Object.keys(d.files)).toEqual(
      expect.arrayContaining([
        "alice.json",
        "alice.md",
        "group.json",
        "index.md",
        "method.md",
      ]),
    );
    expect(Object.values(d.files).every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(
      true,
    );
    const alice = d.subjects.get("alice")!;
    expect(alice.kind).toBe("participant");
    expect(alice.criteria.map((c) => c.id)).toEqual([
      "discovery",
      "listening",
      "negotiation",
    ]);
    expect(alice.objectives.length).toBeGreaterThan(0);
    expect(d.subjects.get("group")!.summary).toBeNull();
    expect(alice.summary?.strengths).toEqual(["You asked about the need."]);
  });
  it("flags a directory without flag_codes as legacy", async () => {
    const f = path.join(dir, "alice.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    for (const c of j.criteria) delete c.flag_codes;
    await writeFile(f, JSON.stringify(j));
    expect((await loadDrafts(dir)).legacy).toBe(true);
  });
  it("refuses a draft that is not an acr.report/1 report, a role id that is unsafe and an oversized file", async () => {
    await writeFile(
      path.join(dir, "mallory.json"),
      JSON.stringify({ schema: "other/1" }),
    );
    await expect(loadDrafts(dir)).rejects.toThrow(/mallory\.json/);
    await rm(path.join(dir, "mallory.json"));
    const f = path.join(dir, "bob.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    j.participant.role = "../x";
    await writeFile(f, JSON.stringify(j));
    await expect(loadDrafts(dir)).rejects.toThrow(/bob\.json/);
    await writeFile(f, "x".repeat(5 * 1024 * 1024));
    await expect(loadDrafts(dir)).rejects.toThrow(/bob\.json/);
  });
  it("ignores files outside the allowed set", async () => {
    await writeFile(
      path.join(dir, "extra.json"),
      JSON.stringify({
        schema: "acr.report/1",
        kind: "participant",
        participant: { role: "extra" },
      }),
    );
    const only = new Set([
      "alice.json",
      "alice.md",
      "bob.json",
      "bob.md",
      "group.json",
      "group.md",
      "index.md",
      "method.md",
    ]);
    expect([...(await loadDrafts(dir, only)).subjects.keys()].sort()).toEqual([
      "alice",
      "bob",
      "group",
    ]);
  });
});
```

- [ ] **Step 6: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/draft.test.ts` Expected: FAIL.

- [ ] **Step 7: Implement `draft.ts`.**

```ts
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isFileSafeId, isSafeId } from "@acr/events";
import { readRegularCapped } from "../util/read-regular.js";
import { ReviewCorruptError } from "./errors.js";
import { sha256 } from "./hash.js";
import { GROUP, type Summary } from "./types.js";

export type DraftCriterion = {
  id: string;
  name: string;
  score: 1 | 2 | 3 | 4 | null;
  level_label: string;
  confidence: "high" | "medium" | "low" | null;
  rationale: string;
  flags: string[];
  flag_codes: string[];
  invalid: boolean;
};
export type DraftObjective = {
  id: string;
  statement: string;
  criteria: string[];
  incomplete: boolean;
};
export type DraftSubject = {
  id: string;
  kind: "participant" | "group";
  file: string;
  evaluationOk: boolean;
  criteria: DraftCriterion[];
  objectives: DraftObjective[];
  summary: Summary | null;
  raw: Record<string, unknown>;
};
export type Drafts = {
  sessionId: string;
  scenarioId: string;
  startedAt: string;
  rubricHash: string | null;
  legacy: boolean;
  subjects: Map<string, DraftSubject>;
  files: Record<string, string>;
};

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 200;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
const strs = (v: unknown, max = 50): string[] | null =>
  Array.isArray(v) &&
  v.length <= max &&
  v.every((x) => typeof x === "string" && x.length <= 2000)
    ? (v as string[])
    : null;

function bad(file: string, why: string): never {
  throw new ReviewCorruptError(`${file}: ${why}`);
}

function parseCriteria(file: string, raw: unknown): DraftCriterion[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS)
    bad(file, "criteria is missing or too long");
  return raw.map((c): DraftCriterion => {
    if (!isObj(c)) bad(file, "a criterion is not an object");
    const id = str(c.id, 64);
    const score = c.score;
    if (!id || !isSafeId(id)) bad(file, "a criterion id is not a safe id");
    if (!(
      score === null ||
      score === 1 ||
      score === 2 ||
      score === 3 ||
      score === 4
    ))
      bad(file, `criterion ${id}: score is not 1 to 4 or null`);
    const conf = c.confidence;
    if (!(
      conf === null ||
      conf === "high" ||
      conf === "medium" ||
      conf === "low"
    ))
      bad(file, `criterion ${id}: confidence is not valid`);
    const flags = strs(c.flags);
    const rationale = str(c.rationale, 5000);
    const name = str(c.name, 200);
    const label = str(c.level_label, 200);
    if (
      !flags ||
      rationale === null ||
      name === null ||
      label === null ||
      typeof c.invalid !== "boolean"
    )
      bad(file, `criterion ${id}: a field is missing or invalid`);
    return {
      id,
      name,
      score,
      level_label: label,
      confidence: conf,
      rationale,
      flags,
      flag_codes: strs(c.flag_codes) ?? [],
      invalid: c.invalid,
    };
  });
}

function parseObjectives(file: string, raw: unknown): DraftObjective[] {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS)
    bad(file, "learning_objectives is missing or too long");
  return raw.map((o) => {
    if (!isObj(o)) bad(file, "a learning objective is not an object");
    const id = str(o.id, 64);
    const statement = str(o.statement, 1000);
    const criteria = strs(o.criteria, MAX_ITEMS);
    if (
      !id ||
      !isSafeId(id) ||
      statement === null ||
      !criteria ||
      !criteria.every(isSafeId) ||
      typeof o.incomplete !== "boolean"
    )
      bad(file, "a learning objective is invalid");
    return { id, statement, criteria, incomplete: o.incomplete };
  });
}

function parseSubject(
  file: string,
  raw: Record<string, unknown>,
): DraftSubject {
  const group = raw.kind === "group";
  if (raw.kind !== "participant" && !group)
    bad(file, "kind is neither participant nor group");
  const role = group
    ? GROUP
    : str((raw.participant as Record<string, unknown> | undefined)?.role, 64);
  if (!role || !isFileSafeId(role))
    bad(file, "the role id is not a safe file name");
  if (file !== `${role}.json`)
    bad(file, "the file name does not match the role");
  const ev = raw.evaluation;
  if (!isObj(ev) || typeof ev.status !== "string")
    bad(file, "evaluation is missing");
  let summary: Summary | null = null;
  if (!group) {
    const s = raw.summary;
    if (!isObj(s)) bad(file, "summary is missing");
    const strengths = strs(s.strengths);
    const dev = strs(s.development_points);
    const na =
      Array.isArray(s.next_actions) &&
      s.next_actions.length <= 50 &&
      s.next_actions.every(
        (a) =>
          isObj(a) && typeof a.lo === "string" && typeof a.action === "string",
      )
        ? (s.next_actions as { lo: string; action: string }[])
        : null;
    if (!strengths || !dev || !na) bad(file, "summary is invalid");
    summary = {
      strengths,
      development_points: dev,
      next_actions: na.map((a) => ({ lo: a.lo, action: a.action })),
    };
  }
  return {
    id: role,
    kind: group ? "group" : "participant",
    file,
    evaluationOk: ev.status === "ok",
    criteria: parseCriteria(file, raw.criteria),
    objectives: parseObjectives(file, raw.learning_objectives),
    summary,
    raw,
  };
}

/** Reads the draft directory like untrusted input: every file hashed, every report validated, sizes capped. `only` limits it to the files a review recorded. */
export async function loadDrafts(
  dir: string,
  only?: ReadonlySet<string>,
): Promise<Drafts> {
  const names = (await readdir(dir))
    .filter(
      (n) =>
        /\.(md|json)$/.test(n) &&
        !n.startsWith("review.") &&
        (only ? only.has(n) : true),
    )
    .sort();
  const files: Record<string, string> = {};
  const subjects = new Map<string, DraftSubject>();
  let meta: {
    sessionId: string;
    scenarioId: string;
    startedAt: string;
    rubricHash: string | null;
  } | null = null;
  let legacy = false;
  for (const name of names) {
    let text: string;
    try {
      text = await readRegularCapped(path.join(dir, name), MAX_DRAFT_BYTES);
    } catch {
      bad(
        name,
        "cannot be read (too large, not a regular file or a symbolic link)",
      );
    }
    files[name] = sha256(text);
    if (!name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      bad(name, "is not valid JSON");
    }
    if (!isObj(raw) || raw.schema !== "acr.report/1")
      bad(name, "is not an acr.report/1 report");
    const s = parseSubject(name, raw);
    if (
      (raw.criteria as Record<string, unknown>[]).some(
        (c) => !Array.isArray(c.flag_codes),
      )
    )
      legacy = true;
    const session = raw.session as Record<string, unknown> | undefined;
    const scenario = raw.scenario as Record<string, unknown> | undefined;
    const evaluator = raw.evaluator as Record<string, unknown> | undefined;
    const m = {
      sessionId: str(session?.id, 64) ?? "",
      scenarioId: str(scenario?.id, 64) ?? "",
      startedAt: str(session?.date, 64) ?? "",
      rubricHash: str(evaluator?.rubricHash, 128),
    };
    if (!isSafeId(m.sessionId) || !isSafeId(m.scenarioId))
      bad(name, "session or scenario id is not a safe id");
    if (
      meta &&
      (meta.sessionId !== m.sessionId || meta.scenarioId !== m.scenarioId)
    )
      bad(
        name,
        "belongs to a different session or scenario than the other reports",
      );
    meta = m;
    subjects.set(s.id, s);
  }
  if (!meta || !subjects.has(GROUP) || subjects.size < 2)
    throw new ReviewCorruptError(
      "this directory does not hold a complete set of draft reports (a group report and at least one player)",
    );
  return { ...meta, legacy, subjects, files };
}
```

- [ ] **Step 8: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review src/evaluator` Expected: PASS (if `alice` criteria ids or summary text differ from the fixture, correct the expected values from the fixture; do not loosen the shape checks).

- [ ] **Step 9: Commit.**

```bash
git add services/runtime/src
git commit -m "[feat] US-0041: structured flag codes in drafts and a validating draft loader"
```

### Task 4: The pure fold for moderation events

**Files:**

- Create: `services/runtime/src/review/gate.ts`, `services/runtime/src/review/fold.ts`
- Test: `services/runtime/src/review/__tests__/fold.test.ts`

**Interfaces:**

- Consumes: `Drafts`, `DraftSubject`, `DraftCriterion` (Task 3); event types (Task 1); `aggregateObjectives`, `INVALID`, `LoResult`, `CriterionScore` from `../evaluator/aggregate.js`; `sha256`; `ReviewIllegalError`.
- Produces (exact):

```ts
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
  resolution: {
    seq: number;
    outcome: Outcome;
    reason: string;
    by: string;
  } | null;
};
export type Snapshot = {
  version: number;
  criteria: CriterionView[];
  summary: Summary | null;
  summaryEdited: boolean;
  objectives: LoResult[];
  table: GroupTable | null;
};
export type GroupTable = {
  objectives: {
    id: string;
    statement: string;
    byRole: Record<string, LoResult | null>;
    team: LoResult | null;
  }[];
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
  objectives: LoResult[];
  versions: number[];
  snapshot: Snapshot | null;
  comments: CommentView[];
  responses: ResponseView[];
  tableStale: boolean;
};
export type View = {
  opened: Extract<ReviewEvent, { type: "review.opened" }>;
  subjects: Map<string, SubjectView>;
  superseded: string | null;
  lastSeq: number;
};
export function currentView(drafts: Drafts, events: ReviewEvent[]): View;
export function releaseProblems(sv: SubjectView): string[]; // gate.ts
```

- [ ] **Step 1: Write the failing fold tests.** Use `makeDraftDir`, `loadDrafts`, and a helper that builds events with `sealEntries`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { currentView } from "../fold.js";
import { sealEntries } from "../review-log.js";
import { sha256 } from "../hash.js";
import {
  POLICY_VERSION,
  REVIEW_SCHEMA,
  ZERO_HASH,
  type Body,
  type Actor,
  type ReviewEvent,
} from "../types.js";
import { ReviewIllegalError } from "../errors.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

let root: string, drafts: Drafts;
beforeEach(async () => {
  const m = await makeDraftDir();
  root = m.root;
  drafts = await loadDrafts(m.dir);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fac: Actor = { kind: "facilitator", by: "kamal" };
const opened = (): Body => ({
  type: "review.opened",
  schema: REVIEW_SCHEMA,
  policyVersion: POLICY_VERSION,
  legacy: false,
  session: {
    id: drafts.sessionId,
    logSha256: null,
    startedAt: drafts.startedAt,
  },
  scenario: { id: drafts.scenarioId, sha256: null },
  rubricHash: drafts.rubricHash,
  files: drafts.files,
  codes: null,
});
function log(...bodies: Body[]): ReviewEvent[] {
  return sealEntries(
    [],
    ZERO_HASH,
    [opened(), ...bodies].map((body) => ({ actor: fac, body })),
    fixedClock(),
  );
}
const fold = (...b: Body[]) => currentView(drafts, log(...b));
const aliceNeeds = () =>
  [...drafts.subjects.get("alice")!.criteria]
    .filter((c) => c.confidence !== "high" || c.flags.length > 0 || c.invalid)
    .map((c) => c.id);

describe("currentView (moderation)", () => {
  it("starts every subject in draft, marking low-confidence and flagged criteria as needing review", () => {
    const v = fold();
    const alice = v.subjects.get("alice")!;
    expect(alice.state).toBe("draft");
    expect(
      alice.criteria.filter((c) => c.needsReview).map((c) => c.id),
    ).toEqual(aliceNeeds());
    expect(alice.criteria.find((c) => c.id === "discovery")!.status).toBe(
      "clear",
    );
    expect(v.lastSeq).toBe(1);
  });
  it("treats a valid Not-observed criterion with no flag as clear (P6)", () => {
    const d = drafts.subjects.get("alice")!.criteria[0]!;
    Object.assign(d, {
      score: null,
      confidence: null,
      flags: [],
      flag_codes: [],
      invalid: false,
    });
    expect(fold().subjects.get("alice")!.criteria[0]!.needsReview).toBe(false);
  });
  it("applies an edit: current level, history, status edited, recomputed objectives, stale summary", () => {
    const before = fold().subjects.get("alice")!;
    const c = before.criteria.find((x) => x.id === "listening")!;
    const to = c.current === 4 ? 3 : 4;
    const v = fold({
      type: "score.edited",
      subject: "alice",
      criterion: "listening",
      from: c.current,
      to,
      reason: "Heard it in scene 2",
    });
    const a = v.subjects.get("alice")!;
    const l = a.criteria.find((x) => x.id === "listening")!;
    expect(l.current).toBe(to);
    expect(l.ai).toBe(c.current);
    expect(l.status).toBe("edited");
    expect(l.edits).toEqual([
      {
        seq: 2,
        from: c.current,
        to,
        reason: "Heard it in scene 2",
        by: "kamal",
      },
    ]);
    expect(a.summaryStale).toBe(true);
    expect(a.objectives).not.toEqual(before.objectives);
  });
  it("accepting resolves a needs-review criterion; an edit after an acceptance wins", () => {
    const id = aliceNeeds()[0]!;
    const v = fold({ type: "score.accepted", subject: "alice", criterion: id });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === id)!.status,
    ).toBe("accepted");
  });
  it("edits the rationale only against the matching hash, and the summary clears staleness", () => {
    const cur = fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "listening")!;
    const v = fold({
      type: "rationale.edited",
      subject: "alice",
      criterion: "listening",
      fromHash: sha256(cur.rationale),
      text: "Better words",
      reason: "clarity",
    });
    expect(
      v.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!
        .rationale,
    ).toBe("Better words");
    const lvl = cur.current === 4 ? 3 : 4;
    const s = fold(
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: cur.current,
        to: lvl,
        reason: "r",
      },
      { type: "summary.accepted", subject: "alice" },
    );
    expect(s.subjects.get("alice")!.summaryStale).toBe(false);
  });
  it("records comments with their visibility, on a subject or a criterion", () => {
    const v = fold(
      {
        type: "comment.added",
        subject: "alice",
        text: "note",
        visibility: "internal",
      },
      {
        type: "comment.added",
        subject: "alice",
        criterion: "listening",
        text: "fb",
        visibility: "feedback",
      },
    );
    expect(
      v.subjects.get("alice")!.comments.map((c) => [c.visibility, c.criterion]),
    ).toEqual([
      ["internal", undefined],
      ["feedback", "listening"],
    ]);
  });
});

describe("currentView rejects illegal sequences", () => {
  const cur = () =>
    fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
  it.each([
    [
      "an unknown subject",
      () => fold({ type: "score.accepted", subject: "carol", criterion: "x" }),
    ],
    [
      "an unknown criterion",
      () =>
        fold({ type: "score.accepted", subject: "alice", criterion: "nope" }),
    ],
    [
      "a stale from (compare-and-set)",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur() === 1 ? 2 : 1,
          to: 3,
          reason: "r",
        }),
    ],
    [
      "an unchanged level",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur(),
          to: cur() as 1,
          reason: "r",
        }),
    ],
    [
      "an empty reason",
      () =>
        fold({
          type: "score.edited",
          subject: "alice",
          criterion: "listening",
          from: cur(),
          to: cur() === 4 ? 3 : 4,
          reason: "",
        }),
    ],
    [
      "a rationale edit against the wrong hash",
      () =>
        fold({
          type: "rationale.edited",
          subject: "alice",
          criterion: "listening",
          fromHash: "0".repeat(64),
          text: "x",
          reason: "r",
        }),
    ],
    [
      "a summary edit on the group",
      () =>
        fold({
          type: "summary.edited",
          subject: "group",
          summary: { strengths: [], development_points: [], next_actions: [] },
          reason: "r",
        }),
    ],
    [
      "accepting twice",
      () =>
        fold(
          { type: "score.accepted", subject: "alice", criterion: "listening" },
          { type: "score.accepted", subject: "alice", criterion: "listening" },
        ),
    ],
    [
      "an event type that arrives in a later story",
      () => fold({ type: "report.released", subjects: ["alice"] }),
    ],
  ])("%s", (_name, run) => {
    expect(run).toThrow(ReviewIllegalError);
  });
  it("rejects a log that does not start with review.opened, a second review.opened, a gap in seq and a superseded review", () => {
    const e = log();
    expect(() => currentView(drafts, [])).toThrow(ReviewIllegalError);
    expect(() => currentView(drafts, [{ ...e[0]!, seq: 2 }])).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      currentView(
        drafts,
        sealEntries(
          [],
          ZERO_HASH,
          [
            {
              actor: fac,
              body: {
                type: "comment.added",
                subject: "alice",
                text: "x",
                visibility: "internal",
              },
            },
          ],
          fixedClock(),
        ),
      ),
    ).toThrow(ReviewIllegalError);
    expect(() => fold(opened())).toThrow(ReviewIllegalError);
    const gap = log({
      type: "comment.added",
      subject: "alice",
      text: "x",
      visibility: "internal",
    });
    gap[1]!.seq = 5;
    expect(() => currentView(drafts, gap)).toThrow(ReviewIllegalError);
    expect(() =>
      fold(
        { type: "review.superseded", by: "sess1-2" },
        {
          type: "comment.added",
          subject: "alice",
          text: "x",
          visibility: "internal",
        },
      ),
    ).toThrow(ReviewIllegalError);
    expect(fold({ type: "review.superseded", by: "sess1-2" }).superseded).toBe(
      "sess1-2",
    );
  });
  it("is total: shuffled and truncated random event lists either fold or throw ReviewIllegalError, never anything else", () => {
    const pool: Body[] = [
      { type: "score.accepted", subject: "alice", criterion: "listening" },
      { type: "score.accepted", subject: "bob", criterion: "listening" },
      {
        type: "comment.added",
        subject: "group",
        text: "x",
        visibility: "feedback",
      },
      { type: "summary.accepted", subject: "alice" },
      {
        type: "score.edited",
        subject: "alice",
        criterion: "listening",
        from: 1,
        to: 2,
        reason: "r",
      },
      { type: "review.superseded", by: "x" },
    ];
    let seed = 7;
    const rnd = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 200; i++) {
      const picks = Array.from(
        { length: Math.floor(rnd() * 6) },
        () => pool[Math.floor(rnd() * pool.length)]!,
      );
      try {
        currentView(drafts, log(...picks));
      } catch (e) {
        expect(e).toBeInstanceOf(ReviewIllegalError);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold.test.ts` Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `gate.ts`.**

```ts
import type { SubjectView } from "./fold.js";

/** Why this subject cannot be released yet (empty: it can). Pure. Messages carry only ids. */
export function releaseProblems(sv: SubjectView): string[] {
  const out: string[] = [];
  if (!sv.evaluationOk) {
    const todo = sv.criteria
      .filter((c) => c.status !== "edited")
      .map((c) => c.id);
    if (todo.length)
      out.push(
        `the evaluation failed; score these by hand first: ${todo.join(", ")}`,
      );
  } else {
    const open = sv.criteria
      .filter((c) => c.status === "needs_review")
      .map((c) => c.id);
    if (open.length)
      out.push(`needs review (accept or edit): ${open.join(", ")}`);
  }
  if (sv.summaryStale)
    out.push(
      "the summary may be out of date after a score change: edit it or accept it",
    );
  return out;
}
```

- [ ] **Step 4: Implement `fold.ts`.**

```ts
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
import {
  GROUP,
  LIMITS,
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
  objectives: LoResult[];
  versions: number[];
  snapshot: Snapshot | null;
  comments: CommentView[];
  responses: ResponseView[];
  tableStale: boolean;
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
    objectives: [],
    versions: [],
    snapshot: null,
    comments: [],
    responses: [],
    tableStale: false,
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
  const roles = [...subjects.values()].filter((s) => s.kind === "participant");
  const team = subjects.get(GROUP)!;
  return {
    objectives: cov.map((o) => ({
      id: o.id,
      statement: o.statement,
      byRole: Object.fromEntries(
        roles.map((r) => [
          r.id,
          r.objectives.find((x) => x.id === o.id) ?? null,
        ]),
      ),
      team: team.objectives.find((x) => x.id === o.id) ?? null,
    })),
  };
}

/** The current state: drafts plus the review log, folded. Pure and total: a view, or ReviewIllegalError. */
export function currentView(drafts: Drafts, events: ReviewEvent[]): View {
  const first = events[0];
  if (!first || first.type !== "review.opened")
    throw new ReviewIllegalError("the log does not start with review.opened");
  const ill = (e: ReviewEvent, m: string): never => {
    throw new ReviewIllegalError(`event ${e.seq} (${e.type}): ${m}`);
  };
  const subjects = new Map<string, SubjectView>(
    [...drafts.subjects.values()].map((d) => [d.id, initSubject(d)]),
  );
  const subj = (e: ReviewEvent, id: string): SubjectView =>
    subjects.get(id) ??
    ill(e, `unknown subject ${JSON.stringify(String(id).slice(0, 40))}`);
  const crit = (e: ReviewEvent, sv: SubjectView, id: string): CriterionView =>
    sv.criteria.find((c) => c.id === id) ??
    ill(e, `unknown criterion ${JSON.stringify(String(id).slice(0, 40))}`);
  const editable = (e: ReviewEvent, sv: SubjectView): void => {
    if (sv.state === "released" || sv.state === "withdrawn")
      ill(e, `${sv.id} is ${sv.state}; amend it first`);
  };
  const facilitator = (e: ReviewEvent): string =>
    e.actor.kind === "facilitator"
      ? e.actor.by
      : ill(e, "only a facilitator can do this");
  const reason = (e: ReviewEvent, r: unknown): string =>
    typeof r === "string" && r.length >= 1 && r.length <= LIMITS.reason
      ? r
      : ill(e, "a reason of 1 to 500 characters is required");
  const text = (e: ReviewEvent, t: unknown): string =>
    typeof t === "string" && t.length >= 1 && t.length <= LIMITS.text
      ? t
      : ill(e, "text of 1 to 1,500 characters is required");
  let superseded: string | null = null;
  let expected = 1;

  for (const e of events) {
    if (e.seq !== expected) ill(e, `expected seq ${expected}`);
    expected++;
    if (e.type === "review.opened") {
      if (e.seq !== 1) ill(e, "review.opened can only be the first event");
      continue;
    }
    if (superseded !== null)
      ill(e, "the review was superseded and is read-only");
    switch (e.type) {
      case "score.edited": {
        const by = facilitator(e);
        const sv = subj(e, e.subject);
        const c = crit(e, sv, e.criterion);
        editable(e, sv);
        if (e.from !== c.current)
          ill(
            e,
            `from ${String(e.from)} does not match the current level ${String(c.current)}`,
          );
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
        const g = subjects.get(GROUP);
        if (sv.kind === "participant" && g && g.versions.length > 0)
          g.tableStale = true;
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
        c.status = "edited";
        break;
      }
      case "summary.edited": {
        facilitator(e);
        const sv = subj(e, e.subject);
        editable(e, sv);
        if (sv.summary === null) ill(e, "this subject has no summary");
        reason(e, e.reason);
        sv.summary = e.summary;
        sv.summaryEdited = true;
        sv.summaryStale = false;
        break;
      }
      case "summary.accepted": {
        facilitator(e);
        const sv = subj(e, e.subject);
        editable(e, sv);
        if (sv.summary === null) ill(e, "this subject has no summary");
        sv.summaryStale = false;
        break;
      }
      case "score.accepted": {
        facilitator(e);
        const sv = subj(e, e.subject);
        const c = crit(e, sv, e.criterion);
        editable(e, sv);
        if (c.status === "accepted" || c.status === "edited")
          ill(e, `${c.id} is already ${c.status}`);
        c.status = "accepted";
        break;
      }
      case "comment.added": {
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
        superseded = e.by;
        break;
      default:
        ill(e, "this event type is not supported yet");
    }
  }
  return { opened: first, subjects, superseded, lastSeq: expected - 1 };
}
```

- [ ] **Step 5: Run to verify it passes.** Same command. Expected: PASS. If the `it.each` "event type that arrives in a later story" breaks in Task 9 when that event becomes supported, replace that row with a still-unsupported illegal case there (Task 9 owns that edit).

- [ ] **Step 6: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0041: pure fold of the review log with the release gate rules"
```

### Task 5: The store (open, load, apply under one lock)

**Files:**

- Create: `services/runtime/src/review/store.ts`
- Test: `services/runtime/src/review/__tests__/store.test.ts`

**Interfaces:**

- Consumes: `readReview`, `sealEntries`, `writeEvents`, `withReviewLock`; `loadDrafts`; `currentView`; errors; `JoinCodes` and `codesFileName`/`MAX_CODES_FILE_BYTES` from `../engine/join-code-file.js` / `join-codes.js`.
- Produces:

```ts
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
export function openReview(dir: string, meta: OpenMeta): Promise<Loaded>;
export function loadReview(dir: string): Promise<Loaded>;
export function applyCommand(
  dir: string,
  now: () => number,
  build: (l: Loaded) => Entry[],
): Promise<{ loaded: Loaded; appended: ReviewEvent[] }>;
export function readCodesRecord(
  codesDir: string,
  sessionId: string,
): Promise<Record<string, unknown> | null>;
```

- [ ] **Step 1: Write the failing tests** (`store.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyCommand, loadReview, openReview } from "../store.js";
import { readReview } from "../review-log.js";
import { ReviewCorruptError, ReviewRefusedError } from "../errors.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const fac = { kind: "facilitator", by: "kamal" } as const;

describe("openReview / loadReview", () => {
  it("opens once, records the file hashes and policy version, and refuses a second open", async () => {
    const l = await openReview(dir, { by: "kamal", now: fixedClock() });
    expect(l.events).toHaveLength(1);
    const o = l.view.opened;
    expect(o.policyVersion).toBe(1);
    expect(o.session.id).toBe("sess1");
    expect(Object.keys(o.files)).toContain("alice.json");
    await expect(
      openReview(dir, { by: "kamal", now: fixedClock() }),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
  });
  it("refuses to load before open, with the next step in the message", async () => {
    await expect(loadReview(dir)).rejects.toThrow(/open/);
  });
  it("refuses everything when a draft file changed or disappeared after open, and ignores a new unrecorded file", async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    await writeFile(path.join(dir, "extra.json"), "{}");
    await expect(loadReview(dir)).resolves.toBeTruthy();
    const f = path.join(dir, "alice.md");
    await writeFile(f, (await readFile(f, "utf8")) + "tampered");
    await expect(loadReview(dir)).rejects.toThrow(/alice\.md/);
    await rm(f);
    await expect(loadReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
  it("turns an illegal sequence in an existing log into a corrupt-review error", async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
    await applyCommand(dir, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "x",
          visibility: "internal",
        },
      },
    ]);
    const f = path.join(dir, "review.jsonl");
    const lines = (await readFile(f, "utf8")).trimEnd().split("\n");
    await writeFile(f, lines.slice(0, 1).join("\n") + "\n" + lines[0] + "\n"); // a second review.opened with a broken chain
    await expect(loadReview(dir)).rejects.toBeInstanceOf(ReviewCorruptError);
  });
});

describe("applyCommand", () => {
  beforeEach(async () => {
    await openReview(dir, { by: "kamal", now: fixedClock() });
  });
  it("appends valid entries in one step and returns the new view", async () => {
    const r = await applyCommand(dir, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "one",
          visibility: "internal",
        },
      },
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "two",
          visibility: "internal",
        },
      },
    ]);
    expect(r.appended.map((e) => e.seq)).toEqual([2, 3]);
    expect((await readReview(dir)).events).toHaveLength(3);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.comments,
    ).toHaveLength(2);
  });
  it("writes nothing when the new entries are illegal, and exits as a refusal", async () => {
    await expect(
      applyCommand(dir, fixedClock(), () => [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: "nope" },
        },
      ]),
    ).rejects.toBeInstanceOf(ReviewRefusedError);
    expect((await readReview(dir)).events).toHaveLength(1);
  });
  it("lets only one of two racing commands through; the loser is refused and the log stays valid", async () => {
    const id = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.status === "needs_review")!.id;
    const accept = () =>
      applyCommand(dir, fixedClock(), () => [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: id },
        },
      ]);
    const results = await Promise.allSettled([accept(), accept()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ReviewRefusedError);
    expect((await loadReview(dir)).events).toHaveLength(2);
  });
  it("does nothing, and writes nothing, when build returns no entries", async () => {
    const r = await applyCommand(dir, fixedClock(), () => []);
    expect(r.appended).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/store.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `store.ts`.**

```ts
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
    const body = {
      type: "review.opened" as const,
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
```

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS. The race test depends on the lock; if the in-process second holder reports a code other than `locked`/`contention`, fix the mapping in `withReviewLock`, not the test.
- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0041: review store (open, verified load, validated append under one lock)"
```

### Task 6: Render the moderated view

**Files:**

- Modify: `services/runtime/src/evaluator/report-model.ts` (`Common.status`/`schema` widen, `JsonCriterion.moderation?`), `services/runtime/src/evaluator/report-md.ts` (banner and visibility from the report object, adjusted criteria, comments), `services/runtime/src/evaluator/method.ts` (new banner texts)
- Create: `services/runtime/src/review/view.ts`
- Test: `services/runtime/src/review/__tests__/view.test.ts`, extend `services/runtime/src/evaluator/__tests__/reports.test.ts` (drafts unchanged)

**Interfaces:**

- Consumes: `ParticipantReport`, `GroupReport`, `JsonCriterion` (report-model); `SubjectView`, `View`; `renderParticipantMarkdown`, `renderGroupMarkdown`.
- Produces:

```ts
// report-model.ts
export type Moderation = {
  adjusted: boolean;
  ai_score: number | null;
  ai_label: string;
  reason: string | null;
  by: string | null;
  rationale_edited: boolean;
  accepted: boolean;
};
// JsonCriterion gains: flag_codes (Task 3) and  moderation?: Moderation
// method.ts
export const IN_REVIEW_BANNER: string;
export const releasedBanner: (version: number, by: string[]) => string;
export const FACILITATOR_ONLY_LINE: string;
// view.ts
export type RenderAudience =
  { audience: "facilitator" } | { audience: "released"; line: string };
export function viewReport(
  draft: ParticipantReport | GroupReport,
  view: View,
  subject: string,
  a: RenderAudience,
): ParticipantReport | GroupReport;
export function renderSubjectMarkdown(
  report: ParticipantReport | GroupReport,
  secrets: string[],
): string;
```

`viewReport` returns a copy of the draft JSON with: final scores/labels per criterion, `moderation` info, recomputed `learning_objectives`, edited rationale and summary, group `lo_coverage` rebuilt from the view, `schema: "acr.view/1"`, `status` "moderated", `draft_notice` and `visibility` per audience, notes extended with the moderation note, and `evaluator.calibration_line` prefixed `AI draft calibration (not the calibration of the final scores): `.

- [ ] **Step 1: Write the failing tests** (`view.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { applyCommand, openReview } from "../store.js";
import { viewReport, renderSubjectMarkdown } from "../view.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";
import type { ParticipantReport } from "../../evaluator/report-model.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  await openReview(dir, { by: "kamal", now: fixedClock() });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const fac = { kind: "facilitator", by: "kamal" } as const;
const draftOf = async (s: string) =>
  JSON.parse(
    await readFile(path.join(dir, `${s}.json`), "utf8"),
  ) as ParticipantReport;

describe("viewReport / renderSubjectMarkdown", () => {
  it("shows an unreviewed subject as in review, facilitator only, with the AI scores and no 'adjusted' marks", async () => {
    const { loadReview } = await import("../store.js");
    const l = await loadReview(dir);
    const r = viewReport(await draftOf("alice"), l.view, "alice", {
      audience: "facilitator",
    }) as ParticipantReport;
    const md = renderSubjectMarkdown(r, []);
    expect(r.schema).toBe("acr.view/1");
    expect(r.status).toBe("moderated");
    expect(md).toContain("IN REVIEW");
    expect(md).toContain("Visibility: facilitator only");
    expect(md).not.toContain("Facilitator-adjusted");
    expect(md).toContain("AI draft calibration");
    expect(r.criteria.every((c) => c.moderation?.adjusted === false)).toBe(
      true,
    );
  });
  it("shows an edited criterion as Facilitator-adjusted with the AI original and the reason, and recomputes the objectives", async () => {
    const a0 = await draftOf("alice");
    const c0 = a0.criteria.find((c) => c.id === "listening")!;
    const to = c0.score === 4 ? 3 : 4;
    const { loaded } = await applyCommand(dir, fixedClock(), (l) => {
      const cur = l.view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.current;
      return [
        {
          actor: fac,
          body: {
            type: "score.edited",
            subject: "alice",
            criterion: "listening",
            from: cur,
            to,
            reason: "Heard in scene 2 <b>x</b>",
          },
        },
      ];
    });
    const r = viewReport(a0, loaded.view, "alice", {
      audience: "facilitator",
    }) as ParticipantReport;
    const c = r.criteria.find((x) => x.id === "listening")!;
    expect(c.score).toBe(to);
    expect(c.moderation).toMatchObject({
      adjusted: true,
      ai_score: c0.score,
      reason: "Heard in scene 2 <b>x</b>",
      by: "kamal",
    });
    const md = renderSubjectMarkdown(r, []);
    expect(md).toContain("Facilitator-adjusted");
    expect(md).toContain("AI draft");
    expect(md).not.toContain("<b>");
    expect(r.notes.join(" ")).toMatch(/moderated by a facilitator \(kamal\)/);
    expect(r.learning_objectives).not.toEqual(a0.learning_objectives);
    expect(r.summary).toEqual(a0.summary);
  });
  it("does not modify the draft object it was given", async () => {
    const { loadReview } = await import("../store.js");
    const l = await loadReview(dir);
    const a0 = await draftOf("alice");
    const copy = JSON.stringify(a0);
    viewReport(a0, l.view, "alice", { audience: "facilitator" });
    expect(JSON.stringify(a0)).toBe(copy);
  });
  it("renders facilitator-only internal comments only for the facilitator audience", async () => {
    const { loaded } = await applyCommand(dir, fixedClock(), () => [
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "INTERNAL-NOTE",
          visibility: "internal",
        },
      },
      {
        actor: fac,
        body: {
          type: "comment.added",
          subject: "alice",
          text: "FEEDBACK-NOTE",
          visibility: "feedback",
        },
      },
    ]);
    const a0 = await draftOf("alice");
    const f = renderSubjectMarkdown(
      viewReport(a0, loaded.view, "alice", { audience: "facilitator" }),
      [],
    );
    expect(f).toContain("INTERNAL-NOTE");
    expect(f).toContain("FEEDBACK-NOTE");
  });
});
```

(Participant-audience rendering of comments is tested in Task 10 once release exists; here only the facilitator audience.)

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/view.test.ts` Expected: FAIL.

- [ ] **Step 3: Edit the renderers (small, mechanical).**
  - `report-model.ts`: widen `Common.status` to `"draft" | "moderated" | "released"` and `schema` to `typeof REPORT_SCHEMA | "acr.view/1"`; add the `Moderation` type and `moderation?: Moderation` to `JsonCriterion`; export `loScoreText`/`scoreText` unchanged. Add to `ParticipantReport` and `GroupReport` an optional `comments?: { criterion?: string; text: string; by: string; visibility: "internal" | "feedback" }[]` and `self?`/`responses?` are added in Task 15.
  - `method.ts`: add `IN_REVIEW_BANNER = "IN REVIEW: AI-drafted and partly reviewed by a facilitator - not released"`, `FACILITATOR_ONLY_LINE = "Visibility: facilitator only until released"`, `releasedBanner = (version, by) => \`Reviewed by ${by.join(", ")} and released (version ${version})\``. Change `DRAFT_BANNER`to`"DRAFT: AI-drafted, not reviewed by a facilitator"`and`VISIBILITY_LINE`to`"Visibility: facilitator only until released"` (the draft files no longer claim "visible to all participants" or "editing is planned"; spec section 3). Update every test and doc that quotes the old strings (`grep -rn "all participants" services docs README.md`; the exact-string test in `reports.test.ts` around line 36 changes).
  - `report-md.ts`: in `header()` replace `DRAFT_BANNER` and `VISIBILITY_LINE` with `r.draft_notice` and `r.visibility`; in `criteriaTable` append, after the flags text, ` - **Facilitator-adjusted** from ${scoreText(ai)} (${reason})` when `c.moderation?.adjusted`, built with `safeMd` for the reason; add after `## Criteria` a `## Facilitator notes` section listing `r.comments` (each `safeMd(text, 1500)` with its criterion id, only when present). `renderMethodMarkdown` keeps using the constants.
  - Re-run `pnpm --filter @acr/runtime exec vitest run src/evaluator src/demo` and update the string expectations (demo counts must not change).

- [ ] **Step 4: Implement `view.ts`.**

```ts
import { INVALID_LABEL, levelLabel } from "../evaluator/aggregate.js";
import type { LoResult } from "../evaluator/aggregate.js";
import {
  FACILITATOR_ONLY_LINE,
  IN_REVIEW_BANNER,
  releasedBanner,
} from "../evaluator/method.js";
import {
  renderGroupMarkdown,
  renderParticipantMarkdown,
} from "../evaluator/report-md.js";
import type {
  GroupReport,
  JsonCriterion,
  JsonObjective,
  Moderation,
  ParticipantReport,
} from "../evaluator/report-model.js";
import {
  who,
  type CriterionView,
  type SubjectView,
  type View,
} from "./fold.js";
import { VIEW_SCHEMA } from "./types.js";

export type RenderAudience =
  { audience: "facilitator" } | { audience: "released"; line: string };
const AI_PREFIX =
  "AI draft calibration (not the calibration of the final scores): ";

const jsonLo = (o: LoResult): JsonObjective => ({
  id: o.id,
  statement: o.statement,
  score: o.score,
  label: o.label,
  criteria: o.criteria,
  observed: o.observed,
  incomplete: o.incomplete,
});

function criterion(c: JsonCriterion, v: CriterionView): JsonCriterion {
  const adjusted = v.edits.length > 0;
  const last = v.edits.at(-1);
  const moderation: Moderation = {
    adjusted,
    ai_score: c.score,
    ai_label: c.level_label,
    reason: last?.reason ?? null,
    by: last?.by ?? v.rationaleEdits.at(-1)?.by ?? null,
    rationale_edited: v.rationaleEdits.length > 0,
    accepted: v.status === "accepted",
  };
  const invalid = v.current === "invalid";
  return {
    ...c,
    score: invalid ? null : v.current,
    level_label: invalid ? INVALID_LABEL : levelLabel(v.current),
    invalid,
    rationale: v.rationale,
    moderation,
  };
}

/** The draft report with the review applied. Pure; the draft object is not modified. Banner and visibility line follow the audience. */
export function viewReport(
  draft: ParticipantReport | GroupReport,
  view: View,
  subject: string,
  a: RenderAudience,
): ParticipantReport | GroupReport {
  const sv = view.subjects.get(subject) as SubjectView;
  const names = [
    ...new Set([
      ...sv.criteria.flatMap((c) =>
        [...c.edits, ...c.rationaleEdits].map((e) => e.by),
      ),
      ...sv.comments.map((c) => c.by),
    ]),
  ];
  const edited = sv.criteria.filter((c) => c.edits.length > 0).length;
  const base = {
    ...structuredClone(draft),
    schema: VIEW_SCHEMA,
    status: "moderated" as const,
    draft_notice:
      a.audience === "facilitator"
        ? IN_REVIEW_BANNER
        : releasedBanner(sv.versions.at(-1) ?? 0, names),
    visibility: a.audience === "facilitator" ? FACILITATOR_ONLY_LINE : a.line,
    criteria: draft.criteria.map((c) =>
      criterion(
        c,
        sv.criteria.find((x) => x.id === c.id)!,
      ),
    ),
  };
  base.evaluator = {
    ...base.evaluator,
    calibration_line: `${AI_PREFIX}${base.evaluator.calibration_line}`,
  };
  base.notes = [
    ...base.notes,
    `Scores were moderated by a facilitator${names.length ? ` (${names.join(", ")})` : ""}; ${edited} of ${sv.criteria.length} criteria were changed.`,
  ];
  const comments = sv.comments
    .filter((c) => a.audience === "facilitator" || c.visibility === "feedback")
    .map((c) => ({
      ...(c.criterion ? { criterion: c.criterion } : {}),
      text: c.text,
      by: c.by,
      visibility: c.visibility,
    }));
  if (draft.kind === "participant") {
    const r = base as ParticipantReport;
    r.learning_objectives = sv.objectives.map(jsonLo);
    if (sv.summary) r.summary = structuredClone(sv.summary);
    if (comments.length) r.comments = comments;
    return r;
  }
  const g = base as GroupReport;
  if (g.learning_objectives.length)
    g.learning_objectives = sv.objectives.map(jsonLo);
  const roles = [...view.subjects.values()].filter(
    (s) => s.kind === "participant",
  );
  g.lo_coverage = {
    players: roles.map((r) => r.id),
    objectives: draft.lo_coverage.objectives.map((o) => {
      const pick = (x: LoResult | undefined) => ({
        score: x?.score ?? null,
        label: x?.label ?? "Not observed",
        incomplete: x?.incomplete ?? false,
      });
      return {
        id: o.id,
        statement: o.statement,
        by_role: Object.fromEntries(
          roles.map((r) => [
            r.id,
            pick(r.objectives.find((x) => x.id === o.id)),
          ]),
        ),
        team: pick(sv.objectives.find((x) => x.id === o.id)),
      };
    }),
  };
  if (comments.length) g.comments = comments;
  return g;
}

export function renderSubjectMarkdown(
  report: ParticipantReport | GroupReport,
  secrets: string[],
): string {
  return report.kind === "participant"
    ? renderParticipantMarkdown(report, secrets)
    : renderGroupMarkdown(report, secrets);
}

export { who };
```

Remove the stray `export { who }` and unused import if lint flags them. Group `learning_objectives` handled only when the draft had team objectives (`learning_objectives_note` stays otherwise).

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review src/evaluator src/demo` Expected: PASS, demo counts unchanged.
- [ ] **Step 6: Commit.**

```bash
git add services/runtime/src
git commit -m "[feat] US-0041: render the moderated view; drafts no longer claim visibility to all"
```

### Task 7: `pnpm moderate` (open, status, show, edit, accept, comment, edit-summary)

**Files:**

- Create: `services/runtime/src/review/cli.ts`, `services/runtime/src/review/main.ts`
- Modify: `package.json` (`"moderate": "pnpm -s --filter @acr/runtime moderate"`), `services/runtime/package.json` (`"moderate": "tsx src/review/main.ts"`)
- Test: `services/runtime/src/review/__tests__/cli.test.ts`

**Interfaces:**

- Consumes: store (`openReview`, `loadReview`, `applyCommand`, `readCodesRecord`), `viewReport`, `renderSubjectMarkdown`, `cleanText`, `cleanBy`, `parseLevel`, `secretValues` from `../evaluator/cli.js`, `readRegularCapped`.
- Produces: `runModerate(deps: ModerateDeps): Promise<{ exitCode: number }>` with `ModerateDeps = { argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; cwd?: string; now?: () => number }`; `MODERATE_USAGE: string`; a handler registry `HANDLERS: Record<string, Handler>` and `ALLOWED: Record<string, string[]>` that later tasks extend.

- [ ] **Step 1: Write the failing CLI tests** (`cli.test.ts`). A helper `run(...argv)` captures stdout/stderr and returns `{ code, out, err }`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runModerate, MODERATE_USAGE } from "../cli.js";
import { loadReview } from "../store.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "",
    err = "";
  const r = await runModerate({
    argv,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
    env,
    cwd: root,
    now: fixedClock(),
  });
  return { code: r.exitCode, out, err };
}
const rel = () => path.relative(root, dir);
const open = () => run(["open", rel(), "--by", "kamal"]);
const needs = async () => {
  const l = await loadReview(dir);
  return l.view.subjects
    .get("alice")!
    .criteria.filter((c) => c.status === "needs_review")
    .map((c) => c.id);
};

describe("pnpm moderate", () => {
  it("prints usage for --help and exits 2 for an unknown subcommand, a missing directory and an unknown option", async () => {
    expect((await run(["--help"])).out).toContain(
      MODERATE_USAGE.split("\n")[0],
    );
    expect((await run(["frobnicate", rel()])).code).toBe(2);
    expect((await run(["status", "nope-dir"])).code).toBe(2);
    expect((await run(["status", rel(), "--bogus"])).code).toBe(2);
  });
  it("refuses every command but open until a review is open (exit 1, says what to run)", async () => {
    const r = await run(["status", rel()]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/open/);
  });
  it("opens a review, then status lists what needs review per subject and never an absolute path", async () => {
    expect((await open()).code).toBe(0);
    const s = await run(["status", rel()]);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/alice: draft/);
    expect(s.out).toContain("needs review");
    expect(s.out).not.toContain(root);
    expect((await open()).code).toBe(1);
  });
  it("edits a score with a reason, rejects a missing or over-long reason, an unknown criterion and a bad level", async () => {
    await open();
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    const level = cur === 4 ? "3" : "4";
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "listening",
          "--level",
          level,
          "--reason",
          "Heard it",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.status,
    ).toBe("edited");
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--reason",
          "x".repeat(501),
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "nope",
          "--level",
          "2",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "9",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "edit",
          rel(),
          "alice",
          "negotiation",
          "--level",
          "2",
          "--reason",
          "r",
        ])
      ).code,
    ).toBe(2);
  });
  it("--expect is a compare-and-set: a different current level exits 1 and prints the current one", async () => {
    await open();
    const r = await run([
      "edit",
      rel(),
      "alice",
      "listening",
      "--level",
      "2",
      "--expect",
      "invalid",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/currently/);
  });
  it("edits the rationale in the same step when --rationale is given", async () => {
    await open();
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    await run([
      "edit",
      rel(),
      "alice",
      "listening",
      "--level",
      cur === 4 ? "3" : "4",
      "--rationale",
      "New words",
      "--reason",
      "clarity",
      "--by",
      "kamal",
    ]);
    expect(
      (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "listening")!.rationale,
    ).toBe("New words");
  });
  it("accepts a criterion and the summary, comments, and edits the summary", async () => {
    await open();
    const id = (await needs())[0]!;
    expect(
      (await run(["accept", rel(), "alice", id, "--by", "kamal"])).code,
    ).toBe(0);
    expect(
      (await run(["accept", rel(), "alice", "--summary", "--by", "kamal"]))
        .code,
    ).toBe(0);
    expect(
      (
        await run([
          "comment",
          rel(),
          "alice",
          "--text",
          "Good scene 2",
          "--feedback",
          "--criterion",
          "listening",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "edit-summary",
          rel(),
          "alice",
          "--strength",
          "Asked well",
          "--development",
          "Price earlier",
          "--action",
          "LO2:State two options",
          "--reason",
          "tighter",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect((await loadReview(dir)).view.subjects.get("alice")!.summary).toEqual(
      {
        strengths: ["Asked well"],
        development_points: ["Price earlier"],
        next_actions: [{ lo: "LO2", action: "State two options" }],
      },
    );
  });
  it("show prints the facilitator's rendering of the current view", async () => {
    await open();
    const r = await run(["show", rel(), "alice"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("# Feedback report: alice");
    expect(r.out).toContain("IN REVIEW");
    expect((await run(["show", rel(), "carol"])).code).toBe(1);
  });
  it("scrubs a secret out of stored free text and escapes markup when shown", async () => {
    await open();
    await run(
      [
        "comment",
        rel(),
        "alice",
        "--text",
        "key sk-live-abcdef123456 <script>x</script>",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    const log = await readFile(path.join(dir, "review.jsonl"), "utf8");
    expect(log).not.toContain("sk-live-abcdef123456");
    expect((await run(["show", rel(), "alice"])).out).not.toContain("<script>");
  });
  it("exits 2 on a damaged log and never repairs it", async () => {
    await open();
    const f = path.join(dir, "review.jsonl");
    await (await import("node:fs/promises")).appendFile(f, "garbage");
    expect((await run(["status", rel()])).code).toBe(2);
    expect((await readFile(f, "utf8")).endsWith("garbage")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/cli.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `cli.ts`.**

```ts
import { stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { scrubText } from "../demo/report.js";
import { secretValues } from "../evaluator/cli.js";
import type {
  GroupReport,
  ParticipantReport,
} from "../evaluator/report-model.js";
import { readRegularCapped } from "../util/read-regular.js";
import { readFile } from "node:fs/promises";
import {
  ReviewCorruptError,
  ReviewRefusedError,
  ReviewUsageError,
} from "./errors.js";
import { loadDrafts } from "./draft.js";
import { sha256 } from "./hash.js";
import {
  applyCommand,
  loadReview,
  openReview,
  readCodesRecord,
  type Loaded,
} from "./store.js";
import { cleanBy, cleanText, parseLevel } from "./text.js";
import { LIMITS, type Actor, type Entry } from "./types.js";
import { renderSubjectMarkdown, viewReport } from "./view.js";

export const MODERATE_USAGE = [
  "usage: pnpm moderate <subcommand> <reports-dir> [options]",
  "  open <dir> --by <name> [--session-log <file>] [--codes-dir <dir>]   start the review of a draft directory written by `pnpm evaluate`",
  "  status <dir>                                                          what is open, per subject",
  "  show <dir> <subject>                                                  the facilitator's view of one report (Markdown to stdout)",
  "  edit <dir> <subject> <criterion> --level 1|2|3|4|na --reason <text> --by <name> [--rationale <text>] [--expect <level>]",
  "  accept <dir> <subject> <criterion> --by <name>   |   accept <dir> <subject> --summary --by <name>",
  "  comment <dir> <subject> --text <text> --by <name> [--criterion <id>] [--feedback]",
  "  edit-summary <dir> <subject> --reason <text> --by <name> [--strength <t>]... [--development <t>]... [--action <lo>:<t>]...",
  "exit codes: 0 done, 1 refused (fix and retry), 2 usage error or a damaged review/draft file",
  "A subject is a player role or `group`. Free text is stored after hidden characters are stripped and secrets scrubbed.",
].join("\n");

export type Out = { write(chunk: string): unknown };
export type ModerateDeps = {
  argv: string[];
  stdout: Out;
  stderr: Out;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => number;
};
export type Ctx = {
  dir: string;
  base: string;
  now: () => number;
  secrets: string[];
  out: (m: string) => void;
  values: Record<string, string | boolean | string[] | undefined>;
  args: string[];
};
export type Handler = (c: Ctx) => Promise<number>;

const OPTIONS = {
  by: { type: "string" },
  reason: { type: "string" },
  level: { type: "string" },
  rationale: { type: "string" },
  expect: { type: "string" },
  text: { type: "string" },
  criterion: { type: "string" },
  feedback: { type: "boolean" },
  summary: { type: "boolean" },
  strength: { type: "string", multiple: true },
  development: { type: "string", multiple: true },
  action: { type: "string", multiple: true },
  "session-log": { type: "string" },
  "codes-dir": { type: "string" },
  help: { type: "boolean" },
} as const;

export const ALLOWED: Record<string, string[]> = {
  open: ["by", "session-log", "codes-dir"],
  status: [],
  show: [],
  edit: ["by", "reason", "level", "rationale", "expect"],
  accept: ["by", "summary"],
  comment: ["by", "text", "criterion", "feedback"],
  "edit-summary": ["by", "reason", "strength", "development", "action"],
};

const facilitator = (c: Ctx): Actor => ({
  kind: "facilitator",
  by: cleanBy(c.values.by),
});
const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new ReviewRefusedError(`unknown ${what}`);
  return v;
};
const lvl = (l: unknown): string => (l === null ? "na" : String(l));

function statusLines(l: Loaded): string[] {
  const out: string[] = [];
  if (l.view.superseded)
    out.push(
      `This review is superseded by ${l.view.superseded} and is read-only.`,
    );
  for (const sv of l.view.subjects.values()) {
    const open = sv.criteria.filter((c) => c.status === "needs_review");
    out.push(
      `${sv.id}: ${sv.state}${sv.versions.length ? ` (version ${sv.versions.at(-1)})` : ""}, ${open.length} of ${sv.criteria.length} criteria need review${sv.summaryStale ? ", summary may be out of date" : ""}${sv.evaluationOk ? "" : ", evaluation failed (score by hand)"}`,
    );
    for (const c of open)
      out.push(`  needs review: ${c.id} (currently ${lvl(c.current)})`);
  }
  return out;
}

export const HANDLERS: Record<string, Handler> = {
  async open(c) {
    const by = cleanBy(c.values.by);
    let sessionLogText: string | undefined;
    const logArg = c.values["session-log"];
    if (typeof logArg === "string") {
      try {
        sessionLogText = await readRegularCapped(
          path.resolve(c.base, logArg),
          64 * 1024 * 1024,
        );
      } catch {
        throw new ReviewUsageError("--session-log cannot be read");
      }
    }
    const d = await loadDrafts(c.dir);
    const codesDir =
      typeof c.values["codes-dir"] === "string"
        ? path.resolve(c.base, c.values["codes-dir"])
        : path.resolve(c.base, "data/sessions");
    const codes = await readCodesRecord(codesDir, d.sessionId);
    const l = await openReview(c.dir, {
      by,
      now: c.now,
      ...(sessionLogText !== undefined ? { sessionLogText } : {}),
      codes,
    });
    c.out(
      `review opened for session ${l.view.opened.session.id}: ${l.view.subjects.size} subjects${l.view.opened.legacy ? " (legacy drafts: no structured flag codes)" : ""}. Next: pnpm moderate status <dir>`,
    );
    return 0;
  },
  async status(c) {
    for (const line of statusLines(await loadReview(c.dir))) c.out(line);
    return 0;
  },
  async show(c) {
    const l = await loadReview(c.dir);
    const id = c.args[0];
    const sv = id ? l.view.subjects.get(id) : undefined;
    if (!id || !sv)
      throw new ReviewRefusedError("unknown subject; run status to list them");
    const draft = l.drafts.subjects.get(id)!.raw as unknown as
      ParticipantReport | GroupReport;
    c.out(
      renderSubjectMarkdown(
        viewReport(draft, l.view, id, { audience: "facilitator" }),
        c.secrets,
      ).trimEnd(),
    );
    return 0;
  },
  async edit(c) {
    const [subject, criterion] = c.args;
    if (!subject || !criterion)
      throw new ReviewUsageError("edit needs <subject> <criterion>");
    const actor = facilitator(c);
    const to = parseLevel(c.values.level);
    const reason = cleanText(
      String(c.values.reason ?? ""),
      LIMITS.reason,
      "--reason",
      c.secrets,
    );
    const rationale =
      typeof c.values.rationale === "string"
        ? cleanText(c.values.rationale, LIMITS.text, "--rationale", c.secrets)
        : undefined;
    const expect =
      typeof c.values.expect === "string" ? c.values.expect : undefined;
    if (
      expect !== undefined &&
      !["1", "2", "3", "4", "na", "invalid"].includes(expect)
    )
      throw new ReviewUsageError("--expect needs 1, 2, 3, 4, na or invalid");
    await applyCommand(c.dir, c.now, (l) => {
      const sv = need(l.view.subjects.get(subject), "subject");
      const cv = need(
        sv.criteria.find((x) => x.id === criterion),
        "criterion",
      );
      if (
        expect !== undefined &&
        expect !== (cv.current === "invalid" ? "invalid" : lvl(cv.current))
      )
        throw new ReviewRefusedError(
          `${criterion} is currently ${cv.current === "invalid" ? "invalid" : lvl(cv.current)}, not ${expect}; nothing was changed`,
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
    c.out(`${subject} ${criterion} set to ${lvl(to)}`);
    return 0;
  },
  async accept(c) {
    const [subject, criterion] = c.args;
    if (!subject)
      throw new ReviewUsageError(
        "accept needs <subject> and a <criterion> or --summary",
      );
    const actor = facilitator(c);
    if (c.values.summary === true) {
      await applyCommand(c.dir, c.now, () => [
        { actor, body: { type: "summary.accepted", subject } },
      ]);
      c.out(`${subject} summary accepted`);
      return 0;
    }
    if (!criterion)
      throw new ReviewUsageError("accept needs a <criterion> or --summary");
    await applyCommand(c.dir, c.now, () => [
      { actor, body: { type: "score.accepted", subject, criterion } },
    ]);
    c.out(`${subject} ${criterion} accepted`);
    return 0;
  },
  async comment(c) {
    const [subject] = c.args;
    if (!subject) throw new ReviewUsageError("comment needs <subject>");
    const actor = facilitator(c);
    const text = cleanText(
      String(c.values.text ?? ""),
      LIMITS.text,
      "--text",
      c.secrets,
    );
    const criterion =
      typeof c.values.criterion === "string" ? c.values.criterion : undefined;
    await applyCommand(c.dir, c.now, () => [
      {
        actor,
        body: {
          type: "comment.added",
          subject,
          ...(criterion !== undefined ? { criterion } : {}),
          text,
          visibility: c.values.feedback === true ? "feedback" : "internal",
        },
      },
    ]);
    c.out(`comment added to ${subject}`);
    return 0;
  },
  async "edit-summary"(c) {
    const [subject] = c.args;
    if (!subject) throw new ReviewUsageError("edit-summary needs <subject>");
    const actor = facilitator(c);
    const reason = cleanText(
      String(c.values.reason ?? ""),
      LIMITS.reason,
      "--reason",
      c.secrets,
    );
    const items = (v: unknown, what: string): string[] =>
      (Array.isArray(v) ? v : []).map((t) =>
        cleanText(String(t), LIMITS.item, what, c.secrets),
      );
    const summary = {
      strengths: items(c.values.strength, "--strength"),
      development_points: items(c.values.development, "--development"),
      next_actions: items(c.values.action, "--action").map((a) => {
        const i = a.indexOf(":");
        if (i < 1) throw new ReviewUsageError("--action needs <lo>:<text>");
        return { lo: a.slice(0, i), action: a.slice(i + 1).trim() };
      }),
    };
    await applyCommand(c.dir, c.now, () => [
      { actor, body: { type: "summary.edited", subject, summary, reason } },
    ]);
    c.out(`${subject} summary replaced`);
    return 0;
  },
};

export async function runModerate(
  deps: ModerateDeps,
): Promise<{ exitCode: number }> {
  const secrets = secretValues(deps.env);
  const err = (m: string) => deps.stderr.write(`${scrubText(m, secrets)}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: deps.argv,
      allowPositionals: true,
      strict: true,
      options: OPTIONS,
    });
  } catch (e) {
    err(`error: ${(e as Error).message.split("\n")[0]}\n${MODERATE_USAGE}`);
    return { exitCode: 2 };
  }
  const { values, positionals } = parsed;
  if (values.help) {
    deps.stdout.write(`${MODERATE_USAGE}\n`);
    return { exitCode: 0 };
  }
  const [sub, dirArg, ...args] = positionals;
  const handler = sub ? HANDLERS[sub] : undefined;
  if (!sub || !handler || !dirArg) {
    err(`error: give a subcommand and a reports directory\n${MODERATE_USAGE}`);
    return { exitCode: 2 };
  }
  const given = Object.keys(values).filter(
    (k) => values[k as keyof typeof values] !== undefined,
  );
  const bad = given.find((k) => !ALLOWED[sub]!.includes(k));
  if (bad) {
    err(`error: --${bad} is not an option of ${sub}\n${MODERATE_USAGE}`);
    return { exitCode: 2 };
  }
  const base = deps.cwd ?? deps.env.INIT_CWD ?? process.cwd();
  const dir = path.resolve(base, dirArg);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) {
    err("error: the reports directory does not exist");
    return { exitCode: 2 };
  }
  const ctx: Ctx = {
    dir,
    base,
    now: deps.now ?? Date.now,
    secrets,
    out: (m) => deps.stdout.write(`${scrubText(m, secrets)}\n`),
    values: values as Ctx["values"],
    args,
  };
  try {
    return { exitCode: await handler(ctx) };
  } catch (e) {
    if (e instanceof ReviewRefusedError) {
      err(`refused: ${e.message}`);
      return { exitCode: 1 };
    }
    if (e instanceof ReviewUsageError || e instanceof ReviewCorruptError) {
      err(`error: ${e.message}`);
      return { exitCode: 2 };
    }
    err("error: the command failed");
    return { exitCode: 2 };
  }
}
```

Remove the unused `readFile` import if lint flags it. Messages use only ids, never absolute paths. `deps.now` defaults to `Date.now` in production.

`review/main.ts`:

```ts
import { REPO_ROOT } from "../main.js";
import { loadLiveEnv } from "../demo/runner.js";
import { runModerate } from "./cli.js";

// Thin entry point (`pnpm moderate`): everything testable lives in cli.ts.
const env = loadLiveEnv(REPO_ROOT, process.env);
const { exitCode } = await runModerate({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  env,
});
process.exitCode = exitCode;
```

Add the two `package.json` scripts.

- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS. A real `pnpm moderate --help` from the repo root prints the usage.
- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src package.json
git commit -m "[feat] US-0041: pnpm moderate (open, status, show, edit, accept, comment, edit-summary)"
```

### Task 8: Re-runs and supersede, then close the story

**Files:**

- Modify: `services/runtime/src/review/store.ts` (`siblingReleased`, `supersedeReview`), `services/runtime/src/review/cli.ts` (`supersede` subcommand, refusal in `open`)
- Test: `services/runtime/src/review/__tests__/supersede.test.ts`
- Modify (docs): `docs/EVALUATOR.md`, `README.md`, `CHANGELOG.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md` (only if ids changed), `progress.md`

**Interfaces:**

- Produces:

```ts
export function siblingReleased(dir: string): Promise<string | null>; // name of an older sibling directory of the same session instance whose review has a release and is not superseded
export function supersedeReview(
  oldDir: string,
  newDir: string,
  o: { by: string; now: () => number },
): Promise<{ carried: string[]; fresh: string[] }>;
```

`openReview` calls `siblingReleased` and throws `ReviewRefusedError("... an earlier evaluation of this session was already released; use supersede <old> <new>")` unless called through `supersedeReview`. Same session instance = same `session.id` and (when both non-null) the same `session.logSha256`, else same `startedAt`.

- [ ] **Step 1: Write the failing tests** (`supersede.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyCommand,
  loadReview,
  openReview,
  supersedeReview,
  siblingReleased,
} from "../store.js";
import { readReview, sealEntries, writeEvents } from "../review-log.js";
import { ReviewRefusedError } from "../errors.js";
import { makeDraftDir, fixedClock } from "./fixtures.js";
import { writeReports } from "../../evaluator/report-write.js";
import { sampleEvaluation } from "../../evaluator/__tests__/fixtures.js";

const fac = { kind: "facilitator", by: "kamal" } as const;
let root: string, dir1: string, dir2: string;
beforeEach(async () => {
  ({ root, dir: dir1 } = await makeDraftDir());
  const w = await writeReports(await sampleEvaluation(), {
    outDir: root,
    evaluator: {
      provider: "scripted mock",
      scripted: true,
      rubricHash: "h1",
      variant: "v1",
    },
  });
  dir2 = w.dir; // sess1-2: same session, a re-run
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Marks alice released in dir1 without going through the gate (the release event itself is built in story 2). */
async function forceRelease(dir: string) {
  const { events, tailHash } = await readReview(dir);
  await writeEvents(
    dir,
    sealEntries(
      events,
      tailHash,
      [{ actor: fac, body: { type: "report.released", subjects: ["alice"] } }],
      fixedClock(),
    ),
  );
}

describe("re-runs", () => {
  it("opens a second review freely while no earlier review of the session has a release", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await expect(
      openReview(dir2, { by: "kamal", now: fixedClock() }),
    ).resolves.toBeTruthy();
  });
  it("refuses to open on a re-run when an earlier directory of the same session was released", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await forceRelease(dir1);
    expect(await siblingReleased(dir2)).toBe(path.basename(dir1));
    await expect(
      openReview(dir2, { by: "kamal", now: fixedClock() }),
    ).rejects.toThrow(/supersede/);
  });
  it("supersede carries byte-identical subjects forward as events marked carriedFrom, starts changed subjects clean, and makes the old review read-only", async () => {
    await openReview(dir1, { by: "kamal", now: fixedClock() });
    await applyCommand(dir1, fixedClock(), (l) => {
      const c = l.view.subjects
        .get("alice")!
        .criteria.find((x) => x.status === "needs_review")!;
      return [
        {
          actor: fac,
          body: { type: "score.accepted", subject: "alice", criterion: c.id },
        },
        {
          actor: fac,
          body: {
            type: "comment.added",
            subject: "bob",
            text: "bob note",
            visibility: "internal",
          },
        },
      ];
    });
    const bobJson = path.join(dir2, "bob.json");
    await writeFile(
      bobJson,
      (await readFile(bobJson, "utf8")).replace(
        /Clear on effort\./,
        "Clear on effort!",
      ),
    ); // bob's draft differs in the re-run
    await forceRelease(dir1);
    const r = await supersedeReview(dir1, dir2, {
      by: "kamal",
      now: fixedClock(),
    });
    expect(r.carried).toContain("alice");
    expect(r.fresh).toContain("bob");
    const l2 = await loadReview(dir2);
    expect(
      l2.events.filter((e) => e.carriedFrom === path.basename(dir1)).length,
    ).toBeGreaterThan(0);
    expect(
      l2.view.subjects
        .get("alice")!
        .criteria.some((c) => c.status === "accepted"),
    ).toBe(true);
    expect(l2.view.subjects.get("bob")!.comments).toHaveLength(0);
    expect(l2.view.subjects.get("alice")!.state).toBe("draft");
    expect((await readReview(dir1)).events.at(-1)!.type).toBe(
      "review.superseded",
    );
    await expect(
      applyCommand(dir1, fixedClock(), () => [
        {
          actor: fac,
          body: {
            type: "comment.added",
            subject: "alice",
            text: "x",
            visibility: "internal",
          },
        },
      ]),
    ).rejects.toThrow(); // exit class tightened to ReviewRefusedError in Task 9, once the fold knows report.released
  });
});
```

Note: until Task 9 the fold rejects `report.released`, so `loadReview(dir1)` of a forced-release log is corrupt. The test therefore reads `dir1` with `readReview` only, and `supersedeReview` works on the raw events of the old log (it filters by event type and checks the draft hashes; it does not fold the old log). Task 9 swaps `forceRelease` for a real gated release and tightens the last assertion to `ReviewRefusedError`.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/supersede.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement in `store.ts`.**

```ts
import { readdir } from "node:fs/promises";
// ...
const sameInstance = (
  a: ReviewEvent,
  b: Extract<ReviewEvent, { type: "review.opened" }>,
): boolean =>
  a.type === "review.opened" &&
  a.session.id === b.session.id &&
  (a.session.logSha256 !== null && b.session.logSha256 !== null
    ? a.session.logSha256 === b.session.logSha256
    : a.session.startedAt === b.session.startedAt);

/** The name of an older sibling directory of the same session instance whose review has a release and was not superseded, else null. */
export async function siblingReleased(dir: string): Promise<string | null> {
  const drafts = await loadDrafts(dir);
  const parent = path.dirname(dir);
  const me = path.basename(dir);
  const probe = {
    type: "review.opened",
    session: {
      id: drafts.sessionId,
      logSha256: null,
      startedAt: drafts.startedAt,
    },
  } as Extract<ReviewEvent, { type: "review.opened" }>;
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
    if (!first || first.type !== "review.opened") continue;
    const sameLog =
      first.session.id === drafts.sessionId &&
      first.session.startedAt === probe.session.startedAt;
    if (
      sameLog &&
      read.events.some((e) => e.type === "report.released") &&
      !read.events.some((e) => e.type === "review.superseded")
    )
      return name;
  }
  return null;
}
```

Use `startedAt` equality for the sibling comparison (the new directory has no review yet, so no log hash exists to compare); keep `sameInstance` only for the carry-forward check if both reviews have hashes, otherwise delete it (do not leave dead code).

`openReview` is unchanged except that it first calls `siblingReleased(dir)` and, if that returns a name, throws `new ReviewRefusedError("an earlier evaluation of this session (<name>) was already released; use `pnpm moderate supersede <old> <new>` to move on")`. `supersedeReview` writes the new review itself (it does not call `openReview`), so it needs no bypass flag.

```ts
const CARRIED = new Set([
  "score.edited",
  "rationale.edited",
  "summary.edited",
  "summary.accepted",
  "score.accepted",
  "comment.added",
]);

export async function supersedeReview(
  oldDir: string,
  newDir: string,
  o: { by: string; now: () => number },
): Promise<{ carried: string[]; fresh: string[] }> {
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
      await writeEvents(oldDir, sealedOld);
      return { carried: identical, fresh };
    }),
  );
}

function stripEnvelope(e: ReviewEvent): Body {
  const { seq: _s, ts: _t, prev: _p, actor: _a, carriedFrom: _c, ...body } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
  return body as Body;
}
```

Add imports (`Body`, `ZERO_HASH`, `REVIEW_SCHEMA`, `POLICY_VERSION`). Order (ruling P16): the new review is written first and the old one is marked `review.superseded` last. If the second write fails, throw `ReviewCorruptError("the new review was opened but the old one could not be marked superseded; delete review.jsonl in the new directory (it holds only copies) and run supersede again")`.

- [ ] **Step 4: CLI.** Add `supersede` to `HANDLERS` and `ALLOWED` (`["by"]`): `pnpm moderate supersede <old-dir> <new-dir> --by <name>`; the second positional is `args[0]`, resolved against `c.base`; prints `carried forward: alice; starts clean: bob, group`. In `open`, the sibling refusal surfaces as exit 1 through the existing mapping. Add `supersede` to `MODERATE_USAGE`.

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS.

- [ ] **Step 6: Docs and plan status (same PR).**
  - `docs/EVALUATOR.md`: new section "Moderating a report" (the commands, the reading order `open` > `status` > `edit`/`accept` > `show`, exit codes, `--expect`), a "What file access defeats" paragraph in the style of `THREAT_MODEL.md` resume (anyone who can write the reports directory can forge a review; the hash chain catches edits in the middle of the log, not a full rewrite; reports are plain files, `cat` is not audited), and the new draft banner. Update every place that says reports are "visible to all participants" or that editing is "planned".
  - `README.md`: one line each for `pnpm moderate`.
  - `CHANGELOG.md` `[Unreleased]`: "Added: `pnpm moderate` review log (open, status, show, edit, accept, comment, edit-summary, supersede) with a hash-chained `review.jsonl`; structured `flag_codes` in report JSON. Changed: draft reports now say 'DRAFT: AI-drafted, not reviewed by a facilitator' and 'Visibility: facilitator only until released'."
  - `docs/TEST_CASES.md`: TC-0049 (review log, fold, tamper), TC-0050 (moderate CLI end to end), format as the TC-0038 rows.
  - `docs/RELEASE_PLAN.md`: tick AC-0209..AC-0216 with file and test pointers (the ACs are filed in the plan PR), set US-0041 Complete and TASK-0066 Done, EPIC-0005 notes updated; `npm run plan:generate`.
  - `progress.md`: append a session note.

- [ ] **Step 7: Gates, then commit and push for review.**

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build
pnpm -s demo --showcase --fast --evaluate   # counts unchanged
# Linux container run of the fs and lock tests (AGENTS.md section 8):
mkdir -p /tmp/x && git archive HEAD | tar -x -C /tmp/x
docker run --rm -v /tmp/x:/w -w /w node:22 bash -c 'corepack enable; corepack prepare pnpm@9 --activate; pnpm install --frozen-lockfile; timeout 300 pnpm -s vitest run services/runtime/src/review services/runtime/src/util'
git add -A && git commit -m "[feat] US-0041: supersede on re-run, moderation docs and story close"
```

Story 1 ends here: open the PR `[feat] US-0041: review log and moderation` (body ends with the Claude Code line). The owner merges.

---

# Story 2: US-0042 Release gate, amend and withdraw, export audit

Branch `feature/EPIC-0005-US-0042-release-gate` from `develop` after story 1 has merged. Tasks 9 and 10.

### Task 9: Fold and gate for release, amend, withdraw and export

**Files:**

- Modify: `services/runtime/src/review/fold.ts` (new cases, `SubjectView.exports`, `takeSnapshot`), `services/runtime/src/review/__tests__/fixtures.ts` (shared `makeFold`, `resolveBodies`), `services/runtime/src/review/__tests__/fold.test.ts` (use the shared helpers; replace the "later story" row), `services/runtime/src/review/__tests__/supersede.test.ts` (tighten the last assertion)
- Test: `services/runtime/src/review/__tests__/fold-release.test.ts`

**Interfaces:**

- Consumes: Task 4 types and `releaseProblems`.
- Produces: `SubjectView.exports: { seq: number; version: number; principal: string; destination: string; by: string }[]`; fold support for `report.released`, `report.amended`, `report.withdrawn`, `report.exported`; `Snapshot` is set at every release (latest release wins; earlier versions stay in `versions`); fixtures `makeFold(drafts): { fac: Actor; opened: () => Body; log: (...b: Body[]) => ReviewEvent[]; fold: (...b: Body[]) => View }` and `resolveBodies(view: View, subject: string): Body[]` (an accept for every needs-review criterion, plus `summary.accepted` when the summary is stale).

- [ ] **Step 1: Move the helpers.** In `fixtures.ts` add `makeFold` and `resolveBodies` (bodies below), switch `fold.test.ts` to `const { fac, opened, log, fold } = makeFold(drafts)` inside `beforeEach`, and replace the table row `"an event type that arrives in a later story"` with `["an event type that arrives in a later story", () => fold({ type: "self.rated", role: "alice", criterion: "listening", level: 3 })]` (story 4 owns that event). Run `vitest run src/review` first: PASS before the new tests.

```ts
import { currentView, type View } from "../fold.js";
import { sealEntries } from "../review-log.js";
import {
  POLICY_VERSION,
  REVIEW_SCHEMA,
  ZERO_HASH,
  type Actor,
  type Body,
  type ReviewEvent,
} from "../types.js";
import type { Drafts } from "../draft.js";

export function makeFold(drafts: Drafts) {
  const fac: Actor = { kind: "facilitator", by: "kamal" };
  const opened = (): Body => ({
    type: "review.opened",
    schema: REVIEW_SCHEMA,
    policyVersion: POLICY_VERSION,
    legacy: false,
    session: {
      id: drafts.sessionId,
      logSha256: null,
      startedAt: drafts.startedAt,
    },
    scenario: { id: drafts.scenarioId, sha256: null },
    rubricHash: drafts.rubricHash,
    files: drafts.files,
    codes: null,
  });
  const log = (...bodies: Body[]): ReviewEvent[] =>
    sealEntries(
      [],
      ZERO_HASH,
      [opened(), ...bodies].map((body) => ({ actor: fac, body })),
      fixedClock(),
    );
  const fold = (...b: Body[]): View => currentView(drafts, log(...b));
  return { fac, opened, log, fold };
}
export function resolveBodies(view: View, subject: string): Body[] {
  const sv = view.subjects.get(subject)!;
  return [
    ...sv.criteria
      .filter((c) => c.status === "needs_review")
      .map((c): Body => ({ type: "score.accepted", subject, criterion: c.id })),
    ...(sv.summaryStale ? [{ type: "summary.accepted", subject } as Body] : []),
  ];
}
```

- [ ] **Step 2: Write the failing tests** (`fold-release.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import type { Body } from "../types.js";
import { makeDraftDir, makeFold, resolveBodies } from "./fixtures.js";

let root: string, drafts: Drafts, f: ReturnType<typeof makeFold>;
beforeEach(async () => {
  const m = await makeDraftDir();
  root = m.root;
  drafts = await loadDrafts(m.dir);
  f = makeFold(drafts);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const resolved = (...subjects: string[]): Body[] =>
  subjects.flatMap((s) => resolveBodies(f.fold(), s));
const released = (...s: string[]): Body[] => [
  ...resolved(...s),
  { type: "report.released", subjects: s },
];

describe("release", () => {
  it("is refused while a criterion needs review, naming it", () => {
    const open = f
      .fold()
      .subjects.get("alice")!
      .criteria.filter((c) => c.status === "needs_review")
      .map((c) => c.id);
    expect(open.length).toBeGreaterThan(0);
    expect(() =>
      f.fold({ type: "report.released", subjects: ["alice"] }),
    ).toThrow(new RegExp(open[0]!));
  });
  it("releases once every item is accepted: version is the event seq, state released, snapshot taken", () => {
    const v = f.fold(...released("alice"));
    const a = v.subjects.get("alice")!;
    expect(a.state).toBe("released");
    expect(a.versions).toEqual([v.lastSeq]);
    expect(a.snapshot?.version).toBe(v.lastSeq);
    expect(v.subjects.get("bob")!.state).toBe("draft");
  });
  it("blocks release behind a stale summary until it is edited or accepted", () => {
    const base = resolved("alice");
    const cur = f
      .fold()
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!.current;
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: cur,
      to: cur === 4 ? 3 : 4,
      reason: "r",
    };
    expect(() =>
      f.fold(...base, edit, { type: "report.released", subjects: ["alice"] }),
    ).toThrow(/summary/);
    expect(
      f
        .fold(
          ...base,
          edit,
          { type: "summary.accepted", subject: "alice" },
          { type: "report.released", subjects: ["alice"] },
        )
        .subjects.get("alice")!.state,
    ).toBe("released");
  });
  it("needs every criterion edited by hand when the evaluation failed", () => {
    drafts.subjects.get("bob")!.evaluationOk = false;
    const v0 = f.fold();
    expect(() =>
      f.fold(...resolveBodies(v0, "bob"), {
        type: "report.released",
        subjects: ["bob"],
      }),
    ).toThrow(/evaluation failed/);
    const edits: Body[] = v0.subjects.get("bob")!.criteria.map((c): Body => ({
      type: "score.edited",
      subject: "bob",
      criterion: c.id,
      from: c.current,
      to: c.current === 1 ? 2 : 1,
      reason: "scored by hand",
    }));
    expect(
      f
        .fold(
          ...edits,
          { type: "summary.accepted", subject: "bob" },
          { type: "report.released", subjects: ["bob"] },
        )
        .subjects.get("bob")!.state,
    ).toBe("released");
  });
  it("releases several subjects in one event, all or none", () => {
    const ok = f.fold(...released("alice", "bob"));
    expect(ok.subjects.get("alice")!.versions).toEqual(
      ok.subjects.get("bob")!.versions,
    );
    expect(() =>
      f.fold(...resolved("alice"), {
        type: "report.released",
        subjects: ["alice", "bob"],
      }),
    ).toThrow(ReviewIllegalError);
    expect(() => f.fold({ type: "report.released", subjects: [] })).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.fold(...released("alice"), {
        type: "report.released",
        subjects: ["alice"],
      }),
    ).toThrow(/released/);
    expect(() =>
      f.fold(...resolved("alice"), {
        type: "report.released",
        subjects: ["alice", "alice"],
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("blocks edits, accepts and summary changes after release but still allows comments", () => {
    const rel = released("alice");
    const crit = f.fold(...rel).subjects.get("alice")!.criteria[0]!;
    for (const b of [
      {
        type: "score.edited",
        subject: "alice",
        criterion: crit.id,
        from: crit.current,
        to: crit.current === 1 ? 2 : 1,
        reason: "r",
      },
      { type: "score.accepted", subject: "alice", criterion: crit.id },
      { type: "summary.accepted", subject: "alice" },
    ] as Body[])
      expect(() => f.fold(...rel, b)).toThrow(/released/);
    expect(
      f
        .fold(...rel, {
          type: "comment.added",
          subject: "alice",
          text: "after",
          visibility: "feedback",
        })
        .subjects.get("alice")!.comments,
    ).toHaveLength(1);
  });
});

describe("amend and withdraw", () => {
  it("amend reopens the subject for edits, re-release makes version 2 and keeps version 1", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const crit = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const amend: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "new evidence",
      basedOn: v1,
    };
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: crit.current,
      to: crit.current === 4 ? 3 : 4,
      reason: "r",
    };
    const v = f.fold(
      ...rel,
      amend,
      edit,
      { type: "summary.accepted", subject: "alice" },
      { type: "report.released", subjects: ["alice"] },
    );
    const a = v.subjects.get("alice")!;
    expect(a.versions).toEqual([v1, v.lastSeq]);
    expect(a.snapshot?.version).toBe(v.lastSeq);
    expect(a.state).toBe("released");
    expect(f.fold(...rel, amend).subjects.get("alice")!.state).toBe("amending");
  });
  it("refuses an amend of a draft, with the wrong basedOn, or with no reason", () => {
    expect(() =>
      f.fold({
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: 1,
      }),
    ).toThrow(ReviewIllegalError);
    const rel = released("alice");
    expect(() =>
      f.fold(...rel, {
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: 1,
      }),
    ).toThrow(/basedOn|version/);
    expect(() =>
      f.fold(...rel, {
        type: "report.amended",
        subject: "alice",
        reason: "",
        basedOn: f.fold(...rel).lastSeq,
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("withdraw is terminal: no amend, release or edit afterwards", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const w: Body = {
      type: "report.withdrawn",
      subject: "alice",
      reason: "wrong session",
    };
    expect(f.fold(...rel, w).subjects.get("alice")!.state).toBe("withdrawn");
    expect(() =>
      f.fold(...rel, w, {
        type: "report.amended",
        subject: "alice",
        reason: "r",
        basedOn: v1,
      }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.fold(...rel, w, { type: "report.released", subjects: ["alice"] }),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.fold({ type: "report.withdrawn", subject: "alice", reason: "r" }),
    ).toThrow(ReviewIllegalError);
  });
  it("marks a released group's player table stale after a player edit and clears it when the group is re-released", () => {
    const rel = released("alice", "bob", "group");
    const v1 = f.fold(...rel).lastSeq;
    const dis = f
      .fold(...rel)
      .subjects.get("alice")!
      .criteria.find((c) => c.id === "discovery")!;
    const amendA: Body = {
      type: "report.amended",
      subject: "alice",
      reason: "r",
      basedOn: v1,
    };
    const edit: Body = {
      type: "score.edited",
      subject: "alice",
      criterion: "discovery",
      from: dis.current,
      to: dis.current === 4 ? 3 : 4,
      reason: "r",
    };
    expect(f.fold(...rel, amendA, edit).subjects.get("group")!.tableStale).toBe(
      true,
    );
    const fresh = f.fold(
      ...rel,
      amendA,
      edit,
      { type: "summary.accepted", subject: "alice" },
      {
        type: "report.amended",
        subject: "group",
        reason: "refresh",
        basedOn: v1,
      },
      { type: "report.released", subjects: ["alice", "group"] },
    );
    expect(fresh.subjects.get("group")!.tableStale).toBe(false);
    expect(
      fresh.subjects.get("group")!.snapshot?.table?.objectives[0]?.byRole.alice,
    ).toBeTruthy();
  });
});

describe("export", () => {
  it("records an export of an existing version of a released subject and refuses the rest", () => {
    const rel = released("alice");
    const v1 = f.fold(...rel).lastSeq;
    const ex = (
      over: Partial<Extract<Body, { type: "report.exported" }>> = {},
    ): Body => ({
      type: "report.exported",
      subject: "alice",
      version: v1,
      principal: "facilitator",
      destination: "out",
      ...over,
    });
    expect(f.fold(...rel, ex()).subjects.get("alice")!.exports).toEqual([
      {
        seq: v1 + 1,
        version: v1,
        principal: "facilitator",
        destination: "out",
        by: "kamal",
      },
    ]);
    expect(() => f.fold(ex({ version: 1 }))).toThrow(ReviewIllegalError); // draft: nothing to export
    expect(() => f.fold(...rel, ex({ version: v1 + 5 }))).toThrow(/version/);
    expect(() => f.fold(...rel, ex({ principal: "" }))).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.fold(
        ...rel,
        { type: "report.withdrawn", subject: "alice", reason: "r" },
        ex(),
      ),
    ).toThrow(ReviewIllegalError);
  });
});
```

- [ ] **Step 3: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-release.test.ts` Expected: FAIL ("not supported yet").

- [ ] **Step 4: Implement.** In `fold.ts`: add `exports: { seq: number; version: number; principal: string; destination: string; by: string }[]` to `SubjectView` and `exports: []` in `initSubject`; add

```ts
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
    objectives: structuredClone(sv.objectives),
    table,
  };
}
const released = (sv: SubjectView): boolean =>
  sv.state === "released" || sv.state === "amending";
```

and the cases before `default` (they replace "not supported yet" for these four types):

```ts
      case "report.released": {
        facilitator(e);
        if (!Array.isArray(e.subjects) || e.subjects.length === 0 || new Set(e.subjects).size !== e.subjects.length) ill(e, "name each subject to release once");
        const svs = e.subjects.map((id) => subj(e, id));
        for (const sv of svs) {
          if (sv.state !== "draft" && sv.state !== "amending") ill(e, `${sv.id} is ${sv.state}`);
          const problems = releaseProblems(sv);
          if (problems.length) ill(e, `${sv.id} cannot be released: ${problems.join("; ")}`);
        }
        for (const sv of svs) { sv.state = "released"; sv.versions.push(e.seq); if (sv.kind === "group") sv.tableStale = false; }
        for (const sv of svs) sv.snapshot = takeSnapshot(sv, e.seq, sv.kind === "group" ? groupTable(drafts, subjects) : null);
        break;
      }
      case "report.amended": {
        facilitator(e); const sv = subj(e, e.subject); reason(e, e.reason);
        if (sv.state !== "released") ill(e, `${sv.id} is ${sv.state}; only a released report can be amended`);
        if (e.basedOn !== sv.versions.at(-1)) ill(e, `basedOn ${e.basedOn} is not the current version ${sv.versions.at(-1)}`);
        sv.state = "amending";
        break;
      }
      case "report.withdrawn": {
        facilitator(e); const sv = subj(e, e.subject); reason(e, e.reason);
        if (!released(sv)) ill(e, `${sv.id} is ${sv.state}; only a released report can be withdrawn`);
        sv.state = "withdrawn";
        break;
      }
      case "report.exported": {
        const by = facilitator(e); const sv = subj(e, e.subject);
        if (sv.state !== "released") ill(e, `${sv.id} is ${sv.state}; only a released report is exported`);
        if (!sv.versions.includes(e.version)) ill(e, `version ${e.version} does not exist`);
        if (typeof e.principal !== "string" || e.principal.length < 1 || e.principal.length > 64 || typeof e.destination !== "string" || e.destination.length < 1 || e.destination.length > 64) ill(e, "principal and destination need 1 to 64 characters");
        sv.exports.push({ seq: e.seq, version: e.version, principal: e.principal, destination: e.destination, by });
        break;
      }
```

Because `groupTable` reads the live role views, a group released together with its players sees their just-released state. The `released` helper name shadows the `released` array in tests only; keep it module-local.

Tighten `supersede.test.ts`: its `forceRelease` helper can now be replaced by `releaseAlice` built from `resolveBodies` and real `report.released`, and the final assertion becomes `rejects.toBeInstanceOf(ReviewRefusedError)` plus `loadReview(dir1)` resolving with `view.superseded` set. Rewrite that one test accordingly.

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0042: fold release, amend, withdraw and export with the release gate"
```

### Task 10: `release`, `amend`, `withdraw`, `export --for facilitator`, and close the story

**Files:**

- Modify: `services/runtime/src/review/cli.ts` (four handlers, options `all`, `to`, `for`), `services/runtime/src/review/store.ts` if a helper is needed
- Test: `services/runtime/src/review/__tests__/cli-release.test.ts`
- Modify (docs): `docs/EVALUATOR.md`, `AGENTS.md`, `README.md`, `CHANGELOG.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`

**Interfaces:**

- Consumes: Task 7 CLI scaffolding, `releaseProblems`, `viewReport`, `renderSubjectMarkdown`, `writeExclusive` and `REPORT_DIR_MODE` from `../evaluator/report-write.js`.
- Produces: subcommands `release <dir> <subject>... | --all --by`; `amend <dir> <subject> --reason --by`; `withdraw <dir> <subject> --reason --by`; `export <dir> <subject> --for facilitator --to <dest-dir> --by` (P15: other principals are refused until Task 12).

- [ ] **Step 1: Write the failing tests** (`cli-release.test.ts`; reuse the `run` helper pattern of `cli.test.ts`, extracted into `fixtures.ts` as `makeRunner(root)` in this task)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function resolveAll(subject: string) {
  const l = await loadReview(dir);
  for (const c of l.view.subjects
    .get(subject)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, subject, c.id, "--by", "kamal"]);
}

describe("release", () => {
  it("is refused (exit 1) while items are open, listing every unresolved item and writing nothing", async () => {
    const r = await run(["release", rel, "alice", "--by", "kamal"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nothing was released/);
    expect(r.err).toMatch(/alice: needs review/);
    expect((await loadReview(dir)).events).toHaveLength(1);
  });
  it("releases one subject once resolved; status shows the version; a second release is refused", async () => {
    await resolveAll("alice");
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect((await run(["status", rel])).out).toMatch(
      /alice: released \(version \d+\)/,
    );
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      1,
    );
  });
  it("--all releases every subject in one event, or none when one is unresolved", async () => {
    await resolveAll("alice");
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(
      1,
    );
    expect((await loadReview(dir)).view.subjects.get("alice")!.state).toBe(
      "draft",
    );
    await resolveAll("bob");
    await resolveAll("group");
    expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(
      0,
    );
    const l = await loadReview(dir);
    expect(l.events.filter((e) => e.type === "report.released")).toHaveLength(
      1,
    );
    expect(
      [...l.view.subjects.values()].every((s) => s.state === "released"),
    ).toBe(true);
  });
  it("needs --by and a subject or --all", async () => {
    expect((await run(["release", rel, "alice"])).code).toBe(2);
    expect((await run(["release", rel, "--by", "kamal"])).code).toBe(2);
  });
  it("two racing releases: exactly one succeeds", async () => {
    await resolveAll("alice");
    const [a, b] = await Promise.all([
      run(["release", rel, "alice", "--by", "kamal"]),
      run(["release", rel, "alice", "--by", "kamal"]),
    ]);
    expect([a.code, b.code].sort()).toEqual([0, 1]);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.versions,
    ).toHaveLength(1);
  });
});

describe("amend and withdraw", () => {
  it("amend reopens edits and a new release makes version 2; edits are refused while released", async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    expect(
      (
        await run([
          "edit",
          rel,
          "alice",
          "discovery",
          "--level",
          "2",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "amend",
          rel,
          "alice",
          "--reason",
          "new evidence",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "discovery")!.current;
    expect(
      (
        await run([
          "edit",
          rel,
          "alice",
          "discovery",
          "--level",
          cur === 2 ? "3" : "2",
          "--reason",
          "r",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    await run(["accept", rel, "alice", "--summary", "--by", "kamal"]);
    expect((await run(["release", rel, "alice", "--by", "kamal"])).code).toBe(
      0,
    );
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.versions,
    ).toHaveLength(2);
  });
  it("amend and withdraw need a reason and a released subject", async () => {
    expect(
      (await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]))
        .code,
    ).toBe(1);
    expect((await run(["withdraw", rel, "alice", "--by", "kamal"])).code).toBe(
      2,
    );
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
    expect(
      (
        await run([
          "withdraw",
          rel,
          "alice",
          "--reason",
          "wrong session",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]))
        .code,
    ).toBe(1);
  });
});

describe("export", () => {
  beforeEach(async () => {
    await resolveAll("alice");
    await run(["release", rel, "alice", "--by", "kamal"]);
  });
  it("writes owner-only Markdown and acr.view/1 JSON into a new directory and records report.exported with the version", async () => {
    const r = await run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      "--to",
      "out/alice-export",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(0);
    const out = path.join(root, "out/alice-export");
    expect((await readdir(out)).sort()).toEqual(["alice.json", "alice.md"]);
    expect((await stat(path.join(out, "alice.md"))).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await readFile(path.join(out, "alice.json"), "utf8")).schema,
    ).toBe("acr.view/1");
    const ex = (await loadReview(dir)).events.filter(
      (e) => e.type === "report.exported",
    );
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      subject: "alice",
      principal: "facilitator",
      destination: "alice-export",
    });
    expect(JSON.stringify(ex[0])).not.toContain(root);
  });
  it("refuses a draft subject, another principal for now, an existing file and a missing --to", async () => {
    expect(
      (
        await run([
          "export",
          rel,
          "bob",
          "--for",
          "facilitator",
          "--to",
          "out/b",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "participant:alice",
          "--to",
          "out/p",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "facilitator",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(2);
    await run([
      "export",
      rel,
      "alice",
      "--for",
      "facilitator",
      "--to",
      "out/x",
      "--by",
      "kamal",
    ]);
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "facilitator",
          "--to",
          "out/x",
          "--by",
          "kamal",
        ])
      ).code,
    ).not.toBe(0);
  });
});
```

Add `makeRunner(root)` to `fixtures.ts` (the `run` closure from `cli.test.ts`, with `now: fixedClock()` created once per runner) and use it from `cli.test.ts` too.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/cli-release.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement the handlers.** Add `all: { type: "boolean" }, to: { type: "string" }, for: { type: "string" }` to `OPTIONS`; `ALLOWED` gets `release: ["by", "all"], amend: ["by", "reason"], withdraw: ["by", "reason"], export: ["by", "to", "for"]`; add them to `MODERATE_USAGE`.

```ts
  async release(c) {
    const actor = facilitator(c);
    const { appended } = await applyCommand(c.dir, c.now, (l) => {
      const ids = c.values.all === true ? [...l.view.subjects.values()].filter((s) => s.state === "draft" || s.state === "amending").map((s) => s.id) : c.args;
      if (ids.length === 0) throw new ReviewUsageError("release needs <subject>... or --all");
      const problems: string[] = [];
      for (const id of ids) {
        const sv = l.view.subjects.get(id);
        if (!sv) { problems.push(`${id}: unknown subject`); continue; }
        if (sv.state !== "draft" && sv.state !== "amending") { problems.push(`${id}: is ${sv.state}`); continue; }
        for (const p of releaseProblems(sv)) problems.push(`${id}: ${p}`);
      }
      if (problems.length) throw new ReviewRefusedError(`nothing was released:\n  ${problems.join("\n  ")}`);
      return [{ actor, body: { type: "report.released", subjects: ids } }];
    });
    const e = appended[0] as Extract<ReviewEvent, { type: "report.released" }>;
    c.out(`released ${e.subjects.join(", ")} as version ${e.seq}`);
    return 0;
  },
  async amend(c) {
    const [subject] = c.args; if (!subject) throw new ReviewUsageError("amend needs <subject>");
    const actor = facilitator(c); const reason = cleanText(String(c.values.reason ?? ""), LIMITS.reason, "--reason", c.secrets);
    await applyCommand(c.dir, c.now, (l) => {
      const sv = need(l.view.subjects.get(subject), "subject");
      return [{ actor, body: { type: "report.amended", subject, reason, basedOn: sv.versions.at(-1) ?? 0 } }];
    });
    c.out(`${subject} reopened for amendment`);
    return 0;
  },
  async withdraw(c) {
    const [subject] = c.args; if (!subject) throw new ReviewUsageError("withdraw needs <subject>");
    const actor = facilitator(c); const reason = cleanText(String(c.values.reason ?? ""), LIMITS.reason, "--reason", c.secrets);
    await applyCommand(c.dir, c.now, () => [{ actor, body: { type: "report.withdrawn", subject, reason } }]);
    c.out(`${subject} withdrawn`);
    return 0;
  },
  async export(c) {
    const [subject] = c.args; if (!subject) throw new ReviewUsageError("export needs <subject>");
    const actor = facilitator(c);
    if (c.values.for !== "facilitator") throw new ReviewUsageError("--for supports only facilitator in this version");
    if (typeof c.values.to !== "string" || c.values.to === "") throw new ReviewUsageError("--to needs a destination directory");
    const dest = path.resolve(c.base, c.values.to);
    const label = isSafeId(path.basename(dest)) ? path.basename(dest) : "destination";
    const l = await loadReview(c.dir);
    const sv = need(l.view.subjects.get(subject), "subject");
    if (sv.state !== "released") throw new ReviewRefusedError(`${subject} is ${sv.state}; only a released report is exported`);
    const report = viewReport(l.drafts.subjects.get(subject)!.raw as unknown as ParticipantReport | GroupReport, l.view, subject, { audience: "facilitator" });
    const md = renderSubjectMarkdown(report, c.secrets); const json = `${JSON.stringify(report, null, 2)}\n`;
    // The audit event comes first (P17): a record of an export that then failed is safer than an export nobody recorded.
    await applyCommand(c.dir, c.now, (cur) => [{ actor, body: { type: "report.exported", subject, version: cur.view.subjects.get(subject)!.versions.at(-1)!, principal: "facilitator", destination: label } }]);
    await mkdir(dest, { recursive: true, mode: REPORT_DIR_MODE });
    const written: string[] = [];
    try { for (const [n, t] of [[`${subject}.md`, md], [`${subject}.json`, json]] as const) { await writeExclusive(path.join(dest, n), t); written.push(n); } }
    catch { for (const n of written) await rm(path.join(dest, n), { force: true }); throw new ReviewCorruptError("the export was recorded in the review but the files could not be written (does the destination already hold them?)"); }
    c.out(`exported ${subject} to ${label}`);
    return 0;
  },
```

Add the imports (`mkdir`, `rm`, `isSafeId`, `ReviewEvent`, `releaseProblems`, `writeExclusive`, `REPORT_DIR_MODE`). The "destination already holds them" case returns exit 2 after the event; the test only asserts it is not 0.

- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS.

- [ ] **Step 5: Docs and plan status.** `docs/EVALUATOR.md`: release gate rules (the list in spec section 4), versions, amend, withdraw, export audit and "viewing is not audited" with the reason. `AGENTS.md` (Operating Principles, near the L-0019 text): "An agent never runs `pnpm moderate release`, `amend` or `withdraw` unless the owner explicitly names the subjects." `README.md`, `CHANGELOG.md`, `docs/TEST_CASES.md` (TC-0051 gate and versions, TC-0052 release CLI and export audit), `docs/RELEASE_PLAN.md` (AC-0217..AC-0222 ticked with pointers, US-0042 Complete, TASK-0067 Done), `npm run plan:generate`, `progress.md`.
- [ ] **Step 6: Gates and commit** (same gate block as Task 8 Step 7, with `git commit -m "[feat] US-0042: release gate, amend, withdraw and export audit commands"`). Open the PR for story 2.

---

# Story 3: US-0043 Visibility

Branch `feature/EPIC-0005-US-0043-visibility` from `develop` after story 2 has merged. Tasks 11 to 13. Must land before story 4.

### Task 11: The policy table, `canView` and group redaction

**Files:**

- Create: `services/runtime/src/review/policy.ts`
- Test: `services/runtime/src/review/__tests__/policy.test.ts`

**Interfaces:**

- Consumes: `SubjectView["state"]`, `GroupReport`, `POLICY_VERSION`, `GROUP`.
- Produces:

```ts
export type Principal =
  | "facilitator"
  | `participant:${string}`
  | "line_manager"
  | "ld"
  | "hr"
  | "sponsor";
export const POLICY: {
  version: 1;
  personal: readonly string[];
  group: readonly string[];
};
export type ViewKind = "report" | "index";
export type Access = {
  allowed: boolean;
  redact: "none" | "peers";
  why: string;
};
export function parsePrincipal(raw: string): Principal | null;
export function canView(o: {
  principal: Principal;
  subject: string;
  state: "draft" | "released" | "amending" | "withdrawn";
  versions: number;
  view: ViewKind;
  superseded: boolean;
  policyVersion: number;
}): Access;
export function redactGroupForParticipant(
  g: GroupReport,
  role: string,
): GroupReport;
```

- [ ] **Step 1: Write the failing tests** (`policy.test.ts`). The expected matrix is written out as literals (not computed with the policy's own logic):

```ts
import { describe, expect, it } from "vitest";
import {
  POLICY,
  canView,
  parsePrincipal,
  redactGroupForParticipant,
  type Principal,
} from "../policy.js";
import type { GroupReport } from "../../evaluator/report-model.js";

const base = {
  versions: 1,
  view: "report" as const,
  superseded: false,
  policyVersion: 1,
};
const P = (p: string) => p as Principal;

describe("canView: released personal report of alice", () => {
  const o = { ...base, subject: "alice", state: "released" as const };
  it.each([
    ["facilitator", true, "none"],
    ["participant:alice", true, "none"],
    ["participant:bob", false, "none"],
    ["line_manager", false, "none"],
    ["ld", false, "none"],
    ["hr", false, "none"],
    ["sponsor", false, "none"],
  ])("%s -> %s", (p, allowed, redact) => {
    expect(canView({ ...o, principal: P(p) })).toMatchObject({
      allowed,
      redact,
    });
  });
});
describe("canView: released group report and index", () => {
  it.each([
    ["facilitator", true, "none"],
    ["participant:alice", true, "peers"],
    ["participant:bob", true, "peers"],
    ["line_manager", false, "none"],
    ["sponsor", false, "none"],
  ])("group, %s", (p, allowed, redact) => {
    expect(
      canView({
        ...base,
        subject: "group",
        state: "released",
        principal: P(p),
      }),
    ).toMatchObject({ allowed, redact });
  });
  it("index follows the same rule", () => {
    expect(
      canView({
        ...base,
        subject: "index",
        view: "index",
        state: "released",
        principal: P("participant:alice"),
      }),
    ).toMatchObject({ allowed: true, redact: "peers" });
  });
});
describe("canView: states other than released", () => {
  it.each([
    ["draft", 0],
    ["withdrawn", 1],
  ] as const)("%s is facilitator only", (state, versions) => {
    for (const p of [
      "participant:alice",
      "line_manager",
      "hr",
      "ld",
      "sponsor",
    ])
      expect(
        canView({ ...base, versions, subject: "alice", state, principal: P(p) })
          .allowed,
      ).toBe(false);
    expect(
      canView({
        ...base,
        versions,
        subject: "alice",
        state,
        principal: "facilitator",
      }).allowed,
    ).toBe(true);
  });
  it("an amendment in progress keeps showing the last released version to the participant", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "amending",
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(true);
  });
  it("a superseded review and a policy version mismatch are facilitator only", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        superseded: true,
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(false);
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        policyVersion: 0,
        principal: P("participant:alice"),
      }).allowed,
    ).toBe(false);
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        superseded: true,
        principal: "facilitator",
      }).allowed,
    ).toBe(true);
  });
  it("never explains a denial with another participant's data", () => {
    expect(
      canView({
        ...base,
        subject: "alice",
        state: "released",
        principal: P("participant:bob"),
      }).why,
    ).not.toMatch(/alice/);
  });
});
describe("the table", () => {
  it("is the spec policy, version 1", () => {
    expect(POLICY.version).toBe(1);
    expect([...POLICY.personal].sort()).toEqual([
      "facilitator",
      "hr",
      "ld",
      "line_manager",
      "participant",
    ]);
    expect([...POLICY.group].sort()).toEqual([
      "facilitator",
      "hr",
      "ld",
      "line_manager",
      "participant",
      "sponsor",
    ]);
  });
  it("parsePrincipal accepts the closed set and safe role ids only", () => {
    expect(parsePrincipal("participant:alice")).toBe("participant:alice");
    for (const bad of [
      "",
      "participant:",
      "participant:../x",
      "admin",
      "Facilitator",
      "participant:a b",
    ])
      expect(parsePrincipal(bad)).toBeNull();
  });
});
describe("redactGroupForParticipant", () => {
  const group = {
    kind: "group",
    lo_coverage: {
      players: ["alice", "bob"],
      objectives: [
        {
          id: "LO1",
          statement: "s",
          by_role: {
            alice: { score: 3, label: "Proficient", incomplete: false },
            bob: { score: 1.5, label: "Developing", incomplete: false },
          },
          team: { score: 2, label: "Developing", incomplete: false },
        },
      ],
    },
  } as unknown as GroupReport;
  it("keeps only the caller's own row, removes peers entirely and does not modify the input", () => {
    const copy = JSON.stringify(group);
    const r = redactGroupForParticipant(group, "alice");
    expect(r.lo_coverage.players).toEqual(["alice"]);
    expect(Object.keys(r.lo_coverage.objectives[0]!.by_role)).toEqual([
      "alice",
    ]);
    expect(JSON.stringify(r)).not.toContain("bob");
    expect(r.lo_coverage.objectives[0]!.team.score).toBe(2);
    expect(JSON.stringify(group)).toBe(copy);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/policy.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `policy.ts`.**

```ts
import { isFileSafeId } from "@acr/events";
import type { GroupReport } from "../evaluator/report-model.js";
import { GROUP, POLICY_VERSION } from "./types.js";

export type Principal =
  | "facilitator"
  | `participant:${string}`
  | "line_manager"
  | "ld"
  | "hr"
  | "sponsor";
export type ViewKind = "report" | "index";
export type Access = {
  allowed: boolean;
  redact: "none" | "peers";
  why: string;
};

/** The default audience policy (PRODUCT_SPEC section 7.3), version 1. A constant: data, not a principal model. */
export const POLICY = {
  version: POLICY_VERSION,
  personal: ["participant", "line_manager", "facilitator", "ld", "hr"],
  group: ["participant", "line_manager", "facilitator", "ld", "hr", "sponsor"],
} as const;

/** Only these audiences can be resolved to a person today (facilitator token, session role). The rest are inert until EPIC-0002 supplies identities. */
const RESOLVABLE = new Set(["facilitator", "participant"]);
const INERT = new Set(["line_manager", "ld", "hr", "sponsor"]);

export function parsePrincipal(raw: string): Principal | null {
  if (raw === "facilitator" || INERT.has(raw)) return raw as Principal;
  const m = /^participant:(.+)$/.exec(raw);
  return m && isFileSafeId(m[1]!) ? (raw as Principal) : null;
}

const no = (why: string): Access => ({ allowed: false, redact: "none", why });

/** Who may see one subject (a role, `group`) or the index. Pure. The facilitator always may; everyone else only sees a released, current, unsuperseded report. */
export function canView(o: {
  principal: Principal;
  subject: string;
  state: "draft" | "released" | "amending" | "withdrawn";
  versions: number;
  view: ViewKind;
  superseded: boolean;
  policyVersion: number;
}): Access {
  if (o.principal === "facilitator")
    return { allowed: true, redact: "none", why: "facilitator" };
  if (o.superseded) return no("this review was superseded");
  if (o.policyVersion !== POLICY.version)
    return no("recorded under another visibility policy version");
  if ((o.state !== "released" && o.state !== "amending") || o.versions === 0)
    return no("not released");
  const kind = o.principal.split(":")[0]!;
  const group = o.subject === GROUP || o.view === "index";
  if (!(group ? POLICY.group : POLICY.personal).includes(kind as never))
    return no("not in the audience");
  if (!RESOLVABLE.has(kind))
    return no("this audience cannot be identified yet");
  const role = o.principal.slice("participant:".length);
  if (!group && o.subject !== role) return no("not your report");
  return { allowed: true, redact: group ? "peers" : "none", why: "audience" };
}

/** The group report for one participant: peers' individual learning-objective results are removed (not blanked); the team result stays. A copy. */
export function redactGroupForParticipant(
  g: GroupReport,
  role: string,
): GroupReport {
  const out = structuredClone(g);
  out.lo_coverage = {
    players: out.lo_coverage.players.filter((p) => p === role),
    objectives: out.lo_coverage.objectives.map((o) => ({
      ...o,
      by_role: Object.fromEntries(
        Object.entries(o.by_role).filter(([r]) => r === role),
      ),
    })),
  };
  return out;
}
```

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0043: audience policy table, canView and group redaction"
```

### Task 12: Released views for participants, the review index, and `export --for`

**Files:**

- Modify: `services/runtime/src/review/view.ts` (released audience reads the frozen snapshot; legacy note), `services/runtime/src/review/cli.ts` (`export --for` through `canView`)
- Create: `services/runtime/src/review/index-view.ts`
- Test: `services/runtime/src/review/__tests__/visibility.test.ts`

**Interfaces:**

- Consumes: `canView`, `parsePrincipal`, `redactGroupForParticipant` (Task 11), `viewReport`, Task 10 export scaffolding.
- Produces: `renderReviewIndex(l: Loaded, a: { audience: "facilitator" } | { audience: "participant"; role: string }, secrets: string[]): string` (Markdown); `viewReport` with `{ audience: "released"; line: string; legacy?: boolean }` renders from `sv.snapshot` (criteria, summary, objectives, group table) plus only `feedback` comments; `export <dir> <subject|index> --for <principal> --to <dest> --by <name>` for `facilitator` and `participant:<role>`; every other principal is refused through `canView` (exit 1).

- [ ] **Step 1: Write the failing tests** (`visibility.test.ts`). The core is the byte-level peer-score proof:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
  const l = await loadReview(dir);
  for (const sv of l.view.subjects.values())
    for (const c of sv.criteria.filter((x) => x.status === "needs_review"))
      await run(["accept", rel, sv.id, c.id, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const ex = (subject: string, to: string, who: string, by = "kamal") =>
  run(["export", rel, subject, "--for", who, "--to", to, "--by", by]);
const read = (p: string) => readFile(path.join(root, p), "utf8");

describe("participants see released reports only, and only their own scores", () => {
  it("refuses every export before release (exit 1), for a participant", async () => {
    expect((await ex("alice", "o/a", "participant:alice")).code).toBe(1);
  });
  describe("after release", () => {
    beforeEach(async () => {
      expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(
        0,
      );
    });
    it("alice gets her own report; bob's personal report is refused; inert audiences are refused", async () => {
      expect((await ex("alice", "o/a", "participant:alice")).code).toBe(0);
      expect(await read("o/a/alice.md")).toContain(
        "Visibility: you and the facilitator",
      );
      expect((await ex("bob", "o/b", "participant:alice")).code).toBe(1);
      for (const p of ["line_manager", "ld", "hr", "sponsor"])
        expect((await ex("alice", `o/${p}`, p)).code).toBe(1);
      expect((await ex("alice", "o/bad", "participant:../x")).code).toBe(2);
    });
    it("alice's group report and index contain no byte of bob's individual results, in Markdown or JSON", async () => {
      expect((await ex("group", "o/g", "participant:alice")).code).toBe(0);
      expect((await ex("index", "o/i", "participant:alice")).code).toBe(0);
      const files = [
        await read("o/g/group.md"),
        await read("o/g/group.json"),
        await read("o/i/index.md"),
      ];
      for (const text of files) {
        expect(text).not.toMatch(/`bob`\s*\|/);
        expect(text).not.toMatch(/"bob":\s*\{\s*"score"/);
      }
      const gj = JSON.parse(files[1]!);
      expect(gj.lo_coverage.players).toEqual(["alice"]);
      expect(
        Object.values(
          gj.lo_coverage.objectives as { by_role: Record<string, unknown> }[],
        ).every((o) => Object.keys(o.by_role).join() === "alice"),
      ).toBe(true);
      expect(files[0]).toContain("`alice`");
      expect(files[2]).toContain("alice.md");
      expect(files[2]).not.toContain("bob.md");
    });
    it("the facilitator's export of the index lists every subject with its state", async () => {
      expect((await ex("index", "o/fi", "facilitator")).code).toBe(0);
      const t = await read("o/fi/index.md");
      for (const s of ["alice", "bob", "group"]) expect(t).toContain(s);
      expect(t).toMatch(/released \(version/);
    });
    it("feedback comments reach the participant; internal ones never do", async () => {
      await run([
        "comment",
        rel,
        "alice",
        "--text",
        "INTERNAL-ONLY",
        "--by",
        "kamal",
      ]);
      await run([
        "comment",
        rel,
        "alice",
        "--text",
        "FEEDBACK-VISIBLE",
        "--feedback",
        "--by",
        "kamal",
      ]);
      await ex("alice", "o/a", "participant:alice");
      const t = (await read("o/a/alice.md")) + (await read("o/a/alice.json"));
      expect(t).toContain("FEEDBACK-VISIBLE");
      expect(t).not.toContain("INTERNAL-ONLY");
    });
    it("during an amendment the participant still gets the last released scores, not the working ones", async () => {
      await ex("alice", "o/v1", "participant:alice");
      const v1 = await read("o/v1/alice.json");
      await run(["amend", rel, "alice", "--reason", "r", "--by", "kamal"]);
      const cur = (await loadReview(dir)).view.subjects
        .get("alice")!
        .criteria.find((c) => c.id === "discovery")!.current;
      await run([
        "edit",
        rel,
        "alice",
        "discovery",
        "--level",
        cur === 4 ? "3" : "4",
        "--reason",
        "r",
        "--by",
        "kamal",
      ]);
      await ex("alice", "o/v1b", "participant:alice");
      expect(JSON.parse(await read("o/v1b/alice.json")).criteria).toEqual(
        JSON.parse(v1).criteria,
      );
    });
    it("withdrawal removes participant access", async () => {
      await run([
        "withdraw",
        rel,
        "alice",
        "--reason",
        "wrong session",
        "--by",
        "kamal",
      ]);
      expect((await ex("alice", "o/w", "participant:alice")).code).toBe(1);
    });
  });
});
```

(The unused `before` lines in the amendment test are removed in the final edit; keep the test body to the v1 vs v1b comparison.)

Add a legacy test: when `review.opened.legacy` is true (open a review on a draft directory whose JSON has `flag_codes` stripped), the participant export carries the note `Legacy draft set` and the facilitator export does not need one.

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/visibility.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `view.ts`: widen `RenderAudience` to `{ audience: "released"; line: string; legacy?: boolean }`. When `released`, build the working copy from the frozen state: `const frozen = sv.snapshot ?? fail`, use `frozen.criteria` instead of `sv.criteria`, `frozen.summary`, `frozen.objectives`, and for the group `frozen.table` (map `table.objectives` to `lo_coverage` the same way the live branch does), while `sv.comments` stays live (feedback only). Add the note `Legacy draft set: this session was played before the visibility policy; the report is limited to the participant and the facilitator.` when `a.legacy`. Refactor the live branch so both read from one local `state` object `{ criteria, summary, objectives, table }` to avoid duplicated code.
  - `index-view.ts`: `renderReviewIndex(l, a, secrets)`: heading and session line from the draft (`scenario.title`, `session.id`, `session.date` through `safeMd`); for the facilitator a table `Subject | State | Version | Open items` over all subjects and the per-role learning-objective table from the live view; for a participant only: links `[alice](alice.md)` to the caller's own report if that subject is released and `[Group report](group.md)` if the group is released, and the learning-objective table with the caller's own column and the team column only (same shape as `renderIndex` in `report-write.ts`, `loScoreText` for cells).
  - `cli.ts` `export`: parse `--for` with `parsePrincipal` (null: usage error, exit 2); subjects may be a role, `group` or `index`; compute `canView({ principal, subject, state, versions: sv.versions.length, view: subject === "index" ? "index" : "report", superseded: l.view.superseded !== null, policyVersion: l.view.opened.policyVersion })` where for `index` use the group subject's state; denied: `ReviewRefusedError("<principal> cannot see <subject>: <why>")` (exit 1; `why` never names another participant). Render: facilitator => unchanged; `participant:<role>` personal => `viewReport(..., { audience: "released", line: "Visibility: you and the facilitator", legacy })`; group => `redactGroupForParticipant(viewReport(...), role)` before rendering Markdown and JSON; index => `renderReviewIndex`. The recorded `principal` is the `--for` value; an `index` export records `subject: "group"`'s version and `destination` as before (an `index` export is audited under subject `group` because the `report.exported` event requires a released subject; document this). Replace the Task 10 refusal of other principals with this path, and update that test (`participant:alice` is now exit 0 after release, exit 1 before).
- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0043: participant exports through canView, peer-free group report and index"
```

### Task 13: Offline demo check S-17, docs and story close

**Files:**

- Create: `services/runtime/src/review/demo-check.ts`
- Modify: `services/runtime/src/demo/showcase.ts` (`SHOWCASE_EVAL_CHECKS` gains S-17; the run), `services/runtime/src/demo/args.ts` (help text mentions S-17), `services/runtime/src/demo/__tests__/showcase-evaluate.test.ts` and the Friday showcase test (check lists and counts)
- Test: `services/runtime/src/review/__tests__/demo-check.test.ts`
- Modify (docs): `docs/EVALUATOR.md`, `docs/PRODUCT_SPEC.md` (ASM-09 line, if it states the interim behaviour), `docs/RELEASE_PLAN.md` (the EPIC-0005 note and AC-0106 wording), `CHANGELOG.md`, `docs/TEST_CASES.md`, `README.md`

**Interfaces:**

- Produces: `runReviewCheck(draftDir: string, o: { now: () => number }): Promise<string>` returning a one-line detail string and throwing `Error` (message states what failed) when any assertion fails. It works on a COPY of the draft directory in a private temp dir and removes it; the demo's reports directory is never modified.

- [ ] **Step 1: Write the failing tests** (`demo-check.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runReviewCheck } from "../demo-check.js";
import { fixedClock, makeDraftDir } from "./fixtures.js";

let root: string, dir: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runReviewCheck", () => {
  it("drives a scripted review end to end and reports what it verified", async () => {
    const detail = await runReviewCheck(dir, { now: fixedClock() });
    expect(detail).toMatch(/3 subjects/);
    expect(detail).toMatch(/access matrix/);
    expect(detail).toMatch(/peer/);
  });
  it("leaves the reports directory untouched (no review.jsonl, no lock)", async () => {
    const before = (await readdir(dir)).sort();
    await runReviewCheck(dir, { now: fixedClock() });
    expect((await readdir(dir)).sort()).toEqual(before);
  });
  it("fails when a draft file carries a peer's learning-objective result in the group report where redaction cannot remove it (a tampered group.json)", async () => {
    const f = path.join(dir, "group.json");
    const j = JSON.parse(await readFile(f, "utf8"));
    j.facilitator_notes = "bob scored 1.5"; // text, not structure: stays; the check must still pass
    await writeFile(f, JSON.stringify(j));
    await expect(
      runReviewCheck(dir, { now: fixedClock() }),
    ).resolves.toBeTruthy();
  });
});
```

(The third test pins that free text in a draft is not treated as a structural leak; the structural proof is in `visibility.test.ts`.)

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/demo-check.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `demo-check.ts`.** Copy every `*.md`/`*.json` of `draftDir` into `mkdtemp(path.join(os.tmpdir(), "acr-s17-"))` (mode 0700), then through the library (not the CLI): `openReview`; assert `applyCommand` with a `report.released` for all subjects is refused while any criterion needs review; accept every needs-review criterion and stale summary; release all in one event; for the matrix `{facilitator, participant:<each role>, line_manager, ld, hr, sponsor} x {each role, group, index}` compare `canView` with an expected function written inline from the spec table (facilitator all; participant own report, group and index with `peers`; others none) and count the cells; build `viewReport`/`redactGroupForParticipant` for the first role and assert the JSON has no other role key in `by_role`; write one `report.exported` through `applyCommand`; assert it is in the log; always `rm` the temp dir in `finally`. Return `` `${n} subjects reviewed and released in one event; access matrix ${cells} cells checked; peers' results absent from ${role}'s group report; ${exports} export recorded` ``.

In `showcase.ts` add to `SHOWCASE_EVAL_CHECKS`:

```ts
  { id: "S-17", title: "A scripted facilitator review released every report through the gate, only the right audience can see each one, a participant's group report holds no peer result, and the export is recorded", kind: "any" },
```

and, inside `if (o.evaluate)` after the S-16 block:

```ts
await rec.run(
  "S-17",
  async () =>
    runReviewCheck(o.holder.evaluation!.written.dir, { now: ctx.now }),
  ["S-16"],
);
```

(S-17 depends on S-16 having passed, so a failed evaluation reports S-17 as skipped, the same way other dependent checks do; read the third argument of `rec.run` in this file and follow its meaning.) Update the check-list expectations: the `--evaluate` run now has `[...SHOWCASE_CHECKS, "S-16", "S-17"]`; the Friday `--evaluate` count 15 becomes 16 (ruling P19). The default runs (29 / 39 / 42 / 14) are unchanged; assert that in the tests you touch.

- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review src/demo` then `pnpm -s demo --showcase --fast --evaluate` and `pnpm -s demo --showcase --fast --scenario scenarios/friday-escalation --evaluate` (both must show S-17 passed), plus the three plain mock demos with counts 29 / 42 / 14.

- [ ] **Step 5: Docs and plan status.** `docs/EVALUATOR.md`: the audience table, "who sees what", redaction of the group report and index for participants, legacy sessions, policy version, why viewing is not audited, and the inert audiences. Update the EPIC-0005 note in `RELEASE_PLAN.md` that says "participants may see each other's scores for now" (superseded), AC-0106's visibility wording, and `PRODUCT_SPEC.md` if it states the interim behaviour. `CHANGELOG.md` (`Added: export --for participant:<role>, S-17`; `Changed: group report and index no longer show peers' individual results to participants`), TC-0053 (policy and `canView` matrix), TC-0054 (peer redaction and S-17), `RELEASE_PLAN.md` (AC-0223..AC-0228 ticked, US-0043 Complete, TASK-0068 Done), `npm run plan:generate`, `progress.md`.
- [ ] **Step 6: Gates and commit** (Task 8 gate block; commit `[feat] US-0043: offline review check S-17, visibility docs and story close`). Open the PR for story 3.

---

# Story 4: US-0044 Self-assessment, response and dispute

Branch `feature/EPIC-0005-US-0044-self-assessment` from `develop` after story 3 has merged (blind rating is not blind while every draft is readable). Tasks 14 and 15.

### Task 14: Fold self-ratings, responses and dispute resolution

**Files:**

- Modify: `services/runtime/src/review/fold.ts` (three cases), `services/runtime/src/review/__tests__/fixtures.ts` (`makeFold` gains `part` and `foldE`), `services/runtime/src/review/__tests__/fold.test.ts` (replace the "later story" row with a still-unsupported case, see Step 1)
- Test: `services/runtime/src/review/__tests__/fold-self.test.ts`

**Interfaces:**

- Consumes: Task 9 fixtures (`makeFold`, `resolveBodies`), `CriterionView.self`, `ResponseView`.
- Produces: fold support for `self.rated`, `response.added`, `dispute.resolved`; `makeFold(...)` additionally returns `part(role: string): Actor` (`{ kind: "participant", role, attestedBy: "kamal" }`) and `foldE(...entries: Entry[]): View` (the opened event first, then these entries with their own actors).

- [ ] **Step 1: Adjust the shared helper and the old row.** Add to `makeFold`:

```ts
const part = (role: string): Actor => ({
  kind: "participant",
  role,
  attestedBy: "kamal",
});
const foldE = (...entries: Entry[]): View =>
  currentView(
    drafts,
    sealEntries(
      [],
      ZERO_HASH,
      [{ actor: fac, body: opened() }, ...entries],
      fixedClock(),
    ),
  );
```

(import `Entry`), return `{ fac, opened, log, fold, part, foldE }`. In `fold.test.ts` the row that used `self.rated` as "a later story" event is replaced by `["an unknown event type", () => fold({ type: "nope" } as never)]` (the fold's `default` branch still rejects it).

- [ ] **Step 2: Write the failing tests** (`fold-self.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { loadDrafts, type Drafts } from "../draft.js";
import { ReviewIllegalError } from "../errors.js";
import type { Body, Entry } from "../types.js";
import { makeDraftDir, makeFold, resolveBodies } from "./fixtures.js";

let root: string, drafts: Drafts, f: ReturnType<typeof makeFold>;
beforeEach(async () => {
  const m = await makeDraftDir();
  root = m.root;
  drafts = await loadDrafts(m.dir);
  f = makeFold(drafts);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const rate = (
  role: string,
  criterion: string,
  level: 1 | 2 | 3 | 4 | null,
  note?: string,
): Entry => ({
  actor: f.part(role),
  body: {
    type: "self.rated",
    role,
    criterion,
    level,
    ...(note ? { note } : {}),
  },
});
const fb = (body: Body): Entry => ({ actor: f.fac, body });
const releaseAlice = (): Entry[] => [
  ...resolveBodies(f.fold(), "alice").map(fb),
  fb({ type: "report.released", subjects: ["alice"] }),
];

describe("self-rating", () => {
  it("records a rating per criterion, the last one wins, and never changes the score, status or objectives", () => {
    const before = f.fold().subjects.get("alice")!;
    const v = f.foldE(
      rate("alice", "listening", 2),
      rate("alice", "listening", 4, "I think I did well"),
    );
    const a = v.subjects.get("alice")!;
    const c = a.criteria.find((x) => x.id === "listening")!;
    expect(c.self).toMatchObject({ level: 4, note: "I think I did well" });
    expect(c.current).toBe(
      before.criteria.find((x) => x.id === "listening")!.current,
    );
    expect(c.status).toBe(
      before.criteria.find((x) => x.id === "listening")!.status,
    );
    expect(a.objectives).toEqual(before.objectives);
    expect(
      f
        .foldE(rate("alice", "listening", null))
        .subjects.get("alice")!
        .criteria.find((x) => x.id === "listening")!.self?.level,
    ).toBeNull();
  });
  it("closes at release and is kept in the frozen snapshot", () => {
    const v = f.foldE(rate("alice", "listening", 3), ...releaseAlice());
    expect(
      v.subjects
        .get("alice")!
        .snapshot!.criteria.find((x) => x.id === "listening")!.self?.level,
    ).toBe(3);
    expect(() =>
      f.foldE(...releaseAlice(), rate("alice", "listening", 2)),
    ).toThrow(/released|closed/);
  });
  it.each([
    [
      "a facilitator actor",
      () =>
        f.foldE(
          fb({
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          }),
        ),
    ],
    [
      "another role's actor",
      () =>
        f.foldE({
          actor: f.part("bob"),
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    [
      "no attestation",
      () =>
        f.foldE({
          actor: { kind: "participant", role: "alice", attestedBy: "" },
          body: {
            type: "self.rated",
            role: "alice",
            criterion: "listening",
            level: 3,
          },
        }),
    ],
    ["the group", () => f.foldE(rate("group", "shared_understanding", 3))],
    ["an unknown criterion", () => f.foldE(rate("alice", "nope", 3))],
    ["an unknown role", () => f.foldE(rate("carol", "listening", 3))],
    [
      "a level outside 1 to 4",
      () => f.foldE(rate("alice", "listening", 7 as never)),
    ],
    [
      "an over-long note",
      () => f.foldE(rate("alice", "listening", 3, "x".repeat(1501))),
    ],
  ])("rejects %s", (_n, run) => {
    expect(run).toThrow(ReviewIllegalError);
  });
});

describe("response and dispute", () => {
  const respond = (
    over: Partial<Extract<Body, { type: "response.added" }>> = {},
  ): Entry => ({
    actor: f.part("alice"),
    body: {
      type: "response.added",
      role: "alice",
      text: "I disagree about scene 2",
      ...over,
    },
  });
  it("accepts a response only after that subject's release, overall or per criterion", () => {
    expect(() => f.foldE(respond())).toThrow(ReviewIllegalError);
    const v = f.foldE(
      ...releaseAlice(),
      respond(),
      respond({ criterion: "listening", dispute: true }),
    );
    expect(
      v.subjects
        .get("alice")!
        .responses.map((r) => [r.criterion, r.dispute, r.resolution]),
    ).toEqual([
      [undefined, false, null],
      ["listening", true, null],
    ]);
    expect(() =>
      f.foldE(...releaseAlice(), respond({ criterion: "nope" })),
    ).toThrow(ReviewIllegalError);
    expect(() =>
      f.foldE(...releaseAlice(), {
        actor: f.fac,
        body: { type: "response.added", role: "alice", text: "x" },
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("resolves a dispute once with an outcome and a reason; upheld and declined leave the score", () => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    const resolve = (
      outcome: "upheld" | "amended" | "declined",
      reason = "checked the recording",
    ): Entry =>
      fb({ type: "dispute.resolved", response: seq, outcome, reason });
    const v = f.foldE(...base, resolve("upheld"));
    expect(v.subjects.get("alice")!.responses[0]!.resolution).toMatchObject({
      outcome: "upheld",
      reason: "checked the recording",
      by: "kamal",
    });
    expect(() =>
      f.foldE(...base, resolve("upheld"), resolve("declined")),
    ).toThrow(/already/);
    expect(() => f.foldE(...base, resolve("declined", ""))).toThrow(
      ReviewIllegalError,
    );
    expect(() =>
      f.foldE(...base, {
        actor: f.part("alice"),
        body: {
          type: "dispute.resolved",
          response: seq,
          outcome: "upheld",
          reason: "r",
        },
      }),
    ).toThrow(ReviewIllegalError);
  });
  it("refuses to resolve a response that is not a dispute or does not exist", () => {
    const base = [...releaseAlice(), respond()];
    const seq = f.foldE(...base).lastSeq;
    expect(() =>
      f.foldE(
        ...base,
        fb({
          type: "dispute.resolved",
          response: seq,
          outcome: "upheld",
          reason: "r",
        }),
      ),
    ).toThrow(/not a dispute/);
    expect(() =>
      f.foldE(
        ...base,
        fb({
          type: "dispute.resolved",
          response: 999,
          outcome: "upheld",
          reason: "r",
        }),
      ),
    ).toThrow(/no such response/);
  });
  it("'amended' needs the report amended after the response (in amendment or re-released)", () => {
    const base = [...releaseAlice(), respond({ dispute: true })];
    const seq = f.foldE(...base).lastSeq;
    const res = fb({
      type: "dispute.resolved",
      response: seq,
      outcome: "amended",
      reason: "fixed",
    });
    expect(() => f.foldE(...base, res)).toThrow(/amend/);
    const v1 = f.foldE(...releaseAlice()).lastSeq;
    expect(
      f
        .foldE(
          ...base,
          fb({
            type: "report.amended",
            subject: "alice",
            reason: "r",
            basedOn: v1,
          }),
          res,
        )
        .subjects.get("alice")!.responses[0]!.resolution?.outcome,
    ).toBe("amended");
  });
});
```

- [ ] **Step 3: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-self.test.ts` Expected: FAIL.

- [ ] **Step 4: Implement in `fold.ts`** (add `import { isSafeId } from "@acr/events";`; the cases go before `default`):

```ts
      case "self.rated": {
        const a = e.actor;
        if (a.kind !== "participant" || a.role !== e.role || !isSafeId(a.attestedBy)) ill(e, "a self-rating is made by the participant and attested by the facilitator");
        const sv = subj(e, e.role);
        if (sv.kind !== "participant") ill(e, "only players rate themselves");
        if (sv.versions.length > 0 || sv.state !== "draft") ill(e, `${sv.id}'s report was already released; self-rating is closed`);
        const c = crit(e, sv, e.criterion);
        if (!(e.level === null || e.level === 1 || e.level === 2 || e.level === 3 || e.level === 4)) ill(e, "level must be 1 to 4 or not observed");
        c.self = { level: e.level, ...(e.note !== undefined ? { note: text(e, e.note) } : {}), seq: e.seq };
        break;
      }
      case "response.added": {
        const a = e.actor;
        if (a.kind !== "participant" || a.role !== e.role || !isSafeId(a.attestedBy)) ill(e, "a response is made by the participant and attested by the facilitator");
        const sv = subj(e, e.role);
        if (sv.kind !== "participant") ill(e, "only players respond");
        if (sv.versions.length === 0 || sv.state === "withdrawn") ill(e, `${sv.id}'s report is not released`);
        if (e.criterion !== undefined) crit(e, sv, e.criterion);
        sv.responses.push({ seq: e.seq, role: e.role, ...(e.criterion !== undefined ? { criterion: e.criterion } : {}), text: text(e, e.text), dispute: e.dispute === true, resolution: null });
        break;
      }
      case "dispute.resolved": {
        const by = facilitator(e);
        const found = [...subjects.values()].flatMap((sv) => sv.responses.map((r) => ({ sv, r }))).find((x) => x.r.seq === e.response);
        if (!found) return ill(e, "no such response");
        if (!found.r.dispute) ill(e, "that response is not a dispute");
        if (found.r.resolution) ill(e, "that dispute is already resolved");
        if (e.outcome !== "upheld" && e.outcome !== "amended" && e.outcome !== "declined") ill(e, "outcome must be upheld, amended or declined");
        if (e.outcome === "amended" && !(found.sv.state === "amending" || found.sv.versions.some((v) => v > e.response))) ill(e, "amend the report first, then resolve the dispute as amended");
        found.r.resolution = { seq: e.seq, outcome: e.outcome, reason: reason(e, e.reason), by };
        break;
      }
```

(`return ill(...)` is only to satisfy control-flow narrowing; if the compiler accepts `ill(...)` alone after `const found = ...; if (!found)`, drop the `return`.)

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review` Expected: PASS.
- [ ] **Step 6: Commit.**

```bash
git add services/runtime/src/review
git commit -m "[feat] US-0044: fold self-ratings, responses and dispute resolution"
```

### Task 15: `self-assess`, `respond`, `resolve`, side-by-side rendering, and close the story

**Files:**

- Modify: `services/runtime/src/review/cli.ts` (three handlers, options `role`, `rate`, `note`, `list`, `dispute`, `outcome`; `status` lists open disputes), `services/runtime/src/review/view.ts` (self and responses in the view), `services/runtime/src/evaluator/report-model.ts` (`self?`, `responses?` on `ParticipantReport`), `services/runtime/src/evaluator/report-md.ts` (Self column and Responses section)
- Test: `services/runtime/src/review/__tests__/cli-self.test.ts`
- Modify (docs): `docs/EVALUATOR.md`, `docs/THREAT_MODEL.md`, `README.md`, `CHANGELOG.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `progress.md`

**Interfaces:**

- Consumes: Task 14 fold; Task 12 released audience; `buildMethod().scale` from `../evaluator/method.js` for the level anchors.
- Produces: `self-assess <dir> --role R --list` (criteria and level anchors only) and `self-assess <dir> --role R --rate <criterion>=<1|2|3|4|na>... [--note <t>] --by <facilitator>`; `respond <dir> --role R [--criterion <id>] --text <t> [--dispute] --by <facilitator>`; `resolve <dir> <response-seq> --outcome upheld|amended|declined --reason <t> --by <name>`. `ParticipantReport` gains `self?: Record<string, { level: number | null; label: string; note?: string }>` and `responses?: { criterion?: string; text: string; dispute: boolean; resolution?: { outcome: string; reason: string } }[]`.

- [ ] **Step 1: Write the failing tests** (`cli-self.test.ts`; `makeRunner`, `resolveAll`-style helpers as in Task 10, repeated locally)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "../store.js";
import { makeDraftDir, makeRunner } from "./fixtures.js";

let root: string, dir: string, run: ReturnType<typeof makeRunner>, rel: string;
beforeEach(async () => {
  ({ root, dir } = await makeDraftDir());
  run = makeRunner(root);
  rel = path.relative(root, dir);
  await run(["open", rel, "--by", "kamal"]);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const resolveAll = async (s: string) => {
  for (const c of (await loadReview(dir)).view.subjects
    .get(s)!
    .criteria.filter((x) => x.status === "needs_review"))
    await run(["accept", rel, s, c.id, "--by", "kamal"]);
};
const release = async () => {
  for (const s of ["alice", "bob", "group"]) await resolveAll(s);
  expect((await run(["release", rel, "--all", "--by", "kamal"])).code).toBe(0);
};
const exportAlice = async (to: string) => {
  await run([
    "export",
    rel,
    "alice",
    "--for",
    "participant:alice",
    "--to",
    to,
    "--by",
    "kamal",
  ]);
  return readFile(path.join(root, to, "alice.md"), "utf8");
};

describe("self-assess", () => {
  it("--list shows the criteria and the level anchors, never a score or rationale, and is unchanged by facilitator edits", async () => {
    const a = await run(["self-assess", rel, "--role", "alice", "--list"]);
    expect(a.code).toBe(0);
    const draft = JSON.parse(
      await readFile(path.join(dir, "alice.json"), "utf8"),
    );
    expect(a.out).toContain("listening");
    for (const c of draft.criteria) expect(a.out).not.toContain(c.rationale);
    const cur = (await loadReview(dir)).view.subjects
      .get("alice")!
      .criteria.find((c) => c.id === "listening")!.current;
    await run([
      "edit",
      rel,
      "alice",
      "listening",
      "--level",
      cur === 4 ? "3" : "4",
      "--reason",
      "r",
      "--by",
      "kamal",
    ]);
    expect(
      (await run(["self-assess", rel, "--role", "alice", "--list"])).out,
    ).toBe(a.out);
  });
  it("records ratings as the participant, attested by the facilitator; the last rating wins; bad input is refused", async () => {
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=2",
          "--rate",
          "negotiation=na",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=4",
          "--note",
          "I was patient",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const l = await loadReview(dir);
    const ev = l.events.filter((e) => e.type === "self.rated");
    expect(ev[0]!.actor).toEqual({
      kind: "participant",
      role: "alice",
      attestedBy: "kamal",
    });
    expect(
      l.view.subjects.get("alice")!.criteria.find((c) => c.id === "listening")!
        .self,
    ).toMatchObject({ level: 4, note: "I was patient" });
    for (const argv of [
      ["--rate", "listening=9"],
      ["--rate", "listening"],
      ["--rate", "nope=3"],
      ["--role", "group", "--rate", "x=3"],
    ]) {
      expect(
        (
          await run([
            "self-assess",
            rel,
            ...(argv[0] === "--role" ? [] : ["--role", "alice"]),
            ...argv,
            "--by",
            "kamal",
          ])
        ).code,
      ).not.toBe(0);
    }
    expect(
      (
        await run([
          "self-assess",
          rel,
          "--role",
          "alice",
          "--rate",
          "listening=3",
        ])
      ).code,
    ).toBe(2); // no attestation
  });
  it("is closed once that report is released", async () => {
    await release();
    const r = await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=3",
      "--by",
      "kamal",
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/closed|released/);
  });
  it("never changes the score", async () => {
    const before = (await loadReview(dir)).view.subjects.get(
      "alice",
    )!.objectives;
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=1",
      "--by",
      "kamal",
    ]);
    expect(
      (await loadReview(dir)).view.subjects.get("alice")!.objectives,
    ).toEqual(before);
  });
});

describe("released report: self against final, responses, disputes", () => {
  it("shows the self-rating next to the final level in the participant's report", async () => {
    await run([
      "self-assess",
      rel,
      "--role",
      "alice",
      "--rate",
      "listening=2",
      "--note",
      "SELF-NOTE-1",
      "--by",
      "kamal",
    ]);
    await release();
    const md = await exportAlice("o/a");
    expect(md).toMatch(/Self-rating/);
    expect(md).toContain("SELF-NOTE-1");
  });
  it("accepts a response only after release; a dispute is listed in status without its text; resolve closes it and shows in the report", async () => {
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--text",
          "RESPONSE-TEXT",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    await release();
    expect(
      (
        await run([
          "respond",
          rel,
          "--role",
          "alice",
          "--criterion",
          "listening",
          "--text",
          "RESPONSE-TEXT <b>x</b>",
          "--dispute",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    const st = await run(["status", rel]);
    expect(st.out).toMatch(/open dispute: #\d+ by alice on listening/);
    expect(st.out).not.toContain("RESPONSE-TEXT");
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "declined",
          "--reason",
          "The recording supports the level",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
    expect((await run(["status", rel])).out).not.toMatch(/open dispute/);
    const md = await exportAlice("o/a2");
    expect(md).toContain("RESPONSE-TEXT");
    expect(md).not.toContain("<b>");
    expect(md).toMatch(/declined/i);
    expect(md).toContain("The recording supports the level");
  });
  it("resolve 'amended' needs an amend first, then works", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "wrong",
      "--dispute",
      "--by",
      "kamal",
    ]);
    const seq = (await loadReview(dir)).events.find(
      (e) => e.type === "response.added",
    )!.seq;
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "amended",
          "--reason",
          "fixed",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
    await run(["amend", rel, "alice", "--reason", "dispute", "--by", "kamal"]);
    expect(
      (
        await run([
          "resolve",
          rel,
          String(seq),
          "--outcome",
          "amended",
          "--reason",
          "fixed",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(0);
  });
  it("another participant's export does not carry alice's response", async () => {
    await release();
    await run([
      "respond",
      rel,
      "--role",
      "alice",
      "--text",
      "ALICE-ONLY",
      "--by",
      "kamal",
    ]);
    await run([
      "export",
      rel,
      "bob",
      "--for",
      "participant:bob",
      "--to",
      "o/b",
      "--by",
      "kamal",
    ]);
    expect(await readFile(path.join(root, "o/b/bob.md"), "utf8")).not.toContain(
      "ALICE-ONLY",
    );
    expect(
      (
        await run([
          "export",
          rel,
          "alice",
          "--for",
          "participant:bob",
          "--to",
          "o/x",
          "--by",
          "kamal",
        ])
      ).code,
    ).toBe(1);
  });
  it("scrubs secrets from a response", async () => {
    await release();
    await run(
      [
        "respond",
        rel,
        "--role",
        "alice",
        "--text",
        "my key sk-live-abcdef123456",
        "--by",
        "kamal",
      ],
      { OPENROUTER_API_KEY: "sk-live-abcdef123456" },
    );
    expect(
      await readFile(path.join(dir, "review.jsonl"), "utf8"),
    ).not.toContain("sk-live-abcdef123456");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/cli-self.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `report-model.ts`: add `self?: Record<string, { level: number | null; label: string; note?: string }>` and `responses?: { criterion?: string; text: string; dispute: boolean; resolution?: { outcome: string; reason: string } }[]` to `ParticipantReport`.
  - `report-md.ts`: `criteriaTable(cs, sec, self?)` adds a `Self-rating` column (between Level and Confidence) only when `self` is given and shows `${level} - ${label}` or `N/O` plus the note (`safeMd`, 1500); `renderParticipantMarkdown` passes `r.self` and, after `## Criteria`, prints `## Your responses` (only when `r.responses` is non-empty): each as `- (criterion) text` with `Facilitator's reply (<outcome>): <reason>` when resolved, all through `safeMd`.
  - `view.ts` participant branch: `r.self` from the frozen criteria's `self` (released audience) or live (facilitator audience), only when at least one rating exists; `r.responses` from `sv.responses` (live; it is the participant's own report, so the same audience).
  - `cli.ts`: add `role`, `rate` (multiple), `note`, `list`, `dispute` (boolean), `outcome` to `OPTIONS`; `ALLOWED` gets `"self-assess": ["role", "by", "rate", "note", "list"], respond: ["role", "by", "criterion", "text", "dispute"], resolve: ["by", "outcome", "reason"]`; usage lines for the three.

```ts
  async "self-assess"(c) {
    const role = typeof c.values.role === "string" ? c.values.role : "";
    if (!role) throw new ReviewUsageError("self-assess needs --role <role>");
    if (c.values.list === true) {
      const l = await loadReview(c.dir);
      const sv = l.view.subjects.get(role);
      if (!sv || sv.kind !== "participant") throw new ReviewRefusedError("unknown player role");
      c.out(`Rate yourself on each criterion (1 to 4, or na if there was no chance to show it):`);
      for (const k of sv.criteria) c.out(`  ${k.id}: ${k.name}`);
      for (const s of buildMethod().scale) c.out(`  ${s.level} ${s.label}: ${s.meaning}`);
      return 0;
    }
    const by = cleanBy(c.values.by);
    const rates = (Array.isArray(c.values.rate) ? c.values.rate : []).map((r) => {
      const i = r.indexOf("="); if (i < 1) throw new ReviewUsageError("--rate needs <criterion>=<1|2|3|4|na>");
      return { criterion: r.slice(0, i), level: parseLevel(r.slice(i + 1)) };
    });
    if (rates.length === 0) throw new ReviewUsageError("self-assess needs --list or at least one --rate");
    if (c.values.note !== undefined && rates.length !== 1) throw new ReviewUsageError("--note goes with exactly one --rate");
    const note = typeof c.values.note === "string" ? cleanText(c.values.note, LIMITS.text, "--note", c.secrets) : undefined;
    await applyCommand(c.dir, c.now, () => rates.map((r) => ({ actor: { kind: "participant", role, attestedBy: by } as const, body: { type: "self.rated", role, criterion: r.criterion, level: r.level, ...(note !== undefined ? { note } : {}) } })));
    c.out(`${rates.length} self-rating(s) recorded for ${role}`);
    return 0;
  },
  async respond(c) {
    const role = typeof c.values.role === "string" ? c.values.role : ""; if (!role) throw new ReviewUsageError("respond needs --role <role>");
    const by = cleanBy(c.values.by); const text = cleanText(String(c.values.text ?? ""), LIMITS.text, "--text", c.secrets);
    const criterion = typeof c.values.criterion === "string" ? c.values.criterion : undefined;
    await applyCommand(c.dir, c.now, () => [{ actor: { kind: "participant", role, attestedBy: by }, body: { type: "response.added", role, ...(criterion !== undefined ? { criterion } : {}), text, ...(c.values.dispute === true ? { dispute: true } : {}) } }]);
    c.out(`response recorded for ${role}${c.values.dispute === true ? " (dispute: it is on the facilitator's list)" : ""}`);
    return 0;
  },
  async resolve(c) {
    const seq = Number(c.args[0]); if (!Number.isInteger(seq) || seq < 1) throw new ReviewUsageError("resolve needs the response number from status");
    const actor = facilitator(c); const reason = cleanText(String(c.values.reason ?? ""), LIMITS.reason, "--reason", c.secrets);
    const outcome = c.values.outcome;
    if (outcome !== "upheld" && outcome !== "amended" && outcome !== "declined") throw new ReviewUsageError("--outcome needs upheld, amended or declined");
    await applyCommand(c.dir, c.now, () => [{ actor, body: { type: "dispute.resolved", response: seq, outcome, reason } }]);
    c.out(`dispute #${seq} resolved: ${outcome}`);
    return 0;
  },
```

In `statusLines` add, per subject, `for (const r of sv.responses.filter((x) => x.dispute && !x.resolution)) out.push(\` open dispute: #${r.seq} by ${r.role}${r.criterion ? \` on ${r.criterion}\` : ""}\`)`(ids only, never the text) and a`${n} self-rating(s)`count. Import`buildMethod`.

- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/review src/evaluator src/demo` Expected: PASS (draft report Markdown has no Self column, so existing tests are unaffected).

- [ ] **Step 5: Docs and plan status.** `docs/EVALUATOR.md`: the self-assessment flow ("run by the facilitator or sitting with the participant; blind; closes at release; never changes the score"), responses, disputes and their outcomes, and the line "Facilitator comments are internal unless marked `--feedback`". `docs/THREAT_MODEL.md`: a short item on the attested participant channel (a participant at the facilitator's machine can read every draft because they share the OS user; attestation is honest about that; EPIC-0002 replaces it with real logins; join codes are never taken on a command line). `README.md`, `CHANGELOG.md`, `docs/TEST_CASES.md` (TC-0055 fold, TC-0056 CLI), `docs/RELEASE_PLAN.md` (AC-0229..AC-0234 ticked, US-0044 Complete, TASK-0069 Done, and the EPIC-0005 description: moderation, visibility and self-assessment now built; only the web UI and SSO remain, in EPIC-0002), `npm run plan:generate`, `progress.md`.
- [ ] **Step 6: Gates and commit** (Task 8 gate block; commit `[feat] US-0044: self-assessment, response and dispute, side by side in released reports`). Open the PR for story 4. After merge: session close updates (`MEMORY.md`, `progress.md`, `CHANGELOG.md`).

---

## Self-review

**Spec coverage** (spec section -> task):

| Spec                                                                    | Task                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 success criteria 1, 2                                                 | 4, 5, 7, 9, 10                                                                                                                                                                                                   |
| 1 criterion 3 (amend, withdraw, history)                                | 9, 10                                                                                                                                                                                                            |
| 1 criterion 4 (policy, peers removed)                                   | 11, 12                                                                                                                                                                                                           |
| 1 criterion 5 (self, response, dispute)                                 | 14, 15                                                                                                                                                                                                           |
| 1 criterion 6 (export audit, documented limits)                         | 9, 10, 12, docs in 8, 10, 13                                                                                                                                                                                     |
| 3 layers, `review.opened`, hashes, join-code snapshot, session instance | 2, 3, 5                                                                                                                                                                                                          |
| 3 events table                                                          | 1 (types), 4, 9, 14                                                                                                                                                                                              |
| 3 fold pure, total, rejects illegal                                     | 4, 9, 14                                                                                                                                                                                                         |
| 3 concurrency, compare-and-set, one-event multi-release                 | 5, 7 (`--expect`, P7), 9, 10                                                                                                                                                                                     |
| 3 limits, stripHidden, scrubDeep, safeMd, `--by`                        | 1, 6, 7                                                                                                                                                                                                          |
| 3 tamper resistance and its documentation                               | 2, 8 (docs)                                                                                                                                                                                                      |
| 4 needs-review rule, structured flags                                   | 3, 4 (P3, P6)                                                                                                                                                                                                    |
| 4 gate, stale summary, failed evaluation                                | 4 (`gate.ts`), 9                                                                                                                                                                                                 |
| 4 group report table freeze/stale                                       | 4, 9                                                                                                                                                                                                             |
| 4 commands                                                              | 7, 10, 15 (`accept --all-high` dropped, P8)                                                                                                                                                                      |
| 4 rendering, human-moderated note, AI draft calibration label           | 6                                                                                                                                                                                                                |
| 5 re-runs and supersede                                                 | 8                                                                                                                                                                                                                |
| 6 policy table, `canView`, redaction, policy version, legacy            | 11, 12                                                                                                                                                                                                           |
| 6 exports, no view audit                                                | 10, 12                                                                                                                                                                                                           |
| 7 self-rating, attestation, at release, response, dispute               | 14, 15                                                                                                                                                                                                           |
| 8 compatibility, `acr.view/1`, mock demos, S-17                         | 6, 13 (P19)                                                                                                                                                                                                      |
| 9 exit codes and messages                                               | 1, 7 (every CLI test)                                                                                                                                                                                            |
| 10 security notes, agent rule                                           | 10 (AGENTS.md), 15 (THREAT_MODEL.md)                                                                                                                                                                             |
| 12 testing list                                                         | fold property test (4), tamper (2, 5), concurrency (5, 10), gate (9), access matrix (11), redaction bytes (12), CLI (7, 10, 15), export audit (10, 12), hostile input (1, 7, 15), Linux container (8 gate block) |
| 14 open items                                                           | long comments: shown whole, wrapped by Markdown (the 1,500 limit is below the 1,600-character display cap used by `safeMd(…, 1500)`); flag codes P3; check S-17; CLI P1                                          |

**Placeholder scan:** no TBD or deferred steps. Where a step names an edit without its full text (the `report-md.ts` table column, the `view.ts` released branch, the `index-view.ts` Markdown), the shape, the exact fields and a test that pins the behaviour are given; the implementer reads the named function first.

**Type consistency:** `Level`, `CurrentLevel`, `Actor`, `Body`, `Entry`, `ReviewEvent` (Task 1) are the only event types; `SubjectView`, `CriterionView`, `Snapshot`, `GroupTable`, `View` (Task 4) gain `exports` in Task 9 and nothing else; `Loaded` (Task 5) is what every CLI handler and `index-view.ts` read; `Principal`, `canView`, `Access` (Task 11) are used by Tasks 12 and 13 unchanged; `makeFold`, `resolveBodies` (Task 9), `makeRunner` (Task 10) and `makeDraftDir` (Task 3) are the only test fixtures.

**Review Focus coverage:** (1) hostile text: Tasks 1, 7, 15; (2) races: Tasks 5, 10; (3) damage: Tasks 2, 5, 7; (4) peer bytes: Tasks 11, 12; (5) re-runs: Task 8.
