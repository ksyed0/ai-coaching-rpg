# Hide a participant response (US-0069) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator hides one participant response (reason required, audited); a hidden response never reaches any participant or facilitator export, the participant's page or the group report; the log keeps the text; hiding never refunds either cap.

**Architecture:** A new facilitator-only review event `response.hidden { response: seq, reason }` follows `dispute.resolved` end to end: fold (`review/`), runtime write and CLI (`moderation/write-b.ts`, `review/cli.ts`), control (`Moderation.hide` and one route), the web BFF (handler, launcher client) and the console. The response stays in the fold's list with a `hidden` mark; one filter in `viewReport` drops hidden responses for every non-console reader.

**Tech Stack:** TypeScript, vitest (`pnpm --filter @acr/<pkg> exec vitest run <path>`), React (apps/web), zod (control routes). Packages: `services/runtime`, `services/control`, `apps/web`.

**Spec:** `docs/superpowers/specs/2026-11-17-hide-participant-response-design.md` (Draft 1, owner-approved 2026-11-17).

## Global Constraints

- Event: `{ type: "response.hidden", response: number, reason: string }`, actor kind `facilitator` only. Reason trimmed, 1 to `LIMITS.reason` (500) characters, cleaned like every other reason (`reasonOf` / the fold's `reason()`). Schema stays `acr.review/2` (no bump).
- `ResponseView.hidden: { seq: number; reason: string; by: string } | null`. A hidden response stays in `sv.responses`; `LIMITS.responses` (50) and the per-link cap (25, counted from `response.added` events) are unchanged by a hide.
- Hidden text appears in NO export (participant, facilitator, Markdown, JSON), participant page payload or group report. The console DTO carries `hidden` and omits `text` for a hidden response.
- A hidden dispute leaves every open-disputes list; `dispute.resolved` on a hidden response is refused. A response already resolved may still be hidden. A response already hidden cannot be hidden again.
- BUG-0029 resend dedupe ignores hidden responses.
- Supersede carries `response.hidden` only when its response was carried (`newSeq.has`), with `response` remapped; otherwise it is dropped with the response and the existing "not carried" notice stands.
- No unhide. No notice to the participant. A hide creates no report version and never changes the frozen snapshot.
- Console: a Hide button beside each response opens a confirm dialog that SHOWS the response text and requires a reason (500 characters); hides only on confirm.
- Commit format `[TYPE] SHORT-ID: description` (max 72 chars), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Coverage at least 80% and all tests pass before each commit. Never write "next ids" in RELEASE_PLAN, TEST_CASES, BUGS or LESSONS (the registry test).

## Review Focus

Each line below has its test in the named task.

1. A hidden response's text in the **group report** and the **Markdown** export (Task 2).
2. Hide of a response that already has a **resolution** (allowed) and of one in a **superseded** review (carried with remap, or dropped, never dangling) (Tasks 1, 3).
3. Hiding a role's **last** response: an empty list renders as none, not an error (Tasks 2, 6).
4. **Two hides** of the same response: the second is refused (Task 3).
5. A response hidden **after a release and an amend**: the next version must not show it (Task 2).

---

### Task 1: The event, the fold and the supersede carry (TASK-0144)

**Files:**
- Modify: `services/runtime/src/review/types.ts` (Body union, the event-name list near line 129, `CARRIED_PARTICIPANT`)
- Modify: `services/runtime/src/review/fold.ts` (`ResponseView`, `case "response.hidden"`, `dispute.resolved` refusal)
- Modify: `services/runtime/src/review/store.ts` (supersede carry, ~line 553)
- Test: `services/runtime/src/review/__tests__/fold-hide.test.ts` (new), `supersede-hide.test.ts` (new)

**Interfaces:**
- Produces: `Body` variant `{ type: "response.hidden"; response: number; reason: string }`; `ResponseView.hidden: { seq: number; reason: string; by: string } | null`; `"response.hidden"` in `CARRIED_PARTICIPANT` and in the event-name list.
- Consumes: the existing `facilitator(e)` (returns the actor's `by`), `reason(e, s)` and `ill(e, msg)` helpers in `fold.ts`.

- [ ] **Step 1: Write failing fold tests** in `fold-hide.test.ts` (copy the log-building helpers from `fold-participant-session.test.ts`). Cases, each with its assertion:
  - a facilitator `response.hidden` sets `responses[0].hidden` to `{ seq, reason, by }` and leaves `responses.length` unchanged (cap pin: add responses up to `LIMITS.responses`, hide one, the next `response.added` is still refused `too many responses`);
  - refused: actor `participant_session`; actor `system`; `response` pointing at no response; a second hide of the same response; empty or whitespace reason; reason over 500 characters;
  - `dispute.resolved` on a hidden dispute is refused with a message containing "hidden"; hiding a dispute that already has a resolution succeeds and keeps `resolution`;
  - Review Focus 2/4: hiding a response twice yields exactly one accepted event.
- [ ] **Step 2: Run to verify they fail:** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-hide.test.ts` → FAIL ("not supported yet").
- [ ] **Step 3: Implement** the Body variant, `hidden: null` in the `response.added` push, and `case "response.hidden"` in the fold (find the response across `subjects` as `dispute.resolved` does; refuse per Global Constraints). Add the refusal in `dispute.resolved` when `found.r.hidden`.
- [ ] **Step 4: Write failing supersede tests** in `supersede-hide.test.ts` (model on `supersede-participant.test.ts`): a response hidden in the old review is carried hidden with `response` remapped to the new seq, and a hide whose response is not carried (player or criterion absent from the re-run) is dropped and the carried list has no dangling `response.hidden`.
- [ ] **Step 5: Implement the carry** in `store.ts`: `else if (e.type === "response.hidden" && newSeq.has(e.response)) body = { ...(stripEnvelope(e) as typeof e), response: newSeq.get(e.response)! } as Body;` and add the type to `CARRIED_PARTICIPANT`. Update the comment at line 503 to name `response.hidden`.
- [ ] **Step 6: Run** both test files and `pnpm --filter @acr/runtime exec vitest run src/review` → all PASS.
- [ ] **Step 7: Commit** `[feat] US-0069: response.hidden event, fold and supersede carry`.

### Task 2: Read paths: the filter and every reader of responses (TASK-0144)

**Files:**
- Modify: `services/runtime/src/review/view.ts` (`viewReport`, the `liveResponses` mapping near line 177)
- Modify: `services/runtime/src/moderation/read.ts` and `moderation/types.ts` (console DTO), `services/runtime/src/review/cli.ts` (status open-disputes line ~181)
- Modify: `services/runtime/src/participant/write.ts` (resend dedupe, ~line 221)
- Check (read, change only if hidden text can pass): `services/runtime/src/evaluator/report-md.ts`, `review/store.ts`
- Test: `services/runtime/src/review/__tests__/view-hide.test.ts` (new), `participant/__tests__/write-hide.test.ts` (new), `moderation/__tests__/read-hide.test.ts` (new)

**Interfaces:**
- Consumes: `ResponseView.hidden` (Task 1).
- Produces: `ModerationSubjectView.responses[]` (in `moderation/types.ts`) becomes `{ seq; role; criterion?; dispute; resolution?; hidden?: { reason: string; by: string }; text?: string }` where `text` is ABSENT when `hidden` is present; `openDisputes` (read.ts, cli.ts) excludes hidden responses.

- [ ] **Step 1: Write failing tests**, each with a canary string `CANARY-HIDDEN-7731` in the hidden response's text:
  - `view-hide.test.ts`: `viewReport` for audience `released` and for the facilitator export contains no canary in `JSON.stringify` of the result nor in `renderMarkdown` output; the group report (`subject: "group"`) contains no canary; a visible response beside it still appears; **Review Focus 3:** hiding the only response yields no `responses` key (or an empty list) and renders without error; **Review Focus 5:** hide after release, `amend`, release again: the new version's report has no canary.
  - `write-hide.test.ts`: after a response is hidden, posting the identical text again returns `wrote: 1`-style success (a new `response.added` is appended) instead of the no-op, and the per-role cap still counts both.
  - `read-hide.test.ts`: the console DTO has `hidden: { reason, by }` and no `text` property for the hidden response; `openDisputes` omits a hidden dispute; status output (cli) omits it.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** In `viewReport`, filter `liveResponses` with `!x.hidden` before the `released`/other split (the console audience does not use `viewReport`; it reads `moderation/read.ts`). In `read.ts` map hidden responses without `text`. In the dedupe, add `r.hidden === null &&` to the `some` predicate. In `cli.ts` and `read.ts` `openDisputes`, add `!r.hidden`.
- [ ] **Step 4: Audit the other readers.** `grep -rn "\.responses" services/runtime/src` (non-test); for each reader not listed above state in the commit message whether hidden text can pass it and why not. `report-md.ts` consumes the already-filtered report.
- [ ] **Step 5: Run** the three new files and `pnpm --filter @acr/runtime exec vitest run` → PASS.
- [ ] **Step 6: Commit** `[feat] US-0069: hidden responses never reach an export or page`.

### Task 3: The runtime write and the CLI (TASK-0144)

**Files:**
- Modify: `services/runtime/src/moderation/write-b.ts` (new `hideResponse`), `moderation/index.ts` (export), `review/cli.ts` (HANDLERS `hide`, usage line, value-key map near line 126, positional map near line 145)
- Test: `services/runtime/src/moderation/__tests__/hide.test.ts` (new), `review/__tests__/cli-hide.test.ts` (new)

**Interfaces:**
- Produces: `hideResponse(o: Base & { seq: number; reason: string }): Promise<void>`; CLI `hide <dir> <response-number> --reason <text> --by <name>`.
- Consumes: `applyCommand`, `actorOf`, `reasonOf`, `ReviewUsageError`, `ReviewRefusedError` as used by `resolveDispute` in the same file.

- [ ] **Step 1: Write failing tests:** `hideResponse` appends one `response.hidden` event whose actor is the facilitator `by`, `response` equals `seq`, reason is the cleaned reason; refusals (`ReviewRefusedError`): no such response ("there is no response with that number…"), already hidden; `ReviewUsageError`: non-integer or out-of-range `seq` (same range as resolve), empty reason; **Review Focus 4:** two sequential hides, second refused and exactly one event in the log. CLI test: `hide` exits 0 and prints `response #N hidden`; a refusal exits non-zero with the message; the usage text lists `hide`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** `hideResponse` mirroring `resolveDispute`: validate `seq` (integer 1 to 999_999_999) and reason; inside `applyCommand` find the response across `l.view.subjects`, refuse when missing or `found.r.hidden`, return `[{ actor, body: { type: "response.hidden", response: seq, reason } }]`. Wire the CLI handler beside `resolve` (value keys `["by", "reason"]`, one positional).
- [ ] **Step 4: Run** both files plus `pnpm --filter @acr/runtime exec vitest run` → PASS; coverage check `pnpm test:coverage` stays at or above 80%.
- [ ] **Step 5: Commit** `[feat] US-0069: hide command in the runtime and CLI`.

### Task 4: Control and the web BFF (TASK-0145)

**Files:**
- Modify: `services/control/src/moderation.ts` (`HideBody`, `Moderation.hide`), `services/control/src/moderation-routes.ts` (route `hide`, the `n === 4` condition at line 130)
- Modify: `apps/web/src/server/launcher-client.ts` (`reportHide`; `SubjectView.responses` type and its parser near lines 397 and 494), `apps/web/src/server/console-report-handlers.ts` (`handleConsoleReportHide`), `apps/web/src/server/routes.ts` (register), the Next route file that registers `handleConsoleReportResolve` (found with `grep -rn "report/resolve" apps/web/src/app`; add the sibling `hide` route)
- Modify: `apps/web/src/lib/console-api.ts` (`ReportResponse`, its parser near line 422, `hideResponse`)
- Test: `services/control/src/__tests__/moderation-hide.test.ts` (new), `apps/web/src/server/__tests__/console-report-handlers-hide.test.ts` (new), `apps/web/src/lib/__tests__/console-api-hide.test.ts` (new)

**Interfaces:**
- Produces: control `POST /api/v1/sessions/:id/report/hide { seq, reason, by }` (strict zod, same `By` and `MAX_TEXT_BODY_BYTES` as resolve); `Moderation.hide(id, { seq, reason }, name): Promise<ModOutcome<void>>`; BFF `POST .../report/hide { seq, reason, by }` via `write()` with `keys: ["seq", "reason"]`; `launcher.reportHide(id, { seq, reason, by }): Promise<void>`; console `hideResponse(sessionId, { seq, reason, by }, f?)`; `ReportResponse` gains `hidden?: { reason: string; by: string }` and `text` becomes optional only when `hidden` is present (parser refuses a hidden response that carries text, and a visible one without text).
- Consumes: `hideResponse` (Task 3), the `write` helper, `postJson`, `reportPath`.

- [ ] **Step 1: Write failing tests:** control route returns the runtime's refusal codes unchanged and refuses an unknown key or a bad `seq` as the neutral invalid answer (copy `moderation-routes.test.ts` resolve cases); BFF handler refuses a body with extra keys, a non-integer `seq`, a missing reason; a cross-site write is refused as for resolve; `console-api` parser accepts a hidden response without text and rejects a hidden response WITH text; `reportHide` sends the body and closes on a malformed answer.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** by mirroring the resolve chain in each file; the launcher parser for `responses` accepts `hidden: { reason, by }` and then requires `text` absent.
- [ ] **Step 4: Run** the new files and `pnpm --filter @acr/control exec vitest run` and `pnpm --filter @acr/web exec vitest run src/server src/lib` → PASS.
- [ ] **Step 5: Commit** `[feat] US-0069: hide route in control and the web service`.

### Task 5: The console: responses list, Hide and the confirm dialog (TASK-0146)

**Files:**
- Create: `apps/web/src/components/console/report/ResponsesPanel.tsx` (lists ALL responses of the subject, not just open disputes), `HideResponseDialog.tsx`
- Modify: `apps/web/src/components/console/report/SubjectView.tsx` (render the panel beside `ResolveDisputePanel`, a `hide` runner like `resolve`), `apps/web/src/lib/messages.ts` (`REPORT_CONSOLE` strings)
- Test: `apps/web/src/components/console/report/__tests__/responses-hide.test.tsx` (new)

**Interfaces:**
- Produces: `ResponsesPanel({ responses: ReportResponse[]; canWrite: boolean; pending: boolean; criterionName: (id: string) => string; onHide: (seq: number, reason: string) => Promise<string | null> })`; `HideResponseDialog` wraps `ReasonDialog` (existing: `title`, `description`, `confirmLabel`, `tone`, `audienceIntro`, `audience`, `reasonLabel`, `name`, `pending`, `opener`, `error`, `onConfirm`, `onCancel`) and passes the response text as the single `audience` line so the facilitator sees exactly what is being hidden (`tone: "danger"`, `confirmLabel: "Hide"`, description says it cannot be undone and the participant is not told).
- Consumes: `hideResponse` (Task 4), `ReasonDialog`, `ConfirmDialog`.

- [ ] **Step 1: Write failing tests:** every response (not only disputes) is listed with its criterion name; Hide opens the dialog showing the response text and an empty required reason; Confirm is disabled until the reason is non-empty; confirming calls `onHide(seq, reason)` once; a refusal keeps the dialog open with the typed reason and shows the sentence; focus returns to the Hide button on cancel; a hidden response renders "Hidden by facilitator", the reason and who, and NOT its text (canary assertion on the DOM); Hide is disabled with the existing cannot-write sentence when `canWrite` is false; **Review Focus 3:** no responses renders nothing; the buttons have accessible names that include the response number.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** the panel and dialog; text is rendered as text (React escaping, no markup). Wire `SubjectView`: `hide = (seq, reason) => run(hideResponse(sessionId, { seq, reason, by: name }))` with the same `run`/error-sentence handling as `resolve`; the open-disputes panel already excludes hidden responses (Task 2 DTO) so also filter `r.hidden === undefined` there.
- [ ] **Step 4: Run** the new file and `pnpm --filter @acr/web exec vitest run src/components/console` → PASS; typecheck `pnpm --filter @acr/web exec tsc --noEmit`.
- [ ] **Step 5: Commit** `[feat] US-0069: console responses list with a hide confirm dialog`.

### Task 6: End-to-end proof, documents and close-out (TASK-0146)

**Files:**
- Test: `services/control/src/__tests__/hide-response.e2e.test.ts` (new; model on `mute-seat.e2e.test.ts` or the existing participant-writes e2e), `apps/web/e2e/` spec only if the existing console report specs make it a copy-and-adapt
- Modify: `docs/THREAT_MODEL.md` ("Participant ratings and responses": replace the "no redaction" sentence), `docs/ROLLBACK.md` (new "US-0069"), `docs/TEST_CASES.md`, `CHANGELOG.md` ([Unreleased] Added), `docs/RELEASE_PLAN.md` (US-0069 In Progress, tick AC-0392..AC-0395 with evidence, TASK-0144..0146, Notes), `docs/ID_REGISTRY.md` (a "Reserved blocks (2026-11-17, hide response)" line for TASK-0144..0146 and TC-0336..0345; move the Next and Last rows past them), `progress.md`, `MEMORY.md`; regenerate with `npm run plan:generate`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the e2e test** (control with a real review dir): a participant posts a response through the link; the facilitator hides it through the route; the participant's report read, the participant export and the facilitator export contain no canary; the log still holds the `response.added` text and one `response.hidden` with `by` and `reason`; a second hide is refused; the per-link and per-role caps are unchanged (post 25 through one link, hide one, the 26th is still refused (`too_many`, the per-link branch in `participant/write.ts`)).
- [ ] **Step 2: Mutation checks:** state in TEST_CASES, for each, the one-line change and which test catches it: drop the `!x.hidden` filter in `viewReport`; remove the carry remap in `store.ts`; remove the dedupe `hidden === null` guard; let `dispute.resolved` accept a hidden response; send `text` for a hidden response in the DTO. Run each, confirm a test fails, revert.
- [ ] **Step 3: Documents.** ROLLBACK text: a runtime older than this change refuses a review log that contains `response.hidden`; roll back only before the first hide, or restore the log from before it. THREAT_MODEL: what a hide does and does not do (text stays in the log; the participant is not told; a forwarded link can post again and be hidden again, the per-link cap still bounds it; the participant's "used N of 50" counter counts visible responses only). TEST_CASES: TC-0336..TC-0345 cover the fold, supersede carry, read paths (group report, Markdown, JSON), resend, CLI, control and BFF, console dialog, the e2e and the five mutations; every case with a result Pass except any that needs a real browser (mark Not Run, owner-run). Do not write the registry's next ids anywhere but `docs/ID_REGISTRY.md`'s table.
- [ ] **Step 4: Gates:** `npm run plan:generate`, `npm run plan:test`, `pnpm test` (root and workspaces), `pnpm --filter @acr/web exec tsc --noEmit`, coverage at or above 80%, `pnpm lint`; all PASS.
- [ ] **Step 5: Commit** `[docs] US-0069: tests, threat model, rollback and trackers`.

## Self-review

- **Spec coverage:** event and refusals (T1, T3); fold, caps, dispute rules, dedupe (T1, T2); single filter and group/Markdown/JSON paths (T2); console DTO without text (T2, T4); entry points CLI, control, BFF, console with confirm (T3, T4, T5); supersede carry (T1); documents and rollback (T6); Review Focus 1 to 5 mapped in the table above; spec section 8 (participant sees nothing, counter mismatch) is documentation in T6. No spec gap found.
- **Type consistency:** `ResponseView.hidden` (T1) is read by T2; the DTO `hidden: { reason, by }` and absent `text` (T2) is parsed by `launcher-client` and `console-api` (T4) and rendered by T5; `hideResponse` (T3) is called by `Moderation.hide` (T4); `ReportResponse.hidden` (T4) is the prop T5 reads.
- **Finding to confirm while building:** the console today lists only OPEN disputes (`ResolveDisputePanel`), not every response, so Task 5 adds a new list; the spec's "button beside each response" is satisfied by that list.
