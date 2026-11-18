# Hide a participant response (US-0069) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator hides one participant response (reason required, audited); a hidden response never reaches any participant or facilitator export, the participant's page or the group report; the log keeps the text; hiding never refunds either cap.

**Architecture:** A new facilitator-only review event `response.hidden { response: seq, reason }` follows `dispute.resolved` end to end: fold (`review/`), runtime write and CLI (`moderation/write-b.ts`, `review/cli.ts`), control (`Moderation.hide` and one route), the web BFF (handler, launcher client) and the console. The response stays in the fold's list with a `hidden` mark; one filter in `viewReport` drops hidden responses for every non-console reader.

**Tech Stack:** TypeScript, vitest (`pnpm --filter @acr/<pkg> exec vitest run <path>`), React (apps/web), zod (control routes). Packages: `services/runtime`, `services/control`, `apps/web`.

**Spec:** `docs/superpowers/specs/2026-11-17-hide-participant-response-design.md` (Draft 1, owner-approved 2026-11-17).

## Global Constraints

- Event: `{ type: "response.hidden", response: number, reason: string }`, actor kind `facilitator` only. Reason trimmed, 1 to `LIMITS.reason` (500) characters, cleaned like every other reason (`reasonOf` / the fold's `reason()`). Schema stays `acr.review/2` (no bump).
- `ResponseView.hidden: { seq: number; ts: number; reason: string; by: string } | null` (`ts` is the hide event's `ts`, so the console can show when). A hidden response stays in `sv.responses`; `LIMITS.responses` (50) and the per-link cap (25, counted from `response.added` events) are unchanged by a hide.
- Hidden text appears in NO export (participant, facilitator, Markdown, JSON, the CLI `show` and `export`), participant page payload or group report. This includes a facilitator export of a released snapshot taken AFTER an amend and a second release (the leak path the Opus plan review found: `snapshotReport` reads `sv.responses`, not `liveResponses`). The console DTO carries `hidden: { reason, by, at }` (omitted when not hidden) and omits `text` for a hidden response.
- A hidden dispute leaves every open-disputes list; `dispute.resolved` on a hidden response is refused. A response already resolved may still be hidden. A response already hidden cannot be hidden again.
- BUG-0029 resend dedupe ignores hidden responses.
- Supersede carries `response.hidden` only when its response was carried (`newSeq.has`), with `response` remapped; otherwise it is dropped with the response and the existing "not carried" notice stands.
- No unhide. No notice to the participant. A hide creates no report version and never changes the frozen snapshot.
- Console: a Hide button beside each response opens a confirm dialog that SHOWS the response text and requires a reason (500 characters); hides only on confirm.
- `frozenView` keeps `hidden` exactly as the live view holds it. Never null it the way a later `resolution` is nulled (`view.ts` ~245): a hide applies at once to every version.
- A hide is refused on a superseded review with the fold's `superseded` code (control 409).
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
- Modify: `docs/ID_REGISTRY.md` (reserve first: a "Reserved blocks (2026-11-17, hide response)" line for TASK-0144..TASK-0146 and TC-0336..TC-0345, and move the table's Next and Last rows past them; do this before any other change so a parallel branch cannot take the ids)
- Modify: `services/runtime/src/review/types.ts` (the `Body` union at lines 41-116, and `CARRIED_PARTICIPANT` at ~128; there is no separate event-name list)
- Modify: `services/runtime/src/review/fold.ts` (`ResponseView`, `case "response.hidden"`, `dispute.resolved` refusal)
- Modify: `services/runtime/src/review/store.ts` (supersede carry after line 553; the comments at lines ~490-493 and ~503 name `dispute.resolved`, name `response.hidden` there too; the `notCarried` label at ~528-533)
- Test: `services/runtime/src/review/__tests__/fold-hide.test.ts` (new), `supersede-hide.test.ts` (new)

**Interfaces:**
- Produces: `Body` variant `{ type: "response.hidden"; response: number; reason: string }`; `ResponseView.hidden: { seq: number; ts: number; reason: string; by: string } | null` (`ts` from the event); `"response.hidden"` in `CARRIED_PARTICIPANT`.
- Consumes: the existing `facilitator(e)` (returns the actor's `by`), `reason(e, s)` and `ill(e, msg)` helpers in `fold.ts`.

- [ ] **Step 1: Write failing fold tests** in `fold-hide.test.ts` (copy the log-building helpers from `fold-participant-session.test.ts`). Cases, each with its assertion:
  - a facilitator `response.hidden` sets `responses[0].hidden` to `{ seq, reason, by }` and leaves `responses.length` unchanged (cap pin: add responses up to `LIMITS.responses`, hide one, the next `response.added` is still refused `too many responses`);
  - refused (do not assert a message where the fold refuses earlier, e.g. a `participant_session` actor is refused with "a web link can only rate or respond"): actor `participant_session`; the attested `participant` actor; actor `system`; `response` pointing at no response; a second hide of the same response; an empty reason; a reason over 500 characters (the fold's `reason()` does not trim; whitespace-only is refused at the write layer, Task 3);
  - `dispute.resolved` on a hidden dispute is refused with a message containing "hidden"; hiding a dispute that already has a resolution succeeds and keeps `resolution`;
  - Review Focus 2/4: hiding a response twice yields exactly one accepted event.
- [ ] **Step 2: Run to verify they fail:** `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-hide.test.ts` → FAIL ("not supported yet").
- [ ] **Step 3: Implement** the Body variant, `hidden: null` in the `response.added` push, and `case "response.hidden"` in the fold (find the response across `subjects` as `dispute.resolved` does; refuse per Global Constraints). Add the refusal in `dispute.resolved` when `found.r.hidden`.
- [ ] **Step 4: Write failing supersede tests** in `supersede-hide.test.ts` (model on `supersede-participant.test.ts`): a response hidden in the old review is carried hidden with `response` remapped to the new seq, and a hide whose response is not carried (player or criterion absent from the re-run) is dropped and the carried list has no dangling `response.hidden`.
  Also: a hidden open dispute of a player who is NOT in the re-run is not announced as an "open dispute" in `notCarried` (change `what` at `store.ts` ~528-533 to `"hidden response"` when `r?.hidden`), and the CLI supersede line (`cli.ts` ~538, "open disputes stay open") does not count it.
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
- Produces: `SubjectViewDto.responses[]` (in `moderation/types.ts`, the type at lines ~36-71) becomes `{ seq; role; criterion?; dispute; resolution?; hidden?: { reason: string; by: string; at: number }; text?: string }` where `text` is ABSENT when `hidden` is present and `hidden` is emitted ONLY for a hidden response (so the existing `toEqual` assertions in `moderation/__tests__/read.test.ts` still hold); `openDisputes` (read.ts, cli.ts) excludes hidden responses. Update the `read.ts` ~line 91 comment ("no author names") to say the hide's author is the one name the DTO carries.

- [ ] **Step 1: Write failing tests**, each with a canary string `CANARY-HIDDEN-7731` in the hidden response's text:
  - `view-hide.test.ts`: `viewReport` for audience `released` has no canary in `JSON.stringify` of the result nor in the Markdown render; a visible response beside it still appears; **Review Focus 3:** hiding the only response yields no `responses` key (or an empty list) and renders without error; the group report has no `responses` key (a regression guard; group reports never carry responses).
  - **The critical path (Opus plan review C1):** `facilitator-export` case: release v1, respond with the canary, hide it, `amend`, release v2; then `exportedReport(exportTarget(role, "facilitator"), loaded)`, `exportedMarkdown(...)` and the JSON the CLI export writes (`JSON.stringify(scrubDeep(report))`, `review/export.ts`) contain no canary, and CLI `show` output has none. **Add a control:** the same flow WITHOUT the hide DOES contain the canary in that facilitator export (the test is then not vacuous). Review Focus 5 is this case plus the participant-audience read of v2.
  - `write-hide.test.ts` (at the `submitResponse` level): after a response is hidden, posting the identical text again returns `{ kind: "ok", wrote: true }` and the log gained one `response.added` (not the no-op); both caps are unchanged: 25 responses through one link then a hide, the next through the same link is `link_full`; 50 responses in the role then a hide, the next is `too_many`.
  - `read-hide.test.ts`: the DTO has `hidden: { reason, by, at }` and no `text` property for the hidden response, and no `hidden` key on a visible one; `openDisputes` omits a hidden dispute; the CLI status omits it.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.** In `viewReport` filter BOTH branches: `const responses = (a.audience === "released" ? liveResponses : sv.responses).filter((x) => x.hidden === null);` (view.ts ~177). This covers the participant page, the participant export, the facilitator export (`snapshotReport` reads `sv.responses` through `frozenView`) and CLI `show`. `frozenView` copies `hidden` unchanged. Do NOT assume the console avoids `viewReport`: `moderation/read.ts` and CLI `show` also call it with the facilitator audience. The console DTO is built from `sv.responses` in `read.ts`: emit `hidden` (with `at` from `ts`; `reason` and `by` through `t()`) and omit `text` for a hidden response. In the dedupe, add `r.hidden === null &&` to the `some` predicate. In `cli.ts` and `read.ts` `openDisputes`, add `!r.hidden`.
- [ ] **Step 4: Audit the other readers.** `grep -rn "\.responses\|response\.added" services/runtime/src services/control/src apps/web/src` (non-test); for each reader not listed above state in the commit message whether hidden text can pass it and why not. `report-md.ts` consumes the already-filtered report. Known consumers already checked by the Opus review: `ResponsesList.tsx`, `ReportView.tsx` (participant page, filtered at the source), `ResolveDisputePanel.tsx`, `SubjectList.tsx` (`openDisputes`, fixed through `read.ts`), `launcher-client.ts` (Task 4).
- [ ] **Step 5: Run** the three new files and `pnpm --filter @acr/runtime exec vitest run` → PASS.
- [ ] **Step 6: Commit** `[feat] US-0069: hidden responses never reach an export or page`.

### Task 3: The runtime write and the CLI (TASK-0144)

**Files:**
- Modify: `services/runtime/src/moderation/write-b.ts` (new `hideResponse`; and `resolveDispute` at ~196-214 refuses a hidden response), `moderation/index.ts` (export), `review/cli.ts` (HANDLERS `hide`, usage line, the `ALLOWED` map at ~111-127, the `ARITY` map at ~130-146, and `statusLines`)
- Test: `services/runtime/src/moderation/__tests__/hide.test.ts` (new), `review/__tests__/cli-hide.test.ts` (new)

**Interfaces:**
- Produces: `hideResponse(o: Base & { seq: number; reason: string }): Promise<void>`; CLI `hide <dir> <response-number> --reason <text> --by <name>`.
- Consumes: `applyCommand`, `actorOf`, `reasonOf`, `ReviewUsageError`, `ReviewRefusedError` as used by `resolveDispute` in the same file.

- [ ] **Step 1: Write failing tests:** `hideResponse` appends one `response.hidden` event whose actor is the facilitator `by`, `response` equals `seq`, reason is the cleaned reason; refusals (`ReviewRefusedError`): no such response ("there is no response with that number…"), already hidden; `ReviewUsageError`: non-integer or out-of-range `seq` (same range as resolve), an empty or whitespace-only reason (the write layer's `cleanText`/`reasonOf` trims and refuses; the fold does not); **Review Focus 4:** two sequential hides, second refused and exactly one event in the log; a hide on a superseded review directory is refused with code `superseded`. `resolveDispute` on a hidden dispute throws `ReviewRefusedError` ("that response is hidden, so there is nothing to resolve"), not an illegal-fold error. CLI tests: `hide` exits 0 and prints `response #N hidden`; a refusal exits non-zero with the message; the usage text lists `hide`; `status` prints one text-free line per response, `  response #N by <role>[ on <criterion>][ (dispute)][ hidden]`, so a plain comment's number can be found (check `cli-status-web.test.ts` and `cli.test.ts` for exact-output assertions before adding the lines and update them); `show` output of a report whose response is hidden has no canary.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** `hideResponse` mirroring `resolveDispute`: validate `seq` (integer 1 to 999_999_999) and reason (`reasonOf`); inside `applyCommand` find the response across `l.view.subjects`, refuse when missing or `found.r.hidden`, return `[{ actor, body: { type: "response.hidden", response: seq, reason } }]`. The usage error reads "hide needs the response number shown by status". In `resolveDispute`, after the `found` check add `if (found.r.hidden) throw new ReviewRefusedError("that response is hidden, so there is nothing to resolve");`. Wire the CLI handler beside `resolve` (value keys `["by", "reason"]`, one positional) and add the `status` response lines.
- [ ] **Step 4: Run** both files plus `pnpm --filter @acr/runtime exec vitest run` → PASS; coverage check `pnpm test:coverage` stays at or above 80%.
- [ ] **Step 5: Commit** `[feat] US-0069: hide command in the runtime and CLI`.

### Task 4: Control and the web BFF (TASK-0145)

**Files:**
- Modify: `services/control/src/moderation.ts` (`HideBody`, `Moderation.hide`), `services/control/src/moderation-routes.ts` (route `hide`, the `n === 4` condition at line 130)
- Modify: `apps/web/src/server/launcher-client.ts` (`reportHide`; `SubjectView.responses` type and its parser near lines 397 and 494), `apps/web/src/server/console-report-handlers.ts` (`handleConsoleReportHide`), `apps/web/src/server/routes.ts` (register), the Next route file that registers `handleConsoleReportResolve` (found with `grep -rn "report/resolve" apps/web/src/app`; add the sibling `hide` route)
- Modify: `apps/web/src/lib/console-api.ts` (`ReportResponse`, its parser near line 422, `hideResponse`)
- Test: `services/control/src/__tests__/moderation-hide.test.ts` (new), `apps/web/src/server/__tests__/console-report-handlers-hide.test.ts` (new), `apps/web/src/lib/__tests__/console-api-hide.test.ts` (new)

**Interfaces:**
- Produces: control `POST /api/v1/sessions/:id/report/hide { seq, reason, by }` (strict zod, same `By` and `MAX_TEXT_BODY_BYTES` as resolve); `Moderation.hide(id, { seq, reason }, name): Promise<ModOutcome<void>>`; BFF `POST .../report/hide { seq, reason, by }` via `write()` with `keys: ["seq", "reason"]`; `launcher.reportHide(id, { seq, reason, by }): Promise<void>`; console `hideResponse(sessionId, { seq, reason, by }, f?)`; `ReportResponse` gains `hidden?: { reason: string; by: string; at: number }` (`at` a finite number, checked by both parsers) and `text` becomes optional only when `hidden` is present (parsers refuse a hidden response that carries text, and a visible one without text). Models for the tests: the resolve cases in `moderation-routes.part-b-codes.test.ts`, `moderation-b.test.ts` and `moderation-routes.test.ts` (control), `console-report-handlers-b.test.ts` (BFF); the BFF Next route file is `apps/web/src/app/api/v1/console/sessions/[id]/report/resolve/route.ts` (add the sibling `hide/route.ts`); a hide on a superseded review answers 409 through control.
- Consumes: `hideResponse` (Task 3), the `write` helper, `postJson`, `reportPath`.

- [ ] **Step 1: Write failing tests:** control route returns the runtime's refusal codes unchanged and refuses an unknown key or a bad `seq` as the neutral invalid answer (copy `moderation-routes.test.ts` resolve cases); BFF handler refuses a body with extra keys, a non-integer `seq`, a missing reason; a cross-site write is refused as for resolve; `console-api` parser accepts a hidden response without text and rejects a hidden response WITH text; `reportHide` sends the body and closes on a malformed answer.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** by mirroring the resolve chain in each file; the launcher parser for `responses` accepts `hidden: { reason, by }` and then requires `text` absent.
- [ ] **Step 4: Run** the new files and `pnpm --filter @acr/control exec vitest run` and `pnpm --filter @acr/web exec vitest run src/server src/lib` → PASS.
- [ ] **Step 5: Commit** `[feat] US-0069: hide route in control and the web service`.

### Task 5: The console: responses list, Hide and the confirm dialog (TASK-0146)

**Files:**
- Create: `apps/web/src/components/console/report/ResponsesPanel.tsx` (lists ALL responses of the subject, not just open disputes), `HideResponseDialog.tsx`
- Modify: `apps/web/src/components/console/report/ReasonDialog.tsx` (an optional `maxLength?: number` prop: when set the textarea gets `maxLength` and a live "n of 500" counter with `aria-live="polite"`, as `SummaryEditor.tsx` does; Amend and Withdraw do not pass it and are unchanged)
- Modify: `apps/web/src/components/console/report/SubjectView.tsx` (render the panel beside `ResolveDisputePanel`, a `hide` runner like `resolve`), `apps/web/src/lib/messages.ts` (`REPORT_CONSOLE` strings)
- Test: `apps/web/src/components/console/report/__tests__/responses-hide.test.tsx` (new)

**Interfaces:**
- Produces: `ResponsesPanel({ responses: ReportResponse[]; canWrite: boolean; pending: boolean; criterionName: (id: string) => string; onHide: (seq: number, reason: string) => Promise<string | null> })`; `HideResponseDialog` wraps `ReasonDialog` (existing: `title`, `description`, `confirmLabel`, `tone`, `audienceIntro`, `audience`, `reasonLabel`, `name`, `pending`, `opener`, `error`, `onConfirm`, `onCancel`; plus the new `maxLength`, passed as 500) and passes the response text as the single `audience` line so the facilitator sees exactly what is being hidden (`tone: "danger"`, `confirmLabel: "Hide"`, description says it cannot be undone and the participant is not told).
- Consumes: `hideResponse` (Task 4), `ReasonDialog`, `ConfirmDialog`.

- [ ] **Step 1: Write failing tests:** every response (not only disputes) is listed with its criterion name; Hide opens the dialog showing the response text and an empty required reason; Confirm is disabled until the reason is non-empty; confirming calls `onHide(seq, reason)` once; a refusal keeps the dialog open with the typed reason and shows the sentence; focus returns to the Hide button on cancel; the counter shows "0 of 500" and updates, 501 characters cannot be typed, and the Amend and Withdraw dialogs render no counter; a hidden response renders "Hidden by facilitator", the reason, who and when (`at`), and NOT its text (canary assertion on the DOM); Hide is disabled with the existing cannot-write sentence when `canWrite` is false; **Review Focus 3:** no responses renders nothing; the buttons have accessible names that include the response number.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** the panel and dialog; text is rendered as text (React escaping, no markup). Wire `SubjectView`: `hide = (seq, reason) => run(hideResponse(sessionId, { seq, reason, by: name }))` with the same `run`/error-sentence handling as `resolve`; the open-disputes panel already excludes hidden responses (Task 2 DTO) so also filter `r.hidden === undefined` there.
- [ ] **Step 4: Run** the new file and `pnpm --filter @acr/web exec vitest run src/components/console` → PASS; typecheck `pnpm --filter @acr/web exec tsc --noEmit`.
- [ ] **Step 5: Commit** `[feat] US-0069: console responses list with a hide confirm dialog`.

### Task 6: End-to-end proof, documents and close-out (TASK-0146)

**Files:**
- Test: `services/control/src/__tests__/hide-response.e2e.test.ts` (new; model on `participant-writes.test.ts` and `moderation-b.test.ts`), `apps/web/e2e/` spec only if the existing console report specs make it a copy-and-adapt
- Modify: `docs/EVALUATOR.md` (a `hide` entry beside `resolve`, ~line 233), `docs/THREAT_MODEL.md` ("Participant ratings and responses": replace the "no redaction" sentence), `docs/ROLLBACK.md` (new "US-0069"), `docs/TEST_CASES.md`, `CHANGELOG.md` ([Unreleased] Added), `docs/RELEASE_PLAN.md` (US-0069 In Progress, tick AC-0392..AC-0395 with evidence, TASK-0144..0146, Notes), `docs/ID_REGISTRY.md` (already reserved in Task 1; confirm the rows), `progress.md`, `MEMORY.md`; regenerate with `npm run plan:generate`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the e2e test** (control with a real review dir): a participant posts a response through the link; the facilitator hides it through the route; the participant's report read and the participant export contain no canary; the facilitator export, taken AFTER an amend and a second release, contains none either (through the control export route; the Opus review's C1 path); the log still holds the `response.added` text and one `response.hidden` with `by` and `reason`; a second hide is refused; the caps are unchanged: post 25 through one link, hide one, the 26th through the same link is refused `link_full` (409); then with a reissued second link post up to 50 in all, hide one, and the 51st through a fresh link is refused `too_many`.
- [ ] **Step 2: Mutation checks:** state in TEST_CASES, for each, the one-line change and which test catches it: drop the `!x.hidden` filter in `viewReport`; filter only `liveResponses` and leave the facilitator branch `sv.responses` unfiltered (caught by the facilitator-export-after-amend test); null `hidden` in `frozenView`; remove the carry remap in `store.ts`; remove the dedupe `hidden === null` guard; let `dispute.resolved` accept a hidden response; send `text` for a hidden response in the DTO. Run each, confirm a test fails, revert.
- [ ] **Step 3: Documents.** ROLLBACK text: a runtime older than this change refuses a review log that contains `response.hidden`; roll back only before the first hide, or restore the log from before it; and an older web service refuses a console response without `text` (`launcher-client.ts` requires it), so that subject's console view would fail: roll the web app, control and runtime back together. THREAT_MODEL: what a hide does and does not do (text stays in the log; the participant is not told; a forwarded link can post again and be hidden again, the per-link cap still bounds it; the participant's "used N of 50" counter counts visible responses only). TEST_CASES: TC-0336..TC-0345 cover the fold, supersede carry, read paths (group report, Markdown, JSON), resend, CLI, control and BFF, console dialog, the e2e and the five mutations; every case with a result Pass except any that needs a real browser (mark Not Run, owner-run). Do not write the registry's next ids anywhere but `docs/ID_REGISTRY.md`'s table.
- [ ] **Step 4: Gates:** `npm run plan:generate`, `npm run plan:test`, `pnpm test` (root and workspaces), `pnpm --filter @acr/web exec tsc --noEmit`, coverage at or above 80%, `pnpm lint`; all PASS.
- [ ] **Step 5: Commit** `[docs] US-0069: tests, threat model, rollback and trackers`.

## Self-review

- **Spec coverage:** event and refusals (T1, T3); fold, caps, dispute rules, dedupe (T1, T2); single filter and group/Markdown/JSON paths (T2); console DTO without text (T2, T4); entry points CLI, control, BFF, console with confirm (T3, T4, T5); supersede carry (T1); documents and rollback (T6); Review Focus 1 to 5 mapped in the table above; spec section 8 (participant sees nothing, counter mismatch) is documentation in T6. No spec gap found.
- **Type consistency:** `ResponseView.hidden` (T1) is read by T2; the DTO `hidden: { reason, by }` and absent `text` (T2) is parsed by `launcher-client` and `console-api` (T4) and rendered by T5; `hideResponse` (T3) is called by `Moderation.hide` (T4); `ReportResponse.hidden` (T4) is the prop T5 reads.
- **Finding to confirm while building:** the console today lists only OPEN disputes (`ResolveDisputePanel`), not every response, so Task 5 adds a new list; the spec's "button beside each response" is satisfied by that list.
