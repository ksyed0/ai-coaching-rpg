# Slice 2c-2: participant self-assess and respond (US-0063) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant with a report link rates themselves (blind, before release) and responds or disputes (after release) in the browser, written by the control service under a new versioned actor kind.

**Architecture:** The runtime owns the rules: `acr.review/2` plus a `participant_session` actor in the fold, and a new read/write subpath `@acr/runtime/participant`. The control service is the only web writer: it re-checks the credential, takes the role from it, retries a held lock, and bounds what a link can write. The BFF stays data-free; the page adds sections around the existing escaped report block.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (`@acr/runtime`, `@acr/control`, `@acr/web`), Next.js route handlers, React, Playwright with Axe.

**Spec:** `docs/superpowers/specs/2026-11-05-slice-2c-2-participant-actions-design.md` (read it first; section numbers below refer to it). Parent: `docs/superpowers/specs/2026-11-05-slice-2c-reports-design.md`.

**Delivery:** branch `feature/EPIC-0002-US-0063-participant-report`, two PRs into `develop`. **PR 1 = Tasks 1 to 8** (no browser; the 2c-1 page and link rule are untouched). **PR 2 = Tasks 9 to 15** (browser). Never merge a PR without the owner's say-so.

## Global Constraints

- Commit format `[TYPE] EPIC-0002: short imperative description` (max 72 chars); types feat, fix, test, docs, refactor, chore. All tests pass and coverage stays at least 80% before any commit. Every user-visible change goes under `[Unreleased]` in `CHANGELOG.md` in the same PR.
- Schema: `REVIEW_SCHEMA = "acr.review/2"`, `REVIEW_SCHEMAS = ["acr.review/1", "acr.review/2"]`; new openers (open, supersede) are `/2`.
- Actor: `{ kind: "participant_session"; v: 1; role; credentialId }`, accepted only for `self.rated` and `response.added`, only in a `/2` review, only when `actor.role === event.role`; unknown `v` is illegal.
- Capacity: at most `10 × criteria` `self.rated` events per role; `LIMITS.responses` = 50 per role; text 1,500 characters (`LIMITS.text`); at most 20 writes per credential per 10 minutes; supersede carries the latest `self.rated` per (role, criterion) only.
- Lock retry: 5 attempts, delays 100, 200, 400, 800 ms, ±25% jitter, then `busy`; `sleep` and `random` injected; the credential is re-checked before every attempt (no write starts after a revoke or reissue returns).
- Body caps: responses 16 KB, self-ratings 64 KB, every other control route stays at 4 KB (`MAX_BODY_BYTES`); over the cap is 413 with a fixed sentence. The BFF uses the same two figures.
- All control and BFF refusal text is a fixed sentence: no id, path, role or error message. A refused credential is the same neutral 404 as the 2c-1 read; a store problem is a 503, never the 404.
- The blind form reads only each criterion's `id` and `name`, the generic scale (`buildMethod().scale`), and the role's own earlier ratings. It never reads a draft field (`level_label`, rationale, evidence, comments).
- Resolution reasons stay participant-visible as today (decision 8). `/1` reviews return `old_schema` for web writes; the terminal path is unchanged.
- Participant text goes through `cleanText(raw, LIMITS.text, what, secrets)` and is rendered only as React text nodes.
- New ids start at AC-0369, TC-0127, TASK-0101 (TASK-0092 and AC-0331 to AC-0335 already belong to US-0063).
- Test commands: `pnpm --filter @acr/runtime exec vitest run <file>`, `pnpm --filter @acr/control exec vitest run <file>`, `pnpm --filter @acr/web exec vitest run <file>`; typecheck `pnpm -r typecheck`; Playwright `pnpm --filter @acr/web exec playwright test <spec>` (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the pinned build is not installed).

## Review Focus

Each line has its test in the named task.

