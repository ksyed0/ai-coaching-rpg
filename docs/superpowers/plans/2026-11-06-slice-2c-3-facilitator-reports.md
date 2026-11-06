# Slice 2c-3: facilitator evaluate, moderate, release and export (US-0064) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator takes an ended session to released reports in the console: evaluate, run summary, review and edit, release, amend, withdraw, resolve a dispute, export.

**Architecture:** The runtime owns the rules: a new subpath `@acr/runtime/moderation` holds the moderation operations extracted from the CLI handlers (the CLI becomes a thin caller, so the gate rules and the hash chain are the same by construction), and `@acr/runtime/run-summary` holds the pure run-summary logic moved out of `demo/`. The control service runs evaluate as a child process (`ReportJobService`) and the operations in-process (`ModerationService`); the BFF and console add facilitator-only routes and a Report panel group.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (`@acr/runtime`, `@acr/control`, `@acr/web`), Next.js route handlers, React, Playwright with Axe.

**Spec:** `docs/superpowers/specs/2026-11-06-slice-2c-3-facilitator-reports-design.md` (read it first; section numbers below refer to it). Parents: `2026-11-05-slice-2c-reports-design.md`, `2026-10-26-web-client-design.md`. Precedent to copy: `docs/superpowers/plans/2026-11-05-slice-2c-2-participant-actions.md` (module extraction, `ParticipantWriteService`, closed-union mapping).

**Delivery:** branch `feature/EPIC-0002-US-0064-report-moderation-web`, two PRs into `develop`. **PR A = Tasks 1 to 9** (evaluate and review; the terminal still releases). **PR B = Tasks 10 to 14**, stacked on A. Never merge a PR without the owner's say-so.

## Global Constraints

- Commit format `[TYPE] EPIC-0002: short imperative description` (max 72 chars). All tests pass and coverage stays at least 80% before any commit. Every user-visible change goes under `[Unreleased]` in `CHANGELOG.md`, in the same PR.
- No schema bump: `acr.review/2` stays. Browser actions use the existing attested actor with `by = "<cleaned name> (console)"`.
- Author: `cleanBy` rules of the CLI (`review/text.ts`), then the suffix ` (console)`; the suffix is appended by the control service only. The name is never taken from the cookie.
- Closed results: `ok`, `refused` with a fixed code, `busy`, `invalid`, plus 404 for an unknown session or subject. No text from the review layer, no path and no id reaches the browser. Codes: `not_ended`, `already_evaluated`, `already_running`, `no_review`, `unknown_subject`, `unknown_criterion`, `stale`, `blocked`, `not_released`, `superseded`, `needs_amend`, `confirm_mismatch`, `too_many_running`.
- Lock retry as `ParticipantWriteService`: 5 attempts, 100/200/400/800 ms ±25%, then `busy`; `sleep` and `random` injected.
- Evaluate: one running job across the service; overall timeout `REPORT_EVALUATE_TIMEOUT_MS` (default 1,800,000); progress tail at most 50 lines of 200 characters, scrubbed; the child env is `buildChildEnv`'s allowlist pattern plus `MODEL_PROVIDER`, the model key variable and `EVAL_*` only.
- Body caps: 4 KB (`MAX_BODY_BYTES`) for every new control and BFF route except `comment` and `edit-summary` (16 KB). Over the cap is 413 with a fixed sentence.
- `release` takes an explicit non-empty list of subjects; an `all` flag is refused. `withdraw`, `amend` and `edit` require a reason. `export` is a `POST`, records the event first, returns the Markdown with `Content-Disposition: attachment; filename="report-<subject>.md"`, `Cache-Control: no-store`; nothing is written to the server's disk.
- Origin and Fetch-Metadata checks run before any throttle accounting on every BFF write. All text is rendered as React text nodes.
- New ids start at AC-0373, TC-0135, TASK-0102 (AC-0336 to AC-0340 and TASK-0093 already belong to US-0064).
- Test commands: `pnpm --filter @acr/runtime exec vitest run <file>`, `pnpm --filter @acr/control exec vitest run <file>`, `pnpm --filter @acr/web exec vitest run <file>`; typecheck `pnpm -r typecheck`; Playwright `pnpm --filter @acr/web exec playwright test <spec> --trace off`.

