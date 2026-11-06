# Slice 2c-3: facilitator evaluate, moderate, release and export (US-0064) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator takes an ended session to released reports in the console: evaluate, run summary, review and edit, release, amend, withdraw, resolve a dispute, export.

**Architecture:** The runtime owns the rules: `@acr/runtime/moderation` holds the moderation operations extracted from the CLI handlers (the module keeps throwing the review errors, so the CLI text and exit codes are unchanged; control wraps it with `toModResult`), `@acr/runtime/run-summary` holds the pure run-summary logic moved out of `demo/`, and `@acr/runtime/reports` gains a draft-candidate lookup. The control service runs evaluate as a child process (`ReportJobService`, then opens the review) and the operations in-process (`ModerationService`); the BFF and console add facilitator-only routes and a Report panel group.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (`@acr/runtime`, `@acr/control`, `@acr/web`), Next.js route handlers, React, Playwright with Axe.

**Spec:** `docs/superpowers/specs/2026-11-06-slice-2c-3-facilitator-reports-design.md` (read it first; section numbers below refer to it). Parents: `2026-11-05-slice-2c-reports-design.md`, `2026-10-26-web-client-design.md`. Precedent to copy: `docs/superpowers/plans/2026-11-05-slice-2c-2-participant-actions.md` (module extraction, `ParticipantWriteService`, closed-union mapping). An Opus review of the first draft of this plan (2026-11-06) is folded in; its evidence is quoted as `file:line` where a task depends on it.

**Delivery:** branch `feature/EPIC-0002-US-0064-report-moderation-web`, two PRs into `develop`. **PR A = Tasks 1 to 10** (evaluate and review; the terminal still releases). **PR B = Tasks 11 to 15**, stacked on A. Never merge a PR without the owner's say-so.

## Global Constraints