1. **A stale form after release.** The participant keeps the rating form open, the facilitator releases, then they press Save: nothing is written, the answer is `closed`, the page says so and keeps what they typed. (Tasks 5, 12)
2. **A double-click or two tabs sending the same response.** Exactly one event is written; the second answer is `ok`. (Task 5)
3. **Full-size multi-byte input.** Seven criteria each with a 1,500-character note in CJK or emoji passes the 64 KB cap and is written; one byte over is 413. (Task 8)
4. **Reissue while someone is mid-rating.** The old cookie's next write gets the neutral 404 and the cookie is cleared; the new link shows the earlier ratings (found by role) and the old draft is gone. (Tasks 9, 10, 11)
5. **A `moderate` command holds the lock when a participant saves.** The save retries, then succeeds or answers `busy` with the draft kept; the log chain stays valid. (Tasks 7, 11)

---

## PR 1: runtime and control, no browser

### Task 1: Schema `/2` and the `participant_session` actor

**Files:**
- Modify: `services/runtime/src/review/types.ts`, `fold.ts`, `store.ts` (`checkActor`, `loadReview`, openers), `review-log.ts` (`isEventShape`)
- Test: `services/runtime/src/review/__tests__/fold-participant-session.test.ts` (new); extend `review-log.test.ts`, `store.test.ts`