## Review Focus

Each line has its test in the named task.

1. **A double click on Evaluate, or two tabs.** One child process runs; the second request is `already_running`; after it finishes a third is `already_evaluated`; no `-2` directory appears. (Tasks 4, 6)
2. **Two tabs edit the same criterion.** The second gets `stale`; the form keeps the typed reason and comment. (Tasks 3, 5, 8)
3. **Release with an empty list, `all`, or an open item.** Refused with nothing written; the response names the blocked subjects by a fixed code. (Tasks 10, 11, 13)
4. **A control restart mid-run.** The job reads `failed` (interrupted); a report directory without a review is listed as an orphan and is not reused by the next start. (Task 4)
5. **Export of an unreleased subject, or the wrong audience.** Refused and no export event is written; a valid export records one event before the file is served, and a `GET` is 404. (Tasks 10, 11, 12)

---

## PR A: evaluate and review

### Task 1: Settle the four open items (investigation)

**Files:** Modify `docs/superpowers/specs/2026-11-06-slice-2c-3-facilitator-reports-design.md` (append "Findings" under section 11); no product code.

- [ ] **Step 1: Log path.** Read `services/control/src/supervisor.ts` (`readLogStatus`, lines near 563 and 759) and `services/runtime/src/host` session-store code. Record: the ended log path (`<sessionsDir>/<id>.jsonl`), whether it survives the end and a restart, and what `readLogStatus` returns for an ended log. Define `isEnded(id)` from it.
- [ ] **Step 2: Pre-run call bound.** Read `services/runtime/src/evaluator/evaluate.ts`. Record the formula (individual roles plus the group, times retries) or that none exists; decide `confirmedCalls` (an "up to N" bound) or `confirmedRoster` (spec section 3) and write the decision.
- [ ] **Step 3: Run-summary seam.** Read `services/runtime/src/demo/live-evidence.ts` and `audit.ts`. Record that `collectLiveEvidence(events, scenario, opts)` is pure and which imports are demo-only (`scrubText` from `demo/report.js`, `provenance.js`). Find which session event marks a scene ended by the Game Master (`scene.exited`/`scene.entered` and its cause field in `packages/events`) and record the exact field, or that no event carries it (then AC-0339 shows fallback counts and alerts only, and the spec is amended).
- [ ] **Step 4: Scripted evaluator.** Write a throwaway script in the scratchpad that plays or loads an e2e session log (see `apps/web/e2e/helpers`) and runs `createScriptedEvaluator` through `runEvaluate` with `MODEL_PROVIDER=mock`. Record pass or fail; on fail, spec section 8's seeding fallback applies.
- [ ] **Step 5: Commit** `[docs] EPIC-0002: US-0064 record the findings of the open items`.

### Task 2: Shared run-summary module

**Files:** Create `services/runtime/src/run-summary/index.ts` (and `evidence.ts` moved from `demo/live-evidence.ts`); Modify `services/runtime/package.json` (`"./run-summary"` export), `demo/audit.ts`, `demo/story.ts`, `demo/showcase*.ts` and any other importer of `live-evidence`; Test `services/runtime/src/run-summary/__tests__/evidence.test.ts` (move `demo/__tests__/live-evidence.test.ts` there, keep it green).

**Interfaces:**
- Produces: `collectRunSummary(events: SessionEvent[], scenario: Scenario, opts: { secrets: string[]; hidden?: string[] }): RunSummary` with `RunSummary = { npcReplies: number; fallbackReplies: number; byCharacter: CharacterEvidence[]; alerts: AlertEvidence[]; scenesEndedByGm: number | null }` (`null` when Task 1 found no signal). Re-exports `AlertEvidence`, `CharacterEvidence`.

