# Slice 2c-3: facilitator evaluate, moderate, release and export in the console (US-0064)

Addendum to `2026-10-26-web-client-design.md` (sections 5.8, 7) and `2026-11-05-slice-2c-reports-design.md` (2c-3 outline). Where they differ, this one wins. Revision 1, 2026-11-06.

## 1. Purpose and success

A facilitator can take an ended session to released reports without a terminal: evaluate it, see the run summary, review and edit the draft, release, and later amend, withdraw, resolve a dispute and export. The same gate rules and the same hash-chained `review.jsonl` apply as for `pnpm moderate`.

Success: AC-0336 to AC-0340, plus the added criteria in section 9. A facilitator who never opens a terminal finishes the programme; the participant reads the released report after the runtime has exited.

**Decisions fixed with the owner (2026-11-06):**
- One spec, two PRs: **A** evaluate and review, **B** release and close-out.
- Evaluate runs as a **child process** of the control service (the existing CLI, sanitised environment). Moderation runs **in-process** over the review library.
- Browser actions are recorded with the existing attested actor: the facilitator types a name once per console session, the control service cleans it like `--by` (1 to 56 letters, digits, `_` or `-`, because the chain accepts only safe ids) and appends `-console`, so the actor reads `priya-console`. **No schema bump.**
- The UI is a **Report panel group on the session console**, shown once the session has ended. No cross-session reports screen.
- Export is a **Markdown download**; PDF is the browser's own "Save as PDF" through the existing print stylesheet. No server-side PDF.

**Out of scope:** `supersede` and re-running a released session; PDF generation; a cross-session reports list; per-person facilitator identities (the console has one shared secret); the participant side (done in 2c-1 and 2c-2).

## 2. Architecture and boundaries

**Control service (new):**
- `ReportJobService`: the evaluate job, one per session, at most one running across the service.
- `ModerationService`: the review operations, in-process, with closed-union results.
- `RunSummary`: read-only, computed from the session log and the review (section 4).

**BFF (new):** facilitator-only routes under `/api/v1/console/sessions/:id/report/*`. They use the existing console cookie. Origin and Fetch-Metadata checks run before any throttle accounting; small per-route body caps; a closed error mapping with no control text. The BFF holds no review data and no file paths (an import guard checks this, as in 2c-1).

**Console UI (new):** the Report panel group (section 6).

**Reused unchanged:** the review library (fold, store, gate, policy, `exportHandler` logic), the participant read side, report-access links, the 2c-2 write path.

**Derived by control, never taken from a request:** the session, the session log path, the scenario directory (found by the scenario id in the log, as the CLI does), and the reports directory.

## 3. Evaluate job (part A)

**Preconditions.** The session has ended, its log is readable, and the session has **no draft or review yet**. `writeReports` writes a fresh `<session-id>-2`, `-3` when the directory exists, so a repeat click would spend again and create a second draft; the control service refuses instead (`already_evaluated`). Re-running a released session is `supersede` and is out of scope.

**Source of the log.** Open item to settle at the start of the plan: confirm the path of an ended session's log (`data/sessions/<id>.jsonl`) and that the ended log is still readable there when the console asks. The plan's first task reads the session-store code and records the answer. If rotation moves the log, control reads it from the rotated location and the spec is amended.

**Run.** Control spawns the existing evaluate CLI with `--json -`, reading the real output directory from its JSON (not guessing `<id>` or `<id>-2`). The child gets the sanitised environment pattern of `child-env.ts` plus the model settings; the model key goes only to the child. Control stores, per session: state (`idle`, `running`, `done`, `failed`), `startedAt`, the exit code, and a **capped tail of progress lines** (no raw log text, scrubbed). It never stores keys.

**Confirmation.** The start request carries `confirmedCalls: n`. The server computes its own bound with the same function the dialog uses and refuses a different `n`. The bound is `2 × (human players + 1 if the group rubric has criteria)` (each ask makes at most 2 calls; AI-filled roles are not asked); transport retries are not counted. The request carries `confirmedCalls`; the overview returns the bound as `confirm.upTo` when the stage is ready. The exact count appears only after the run (`modelCalls`, as `summaryLines` prints it).

**Limits.** One running evaluate across the service. An overall timeout of `bound × EVAL_TIMEOUT_MS + REPORT_EVALUATE_MARGIN_MS` (margin default 120,000), not a fixed figure. Cancel sends a signal to the child; money already spent is not refunded, and the dialog says so.