**Interfaces:**
- Produces: `REVIEW_SCHEMAS: readonly ["acr.review/1","acr.review/2"]`; `Actor` gains `{ kind: "participant_session"; v: 1; role: string; credentialId: string }`; `isCredentialId`-shaped check available to the runtime as a local `isCredentialIdShape(s: unknown): s is string` in `review/types.ts` (11-character base64url, the same rule as control's `isCredentialId`).

- [ ] **Step 1: Failing tests** in `fold-participant-session.test.ts` (use `makeFold`, `makeDraftDir` from `fixtures.ts`): `accepts self.rated and response.added from a participant_session in a /2 review`; `refuses participant_session on every other event type` (loop over all `Body["type"]` except those two, asserting `ReviewIllegalError`); `refuses it in a /1 review`; `refuses v other than 1 (0, 2, undefined)`; `refuses a role that differs from event.role`; `still accepts the attested actor, including a log that mixes both kinds`; `self-rating after release and response before release are still illegal for the new kind`; `who() renders "alice (web link <id>)"`. In `review-log.test.ts`: `a web event round-trips through readReview` (write with `writeEvents`, read back, no `ReviewCorruptError`); `a /1 log written before this change still loads`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-participant-session.test.ts src/review/__tests__/review-log.test.ts`. Expected: FAIL (kind unknown, schema unknown).
- [ ] **Step 3: Implement.** Change `REVIEW_SCHEMA` and add `REVIEW_SCHEMAS`; widen the `Actor` union; update `checkActor` (`store.ts`), the actor test in `isEventShape` (`review-log.ts`), `who()` and the `attested()` helper in `fold.ts` so `self.rated` and `response.added` accept either kind under the rules in Global Constraints; `checkOpened` and `loadReview` accept any schema in `REVIEW_SCHEMAS` and the fold knows the opener's schema when judging the actor. `moderate open` and supersede write `REVIEW_SCHEMA`.
- [ ] **Step 4: Run** the same command plus `pnpm --filter @acr/runtime exec vitest run src/review`. Expected: PASS (all existing review tests included).
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 review schema /2 and participant_session actor`.

### Task 2: `ReviewBusyError`

**Files:** Modify `services/runtime/src/review/errors.ts`, `review-log.ts` (`withReviewLock`); Test `review-log.test.ts`.

**Interfaces:** Produces `class ReviewBusyError extends ReviewRefusedError` (same message and exit code as today).

- [ ] **Step 1: Failing test** `withReviewLock throws ReviewBusyError when the lock is held, and it is still a ReviewRefusedError with the same message`; `the CLI still exits 1 with the same text` (extend `cli.test.ts` only if it already covers the lock message).
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/review-log.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the class and throw it for `locked` and `contention`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/review`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 distinguish a held review lock`.

### Task 3: Supersede carries the latest rating only

**Files:** Modify `services/runtime/src/review/store.ts` (the carry loop around the `CARRIED_PARTICIPANT` handling); Test `supersede-participant.test.ts`.

**Interfaces:** Consumes Task 1's actor. Produces no new API.

- [ ] **Step 1: Failing tests:** `ten resubmits of one criterion carry as one self.rated`; `the carried rating is the latest by seq`; `responses and resolutions are still all carried`; `carried participant_session events keep their original actor and stay valid in the new /2 log`; `the carried-event limit check still refuses an over-limit log`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/supersede-participant.test.ts`. Expected: FAIL on the first two.
- [ ] **Step 3: Implement** in the carry loop: keep, per (role, criterion), only the highest-seq `self.rated`; leave the other carried types untouched.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/review`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 supersede carries the latest self-rating`.

### Task 4: `@acr/runtime/participant`, read side

**Files:**
- Create: `services/runtime/src/participant/types.ts`, `form.ts`, `progress.ts`, `index.ts`
- Modify: `services/runtime/package.json` (`"./participant": "./src/participant/index.ts"` in `exports`)
- Test: `services/runtime/src/participant/__tests__/form.test.ts`, `progress.test.ts`

**Interfaces:**
- Produces (exact):
  - `type Scale = { level: number; label: string; meaning: string }[]`
  - `type FormResult = { kind: "form"; criteria: { id: string; name: string }[]; scale: Scale; existing: Record<string, { level: Level; note?: string }> } | { kind: "closed" | "old_schema" | "none" | "unavailable" }`
  - `readSelfAssessForm(reportsDir: string, sessionId: string, role: string): Promise<FormResult>`
  - `type ProgressRow = { role: string; rated: number | null; total: number }` (`null` = unknown)
  - `selfRatingProgress(reportsDir: string, sessionId: string): Promise<{ kind: "ok"; rows: ProgressRow[] } | { kind: "none" | "unavailable" }>`
- Consumes: `reviewStatus`/`resolveReviewDir` from `../reports/index.js`, `loadReview`, `buildMethod` from `../evaluator/method.js`. Never throws; no path or id in any result.

- [ ] **Step 1: Failing tests** (build reviews with `makeDraftDir` and the `moderate` store functions): `form: returns only criteria {id,name}, the scale and the role's own ratings`; `form: the result's keys are exactly kind, criteria, scale, existing`; `form: evaluator rationale, evidence and comment canaries appear nowhere in JSON.stringify(result)`; `form: closed after release, for a withdrawn report, and for a draft with selfClosed`; `form: old_schema for a /1 review`; `form: none for an AI role, an unknown role and a session with no live review`; `form: symlinked or invalid session id gives none, never a path`; `progress: counts rated criteria out of total per draft human role, omits released roles and AI roles`; `progress: a half-written last log line gives rated:null for that role and does not fail the call`; `progress: takes no lock` (hold the lock, call, expect a result).
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/participant`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** both functions per Spec 4.1 and 4.5; `index.ts` re-exports the functions and types (Task 5 adds the write functions to it).
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/participant && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 participant module blind form and progress`.

### Task 5: `@acr/runtime/participant`, writes

**Files:** Create `services/runtime/src/participant/write.ts`; Modify `index.ts`, `types.ts`; Test `services/runtime/src/participant/__tests__/write.test.ts`.

**Interfaces:**
- Produces (exact):
  - `type SubmitCtx = { reportsDir: string; sessionId: string; role: string; credentialId: string; now: () => number; secrets: string[] }`
  - `type RatingInput = { criterion: string; level: Level; note?: string }`
  - `type SelfRatingResult = { kind: "ok"; wrote: number } | { kind: "closed" | "invalid" | "too_many" | "busy" | "old_schema" | "none" | "unavailable" }`
  - `submitSelfRatings(c: SubmitCtx & { ratings: RatingInput[] }): Promise<SelfRatingResult>`
  - `type ResponseInput = { criterion?: string; text: string; dispute?: boolean }`
  - `type ResponseResult = { kind: "ok"; wrote: boolean } | { kind: "not_released" | "withdrawn" | "too_many" | "invalid" | "busy" | "old_schema" | "none" | "unavailable" }`
  - `submitResponse(c: SubmitCtx & ResponseInput): Promise<ResponseResult>`
- Consumes: `applyCommand`, `ReviewBusyError` (Task 2), `cleanText` and `LIMITS`, the actor from Task 1. Notes and text use `cleanText`; an empty or all-hidden note is treated as absent; a response with empty text is `invalid`.

- [ ] **Step 1: Failing tests:** *ratings* `writes only changed ratings, in one append`; `an unchanged resubmit writes nothing and is ok`; `a note-only change writes`; `a rating without a note clears the earlier note`; `a criterion listed twice is invalid`; `an unknown criterion is invalid`; `an omitted criterion is unchanged`; `closed after release (Review Focus 1), for selfClosed and for a withdrawn report`; `too_many when the role would pass 10 × criteria self.rated events`; `old_schema in a /1 review`; `busy when review.lock is held (and nothing written)`; `events carry actor participant_session v:1 with the given role and credentialId`; `secrets and hidden characters are scrubbed from notes`. *responses* `writes one response with the dispute flag`; `refused before release (not_released) and when withdrawn`; `allowed while amending`; `the 51st is too_many`; `an unknown criterion is invalid`; `two concurrent identical submits write exactly one event (Review Focus 2)`; `a duplicate compares the cleaned text`; `a different dispute flag is not a duplicate`; `busy and old_schema as above`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/participant/__tests__/write.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both inside one `applyCommand` build function each, so the duplicate check, the diff and the caps are evaluated under the lock; map `ReviewBusyError` to `busy` and any other thrown review error to `unavailable`; map fold refusals to the result kinds above by checking state before building entries (as `cli.ts` `respond` does).
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/participant src/review && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 participant module self-ratings and responses`.

### Task 6: Pins, `resolve` copy and the `moderate status` line

**Files:** Modify `services/runtime/src/review/cli.ts` (`status`, `resolve` help text); Test `services/runtime/src/reports/__tests__/reports.test.ts` (pin), `services/runtime/src/review/__tests__/cli-self.test.ts` and `cli-show.test.ts`, a new `export-participant-text.test.ts` in `src/review/__tests__/`.

**Interfaces:** Consumes `selfRatingProgress` (Task 4). Produces no new API.

- [ ] **Step 1: Failing tests:** `readReleasedView own contains self ratings, responses, and resolution outcome and reason for a /1 and a /2 review` (a pin, expected to PASS already; confirm it does before changing anything); `export neutralises [x](url), ![x](url) and [x][ref] in notes and responses`; `no double escaping on a second render`; `moderate status prints "rated k of n criteria" per draft player and "x of y players have rated"`; `resolve --help says the reason is shown to the participant`.
- [ ] **Step 2: Run** the three files. Expected: pins pass; status and help tests FAIL.
- [ ] **Step 3: Implement** the status lines and the help sentence only.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/review src/reports`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 rating progress in moderate status`.

### Task 7: Control `ParticipantWriteService`

**Files:**
- Create: `services/control/src/participant-writes.ts`
- Modify: `services/control/src/__tests__/bots/imports.test.ts` (`ALLOWED` gains `"@acr/runtime/participant"`)
- Test: `services/control/src/__tests__/participant-writes.test.ts`

**Interfaces:**
- Consumes: `ReportAccessStore.checkResult(credentialId, sessionId)` (returns `{kind:"live"|"refused"|"unavailable"}`), `submitSelfRatings`/`submitResponse`, `ControlConfig.reportsDir`.
- Produces (exact):
  - `type WriteOutcome = { status: 200; wrote: number | boolean } | { status: 400 | 404 | 409 | 429 | 503; code: string; message: string; retryAfterMs?: number }`
  - `type ParticipantWriteService = { rate(sessionId: string, credentialId: string, ratings: RatingInput[]): Promise<WriteOutcome>; respond(sessionId: string, credentialId: string, input: ResponseInput): Promise<WriteOutcome> }`
  - `createParticipantWriteService(d: { config: ControlConfig; store: ReportAccessStore; secrets: string[]; now: () => number; sleep: (ms: number) => Promise<void>; random: () => number; log?: (m: string) => void }): ParticipantWriteService`
  - `warnIfReportsNotWritable(dir: string, log: (m: string) => void): Promise<void>` (logs one fixed line; never throws)
  - Fixed sentences exported as constants: `WRITE_CLOSED`, `WRITE_NOT_RELEASED`, `WRITE_WITHDRAWN`, `WRITE_TOO_MANY`, `WRITE_OLD_SCHEMA`, `WRITE_BUSY`, `WRITE_INVALID`, `WRITE_THROTTLED`. `old_schema` text: "This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal."

- [ ] **Step 1: Failing tests** (fake `sleep` and `random`, store from `report-fixture.ts`): `the role is taken from the credential` (a credential for role A writes events with role A only); `a refused, revoked, expired or other-session credential is the neutral 404 and writes nothing`; `a store problem is 503 unavailable, never 404`; `maps each runtime result to the status and fixed sentence in Spec 5.3`; `busy retries 5 times with delays 100/200/400/800 ±25% and then answers busy` (record sleeps); `a lock released on attempt 3 then succeeds` (Review Focus 5); `a revoke between attempts writes nothing (no write starts after revoke returns)`; `a reissue between attempts writes nothing`; `the 21st write in 10 minutes is 429 with retryAfterMs; the window slides`; `a concurrent moderate command leaves a valid chain`; `warnIfReportsNotWritable logs one fixed line for a read-only dir and nothing for a writable one`. In `imports.test.ts`, the guard test must pass with the new subpath and still fail for any other `@acr/runtime/*`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/participant-writes.test.ts src/__tests__/bots/imports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Per attempt: re-run `store.checkResult` (refused → 404), call the runtime, on `busy` sleep and retry. Throttle is a per-credential sliding window held in memory (20 per 10 min). Log at most one fixed line a minute, as `reports.ts` does.
- [ ] **Step 4: Run** `pnpm --filter @acr/control exec vitest run src/__tests__ && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 control participant write service`.

### Task 8: Control routes, per-route caps and PR 1 close-out

**Files:** Modify `services/control/src/api.ts` (`readBody`/`jsonBody` take a cap, two routes), `services/control/src/main.ts` (create the service, call `warnIfReportsNotWritable`); Test `services/control/src/__tests__/api.participant.test.ts` (new); Docs: `CHANGELOG.md`, `docs/ID_REGISTRY.md`.

**Interfaces:**
- Consumes: Task 7. Produces: `PUT /sessions/:id/reports/:credentialId/self-ratings` (body `{ ratings: [{ criterion, level, note? }] }`, cap 64 KB) and `POST /sessions/:id/reports/:credentialId/responses` (body `{ criterion?, text, dispute? }`, cap 16 KB). Success body `{ wrote }`. `readBody(req, max = MAX_BODY_BYTES)` and `jsonBody(req, max = MAX_BODY_BYTES)`.
- Zod bodies are strict: a `role` key (or any unknown key) is 400.

- [ ] **Step 1: Failing tests:** `a body with a role field is 400`; `credential id checked with isCredentialId before any lookup`; `neutral 404 identical for every refusal`; `7 criteria with 1,500-character CJK notes passes the 64 KB cap and is written (Review Focus 3)`; `one byte over either cap is 413 with the fixed sentence; other routes still cap at 4 KB`; `non-JSON content type is 400`; `429 carries Retry-After`; `503 busy has code busy`; `the 2c-1 GET and link routes are unchanged`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/api.participant.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes next to the existing `reports` GET (`seg.length === 5`), reading the body with the route's cap before parsing.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime test && pnpm --filter @acr/control test && pnpm -r typecheck && npm run plan:generate`. Expected: PASS.
- [ ] **Step 5: Docs and commit.** Add a CHANGELOG entry under `[Unreleased]` (control accepts participant ratings and responses; runtime `/2`); register the ids this PR used in `docs/ID_REGISTRY.md`. Commit `[feat] EPIC-0002: US-0063 control write routes (slice 2c-2 PR 1)`. Push, open PR 1 into `develop` as a draft, and wait for green CI.

---

## PR 2: browser

### Task 9: Read states and the link rule, control and BFF together

**Files:**
- Modify: `services/control/src/reports.ts` (`read`, `links`, `issue`, `reissue`, `NOT_READY`), `services/control/src/api.ts` (no route change; body of the GET), `apps/web/src/server/launcher-client.ts` (`ReportRead`, `readReport`, `LauncherReason` gains `"busy"`), `apps/web/src/server/report-handlers.ts` (`KNOWN_CONFLICTS`)
- Test: `services/control/src/__tests__/reports.test.ts`, `api.reports.test.ts`; `apps/web/src/server/__tests__/` (launcher-client and report-handlers tests)

**Interfaces:**
- Produces: control read states `self_assess` (with `form: FormResult["form"]` fields), `released`, `not_released`, `closed`, `old_schema`; `ReportRead` in the BFF as the same union; `links()` rows `{ role, credential, selfRated: { rated: number | null; total: number } | null }` plus `players: { rated: number; total: number } | null`; `requireLinkable(sessionId, role)` replaces `requireReleased`; new `NOT_READY` = "No reports are ready for this session yet. Run evaluate and moderate open, from the terminal (see the guide)."; the "no report to link" sentence becomes "There is no report to link for this role.", both mirrored in `KNOWN_CONFLICTS` in the same commit.

- [ ] **Step 1: Failing tests:** *control* `a draft human player can be issued, reissued and revoked; a withdrawn one cannot be issued but can be revoked; an AI role never`; `read gives self_assess for a draft, released for a released report, closed for a draft with selfClosed, old_schema for a /1 review, not_released for withdrawn`; `links lists draft and released roles with selfRated and the players summary; unreadable log gives rated:null`; `all 2c-1 released-role tests still pass`. *BFF* `readReport parses all five states and fails closed on anything else`; `busy is a known LauncherReason`; `the console still shows the not-ready and no-report sentences (KNOWN_CONFLICTS carries the new text, a stale sentence becomes the generic one)`.
- [ ] **Step 2: Run** the four files. Expected: FAIL.
- [ ] **Step 3: Implement** control first, then the BFF types and handler mappings; both ship in one commit so the existing sentences never drift.
- [ ] **Step 4: Run** `pnpm --filter @acr/control test && pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 report links and read states for draft reports`.

### Task 10: BFF write routes

**Files:**
- Create: `apps/web/src/app/api/v1/report/self-ratings/route.ts`, `apps/web/src/app/api/v1/report/responses/route.ts` (re-export only, like `report/route.ts`)
- Modify: `apps/web/src/server/report-handlers.ts` (`handleReportRate`, `handleReportRespond`), `routes.ts` (`reportRatePUT`, `reportRespondPOST`, a `reportWriteThrottle`), `launcher-client.ts` (`rateReport`, `respondReport`)
- Test: `apps/web/src/server/__tests__/report-writes.test.ts`

**Interfaces:**
- Produces: `launcher.rateReport(sessionId, credentialId, ratings): Promise<{ wrote: number }>`; `launcher.respondReport(sessionId, credentialId, input): Promise<{ wrote: boolean }>`. On success the handlers re-read with `readReport` and return `{ ...read, availableUntil }`, so the page gets the new view.
- Consumes: `checkOrigin`, `checkFetchSite`, `requestAddress` from `guards.ts`; the sealed cookie; body caps 64 KB and 16 KB.

- [ ] **Step 1: Failing tests:** `forged Origin or Fetch-Metadata is refused before the throttle and before any control call`; `non-JSON, oversized, and bodies with a role key are refused`; `no cookie, forged cookie or other-audience cookie is the neutral 404`; `a control 404 clears the cookie; a 503 keeps it (Review Focus 4)`; `busy, closed, too_many, invalid, 413 and 429 are passed through as fixed states with no control text`; `a per-credential write throttle answers 429 with Retry-After`; `success returns the re-read view`; `responses are no-store`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/report-writes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by following `handleReportGet` for cookie handling and `handleReportEnter` for the guards.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 BFF routes for ratings and responses`.

### Task 11: Drafts and the self-rating form

**Files:**
- Create: `apps/web/src/lib/report-draft.ts`, `apps/web/src/components/SelfRatingForm.tsx`
- Modify: `apps/web/src/components/ReportView.tsx` (render the form for `self_assess`), `apps/web/src/components/ReportEnter.tsx` (clear the draft on success), `apps/web/src/lib/messages.ts`
- Test: `apps/web/src/components/__tests__/SelfRatingForm.test.tsx`, `report-draft.test.ts`, `ReportEnter.test.tsx`

**Interfaces:**
- Produces: `report-draft.ts`: `loadDraft(): Draft | null`, `saveDraft(d: Draft): void`, `clearDraft(): void` with `type Draft = { ratings: Record<string, { level: number | null; note: string }> }`, key `scenecoach-report-draft`, every call in try/catch. `SelfRatingForm` props: `{ form: { criteria: {id,name}[]; scale: Scale; existing: Record<string, {level; note?}> }; fetch?: typeof fetch; onSaved(view: unknown): void }`.

- [ ] **Step 1: Failing tests:** `one fieldset and legend per criterion with radios for each scale level and Not observed`; `the draft is written only after a field is touched and restored after a reload`; `existing ratings from the server pre-fill when there is no draft`; `Save disables the button, sets aria-busy and shows "Saving…"`; `saved shows a status message and clears the draft`; `busy shows "Busy, try again" and keeps the draft (Review Focus 5)`; `closed shows the closed message and keeps what was typed (Review Focus 1)`; `413 and 429 show their fixed messages`; `unavailable storage still lets the form work`; `the note counter stops at 1,500 characters`; `entering a link clears the draft (Review Focus 4)`; `evaluator data never appears (the component receives none)`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/__tests__/SelfRatingForm.test.tsx src/lib/__tests__/report-draft.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with React text nodes only, an error summary that takes focus, and copy in `messages.ts`.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 self-rating form with browser drafts`.

### Task 12: Released sections and the remaining states

**Files:**
- Create: `apps/web/src/lib/report-compare.ts`, `apps/web/src/components/ComparisonTable.tsx`, `ResponsesList.tsx`, `ResponseForm.tsx`
- Modify: `ReportView.tsx` (the five read states, the new sections, print classes), `messages.ts`, `app.css` print rules
- Test: matching `__tests__` files and `ReportView.test.tsx`

**Interfaces:**
- Produces: `comparisonRows(own: unknown): ComparisonRow[]` with `type ComparisonRow = { criterion: string; evaluator: string; yours: string; note?: string }` (read `services/runtime/src/evaluator/report-model.ts` lines 78 to 95 for the field names of `ParticipantReport` and adapt; unknown shapes yield no rows, never an error); `ResponseForm` props `{ criteria: {id,name}[]; used: number; fetch?; onSent(view: unknown): void }`.

- [ ] **Step 1: Failing tests:** `comparisonRows pairs the evaluator level with the participant's own rating and note`; `table cells are text, not HTML (an <img onerror> note renders as text)`; `responses list shows criterion, dispute marker, outcome and reason once resolved, and "n of 50 used"`; `the response form defaults to The whole report, counts to 1,500, sends once (button disabled), keeps text on failure`; `a duplicate-looking resend still shows success`; `closed, old_schema, throttled, not_released and retry states each show their own sentence and a retry only where it helps`; `forms are no-print; the printout has the report, table and responses`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components src/lib`. Expected: FAIL.
- [ ] **Step 3: Implement** the components; the report block stays the escaped `<pre>` unchanged.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 comparison table, responses and response form`.

### Task 13: Console panel

**Files:** Modify `apps/web/src/components/console/ReportLinksPanel.tsx`, the console DTO in `report-handlers.ts` (`linkDto`/list handler), `apps/web/src/lib/console-api.ts`, `messages.ts`; Test `ReportLinksPanel.test.tsx` and the console handler tests.

**Interfaces:** Consumes Task 9's `selfRated` and `players`. Produces nothing new for other tasks.

- [ ] **Step 1: Failing tests:** `draft roles are listed with "Rated k of n criteria"; the header shows "x of y players have rated"`; `rated:null shows "not available"`; `a warning line says releasing closes self-rating for everyone, shown only while any role is a draft`; `copy says the link works for rating before release and for responses after`; `issue, reissue (with confirmation) and revoke still work and the token is shown once`; `the DTO still never carries a credential id or token`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/console src/server`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0063 console shows who has rated`.

### Task 14: End to end and Axe

**Files:** Modify `apps/web/e2e/report-access.spec.ts`, `apps/web/e2e/axe.spec.ts`, `services/control/src/__tests__/seed-report-folders.ts` (open `/2` reviews, add a draft-state seed with a recognisable evaluator level and rationale).

- [ ] **Step 1: Failing specs:** `issue a link on a draft, rate with the runtime exited, and the page never contains the seeded evaluator level or rationale`; `release (runtime moderate functions), reload: report, comparison table and response form appear`; `respond and dispute, resolve with the runtime functions, reload: the outcome and reason appear`; `revoke while a cookie exists: the next write is refused and the page shows the refused state`; `reissue mid-rating: old tab refused, new link shows earlier ratings`; Axe at 400 and 1280 px in light and dark for self-rating, released with forms, closed, old_schema, throttled, not_released and busy states.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test e2e/report-access.spec.ts e2e/axe.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** seeder changes and any accessibility fixes the specs surface (no new features).
- [ ] **Step 4: Run** the same command plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[test] EPIC-0002: US-0063 end to end and Axe for ratings and responses`.

### Task 15: Documents and PR 2 close-out

**Files:** Modify `docs/THREAT_MODEL.md` (extend "Report access" per Spec 8, fix the "control only reads" sentence), the deploy notes under `deploy/` (control must share a user or a group-writable reports directory with `moderate`; the volume must not be read-only), `docs/RELEASE_PLAN.md` (amend AC-0327 and AC-0332; add AC-0369 capacity bounds, AC-0370 no write after revoke, AC-0371 rating progress, AC-0372 old-schema refusal; TC-0127 to TC-0133; TASK-0101 for PR 2 with TASK-0092 covering PR 1; tick AC-0331 to AC-0335 and the new ones; US-0063 Done), `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md` (Session 29), `MEMORY.md`.

- [ ] **Step 1: Write the documents** as listed, with the release-notes risk lines from Spec 11 (rolling back makes `/2` reviews unreadable).
- [ ] **Step 2: Run** `npm run plan:generate && pnpm --filter @acr/runtime test && pnpm --filter @acr/control test && pnpm --filter @acr/web test && pnpm -r typecheck && pnpm --filter @acr/web exec playwright test e2e/report-access.spec.ts`. Expected: all PASS; the id-registry test passes.
- [ ] **Step 3: Commit** `[docs] EPIC-0002: US-0063 threat model, deploy notes and plan documents`, push, open PR 2 into `develop` as a draft, and wait for green CI.

---

## Self-review

- **Spec coverage:** Spec 3 → Tasks 1, 2; 4.1, 4.5 → 4; 4.2, 4.3 → 5; 4.4, 4.7, 4.8 → 6; 4.6 → 3; 5.1, 5.3, 5.4, 5.7 → 7, 8; 5.2, 5.5, 5.6 → 9; 6.1 → 10; 6.2 to 6.5 → 11, 12; 7 → 6, 13; 8 → 15; 9 → tests in each task and 14; 10 → PR split; 11 → 15. AC-0331 → 1; AC-0332 → 4, 11, 12; AC-0333 → 7; AC-0334 → 6, 12; AC-0335 → 1, 7, 10.
- **Deliberate reading of Spec 5.2:** "a successful write returns the new view" is met in the BFF (Task 10 re-reads after a write); the control write routes return only `{ wrote }`.
- **Spec wording settled here:** Spec 4.1 lists a withdrawn report under the form's `closed` and Spec 5.2 lists it under `not_released`. The plan follows 5.2 for the control read (Task 9: a withdrawn report is `not_released`; `closed` means a draft whose self-rating is closed by `selfClosed`), while the runtime form (Task 4) still returns `closed` for it, so a write to a withdrawn report is refused either way.
- **Open item for execution:** the exact field names of `ParticipantReport` for `comparisonRows` are read at Task 12, as the spec says it must be verified; if the report lacks the evaluator's level per criterion, stop and report before building the table.
- **Type consistency:** `Level`, `RatingInput`, `ResponseInput`, `FormResult`, `ProgressRow`, `WriteOutcome`, `ReportRead` are defined once (Tasks 4, 5, 7, 9) and reused by name.