- [ ] **Step 1: Failing tests** in `evidence.test.ts`: `counts replies and canned fallbacks per character`; `scenesEndedByGm counts only scenes closed by the Game Master` (fixture built from the field Task 1 recorded); `returns scenesEndedByGm null when the log carries no signal`; `the output holds no code, token or fact text` (fixture with a hidden fact string; assert it is absent from `JSON.stringify(result)`).
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/run-summary`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the pure body of `collectLiveEvidence` (no `demo/` imports: move or copy the two helpers it needs into `run-summary/`); `demo/` imports from `../run-summary`. Add `scenesEndedByGm`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/run-summary src/demo`. Expected: PASS.
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 move the run summary logic out of demo`.

### Task 3: Moderation module, part A operations

**Files:** Create `services/runtime/src/moderation/{index,types,read,write}.ts`; Modify `services/runtime/package.json` (`"./moderation"`), `services/runtime/src/review/cli.ts` (the handlers `open`, `status`, `show`, `edit`, `accept`, `comment`, `edit-summary` call the module and keep their output text and exit codes); `review/errors.ts` (add an optional `code` to `ReviewRefusedError`, set at: stale `--expect`, unresolved items, missing review); Test `services/runtime/src/moderation/__tests__/{read,write-a}.test.ts`; the existing `review/__tests__/cli*.test.ts` must stay green unchanged.

**Interfaces:**
- Produces (`ModerationCode` is the list in Global Constraints):
  `type ModResult<T> = { ok: true; value: T } | { ok: false; code: ModerationCode; detail?: string[] }` (`detail` is subject ids only, used by `blocked` in Task 10)
  `reviewStatus(dir: string): Promise<ModResult<ReviewStatus>>` with `ReviewStatus = { superseded: string | null; subjects: SubjectStatus[] }` and `SubjectStatus = { id: string; state: "draft"|"released"|"amending"|"withdrawn"; version: number | null; criteriaTotal: number; openCriteria: string[]; summaryStale: boolean; selfRated: number; openDisputes: { seq: number; role: string; criterion: string | null }[] }`
  `subjectView(dir: string, subject: string): Promise<ModResult<ReturnType<typeof viewReport>>>` (facilitator audience)
  `openFacilitatorReview(o: { dir: string; by: string; now: () => number; sessionLogText?: string; codesDir: string }): Promise<ModResult<{ subjects: number }>>`
  `editScore(o: Base & { subject: string; criterion: string; level: 1|2|3|4|null; reason: string; rationale?: string; expect?: "1"|"2"|"3"|"4"|"na"|"invalid" }): Promise<ModResult<null>>`
  `acceptCriterion(o: Base & { subject: string; criterion: string })`, `acceptSummary(o: Base & { subject: string })`, `commentOn(o: Base & { subject: string; text: string; criterion?: string; feedback?: boolean })`, `editSummary(o: Base & { subject: string; reason: string; strengths?: string[]; developments?: string[]; actions?: { lo: string; text: string }[] })`
  where `Base = { dir: string; by: string; now: () => number; secrets: string[] }`. Each write returns `busy` for a held lock and maps every other `ReviewRefusedError` to `refused` or its `code`; `ReviewCorruptError` and `ReviewIllegalError` propagate.

- [ ] **Step 1: Failing tests.** `read.test.ts`: `reviewStatus lists open criteria and open disputes per subject`; `subjectView returns the facilitator audience`; `unknown subject is unknown_subject`. `write-a.test.ts` (use the review fixtures in `review/__tests__/fixtures.ts`): `editScore with a matching expect writes score.edited`; `editScore with a stale expect returns stale and writes nothing (file bytes unchanged)`; `editScore with an empty reason is invalid`; `acceptCriterion and acceptSummary append their events`; `commentOn with feedback true is visible in the participant view of a released subject only`; `a held lock returns busy`; `the appended events verify as a chain (loadReview succeeds)`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving each handler body's `applyCommand` builder into the module unchanged (same entries, same `cleanText` limits), taking `by` as already-cleaned actor text; the CLI handler cleans its flags, calls the module and prints the same line as today.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation src/review && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 extract the moderation operations (part A)`.