**Open after evaluate.** The start request carries the typed name; when the child exits 0, control opens the review at once with it (AC-0336 "runs evaluate and moderate open"). If the open fails the stage is `ready_to_open` and the console offers Open. Control finds the draft with a draft-candidate lookup (`<id>` or `<id>-N` holding the session's draft files, with or without a `review.jsonl`), exported from `@acr/runtime/reports`; the job state persists `outputDir` and `modelCalls`.

**Restart.** A control restart mid-run marks the job `failed (interrupted)`. The CLI writes only after the model calls finish and removes its own partial directory on a write failure, so an interruption in the long phase leaves nothing. A hard kill during the brief write could leave an orphan directory without a review; an orphan is a candidate directory whose draft set is incomplete or fails to load. The overview carries `orphan: true` with a fixed sentence pointing at the ROLLBACK step (remove the folder by hand); control never reuses it. A late valid draft from a child that outlived a hard kill reads `ready_to_open`, not orphan. Control's shutdown kills the child.

## 4. Run summary (AC-0339)

Scenes ended by the Game Master (`scene.exited` with `reason: "gm_detects"`), fallback counts (canned lines against real replies), and facilitator alerts with their reasons, shown before release.

The logic exists as `narrateRunSummary`/`collectLiveEvidence` in `demo/` (US-0023), and `collectLiveEvidence(events, scenario, opts)` is a pure function over session events. As with the AI-player bot in 2b, the plan **moves the pure part into a shared module** that the demo and the control service both use; the demo keeps only its narration. Open item: confirm in the plan that it separates cleanly (no demo-only context). Counts and sanitised reasons only; no code, token or fact text, as US-0023 already requires. Text is rendered as text.

## 5. Moderation operations (parts A and B)

All run in-process over the review library with its lock, gate rules and hash chain. Results are a **closed union**: `ok`, `refused` with a fixed code, `busy`, `invalid`; nothing from the review layer's text reaches the browser. A held `review.lock` is retried with backoff (as `ParticipantWriteService`), then `busy`.

**Author.** The request carries the typed name; control validates it with the `--by` rule (a safe id: letters, digits, `_`, `-`; at most 56 characters so the `-console` suffix fits the chain's 64) and appends `-console`. The console field states the rule; a name with a space is refused with a fixed sentence. The BFF takes it from the body, not from the cookie. Anyone with the shared secret can type any name; this is documented in the threat model, not solved here.

**Part A:** `open`, `edit` (level, reason, optional rationale; carries `--expect <level>` so two open tabs cannot overwrite each other), `accept` (a criterion or the summary), `comment` (optionally per criterion, optionally feedback to the participant), `edit-summary`.

**Part B:**
- `release`: takes an **explicit list of subjects**. An empty list and an `all` flag are refused by the server. The UI's "release everything" sends the full list it shows. All-or-nothing: every open item must be resolved first; a refusal names which subjects are blocked by a fixed code.
- `amend` and `withdraw`: a reason is required. `withdraw` cannot be undone, and the dialog says so.
- `resolve`: outcome `upheld`, `amended` or `declined` with a reason shown to the participant. `amended` needs an amend of that report first; the UI offers them in that order.
- `export`: a **`POST`**, not a `GET`, because it records the export event in the chain before it serves the file (as the CLI does). It returns the Markdown as an attachment with a fixed safe filename and `no-store`. The event's destination label is `console-download`. Subject is a role, `group` or `index`; audience is the facilitator view or `participant:<role>`. Nothing is written to the server's disk.

**Stage and state.** There is no global "released" stage. The report stage is `not_ended`, `not_evaluated`, `evaluating`, `failed`, `ready_to_open` or `in_review`; each subject carries its own state (`draft`, `released`, `amending`, `withdrawn`, the review library's names).

## 6. Console UI

The Report panel group on the session console, shown when the session has ended; it replaces the fixed "reports are not ready" message. In order:
1. **Evaluate card**: not ended, ready, running (progress and Cancel), failed, done. Ready opens the confirmation dialog.
2. **Run summary**, above the subject list.
3. **Subject list**: one row per role and the group, with its state and the open items still to resolve.
4. **Subject view** (a few small components, not one large file): levels with edit and accept, comment box. Edit needs a reason.
5. **Release bar (B)**: the checked subjects, and the dialog.
6. **After release (B)**: amend, withdraw, export, and resolve for disputes.
7. **Links panel**: the participant links from 2c-1 and 2c-2, unchanged.

**Release dialog (AC-0338).** It names each subject and its audience, taken from the visibility policy, not invented. Today (`review/policy.ts`, version 1): a role's own report is seen by that participant (and the facilitator); the group report is seen by every participant (with peers' individual results removed) and the facilitator. The other audiences in the policy (line manager, L&D, HR, sponsor) are inert until identities exist and are not promised in the dialog. The dialog also lists any open items that block the release.

**Never lose typed text.** On a stale-edit refusal (`--expect` mismatch), the reason and comment text stay in the form; the message says to reload the level. (Lesson from 2c-2, where a note was lost.)

**Accessibility.** Dialogs trap focus and return it. Progress and refusals are announced politely (`aria-live`). State is never colour only. Axe runs on every state.

## 7. Threat-model changes

A new section **"Facilitator moderation"** in `docs/THREAT_MODEL.md`:
- One shared facilitator secret; the typed name and `-console` marker are labels, not identity.
- A click can spend model budget: one global evaluate slot, an explicit confirmation, a repeat guard, cancel.
- The evaluate child gets a sanitised environment; the model key does not reach the control process's other children.
- Cross-site writes are refused before any throttle; export is a `POST`.
- The BFF holds no review data, no paths, and sees no control text; errors are a closed mapping.
- Documented limit: the chain is unkeyed; a console-labelled name can be forged by anyone who can write the reports directory (as for the participant actor in 2c-2).

Also: `docs/ID_REGISTRY.md`, `RELEASE_PLAN.md` (US-0064, TASK-0093 and any new tasks), `TEST_CASES.md`, `ROLLBACK.md`, `CHANGELOG.md`, `README`, `.env.example` (any new setting, such as the evaluate overall timeout margin), `progress.md`, `MEMORY.md`.

## 8. Tests

**Unit and service.** Job lifecycle (start, progress cap, done, failed, cancel kills the child, a second start refused, `already_evaluated`); a control restart marks a running job interrupted and reports an orphan; the closed result union; `--expect` stale refusal; release refused for an empty list, for `all`, and while open items remain (nothing written); withdraw and amend require a reason; export records the event first and serves the file; author cleaning and the `-console` suffix; per-route body caps; the confirmation re-check.

**Boundary.** The BFF imports no review code and holds no review data (import guard); no path or control text appears in any BFF error.

**Security.** Cross-site writes refused before any throttle; `export` is not reachable by `GET`.

**E2E.**
- **Part A (own spec file):** end a session, evaluate through the console, see the run summary, open the review, edit a level (stale refusal keeps the typed text), accept, comment. Axe on each state.
- **Part B:** release, the participant reads the report **with the runtime gone**, then amend, withdraw, resolve and export. Axe on the dialogs. This covers AC-0340.
- **Mock model.** The e2e runs the real `evaluate` with `MODEL_PROVIDER=mock`. `createScriptedEvaluator(events, scenario, rubrics)` takes any session's events, so it should score an e2e-played session. The plan's first e2e task proves that on a real e2e session log. If it cannot, the e2e seeds the draft folder with the runtime's own functions, as the 2c-1 and 2c-2 e2e do, and the evaluate path keeps its unit and service coverage; the spec is amended to say so.

## 9. Acceptance criteria

Existing: AC-0336 to AC-0340 (AC-0336 and AC-0337 are split between parts A and B; AC-0338 is part B; AC-0339 and the evaluate half of AC-0336 are part A; AC-0340 is part B).

Added (ids assigned in the plan; next free AC-0373, TC-0135, TASK-0102):
- The control service refuses to evaluate a session that already has a draft or review, and never reuses an orphan directory.
- The facilitator confirms the model spend before evaluate runs, and a stale confirmation is refused.
- Release takes an explicit list of subjects; an empty list or `all` is refused by the server.
- Export is a `POST` that records the export before serving the file, and nothing is written to the server's disk.
- The facilitator can resolve a participant's dispute in the browser.
- A stale edit keeps the facilitator's typed text.

## 10. PR split

- **PR A (evaluate and review):** shared run-summary module (demo refactor), `ReportJobService`, `ModerationService` for `open`, `edit`, `accept`, `comment`, `edit-summary`, the control and BFF routes, the Evaluate card, run summary, subject list and subject view, the part A e2e, threat-model section and ids.
- **PR B (release and close-out):** `release`, `amend`, `withdraw`, `resolve`, `export`, the dialogs and release bar, the part B e2e (release, read with the runtime gone, export), the updated "not ready" message and the README steps, rollback notes and the close-out docs.

PR A ships alone and is useful (the facilitator evaluates and reviews in the browser; the terminal still releases). PR B stacks on A.

## 11. Open items settled at the start of the plan

Settled by the Opus review (2026-11-06): the ended log stays at `<sessionsDir>/<id>.jsonl`; the call bound is the formula in section 3; the run summary separates cleanly and the Game Master signal exists. Still open, settled in the plan's Task 1: whether the scripted evaluator scores an e2e-played session.

Each has a named fallback above; none changes the design if it fails.

**Finding (Task 1, 2026-11-06):** `MODEL_PROVIDER=mock` evaluate exits 0 with one JSON document and an absolute `dir` on a real e2e `endedSession` log, but scores no role: the e2e players never speak, so every role and the group report `insufficient_evidence` (0 utterances, at least 2 needed) and `modelCalls` is 0. The e2e therefore seeds the draft folder with `seedDraft` (the section 8 fallback applies); the evaluate path keeps its unit and service coverage.