- Commit format `[TYPE] EPIC-0002: short imperative description` (max 72 chars). All tests pass and coverage stays at least 80% before any commit. Every user-visible change goes under `[Unreleased]` in `CHANGELOG.md`, in the same PR.
- No schema bump: `acr.review/2` stays. Browser actions use the existing `facilitator` actor. **`checkActor` and `fold` require `isSafeId(by)`** (`store.ts:81-93`, `fold.ts:334-336`; `SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/`, `packages/events/src/ids.ts:44`), so the author is `<name>-console`: the name passes `cleanBy` (1 to 56 characters of letters, digits, `_`, `-`), the control service appends `-console`. A name with a space is `invalid`; the console field states the rule. The name is never taken from the cookie.
- Results: control answers 200, 404 (unknown session or subject; the review layer's `unknown_subject` is answered 404, never 409), 400 `invalid`, 409 with a closed code, 503 `busy` (Retry-After) or 503 `unavailable`. Closed codes: `not_ended`, `already_evaluated`, `already_running`, `too_many_running`, `confirm_mismatch`, `orphan` (evaluate beside a damaged report folder), `no_review`, `unknown_criterion`, `stale`, `blocked`, `not_released`, `not_editable`, `superseded`, `needs_amend`, `refused`. Mapping from review errors (check in this order): `ReviewBusyError` → `busy`; `ReviewUsageError` → `invalid`; `ReviewCorruptError`, `ReviewIllegalError` and I/O errors → 503 `unavailable`; a `ReviewRefusedError` with a `code` → that code; any other `ReviewRefusedError` → `refused`. No text from the review layer, no path and no id reaches the browser.
- Lock retry as `ParticipantWriteService`: 5 attempts, 100/200/400/800 ms ±25%, then `busy`; `sleep` and `random` injected. The helper is not exported today (`participant-writes.ts`): extract it to `services/control/src/retry.ts` and use it from both.
- Evaluate: one running job across the service; overall timeout `bound × EVAL_TIMEOUT_MS + REPORT_EVALUATE_MARGIN_MS` (margin default 120,000, env `REPORT_EVALUATE_MARGIN_MS`); the call bound is `2 × (human players + 1 if the group rubric has criteria)`, exported from the runtime; progress is an allowlist, never raw child output (Task 5).
- Body caps: 4 KB for every new control and BFF route except `edit`, `comment` and `edit-summary` (16 KB; an edit's reason and rationale can be about 6 KB in CJK). Over the cap is 413 with a fixed sentence on both sides (the BFF reuses `readCapped`, exported from `report-handlers.ts`).
- `release` takes an explicit non-empty list of subjects; an `all` flag is refused. `withdraw`, `amend` and `edit` require a reason; `edit` also requires `expect` on the control and BFF routes (the CLI keeps it optional). `export` is a `POST`; control returns `{ fileName, markdown }` in the JSON envelope; only the BFF builds the attachment (`Content-Disposition: attachment; filename="report-<subject>.md"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`); the event's destination label is `console-download`; nothing is written to the reports directory.
- Origin and Fetch-Metadata checks run before any throttle accounting on every BFF write. All text is rendered as React text nodes.
- New ids start at AC-0373, TC-0135, TASK-0102 (AC-0336 to AC-0340 and TASK-0093 already belong to US-0064).
- Test commands: `pnpm --filter @acr/runtime exec vitest run <file>`, `pnpm --filter @acr/control exec vitest run <file>`, `pnpm --filter @acr/web exec vitest run <file>`; typecheck `pnpm -r typecheck`; Playwright `pnpm --filter @acr/web exec playwright test <spec> --trace off`.

## Review Focus

Each line has its test in the named task.

1. **A double click on Evaluate, or two tabs.** One child process runs; the second request is `already_running`; after it finishes a third is `already_evaluated`; no `-2` directory appears. (Tasks 5, 7)
2. **Two tabs edit the same criterion.** The second gets `stale`; the form keeps the typed reason and comment. (Tasks 4, 6, 9)
3. **Release with an empty list, `all`, or an open item.** Refused with nothing written; the answer carries the blocked subject ids. (Tasks 11, 12, 13)
4. **A control restart or shutdown mid-run.** The job reads `failed` (interrupted) and the child is killed; a late valid draft reads `ready_to_open`; a broken folder reads `orphan` and is never reused. (Task 5)
5. **Export of an unreleased subject, or the wrong audience.** Refused and no export event is written; a valid export records one event before the file is served; a `GET` is 404; the reports directory is unchanged apart from `review.jsonl`. (Tasks 11, 12, 13)

---

## PR A: evaluate and review

### Task 1: Prove the mock evaluate path (investigation)

**Files:** Modify `docs/superpowers/specs/2026-11-06-slice-2c-3-facilitator-reports-design.md` (one "Finding" line under section 11); no product code.

- [ ] **Step 1: Throwaway script** in the scratchpad: take the log of an e2e-played session (see `apps/web/e2e/helpers` `endedSession`) and its scenario, run `node --import tsx services/runtime/src/evaluator/main.ts <log> --scenario <dir> --out <tmpdir> --json -` with `MODEL_PROVIDER=mock` from the repo root. Record: exit code, that stdout is one JSON document with an absolute `dir`, and whether `createScriptedEvaluator` scored every role.
- [ ] **Step 2: Decide.** On success the e2e (Tasks 10, 15) uses the real evaluate. On failure they seed the draft folder with the runtime's own functions (`seedDraft` helper) and the spec's section 8 fallback applies; write which in the spec.
- [ ] **Step 3: Commit** `[docs] EPIC-0002: US-0064 record the mock evaluate finding`.

### Task 2: Shared run-summary module and the call bound

**Files:** Create `services/runtime/src/run-summary/{index,evidence}.ts`; Modify `services/runtime/package.json` (`"./run-summary"`), `demo/live-evidence.ts` (moved), importers `demo/audit.ts`, `story.ts`, `lab.ts`, `ctx.ts`, `showcase*.ts`, `report.ts`; Test `services/runtime/src/run-summary/__tests__/{evidence,bound}.test.ts` (move `demo/__tests__/live-evidence.test.ts` to `evidence.test.ts`, keep it green).

**Interfaces:**
- Produces: `collectRunSummary(events: SessionEvent[], scenario: Scenario, opts: { secrets: string[]; hidden?: string[]; legacy?: boolean; maxFallbacks?: number | null }): RunSummary`; `RunSummary = { npcReplies: number; fallbackReplies: number; byCharacter: CharacterEvidence[]; alerts: AlertEvidence[]; scenesEndedByGm: number }` (the count of `scene.exited` events with `reason === "gm_detects"`, `packages/events/src/events.ts:10,50`); `runSummaryFromLog(logPath: string, scenarioDir: string, secrets: string[]): Promise<RunSummary | null>` (null when the log or scenario cannot be read; reads the log as `evaluator/log-reader.ts` does, exporting what it needs); `evaluationCallBound(events: SessionEvent[], scenario: Scenario): number` (`2 × (human players + (group rubric has criteria ? 1 : 0))`, AI roles excluded as `evaluate.ts:113-117,156` does; export `aiRolesOf` if needed).
- `scrubText`: import it the way `review/` and `participant/` do (no copy of the scrubber). `collectLiveEvidence` imports `provenance.js`, `engine/join-codes.js` and `scrubText`; `demo/report.ts` imports `live-evidence` back, so break that cycle by moving the shared pieces down, not by duplicating them.

- [ ] **Step 1: Failing tests:** `counts replies and canned fallbacks per character`; `scenesEndedByGm counts only scene.exited with reason gm_detects`; `legacy true changes fallback detection exactly as the demo's tests expect`; `the output holds no code, token or hidden-fact text` (fixture with a hidden fact; assert it is absent from `JSON.stringify`); `evaluationCallBound is 2×(humans+1) for a 3-human scenario with a group rubric and excludes AI-filled roles`; `runSummaryFromLog returns null for a missing log`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/run-summary`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the pure body of `collectLiveEvidence`; `demo/` keeps only its narration and imports from `../run-summary`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/run-summary src/demo && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 move the run summary logic out of demo`.

### Task 3: Draft-candidate lookup and the evaluator's dotenv rule

**Files:** Modify `services/runtime/src/reports/index.ts` (export the lookup), `services/runtime/src/evaluator/main.ts` (skip `.env` when `NO_DOTENV=1`, as `services/runtime/src/main.ts:73` does); Test `services/runtime/src/reports/__tests__/candidates.test.ts`, `services/runtime/src/evaluator/__tests__/main-env.test.ts`.

**Interfaces:**
- Produces: `listDraftCandidates(reportsDir: string, sessionId: string): Promise<{ name: string; dir: string; hasReview: boolean; complete: boolean }[]>` using the existing `isCandidate` rule (`<id>` or `<id>-N`, N 2 to 99, real directories only); `complete` means `loadDrafts` succeeds and its `sessionId` equals `sessionId`. Never throws (a read error is an empty list).

- [ ] **Step 1: Failing tests:** `lists <id> and <id>-2 but not <id>-100, a symlink or another session`; `an evaluated, unopened draft is complete with hasReview false`; `a folder with a missing draft file is complete false`; `an opened review has hasReview true`; `evaluator main does not read the repo .env when NO_DOTENV=1 (a key placed in a temp .env is absent from the resolved env)`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/reports src/evaluator/__tests__/main-env.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `main.ts` of the evaluator keeps `loadLiveEnv` for the terminal and skips it when `NO_DOTENV === "1"`.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/runtime exec vitest run src/reports src/evaluator`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 draft candidate lookup and evaluator dotenv rule`.

### Task 4: Moderation module, part A operations

**Files:** Create `services/runtime/src/moderation/{index,types,read,write,result}.ts`; Modify `services/runtime/package.json` (`"./moderation"`), `services/runtime/src/review/cli.ts` (handlers `open`, `status`, `show`, `edit`, `accept`, `comment`, `edit-summary` call the module and print the same text, set the same exit codes), `review/errors.ts` (optional `code?: ModerationCode` on `ReviewRefusedError`, set where the fold and `edit` know it: stale `--expect` → `stale`, unknown subject/criterion (`need()`, `fold.ts:363,367`) → `unknown_subject`/`unknown_criterion`, not editable (`fold.ts` "amend it first" and the released-state refusals) → `not_editable`, unresolved items → `blocked`, a sibling released review (`store.ts:162-167`) → `superseded`); Test `services/runtime/src/moderation/__tests__/{read,write-a,result}.test.ts`; the existing `review/__tests__/cli*.test.ts` stay green unchanged.

**Interfaces:**
- Module functions **throw** the review errors (unchanged messages). Produces `toModResult<T>(fn: () => Promise<T>): Promise<ModResult<T>>` with `ModResult<T> = { ok: true; value: T } | { ok: false; code: ModerationCode; detail?: string[] }` applying the mapping in Global Constraints (`detail` is subject ids only); the CLI does not use it.
- `moderationStatus(dir: string): Promise<ModerationStatus>` (named to avoid the `reviewStatus` of `@acr/runtime/reports`) with `ModerationStatus = { superseded: string | null; subjects: SubjectStatus[] }`, `SubjectStatus = { id: string; state: "draft"|"released"|"amending"|"withdrawn"; version: number | null; criteriaTotal: number; openCriteria: string[]; summaryStale: boolean; tableStale: boolean; evaluationOk: boolean; selfRated: number; openDisputes: { seq: number; role: string; criterion: string | null }[] }` (the `statusLines` facts, `cli.ts:175`).
- `subjectView(dir: string, subject: string, secrets: string[]): Promise<SubjectViewDto>` where `SubjectViewDto = { id; state; criteria: { id; name; current: 1|2|3|4|null|"invalid"; status: "needs_review"|"accepted"|"edited"; rationale: string; evidence: { quote: string; scene?: string }[]; flags: string[]; selfLevel: 1|2|3|4|null|undefined }[]; summary: { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] }; objectives: { id: string; label: string }[]; comments: { visibility: "internal"|"feedback"; text: string; criterion?: string }[]; responses: { seq: number; role: string; text: string; criterion?: string; dispute: boolean; resolution?: { outcome: string; reason: string } }[]; versions: number[] }` built from `viewReport(draft, view, id, { audience: "facilitator" })` through the same line-level cleaning the CLI's `show` applies (`cleanLine`); the implementer reads `view.ts` and maps field by field, dropping anything not listed.
- `openFacilitatorReview(o: { dir; by; now; sessionLogText?: string; codesDir: string }): Promise<{ subjects: number }>`; `editScore(o: Base & { subject; criterion; level: 1|2|3|4|null; reason; rationale?; expect?: "1"|"2"|"3"|"4"|"na"|"invalid" }): Promise<void>`; `acceptCriterion(o: Base & { subject; criterion })`; `acceptSummary(o: Base & { subject })`; `commentOn(o: Base & { subject; text; criterion?; feedback?: boolean })`; `editSummary(o: Base & { subject; reason; strengths?: string[]; developments?: string[]; actions?: { lo: string; text: string }[] })`, with `Base = { dir: string; by: string; now: () => number; secrets: string[] }` and `by` already a cleaned safe id (the module calls `cleanText` with the CLI's limits on free text).

- [ ] **Step 1: Failing tests.** `read.test.ts`: `moderationStatus lists open criteria, open disputes, evaluationOk and tableStale per subject`; `subjectView returns only the listed fields (a JSON key check) and strips control characters and secrets`; `subjectView of an unknown subject throws a ReviewRefusedError with code unknown_subject`. `write-a.test.ts` (fixtures in `review/__tests__/fixtures.ts`): `editScore with a matching expect writes score.edited`; `editScore with a stale expect throws code stale and the file bytes are unchanged`; `acceptCriterion and acceptSummary append their events`; `commentOn with feedback is visible in the participant view only after release`; `editSummary with an unknown LO id throws a ReviewUsageError`; `the appended events verify (loadReview succeeds)`; `a held lock throws ReviewBusyError`. `result.test.ts`: `toModResult maps Busy→busy, Usage→invalid, coded Refused→its code, plain Refused→refused, Corrupt→unavailable, and checks Busy before Refused`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving each handler body's `applyCommand` builder into the module unchanged (same entries, same limits); the CLI handlers clean their flags, call the module and print today's text.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation src/review && pnpm -r typecheck`. Expected: PASS (every existing CLI test included).
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 extract the moderation operations (part A)`.

### Task 5: `ReportJobService`

**Files:** Create `services/control/src/report-job.ts`, `services/control/src/eval-child.ts` (`EvalSpawnFn`, `buildEvalChildEnv`); Modify `services/control/src/config.ts` (`evaluateMarginMs` from `REPORT_EVALUATE_MARGIN_MS`), `.env.example`; Test `services/control/src/__tests__/report-job.test.ts`.

**Interfaces:**
- Consumes: Task 2 (`evaluationCallBound`, `runSummaryFromLog`), Task 3 (`listDraftCandidates`), `isAllowedChildVar` (`child-env.ts`), `readLogStatus` (`log-tail.ts`), the session list entry (`scenarioId`, ended state; `supervisor.ts:380-390`), `scenarioDir(config.scenariosDir, scenarioId)` (`scenarios.ts:9-12`).
- Produces: `type EvalSpawnFn = (o: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }) => { stdout: Readable; stderr: Readable; kill(sig: NodeJS.Signals): void; onExit(cb: (code: number | null, signal: string | null) => void): void }`; `buildEvalChildEnv(parentEnv, config): NodeJS.ProcessEnv` (allowlist names and prefixes of `isAllowedChildVar` only, plus `NO_DOTENV=1`; no `LAUNCHER_TOKEN`, no `FACILITATOR_SECRET`; `NODE_OPTIONS` is excluded here even though the `NODE_` prefix passes elsewhere).
- `class ReportJobService { constructor(o: { config: ControlConfig; sessions: { get(id): { scenarioId: string; ended: boolean } | undefined }; spawn?: EvalSpawnFn; now?: () => number; parentEnv?: NodeJS.ProcessEnv; onDone?: (id: string, outputDir: string, by: string) => Promise<void> }); preflight(id): Promise<Preflight>; start(id, o: { confirmedCalls: number; by: string }): Promise<JobOutcome>; cancel(id): Promise<JobOutcome>; status(id): JobStatus; orphan(id): Promise<boolean>; shutdown(): Promise<void> }`.
- `JobStatus = { state: "idle"|"running"|"done"|"failed"; reason?: "interrupted"|"timeout"|"cancelled"|"error"; startedAt: number | null; progress: string[]; modelCalls: number | null; outputDir: string | null }` (`outputDir` relative to `reportsDir` and a valid candidate name). `Preflight = { ok: true; upTo: number } | { ok: false; code: "not_ended"|"already_evaluated" }`. `JobOutcome = { status: 200; value: JobStatus } | { status: 404 } | { status: 409; code: "not_ended"|"already_evaluated"|"already_running"|"confirm_mismatch"|"too_many_running" }`.

- [ ] **Step 1: Failing tests** (inject a fake `EvalSpawnFn` emitting scripted stdout, stderr and an exit): `start spawns node --import tsx <abs evaluator/main.ts> <abs log> --scenario <abs dir> --out <reportsDir> --json - with cwd the repo root`; `a second start is already_running; another session's start is too_many_running`; `a session that has any complete candidate (draft or review) is already_evaluated and spawns nothing`; `a session not ended is not_ended`; `confirmedCalls different from the bound is confirm_mismatch`; `outputDir is the relative name from the multi-line JSON on stdout parsed after exit, and must be a candidate name`; `progress keeps only lines matching the allowlist (evaluating <safe-id>, evaluation finished) at most 50, and drops a line with a path or provider text`; `buildEvalChildEnv holds no variable outside the allowlist and no NODE_OPTIONS`; `cancel signals the child; the state is failed/cancelled`; `the timeout (bound × EVAL_TIMEOUT_MS + margin, injected clock) kills the child; failed/timeout`; `on exit 0 onDone is called once with outputDir and by; if onDone throws the state is done and the overview reads ready_to_open`; `a persisted running state (report-jobs.json, 0600, atomic, with outputDir and modelCalls) becomes failed/interrupted on construction`; `shutdown kills a running child`; `a late complete draft after interruption reads as ready_to_open, not orphan`; `orphan(id) is true for a candidate whose drafts do not load`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/report-job.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Spawn `process.execPath` with `--import tsx` (tsx is a root devDependency, `package.json:69`); the log path is `<sessionsDir>/<id>.jsonl`; the scenario directory comes from the list entry's `scenarioId`; never pass anything from a request except `confirmedCalls` and `by`. Cwd is the repo root so the calibration stamp finds `data/calibration`.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 evaluate job service in the control service`.

### Task 6: `ModerationService`, part A

**Files:** Create `services/control/src/moderation.ts`, `services/control/src/retry.ts` (extracted from `participant-writes.ts`, which then imports it); Test `services/control/src/__tests__/moderation.test.ts`.

**Interfaces:**
- Consumes: Task 4 (`toModResult` and the functions), Task 5 (`ReportJobService`), Task 3 (`listDraftCandidates`), Task 2 (`runSummaryFromLog`).
- Produces: `class ModerationService { constructor(o: { config: ControlConfig; jobs: ReportJobService; secrets: string[]; sleep?; random?; now? }); overview(id): Promise<ModOutcome<Overview>>; open(id, name): Promise<ModOutcome<{ subjects: number }>>; subject(id, subject): Promise<ModOutcome<SubjectViewDto>>; edit(id, subject, body: { criterion; level; reason; rationale?; expect }, name); accept(id, subject, body: { criterion?: string; summary?: true }, name); comment(id, subject, body: { text; criterion?; feedback? }, name); editSummary(id, subject, body, name) }`.
- `Overview = { stage: "not_ended"|"not_evaluated"|"evaluating"|"failed"|"ready_to_open"|"in_review"; job: JobStatus; confirm: { upTo: number } | null; orphan: boolean; summary: RunSummary | null; subjects: SubjectStatus[] }`. `ModOutcome<T> = { status: 200; value: T } | { status: 404 } | { status: 400; code: "invalid" } | { status: 409; code: ModerationCode; detail?: string[] } | { status: 503; code: "busy"; retryAfterMs: number } | { status: 503; code: "unavailable" }`. There is no `released` stage.
- The review directory is found with `listDraftCandidates` (the one with a `review.jsonl` and not superseded, or the complete draft for `open`); `codesDir` is `config.sessionsDir`; the session log text is read from `<sessionsDir>/<id>.jsonl` (capped as the CLI's 64 MB).

- [ ] **Step 1: Failing tests:** `the actor is <cleaned name>-console and the event passes loadReview`; `a name with a space or over 56 characters is 400 invalid`; `edit with a stale expect is 409 stale and keeps the log bytes`; `a busy lock is retried 5 times with the injected sleep, then 503 busy`; `a corrupt log is 503 unavailable, not 500`; `open reads the session log and the codes record and returns the subject count`; `overview is not_evaluated with no candidate, evaluating while the job runs, ready_to_open for a complete unopened draft, in_review once opened, orphan true for a broken candidate, and carries summary and subjects only in_review`; `overview.confirm.upTo equals the bound only in not_evaluated`; `no outcome field contains a path separator or a review-layer message` (assert over every string of every outcome in the suite).
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by calling Task 4's functions through `toModResult`; `runSummary` comes from `runSummaryFromLog` with `secrets`.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 moderation service, part A`.

### Task 7: Control routes and wiring, part A

**Files:** Create `services/control/src/moderation-routes.ts` (`handleReportRoute(seg, method, req, res, deps): Promise<boolean>`, called from `api.ts` before `notFound()`); Modify `services/control/src/api.ts` (deps `jobs?`, `moderation?`; 404 when absent; add the new codes to the error maps), `services/control/src/main.ts` (construct `ReportJobService` with `onDone` calling `moderation.open`, construct `ModerationService` with `secrets` from `collectSecrets(env)`, pass both; call `jobs.shutdown()` from `close`), `services/control/src/reports.ts` (`NOT_READY` → "No reports are ready for this session yet. Evaluate it from the Report panel of its console.", and the same sentence in `apps/web/src/server/report-handlers.ts` and `apps/web/src/lib/console-api.ts`; update their tests); Test `services/control/src/__tests__/moderation-routes.test.ts`.

**Interfaces:** Produces, under `/sessions/:id/report` behind the service token: `GET ""` (Overview), `POST evaluate` body `{ confirmedCalls: number, by: string }`, `POST evaluate/cancel`, `POST open` body `{ by }`, `GET subjects/:subject`, `POST subjects/:subject/edit` body `{ criterion, level: 1|2|3|4|null, reason, rationale?, expect: "1"|"2"|"3"|"4"|"na"|"invalid", by }`, `POST subjects/:subject/accept` body `{ criterion?, summary?, by }`, `POST subjects/:subject/comment` body `{ text, criterion?, feedback?, by }`, `POST subjects/:subject/edit-summary`. Zod `strictObject` bodies; `by` max 64 UTF-16 units. A 409 body is `{ error: { code }, data: { blocked?: string[] } | null }` (extend `fail()` for it).

- [ ] **Step 1: Failing tests:** `each route 404s when its service is absent`; `a bad session id, subject or criterion id is 404 before the body is read`; `a body over the cap is 413 with the fixed sentence`; `an unknown body key is 400`; `409 carries only the closed code`; `503 busy sets Retry-After`; `GET evaluate is 404`; `edit without expect is 400`; `close() stops a running job`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Subject ids pass `RoleIdSchema` or equal `"group"`; criterion ids pass `isFileSafeId`.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/control test && pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 control routes for evaluate and review`.

### Task 8: BFF routes, part A

**Files:** Create `apps/web/src/server/console-report-handlers.ts`; Create route files under `apps/web/src/app/api/v1/console/sessions/[id]/report/` (`route.ts`, `evaluate/route.ts`, `evaluate/cancel/route.ts`, `open/route.ts`, `subjects/[subject]/route.ts`, `subjects/[subject]/{edit,accept,comment,edit-summary}/route.ts`), each a re-export like `report-links/route.ts`; Modify `apps/web/src/server/launcher-client.ts` (typed calls; hand-written closed parsers, since the app has no schema library (`launcher-client.ts:150`); the subject-view parser uses the larger report cap `MAX_REPORT_RESPONSE_CHARS` (`:108`); add the new codes to `BY_CODE` (`:115`) and parse `data.blocked` as safe-id strings only), `apps/web/src/server/handlers.ts` (`Deps.consoleReportThrottle`) and `routes.ts` (construct it: key = digest of the console cookie, 60 writes per minute, injected clock), `report-handlers.ts` (export `readCapped`); Test `apps/web/src/server/__tests__/console-report-handlers.test.ts`; extend `apps/web/src/__tests__/runtime-imports.test.ts` (it already forbids `@acr/runtime` imports in web source; add the new files to what it covers and assert no `node:fs` import in `console-report-*.ts`).

**Interfaces:** BFF paths mirror Task 7 under `/api/v1/console/sessions/[id]/report`; envelope responses; every refusal is a fixed sentence by closed code in `apps/web/src/lib/messages.ts` (`stale` → "Someone changed this. Reload the level and try again."; `invalid` for a name → the safe-id rule sentence).

- [ ] **Step 1: Failing tests:** `a write without the console cookie is 401`; `a cross-site write is refused before the throttle counts it`; `a valid write forwards the typed name as by and nothing from the cookie`; `an unknown control code maps to the generic sentence`; `stale reaches the browser as the stale sentence only`; `the control timeout (15 s, injected clock) is 504 with a fixed sentence`; `a body over the cap is 413`; `the subject-view parser rejects an unknown level value (fails closed)`; `61 writes in a minute from one cookie are throttled`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-report-handlers.test.ts src/__tests__/runtime-imports.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** following `report-handlers.ts` (reuse its Origin check, cookie and error-mapping helpers).
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 BFF routes for evaluate and review`.

### Task 9: Console UI, part A

**Files:** Create `apps/web/src/components/console/report/{ReportPanel,EvaluateCard,EvaluateConfirmDialog,RunSummaryView,SubjectList,SubjectView,CriterionRow,AuthorName}.tsx`; Modify `apps/web/src/components/console/SessionConsole.tsx` (render `ReportPanel` when `endedFinal || polledEnded` (line 81), above `ReportLinksPanel`), `apps/web/src/lib/console-api.ts`, `lib/messages.ts`, `lib/app.css`, `apps/web/src/__tests__/source-rules.test.ts` (exempt `AuthorName.tsx` from the `sessionStorage` rule, as `lib/report-draft.ts` is exempt); Test `apps/web/src/components/console/report/__tests__/*.test.tsx`.

**Interfaces:** Consumes Task 8's paths and the existing `ConfirmDialog.tsx` (reuse it for focus trapping). Produces `ReportPanel({ sessionId, fetch }: { sessionId: string; fetch?: typeof fetch })` (same injected-fetch shape as `ReportLinksPanel`); `AuthorName` keeps the typed name in `sessionStorage` (try/catch around every access), validates the safe-id rule before enabling any write and shows the rule.

- [ ] **Step 1: Failing tests:** `EvaluateCard shows not_ended, ready, running (progress lines, Cancel), failed (a fixed sentence per reason), ready_to_open (Open button), orphan (fixed sentence naming the ROLLBACK step) and done`; `the confirm dialog shows "up to N calls" from overview.confirm.upTo, says money already spent is not refunded on Cancel, and sends N back unchanged with the typed name`; `RunSummaryView shows scenes ended by the Game Master, fallback counts and alerts as text`; `SubjectList shows each subject's own state (draft, released, amending, withdrawn) and open-item count, with no global released state`; `a stale edit keeps the typed reason and comment and shows the stale sentence`; `Save is disabled until a reason is typed`; `AuthorName rejects "Kamal Syed" with the rule sentence and accepts "kamal"`; `a "<b>" in a comment stays literal text`; `polling runs only while evaluating (injected timer)`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: FAIL.
- [ ] **Step 3: Implement** with plain `fetch` through `console-api.ts`; poll the overview every 2 s only while `evaluating`; a status line uses `aria-live="polite"`.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/web test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 console evaluate and review panel`.

### Task 10: PR A end to end, threat model and docs

**Files:** Create `apps/web/e2e/report-moderation.spec.ts`; Modify `apps/web/e2e/axe.spec.ts`, `docs/THREAT_MODEL.md` (new section "Facilitator moderation", spec section 7; mention the `NODE_` prefix and the dotenv rule), `docs/RELEASE_PLAN.md` (AC-0336 and the review parts of AC-0337, AC-0339 ticked; TASK-0093 In Progress; new TASK-0102 for PR B), `docs/TEST_CASES.md` (TC-0135 onward), `docs/ID_REGISTRY.md`, `docs/ROLLBACK.md` (including removing an orphan folder by hand), `CHANGELOG.md`, `README.md`, `.env.example`, `progress.md`, `MEMORY.md`; run `npm run plan:generate`.

- [ ] **Step 1: Write the e2e** (own spec file; use the `endedSession` and `seedDraft` helpers): evaluate through the console (real `evaluate` with `MODEL_PROVIDER=mock` if Task 1 allows, else seeded), see the run summary and subject list, edit a level, assert a second tab's stale edit keeps the typed text, accept, comment. Two-tab double click on Evaluate asserts one job and `already_evaluated` afterwards. Axe on each state of the panel.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-moderation axe --trace off`. Expected: PASS.
- [ ] **Step 3: Write the docs** listed above.
- [ ] **Step 4: Gate:** `pnpm -r typecheck && pnpm --filter @acr/runtime test && pnpm --filter @acr/control test && pnpm --filter @acr/web test && npm run plan:generate && npx jest tests/unit/id-registry.test.js` (a jest test; `node --test` cannot run it). Expected: all pass.
- [ ] **Step 5: Commit** `[docs] EPIC-0002: US-0064 PR A e2e, threat model and close-out`. Push, open the PR as a draft, run the whole-branch review with the most capable model before marking ready.

## PR B: release and close-out (stacked on PR A)

### Task 11: Moderation module, part B operations

**Files:** Create `services/runtime/src/moderation/write-b.ts`; Modify `services/runtime/src/moderation/index.ts`, `review/cli.ts` (handlers `release`, `amend`, `withdraw`, `resolve`, `export` call the module; `releaseRefusal`, `staleHint` and the `export` destination handling keep working for the CLI); Test `services/runtime/src/moderation/__tests__/write-b.test.ts`; existing CLI tests stay green.

**Interfaces:** Produces (functions throw as in Task 4; `toModResult` wraps them): `releaseSubjects(o: Base & { subjects: string[] }): Promise<{ released: string[]; groupTableStale: boolean }>` (a non-empty list; throws a coded `blocked` refusal whose message the CLI still prints through `releaseRefusal`, and a typed `blockedSubjects: string[]` field for control); `amendSubject(o: Base & { subject; reason })`; `withdrawSubject(o: Base & { subject; reason }): Promise<{ groupTableStale: boolean }>`; `resolveDispute(o: Base & { seq: number; outcome: "upheld"|"amended"|"declined"; reason })` (`needs_amend` code when `amended` and the report was not amended first); `exportReport(o: Base & { subject: string; audience: "facilitator" | \`participant:${string}\` }): Promise<{ fileName: string; markdown: string }>`. `exportReport` ports `export.ts`'s `gate` (only a released subject; an `amending` subject is refused for a facilitator export; the index export is recorded under the group) and `tidy` (`cleanLine` per line) exactly, uses destination label `console-download` (1 to 64 characters, no control characters, `fold.ts:666-669`), appends the export event **before** rendering, and writes no file. The file name is `report-<subject>.md`, the subject matched against a safe-id pattern, `report-index.md` for the index.

- [ ] **Step 1: Failing tests:** `releaseSubjects with an empty list is a ReviewUsageError and writes nothing`; `with an open criterion it throws code blocked with that subject id and the log bytes are unchanged`; `releases two subjects atomically and reports groupTableStale`; `withdraw and amend require a reason`; `resolveDispute amended before an amend throws needs_amend`; `exportReport of a draft subject throws not_released and appends no event`; `of an amending subject for the facilitator is refused`; `for participant:<other role> on a personal report is refused`; `appends exactly one export event with destination console-download, then returns the audience's Markdown with no facilitator-only text for a participant audience`; `the reports directory listing is unchanged apart from review.jsonl`.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving the handler bodies as in Task 4.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/moderation src/review && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[refactor] EPIC-0002: US-0064 extract the moderation operations (part B)`.

### Task 12: Control service and routes, part B

**Files:** Modify `services/control/src/moderation.ts`, `moderation-routes.ts`; Test `services/control/src/__tests__/moderation-b.test.ts`, extend `moderation-routes.test.ts`.

**Interfaces:** Produces `ModerationService.release(id, body: { subjects: string[] }, name): ModOutcome<{ released: string[]; groupTableStale: boolean }>`, `amend(id, subject, { reason }, name)`, `withdraw(id, subject, { reason }, name)`, `resolve(id, { seq, outcome, reason }, name)`, `export(id, { subject, audience }, name): ModOutcome<{ fileName: string; markdown: string }>`; routes `POST /sessions/:id/report/{release,resolve,export}` and `POST …/subjects/:subject/{amend,withdraw}`. A `blocked` answer is `409 { error: { code: "blocked" }, data: { blocked: string[] } }` (subject ids only, each a safe id).

- [ ] **Step 1: Failing tests:** `release with {subjects: []} and with {all: true} are 400 before the service is called`; `release with an open item is 409 blocked with data.blocked ids and nothing written`; `export is POST only (GET is 404)`; `export answers JSON {fileName, markdown} (control sets no attachment headers)`; `the export event is in the log before the response is sent`; `the author suffix -console is on every part B event`; `a superseded review is 409 superseded`.
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-b.test.ts src/__tests__/moderation-routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with Task 11's functions.
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 control routes for release and export`.

### Task 13: BFF routes, part B

**Files:** Modify `apps/web/src/server/console-report-handlers.ts`, `launcher-client.ts`, `routes.ts`; Create route files for `release`, `resolve`, `export`, `subjects/[subject]/{amend,withdraw}`; Test `apps/web/src/server/__tests__/console-report-handlers-b.test.ts`.

**Interfaces:** `export` builds the `Response` itself from control's `{ fileName, markdown }`: `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="<name>"`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`; it never copies headers from control; a `fileName` that does not match `report-<safe-id>.md` is replaced by `report.md`.

- [ ] **Step 1: Failing tests:** `export by GET is 404 and by a cross-site POST is refused before the throttle`; `the export response headers are exactly the four above`; `a bad fileName is replaced by report.md`; `release forwards an explicit list unchanged and refuses all`; `blocked maps to a fixed sentence plus the subject ids and nothing else`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-report-handlers-b.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 BFF routes for release and export`.

### Task 14: Console UI, part B

**Files:** Create `apps/web/src/components/console/report/{ReleaseBar,ReleaseDialog,WithdrawDialog,AmendDialog,ResolveDisputePanel,ExportMenu}.tsx`, `apps/web/src/lib/report-audience.ts`; Modify `SubjectList.tsx`, `ReportPanel.tsx`, `lib/console-api.ts`, `lib/messages.ts`, `lib/app.css`; Test `…/report/__tests__/*.test.tsx`.

**Interfaces:** `report-audience.ts` exports the audience wording per subject kind, mirroring `review/policy.ts` version 1 (personal: that participant and the facilitator; group: every participant with peers' individual results removed, and the facilitator); the inert audiences (line manager, L&D, HR, sponsor) are never listed. `ReleaseDialog`, `AmendDialog` and `WithdrawDialog` each take `{ subject: { id: string; audience: string[] }; … }` and name the subject and audience (AC-0338).

- [ ] **Step 1: Failing tests:** `ReleaseDialog names each subject and its audience and lists the open items that block it`; `its confirm is disabled while any item blocks`; `release everything sends the full list, never an all flag`; `AmendDialog and WithdrawDialog each name the subject and the audience`; `WithdrawDialog says it cannot be undone and requires a reason`; `ResolveDisputePanel offers amended only after an amend`; `ExportMenu posts, saves the returned text, and shows the fixed sentence on a refusal`; `after a stale or busy refusal the typed reason stays`; `the groupTableStale hint is shown after a release or withdraw`; `a snapshot test that report-audience.ts equals POLICY in review/policy.ts` (import the runtime constant in the test only).
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same plus `pnpm --filter @acr/web test && pnpm --filter @acr/control test && pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: US-0064 console release, withdraw, resolve and export`.

### Task 15: PR B end to end and close-out

**Files:** Modify `apps/web/e2e/report-moderation.spec.ts` (or add `report-release.spec.ts`), `apps/web/e2e/axe.spec.ts`; docs as in Task 10 (AC-0336 to AC-0340 all ticked, US-0064 and TASK-0093 and TASK-0102 Done, TC ids, ID registry, ROLLBACK, CHANGELOG, README steps replacing the terminal ones, `progress.md`, `MEMORY.md`); `npm run plan:generate`.

- [ ] **Step 1: Write the e2e:** evaluate, review, release a role and the group through the dialog, then **stop the runtime**, open the participant link in a fresh browser context and read the released report (AC-0340); the group view hides peers' individual results; the facilitator amends, withdraws a second subject, resolves a dispute the participant filed, and exports (the download body equals the facilitator's view Markdown; a second export records a second event). Axe on the release, withdraw and amend dialogs.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-moderation axe --trace off`. Expected: PASS.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4: Gate:** the Task 10 gate plus `pnpm --filter @acr/web exec playwright test --trace off`. Expected: all pass.
- [ ] **Step 5: Commit** `[docs] EPIC-0002: US-0064 PR B e2e and close-out`. Push, draft PR, whole-branch review with the most capable model, then ready.