### Task 4: `ReportJobService`

**Files:** Create `services/control/src/report-job.ts`; Modify `services/control/src/config.ts` (`evaluateTimeoutMs`, from `REPORT_EVALUATE_TIMEOUT_MS`), `.env.example`; Test `services/control/src/__tests__/report-job.test.ts`.

**Interfaces:**
- Consumes: Task 1's `isEnded` rule and call-bound decision; `buildChildEnv`'s allowlist pattern (`child-env.ts`); the `--json -` output of the evaluate CLI.
- Produces: `class ReportJobService { constructor(o: { config: ControlConfig; spawn?: SpawnFn; now?: () => number; parentEnv?: NodeJS.ProcessEnv; reportDirFor: (id: string) => Promise<string | null> }); preflight(id: string): Promise<Preflight>; start(id: string, confirmed: Confirm): Promise<JobOutcome>; cancel(id: string): Promise<JobOutcome>; status(id: string): JobStatus; orphans(): Promise<string[]> }`
  `JobStatus = { state: "idle"|"running"|"done"|"failed"; reason?: "interrupted"|"timeout"|"cancelled"|"error"; startedAt: number | null; progress: string[]; modelCalls: number | null; outputDir: string | null }` (`outputDir` is a name relative to `reportsDir`, never absolute).
  `Preflight = { ok: true; confirm: { upTo: number } | { roster: string[]; model: string } } | { ok: false; code: "not_ended"|"already_evaluated" }`. `JobOutcome = { status: 200; value: JobStatus } | { status: 404 } | { status: 409; code: "not_ended"|"already_evaluated"|"already_running"|"confirm_mismatch"|"too_many_running" }`.

- [ ] **Step 1: Failing tests** (inject a fake `spawn` that emits scripted stdout and an exit code): `start spawns the evaluate CLI once with --json - and --out <reportsDir>`; `a second start while running is already_running`; `a start for another session while one runs is too_many_running`; `a start on a session that has a review or draft is already_evaluated and spawns nothing`; `a start on a running (not ended) session is not_ended`; `a wrong confirmed value is confirm_mismatch`; `outputDir comes from the CLI's JSON, not from the session id`; `progress keeps the last 50 lines, each scrubbed and cut at 200 characters`; `the child env holds no variable outside the allowlist (no LAUNCHER_TOKEN, FACILITATOR_SECRET)`; `cancel signals the child and the state is failed/cancelled`; `the timeout kills the child and the state is failed/timeout`; `a new service instance over a directory with an unreviewed report folder lists it in orphans() and start still refuses (already_evaluated)`; `a restart mid-run reads failed/interrupted` (persist `{state, startedAt}` in `<dataDir>/report-jobs.json`, `0600`, atomic; on construction a persisted `running` becomes `failed/interrupted`).
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/report-job.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `ReportJobService`; the child is `pnpm`-free: run the same entry the root script uses (`tsx services/runtime/src/evaluator/main.ts`, found from `repoRoot`; read `supervisor.ts` for how the runtime child is launched and copy that mechanism). Session log path and scenario directory are derived, never passed in.
- [ ] **Step 4: Run** the same command and `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 evaluate job service in the control service`.

### Task 5: `ModerationService`, part A

**Files:** Create `services/control/src/moderation.ts`; Test `services/control/src/__tests__/moderation.test.ts`.

**Interfaces:**
- Consumes: Task 3's module; `ReportService`'s resolver for the live review directory (read `services/control/src/reports.ts` and `@acr/runtime/reports`; use the same lookup `requireLinkable` uses and throw nothing for a missing one).
- Produces: `class ModerationService { constructor(o: { config: ControlConfig; jobs: ReportJobService; runSummary: (id: string) => Promise<RunSummary | null>; dirFor: (id: string) => Promise<string | null>; sessionLog: (id: string) => Promise<string | null>; sleep?; random?; now? }); overview(id): Promise<ModOutcome<Overview>>; open(id, name): Promise<ModOutcome<{ subjects: number }>>; subject(id, subject): Promise<ModOutcome<SubjectView>>; edit(id, subject, body: EditBody, name): Promise<ModOutcome<null>>; accept(id, subject, body: { criterion?: string; summary?: true }, name); comment(id, subject, body: CommentBody, name); editSummary(id, subject, body, name) }`
  `ModOutcome<T> = { status: 200; value: T } | { status: 404 } | { status: 400; code: "invalid" } | { status: 409; code: ModerationCode } | { status: 503; code: "busy"; retryAfterMs: number }`; `Overview = { stage: "not_ended"|"not_evaluated"|"evaluating"|"failed"|"in_review"; job: JobStatus; summary: RunSummary | null; subjects: SubjectStatus[] }`. There is no `released` stage (spec section 5).

- [ ] **Step 1: Failing tests:** `the author is the cleaned name plus " (console)"` (read the appended event's actor); `a name that is empty after cleaning is invalid`; `edit with expect stale is 409 stale and keeps the log bytes`; `a busy lock is retried 5 times with the injected sleep, then 503 busy`; `open reads the session log and codes record and returns the subject count`; `overview is not_evaluated with no draft, evaluating while the job runs, in_review once a review is open, and carries the run summary only then`; `no outcome contains a path or review-layer text` (assert against every field with a regex for "/" and the fixture's error strings).
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by calling Task 3's functions and mapping `ModResult` to `ModOutcome`; backoff as `participant-writes.ts` (read it and reuse its helper if it is exported, else extract the helper into `retry.ts` and use it from both).
- [ ] **Step 4: Run** same command and `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 moderation service, part A`.

### Task 6: Control routes, part A

**Files:** Create `services/control/src/moderation-routes.ts` (a `handleReportRoute(seg, method, req, res, deps): Promise<boolean>` called from `api.ts` before `notFound()`); Modify `services/control/src/api.ts` (deps `jobs?: ReportJobService`, `moderation?: ModerationService`; 404 when absent), `main.ts` (construct and pass them); Test `services/control/src/__tests__/moderation-routes.test.ts`.

**Interfaces:** Produces (all under `/sessions/:id/report`, behind the service token): `GET ""` (overview), `POST evaluate` body `{ confirmed: number }` or `{ confirmedRoster: string[] }`, `POST evaluate/cancel`, `POST open` body `{ by }`, `GET subjects/:subject`, `POST subjects/:subject/edit` body `{ criterion, level: 1|2|3|4|null, reason, rationale?, expect?, by }`, `POST subjects/:subject/accept` body `{ criterion?, summary?, by }`, `POST subjects/:subject/comment`, `POST subjects/:subject/edit-summary`. Zod `strictObject` bodies; `by` max 200 UTF-16 units.

- [ ] **Step 1: Failing tests:** `each route 404s when its service is absent`; `a bad session id or subject id is 404 before the body is read`; `a body over the cap is 413 with the fixed sentence`; `an unknown body key is 400`; `409 carries only the closed code`; `503 busy sets Retry-After`; `GET evaluate is 404`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Subject ids pass `RoleIdSchema` or equal `"group"`; criterion ids pass `isFileSafeId`.
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 control routes for evaluate and review`.

### Task 7: BFF routes, part A

**Files:** Create `apps/web/src/server/console-report-handlers.ts`; Create route files under `apps/web/src/app/api/v1/console/sessions/[id]/report/` (`route.ts`, `evaluate/route.ts`, `evaluate/cancel/route.ts`, `open/route.ts`, `subjects/[subject]/route.ts`, `subjects/[subject]/{edit,accept,comment,edit-summary}/route.ts`), each a re-export like `report-links/route.ts`; Modify `apps/web/src/server/launcher-client.ts` (typed calls with a closed parse; fail closed on any unknown field value), `routes.ts` (wire handlers and a facilitator write throttle); Test `apps/web/src/server/__tests__/console-report-handlers.test.ts`, extend the import-guard test (`source-rules.test.ts`).

**Interfaces:** Produces BFF `GET/POST` paths mirroring Task 6 under `/api/v1/console/sessions/[id]/report`; responses use the project envelope; every refusal is a fixed sentence by closed code (`stale` → "Someone changed this. Reload the level and try again."; the sentence table lives in `apps/web/src/lib/messages.ts`).

- [ ] **Step 1: Failing tests:** `a write without the console cookie is 401`; `a cross-site write (Sec-Fetch-Site: cross-site, or an Origin not allowed) is refused before the throttle counts it`; `a valid write forwards the typed name as by and nothing from the cookie`; `an unknown control code maps to the generic sentence`; `a control 409 stale reaches the browser as the stale sentence and nothing else`; `the control timeout (15 s, injected clock) is 504 with a fixed sentence`; `the source guard: no file under src/server/console-report-*.ts imports @acr/runtime/review, /moderation or node:fs`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-report-handlers.test.ts src/server/__tests__/source-rules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** following `report-handlers.ts` (read it for the throttle, Origin check, cookie and error-mapping helpers and reuse them).
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 BFF routes for evaluate and review`.

### Task 8: Console UI, part A

**Files:** Create `apps/web/src/components/console/report/{ReportPanel,EvaluateCard,EvaluateConfirmDialog,RunSummaryView,SubjectList,SubjectView,CriterionRow,AuthorName}.tsx`; Modify `apps/web/src/components/console/SessionConsole.tsx` (render `ReportPanel` when the session has ended, above `ReportLinksPanel`), `apps/web/src/lib/console-api.ts` (typed client + parsers), `lib/messages.ts`, `lib/app.css`; Test `apps/web/src/components/console/report/__tests__/*.test.tsx`.

**Interfaces:** Consumes Task 7's paths. Produces `ReportPanel({ sessionId, ended }: …)`; `AuthorName` keeps the typed name in `sessionStorage` (wrapped in try/catch) and passes it as `by`.

- [ ] **Step 1: Failing tests:** `EvaluateCard shows the right state for not_ended, ready, running (progress, Cancel), failed (reason sentence) and done`; `the confirm dialog shows "up to N" (or the roster and model) and sends it back unchanged`; `RunSummaryView shows scenes ended by the Game Master, fallback counts and alerts as text, and shows nothing for a null scene count`; `SubjectList shows each subject's own state and open-item count, never a global released state`; `a stale edit keeps the typed reason and comment and shows the stale sentence`; `the reason is required before Save is enabled`; `all control text is rendered as text (a "<b>" in a comment stays literal)`; `dialogs trap focus and return it`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: FAIL.
- [ ] **Step 3: Implement** with plain `fetch` calls through `console-api.ts`; poll the overview every 2 s only while `evaluating` (injected timer); a status line uses `aria-live="polite"`.
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 console evaluate and review panel`.

### Task 9: PR A end to end, threat model and docs

**Files:** Create `apps/web/e2e/report-moderation.spec.ts`; Modify `apps/web/e2e/axe.spec.ts`, `docs/THREAT_MODEL.md` (new section "Facilitator moderation", spec section 7), `docs/RELEASE_PLAN.md` (US-0064 AC-0336 and the evaluate and review parts of AC-0337, AC-0339 ticked; TASK-0093 and a new TASK-0102 for PR B), `docs/TEST_CASES.md` (TC-0135 onward), `docs/ID_REGISTRY.md`, `docs/ROLLBACK.md`, `CHANGELOG.md`, `README.md`, `.env.example`, `progress.md`, `MEMORY.md`; run `npm run plan:generate`.

- [ ] **Step 1: Write the e2e** (own spec file): end a session, evaluate through the console (`MODEL_PROVIDER=mock`, or the seeding fallback from Task 1), see the run summary and subject list, open the review, edit a level, assert a second tab's stale edit keeps the typed text, accept, comment. Axe on each state of the panel. Two-tab double click on Evaluate asserts one job and `already_evaluated` afterwards.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-moderation axe --trace off`. Expected: PASS.
- [ ] **Step 3: Write the docs** listed above; add the ids in `ID_REGISTRY.md`; keep the fixed "not ready" sentence unchanged until PR B.
- [ ] **Step 4: Gate:** `pnpm -r typecheck && pnpm --filter @acr/runtime test && pnpm --filter @acr/control test && pnpm --filter @acr/web test && npm run plan:generate && node --test tests/unit/id-registry.test.js`. Expected: all pass.
- [ ] **Step 5: Commit** `[docs] EPIC-0002: US-0064 PR A e2e, threat model and close-out`. Push, open the PR as a draft, then the whole-branch review by the most capable model before marking ready.

## PR B: release and close-out (stacked on PR A)

### Task 10: Moderation module, part B operations

**Files:** Modify `services/runtime/src/moderation/{index,write}.ts` (add `write-b.ts`), `review/cli.ts` (handlers `release`, `amend`, `withdraw`, `resolve`, `export` call the module); Test `services/runtime/src/moderation/__tests__/write-b.test.ts`; existing CLI tests stay green.

**Interfaces:** Produces (with `Base` from Task 3): `releaseSubjects(o: Base & { subjects: string[] }): Promise<ModResult<{ released: string[] }>>` (non-empty list; refuses with code `blocked` and the blocked ids in `ModResult`'s optional `detail: string[]` of subject ids only; all-or-nothing); `amendSubject(o: Base & { subject: string; reason: string })`; `withdrawSubject(o: Base & { subject: string; reason: string })`; `resolveDispute(o: Base & { seq: number; outcome: "upheld"|"amended"|"declined"; reason: string })` (`needs_amend` when `amended` and the report was not amended); `exportReport(o: Base & { subject: string; audience: "facilitator" | `participant:${string}`; }): Promise<ModResult<{ fileName: string; markdown: string }>>` (index is `subject: "index"`; the export event is appended **before** the Markdown is rendered, as `exportHandler` does; a failed render after the event is allowed, as the CLI documents).

- [ ] **Step 1: Failing tests:** `releaseSubjects with an empty list is invalid and writes nothing`; `with an open criterion it returns blocked with that subject id and the log bytes are unchanged`; `releases two subjects atomically`; `withdraw requires a reason`; `resolveDispute amended before an amend returns needs_amend`; `exportReport of a draft subject is not_released and appends no event`; `exportReport for participant:<other role> on a personal report is refused`; `exportReport appends exactly one export event, then returns the Markdown of the audience's view (no facilitator-only text for a participant audience)`; `file names are report-<subject>.md with the subject matched against a safe-id pattern`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the handler bodies as in Task 3; `exportReport` reuses `canView`/`viewReport` and `renderSubjectMarkdown`/`renderReviewIndex`; no file is written.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation src/review && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 extract the moderation operations (part B)`.

### Task 11: Control service and routes, part B

**Files:** Modify `services/control/src/moderation.ts`, `moderation-routes.ts`; Test `services/control/src/__tests__/moderation-b.test.ts`, extend `moderation-routes.test.ts`.

**Interfaces:** Produces `ModerationService.release(id, body: { subjects: string[] }, name)`, `amend(id, subject, { reason }, name)`, `withdraw`, `resolve(id, { seq, outcome, reason }, name)`, `export(id, { subject, audience }, name): Promise<ModOutcome<{ fileName: string; markdown: string }>>`; routes `POST /sessions/:id/report/{release,resolve,export}` and `POST …/subjects/:subject/{amend,withdraw}`. `blocked` responses carry `detail: string[]` (subject ids only, each matching the safe-id pattern).

- [ ] **Step 1: Failing tests:** `release with {subjects: []} and with {all: true} are 400 before the service is called`; `release with an open item is 409 blocked with detail ids and nothing written`; `export is POST only (GET is 404)`; `export answers the Markdown with the attachment name and no-store`; `the export event is in the log before the response is sent`; `author suffix on every part B event`; `a revoked or superseded review is superseded/409`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-b.test.ts src/__tests__/moderation-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with Task 10's functions.
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 control routes for release and export`.

### Task 12: BFF routes, part B

**Files:** Modify `apps/web/src/server/console-report-handlers.ts`, `launcher-client.ts`, `routes.ts`; Create route files for `release`, `resolve`, `export`, `subjects/[subject]/{amend,withdraw}`; Test `apps/web/src/server/__tests__/console-report-handlers-b.test.ts`.

**Interfaces:** `export` returns the control's Markdown as a `Response` with the control's headers re-set by the BFF (it never copies headers from control): `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition` with the fixed pattern, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.

- [ ] **Step 1: Failing tests:** `export by GET is 404 and by a cross-site POST is refused before the throttle`; `the export response headers are exactly the four above`; `a control filename that does not match report-<safe-id>.md is replaced by report.md`; `release forwards an explicit list unchanged and refuses all`; `blocked maps to a fixed sentence plus subject ids and nothing else`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-report-handlers-b.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 BFF routes for release and export`.

### Task 13: Console UI, part B

**Files:** Create `apps/web/src/components/console/report/{ReleaseBar,ReleaseDialog,PostReleaseActions,WithdrawDialog,AmendDialog,ResolveDisputePanel,ExportMenu}.tsx`; Modify `SubjectList.tsx`, `ReportPanel.tsx`, `lib/console-api.ts`, `lib/messages.ts`, `lib/app.css`; replace the fixed "not ready" sentence in `services/control/src/reports.ts`, `apps/web/src/server/report-handlers.ts` and `apps/web/src/lib/console-api.ts` with one that points at the Report panel (keep all three equal; update their tests); Test `…/report/__tests__/*.test.tsx`.

**Interfaces:** `ReleaseDialog({ subjects: { id; audience: string[] }[]; blocked: string[]; onConfirm })` where `audience` is taken from a constant in `lib/report-audience.ts` mirroring `review/policy.ts` version 1 (personal: the participant and the facilitator; group: every participant with peers' results removed, and the facilitator); the dialog never lists the inert audiences.

- [ ] **Step 1: Failing tests:** `ReleaseDialog names each subject and its audience and lists the open items that block it`; `the confirm button is disabled while any item blocks`; `"release everything" sends the full list, never an all flag`; `WithdrawDialog says it cannot be undone and requires a reason`; `ResolveDisputePanel offers amended only after an amend`; `ExportMenu posts and saves the returned text; a refusal shows the fixed sentence`; `after a stale or busy refusal the typed reason stays`; `a snapshot test that the audience constant equals POLICY in review/policy.ts` (import the runtime constant in the test only).
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same plus `pnpm --filter @acr/web test && pnpm --filter @acr/control test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 console release, withdraw, resolve and export`.

### Task 14: PR B end to end and close-out

**Files:** Modify `apps/web/e2e/report-moderation.spec.ts` (or add `report-release.spec.ts`), `apps/web/e2e/axe.spec.ts`; docs as in Task 9 (AC-0336 to AC-0340 all ticked, US-0064 and TASK-0093 Done, TC ids, ID registry, THREAT_MODEL if anything changed, ROLLBACK, CHANGELOG, README steps replacing the terminal ones, `progress.md`, `MEMORY.md`); `npm run plan:generate`.

- [ ] **Step 1: Write the e2e:** evaluate, review, release both a role and the group through the dialog, then **stop the runtime** and open the participant link in a fresh browser context and read the released report (AC-0340); the group view hides peers' individual results; the facilitator amends, withdraws a second subject, resolves a dispute the participant filed, and exports (the download body equals the facilitator's view Markdown; a second export records a second event). Axe on the release, withdraw and amend dialogs.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-moderation axe --trace off`. Expected: PASS.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Gate:** the Task 9 gate plus `pnpm --filter @acr/web exec playwright test --trace off`. Expected: all pass.
- [ ] **Step 5: Commit** `[docs] EPIC-0002: US-0064 PR B e2e and close-out`. Push, draft PR, whole-branch Opus review, then ready.
