# Slice 2c-4: EPIC-0002 Close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish US-0060 (AC-0321, AC-0322) with an explicit, fail-closed AI-role guard and verified AI labels on the web, then add the console edit-summary control, a shorter credential id in the moderate CLI and the cheap deferred minors, so EPIC-0002 can be marked Complete.

**Architecture:** PR 1 adds one runtime reader (`aiRolesFromLog`) and one control dependency (`aiRoles`) that `createReportService` uses to refuse AI roles and to flag them in `links()`; the web side reads the flag as optional. PR 2 is independent polish on the console report files and the review fold. No evaluator, schema or existing-field changes.

**Tech Stack:** TypeScript, pnpm workspaces (`@acr/runtime`, `@acr/control`, `@acr/web`), Vitest, Next.js (webpack build), Playwright, Axe.

**Spec:** `docs/superpowers/specs/2026-11-06-slice-2c-4-close-out-design.md`. Where this plan differs from the spec (see "Deviations"), this plan wins; the spec gets a one-line pointer in Task 0.

## Global Constraints

- New refusal sentence, verbatim: `AI players do not get report links.` Copied in three places that must change together: `services/control/src/reports.ts` (`AI_ROLE_REFUSED`), `apps/web/src/lib/console-api.ts`, and `KNOWN_CONFLICTS` in `apps/web/src/server/report-handlers.ts` (the same rule as `NOT_READY` and `NO_REPORT`).
- Fail closed: an AI-role set that cannot be read, or a log the evaluator calls inconsistent, answers the existing `REPORTS_UNREADABLE` 503 (`reportsDown()`); it never issues a link.
- The only wire change is an **optional** `ai: true` on a `links()` role entry. A missing flag means "not AI" on the web. No required field is added anywhere (control deploys before web; rollback is the reverse).
- The credential id is shown as its **first 8 characters** in terminal output; the full id stays in `review.jsonl` and is never shortened there.
- Edit-summary uses the existing route and its **16 KB** body cap; no server changes.
- A minor is fixed only if it is under about 30 lines, has a test and changes no wire shape; otherwise it is filed as a BUG.
- New regexes over ids use `isSafeId` (the US-0020 id-rule guard failed on the last two slices).
- Commits: `[TYPE] ID: short imperative description (max 72 chars)`, ending with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Types: feat, fix, test, docs, refactor, chore, style, perf.
- Coverage stays at or above 80%. No new dependencies. Strings from reports render as React text nodes, never HTML.

## Review Focus

Each line has a test in the task named in brackets.

1. The session log is missing, unreadable, or has an inconsistent AI record: issue and reissue answer 503 and never mint a credential. [Task 3]
2. A stale live credential for an AI role: the role is listed with `ai: true`, offers no issue or reissue, and revoke still works. [Task 3, Task 4]
3. Old control answer with no `ai` flag, or a malformed one (`ai: "yes"`): the console still renders and treats the role as not AI. [Task 4]
4. Role ids that are odd but valid (`__proto__`, `constructor`) must not confuse the AI-role lookup. [Task 3]
5. Edit-summary with all three lists empty, with a reason only, and with more than 16 KB: a fixed refusal sentence is shown and what was typed stays. [Task 11]
6. A web actor whose credential id is shorter than 8 characters or malformed must not crash `moderate status`. [Task 7]

## Deviations from the spec (found while reading the code)

1. **No `history` command exists** in the moderate CLI. The credential-id item becomes `status` plus the fold's `who()`; `who()` already prints the **full** credential id (`<role> (web link <id>)`), so the work is to shorten it, not to add it.
2. **The supervisor is not used for the AI-role set.** A report link needs a review, which only exists for an ended session, so the session log is always there and is the one authoritative source. Control memoises a successful read per session (the log is immutable once ended), which also answers the polling-cost concern.
3. **No "AI player, not scored" row is added to the console subject list.** `SubjectStatus` lists review subjects and an AI role has none; that row exists only in the Markdown `index.md`. The task is a negative test (an AI role never appears in the subject list or the export menu). In the console, "AI player" is shown only on the link row of an AI role that still has a live credential.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `services/runtime/src/run-summary/log.ts` (+ `index.ts` export) | `aiRolesFromLog`: AI roles of a recorded session, `null` when unreadable or inconsistent | 2 |
| `services/control/src/reports.ts` | `AI_ROLE_REFUSED`, `aiRoles` dependency, guard in `requireLinkable`, `ai` flag and memo in `links()` | 3 |
| `services/control/src/main.ts` | Wires `aiRoles` from the session list, scenarios dir and sessions dir | 3 |
| `apps/web/src/lib/console-api.ts`, `apps/web/src/server/report-handlers.ts`, `apps/web/src/server/launcher-client.ts` | Sentence copy, optional `ai` flag through the BFF | 3, 4 |
| `apps/web/src/components/console/ReportLinksPanel.tsx` | "AI player" label, no issue or reissue for an AI role | 4 |
| `services/runtime/src/review/fold.ts`, `services/runtime/src/review/cli.ts` | `shortLinkId`, `who()`, status lines | 7 |
| `apps/web/src/components/console/report/{SubjectList,ReportPanel,CriterionRow,SubjectView}.tsx`, `SummaryEditor.tsx` (new) | Minors and the edit-summary section | 8, 9, 11 |
| `apps/web/src/lib/console-api.ts`, `apps/web/src/lib/messages.ts` | `editSummary` call, copy | 11 |

---

## PR 1: AI-role guarantees (branch `feature/EPIC-0002-US-0060-ai-role-guarantees`, story US-0060)

### Task 0: Branches and ids

**Files:** Modify `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`; note in `docs/superpowers/specs/2026-11-06-slice-2c-4-close-out-design.md`.

- [ ] **Step 1:** Merge this docs branch (spec and plan) into `develop` through a docs PR, or cherry-pick both files onto each feature branch; then create `feature/EPIC-0002-US-0060-ai-role-guarantees` from the current `origin/develop` tip.
- [ ] **Step 2:** Re-read `docs/ID_REGISTRY.md`. Reserve, in one commit, from the next free ids: a new story US-0066 ("EPIC-0002 close-out polish", Priority Medium, Estimate M, Status Planned, under EPIC-0002), six acceptance criteria for the spec's section 7, TC ids for the tasks below, TASK-0103 (PR 1) and TASK-0104 (PR 2). Add a "Reserved blocks (2026-11-06, slice 2c-4)" paragraph in the registry's existing style.
- [ ] **Step 3:** Append to the spec's section 9 a line: "Settled in the plan: log-only AI-role source with a memo, no subject-list AI row, CLI work is `status` and `who()`."
- [ ] **Step 4:** Run `npx jest tests/unit/id-registry.test.js`. Expected: 8 passed.
- [ ] **Step 5:** Commit `[docs] EPIC-0002: reserve ids for slice 2c-4`.

### Task 1: Pin that AI labels survive the web (AC-0321, run first)

**Files:** Test `apps/web/src/components/__tests__/ReportView.ai-label.test.tsx`; Test `services/runtime/src/reports/__tests__/ai-label-export.test.ts`; Modify only if a test fails.

**Interfaces:** Consumes the existing released-view text from `readReleasedView` (`ReleasedView`) and the existing Markdown export builder used by the BFF download route (the implementer locates it from `apps/web/src/server/report-handlers.ts`).

- [ ] **Step 1: Write the failing-or-passing tests.**
  - `ReportView renders "(AI player)" in a quote on the page and in the print view`: render `ReportView` with a released group report whose text contains `"We should ship Friday" (AI player)`; assert the text is in the document and that no HTML element was created from it (use `container.querySelector("script")` null with a `<script>` variant of the same quote).
  - `released group report export keeps the (AI player) marker`: build the released view of a fixture review whose group report holds an `ai: true` quote and assert the exported Markdown contains `(AI player)`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/ReportView.ai-label.test.tsx` and `pnpm --filter @acr/runtime exec vitest run src/reports/__tests__/ai-label-export.test.ts`. Expected: PASS means AC-0321's label half already holds; FAIL means a path drops it.
- [ ] **Step 3:** If a test fails, fix that path only (no AI logic in `ReportView`; fix the renderer or the export builder that dropped the text) and re-run until PASS. Record in the commit body which path, if any, was broken.
- [ ] **Step 4:** Commit `[test] US-0060: AI player labels survive the report page and export`.

### Task 2: `aiRolesFromLog` reader

**Files:** Modify `services/runtime/src/run-summary/log.ts`, `services/runtime/src/run-summary/index.ts`; Test `services/runtime/src/run-summary/__tests__/ai-roles-from-log.test.ts`.

**Interfaces:**
- Produces: `aiRolesFromLog(logPath: string, scenarioDir: string): Promise<string[] | null>` exported from `@acr/runtime/run-summary`. Returns the AI roles in scenario order, `[]` for a log with none, and `null` when the log or scenario cannot be read or `aiRolesOf` returns `"invalid"`. Never throws.

- [ ] **Step 1: Write the failing tests** (use the fixtures the existing `evaluationCallBoundFromLog` tests use for a log and scenario dir): `returns the AI roles of a log with aiRoles`, `returns [] when the log records none`, `returns null for an inconsistent record (aiRoles naming a non-player role)`, `returns null when the log file is missing`, `returns null when the scenario dir is missing`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/run-summary/__tests__/ai-roles-from-log.test.ts`. Expected: FAIL, `aiRolesFromLog` is not exported.
- [ ] **Step 3:** Implement in `log.ts` beside `evaluationCallBoundFromLog`, reading with `readSessionLog` and `loadScenario` exactly as that function does and mapping `"invalid"` to `null`. Export from `index.ts`.
- [ ] **Step 4:** Re-run the test file. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0060: read a session's AI roles from its log`.

### Task 3: Control guard and `links()` flag

**Files:** Modify `services/control/src/reports.ts`, `services/control/src/main.ts`, `apps/web/src/lib/console-api.ts`, `apps/web/src/server/report-handlers.ts`; Test `services/control/src/__tests__/reports.ai-roles.test.ts`.

**Interfaces:**
- Consumes: `aiRolesFromLog` (Task 2).
- Produces: `export const AI_ROLE_REFUSED = "AI players do not get report links."`; `createReportService` takes a new dependency `aiRoles: (sessionId: string) => Promise<string[] | null>`; each `links()` role entry gains optional `ai?: true`.

- [ ] **Step 1: Write the failing tests** with a fake `aiRoles`:
  - `issue refuses an AI role with AI_ROLE_REFUSED before the report lookup` (the store must not be called; assert on a spy).
  - `reissue refuses an AI role the same way`.
  - `issue answers unavailable (503) when aiRoles returns null` and the store is not called.
  - `a human role with a draft is still issued a link`.
  - `a role named __proto__ or constructor is not treated as AI unless listed`.
  - `revoke still works for an AI role with a live credential`.
  - `links lists an AI role with a live credential as ai: true`, `links omits an AI role without a credential`, `links still lists human roles unchanged`.
  - `aiRoles is read once per session across repeated links calls` (memo), and `a null result is not cached` (a later successful read is used).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/reports.ai-roles.test.ts`. Expected: FAIL.
- [ ] **Step 3:** In `reports.ts`: add `AI_ROLE_REFUSED`; add the `aiRoles` dependency; in `requireLinkable` check the AI set first (`null` throws `reportsDown()`, a listed role throws `new ControlError("conflict", AI_ROLE_REFUSED)`), before the review lookup; in `links()` apply the AI set to the role list as above, treating a `null` set as "unknown, do not mark and do not hide" (the guard, not the display, protects); memoise successful reads per session id in a `Map` capped at 64 entries (drop the oldest).
- [ ] **Step 4:** Wire `aiRoles` in `main.ts` using `list.read()` to find the session's `scenarioId`, `path.join(config.sessionsDir, \`${id}.jsonl\`)` and `scenarioDir(config.scenariosDir, scenarioId)`, calling `aiRolesFromLog`; an unknown session returns `null`.
- [ ] **Step 5:** Add the sentence to `apps/web/src/lib/console-api.ts` (next to `REPORT_NOT_READY`) and to `KNOWN_CONFLICTS` in `apps/web/src/server/report-handlers.ts`; extend the existing sentence-equality test (BUG-0027 area) or add one assertion per copy so the three strings stay equal.
- [ ] **Step 6:** Re-run the control test file and `pnpm --filter @acr/web exec vitest run src/server`. Expected: PASS.
- [ ] **Step 7:** Commit `[feat] US-0060: refuse report links for AI roles, fail closed`.

### Task 4: Optional `ai` flag through the BFF to the console

**Files:** Modify `apps/web/src/server/launcher-client.ts` (`ReportLinkRow`, the `links` mapping near line 639), `apps/web/src/lib/console-api.ts` (`ReportLinkRole`, `parseReportLinks`), `apps/web/src/components/console/ReportLinksPanel.tsx`; Test `apps/web/src/lib/__tests__/console-api.report-links-ai.test.ts`, `apps/web/src/components/console/__tests__/ReportLinksPanel.ai.test.tsx`.

**Interfaces:**
- Consumes: control's optional `ai: true` (Task 3).
- Produces: `ReportLinkRole` gains `ai: boolean` (false when the flag is missing or not exactly `true`).

- [ ] **Step 1: Write the failing tests:** `parseReportLinks reads ai: true`, `parseReportLinks treats a missing ai as false`, `parseReportLinks treats ai: "yes" as false`, `the panel shows "AI player" for an ai role and offers no Create link or Reissue button, only Revoke`, `a human role row is unchanged`.
- [ ] **Step 2:** Run both new test files with `pnpm --filter @acr/web exec vitest run <file>`. Expected: FAIL.
- [ ] **Step 3:** Implement the type, the parse (`r.ai === true`), pass the flag through `launcher-client.ts`, and render the label and the action restrictions in `ReportLinksPanel.tsx` (copy lives in `lib/messages.ts`; the label text is `AI player`, shown as text, not colour alone).
- [ ] **Step 4:** Re-run the two files plus `pnpm --filter @acr/web exec vitest run src/components/console`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0060: mark AI roles on the console link list`.

### Task 5: AI roles never appear as report subjects or exports

**Files:** Test `apps/web/src/components/console/report/__tests__/ai-role-absent.test.tsx`.

- [ ] **Step 1:** Write `SubjectList and ExportMenu never show an AI role`: render both with an overview whose subjects are the human roles and `group` only (an AI role is never a subject) and assert no "AI player" row, no action for it, and no export entry for it; add the same assertion against the control `overview` fixture to document that an AI role has no subject.
- [ ] **Step 2:** Run it. Expected: PASS immediately (this pins existing behaviour; if it fails, the console invents an AI subject and that is a bug to fix in the component).
- [ ] **Step 3:** Commit `[test] US-0060: AI roles are never report subjects in the console`.

### Task 6: Optional e2e (skip if seeding is not cheap)

**Files:** Modify `apps/web/e2e/report-moderation.spec.ts` or add `apps/web/e2e/report-ai-role.spec.ts`.

- [ ] **Step 1:** Check whether the e2e seeder can start a session with `aiRoles` in `session.started` without new launcher work (read the e2e helpers). If it needs more than about an hour, skip to Step 3.
- [ ] **Step 2:** Add one test: a session with an AI role, ended and evaluated with `seedDraft`, shows the link list without a Create link for the AI role, and a direct `POST` of the issue route for that role is refused with `AI players do not get report links.`
- [ ] **Step 3:** If skipped, record "AI-role e2e not added: seeding an AI session needs launcher work" under Known gaps in the Task 12 docs.
- [ ] **Step 4:** Commit `[test] US-0060: e2e for AI roles and report links` (only if added).

### Task 6b: PR 1 documentation, gates and review

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** THREAT_MODEL: add "AI roles in the credential path" (explicit refusal, fail-closed on an unreadable or inconsistent log, `links()` keeps a live credential revocable). ROLLBACK: the `ai` flag is optional, so rolling back control alone is safe. TEST_CASES: file the TCs for Tasks 1 to 5. RELEASE_PLAN: tick AC-0321 and AC-0322 with a pointer to the tests; keep US-0060 In Progress until PR 2 merges only if any criterion is open, otherwise mark it Done. CHANGELOG `[Unreleased]`: one line for the guard and the label tests. `progress.md`: a Session 32 entry with the verification numbers.
- [ ] **Step 2:** Run the gates: `pnpm -r typecheck`; `pnpm test:coverage` twice, the second under load (`yes > /dev/null` x8, then kill them); `pnpm --filter @acr/web exec next build --webpack`; the affected Playwright specs with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set to the installed Chromium 1223 (`report-moderation`, `report-release`, `axe`, plus the new spec if added); `npm run plan:generate`; `npx jest tests/unit/id-registry.test.js`. Expected: all pass, coverage at or above 80%.
- [ ] **Step 3:** Run an independent review of the whole PR 1 diff (the credential path): a fresh reviewer on the most capable model, given the diff and the spec, not this plan's conclusions. Fix Critical and Important findings; file Minor ones.
- [ ] **Step 4:** Commit `[docs] US-0060: close out the AI-role guarantees`, push, open the PR into `develop`, and wait for green CI. Do not merge without the owner's say-so.

---

## PR 2: Console and CLI polish (branch `feature/EPIC-0002-US-0066-close-out-polish`, story US-0066, from `develop` after PR 1 merges)

### Task 7: Shorter credential id in the moderate CLI

**Files:** Modify `services/runtime/src/review/fold.ts` (`who`, around line 134) and `services/runtime/src/review/cli.ts` (`statusLines`, around lines 160 to 181); Test `services/runtime/src/review/__tests__/fold-participant-session.test.ts` (update the `who()` test), `services/runtime/src/review/__tests__/cli-status-web.test.ts` (new).

**Interfaces:**
- Produces: `export const shortLinkId = (id: string): string => id.slice(0, 8)` in `fold.ts`; `who()` renders `<role> (web link <shortLinkId(id)>)`.

- [ ] **Step 1: Write the failing tests:** update the existing test to expect `alice (web link AAAAAAAA)` for a longer id; add `shortLinkId keeps ids of 8 characters or fewer whole`; in `cli-status-web.test.ts`, `status prints "rated via web link <8>" for a subject whose latest self-rating came from a web link`, `status prints "open dispute: #<n> by <role> via web link <8>" for a dispute response from a web link`, `status for a facilitator-attested rating is unchanged`, and `status does not throw for a web actor with a short id`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/fold-participant-session.test.ts src/review/__tests__/cli-status-web.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `shortLinkId` and the `who()` change. Where the fold records `self.rated` and `response.added`, keep the actor's web link id (short form) on the subject's response record and on the latest self-rating (a field `via: string | null`, `null` for a facilitator-attested event), and have `statusLines` append `via web link <id>` to the matching lines. The review log on disk is not changed.
- [ ] **Step 4:** Re-run the files and the whole review suite `pnpm --filter @acr/runtime exec vitest run src/review`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0066: show a web link's short id in moderate status`.

### Task 8: Console minors, batch A (fail-closed and Withdraw)

**Files:** Modify `apps/web/src/components/console/report/SubjectList.tsx` (Withdraw on an amending row), `apps/web/src/components/console/report/ReportPanel.tsx` (blockers for a missing row); Test the matching `__tests__` files in `apps/web/src/components/console/report/__tests__/`.

- [ ] **Step 1: Write the failing tests:** `an amending row offers Withdraw`, `a released row still offers Amend and Withdraw`, `a withdrawn row offers neither`, `ReportPanel treats a subject with no status row as blocked and the release dialog lists it as blocked`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement both changes (each under about 30 lines). The server rules are unchanged: it already allows withdraw while amending and refuses a blocked release.
- [ ] **Step 4:** Re-run `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: PASS.
- [ ] **Step 5:** Check the Blob URL revoke in `ExportMenu.tsx`. If it already waits 30 seconds, add a one-line test `revokes the object URL after 30 seconds, not immediately` using fake timers; if not, change it to 30 000 ms with that test.
- [ ] **Step 6:** Commit `[fix] US-0066: Withdraw on amending rows and fail-closed blockers`.

### Task 9: Console minors, batch B (save rule, fixtures, dead copy)

**Files:** Modify `apps/web/src/components/console/report/CriterionRow.tsx`, `apps/web/e2e/axe.spec.ts`, `apps/web/src/lib/messages.ts`; Test `apps/web/src/components/console/report/__tests__/CriterionRow.test.tsx`.

- [ ] **Step 1: Write the failing test:** `a whitespace-only rationale with no level does not block saving` (the row treats it as absent, as the server does) and `a whitespace-only rationale with a level is trimmed and saved`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement the trim in the save-enable rule. In `axe.spec.ts` change the intercepted throttled body's code from `throttled` to `rate_limited`. Delete `REPORT_CONSOLE.resolved` after confirming with a search that nothing references it.
- [ ] **Step 4:** Run the component test, then `pnpm -r typecheck` (the removal must not break anything). Expected: PASS and clean.
- [ ] **Step 5:** Commit `[fix] US-0066: whitespace note rule, Axe fixture code, dead copy`.

### Task 10: Route tests for uncovered part B codes (capped)

**Files:** Test `services/control/src/__tests__/moderation-routes.part-b-codes.test.ts`.

- [ ] **Step 1:** List the `ModOutcome` codes that the part B routes (`release`, `resolve`, `export`, `amend`, `withdraw`) map to 409 or 503 in `services/control/src/moderation-routes.ts`; mark each one no existing test reaches. That list is the whole scope; stop there.
- [ ] **Step 2:** Write one test per unmarked code asserting the status and the fixed body; run `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-routes.part-b-codes.test.ts`. Expected: PASS (the behaviour exists; if one fails it is a bug, fix or file it).
- [ ] **Step 3:** Commit `[test] US-0066: route tests for part B 409 and 503 codes`.

### Task 11: Edit-summary section in the console (last; split into its own PR if it runs long)

**Files:** Create `apps/web/src/components/console/report/SummaryEditor.tsx`; Modify `apps/web/src/components/console/report/SubjectView.tsx`, `apps/web/src/lib/console-api.ts`, `apps/web/src/lib/messages.ts`; Test `apps/web/src/components/console/report/__tests__/SummaryEditor.test.tsx`, `apps/web/src/lib/__tests__/console-api.edit-summary.test.ts`.

**Interfaces:**
- Produces: `editSummary(sessionId: string, subject: string, input: { reason: string; strengths: string[]; developments: string[]; actions: string[]; by: string }, f?: typeof fetch): Promise<ApiResult<...>>` in `console-api.ts`, posting to `/api/v1/console/sessions/:id/report/subjects/:subject/edit-summary` (the existing BFF route; shape per `ReportEditSummaryInput` in `launcher-client.ts`).
- `SummaryEditor` props: `{ sessionId: string; subject: string; author: string | null; summary: { strengths: string[]; developments: string[]; actions: string[] }; editable: boolean; fetch?: typeof fetch; onChanged?: () => void }`.

- [ ] **Step 1: Write the failing tests:**
  - `editSummary posts the lists and the reason and returns the parsed refusal sentence on a 4xx`.
  - `SummaryEditor is not rendered when the subject is not editable`.
  - `Save is disabled without a valid author name and without a reason`.
  - `one entry per line: a three-line strengths box posts three strings, blank lines dropped`.
  - `all three lists empty with a reason posts empty lists` (and shows the server's refusal sentence if refused).
  - `a refusal keeps what was typed and shows one fixed sentence`.
  - `a body over 16 KB is refused before sending with a fixed sentence`.
  - `every string from the summary renders as text` (a `<img onerror>` entry appears as literal text).
  - `labels and the error line are reachable by keyboard and have accessible names`.
- [ ] **Step 2:** Run both new files with `pnpm --filter @acr/web exec vitest run <file>`. Expected: FAIL.
- [ ] **Step 3:** Implement `editSummary` and `SummaryEditor` (one textarea per list, one entry per line, a required reason field, no reordering, no inline editing), mount it in `SubjectView` under the criteria when the subject is editable, call `onChanged` on success so the panel refreshes, and add copy to `messages.ts`.
- [ ] **Step 4:** Re-run the two files and `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: PASS.
- [ ] **Step 5:** Add an Axe test for the new section in `apps/web/e2e/axe.spec.ts` (render with a seeded editable subject). If the e2e seed supports it, add one step to `report-moderation.spec.ts` editing a summary; otherwise record it as a known gap.
- [ ] **Step 6:** Commit `[feat] US-0066: edit a participant's summary from the console`.

### Task 12: PR 2 close-out, filing leftovers and the epic

**Files:** Modify `docs/BUGS.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`, `docs/LESSONS.md`.

- [ ] **Step 1:** File one BUG each (next free ids, Severity Low unless noted, Status Open) for the six deferred items in the spec's section 4.3: resent response stored twice; forwarded link exhausting the 50 response slots and redaction; reviews before schema `/2` cannot take web writes; overview answers out of order and the first read never retrying; participant-view and amending-export menu entries; edits lost when a draft clears during a save.
- [ ] **Step 2:** Mark US-0066 Done with its criteria ticked, US-0060 Done, and EPIC-0002 Complete in `docs/RELEASE_PLAN.md`; update TEST_CASES, the registry, THREAT_MODEL (the 8-character id in terminal output and why), CHANGELOG, `progress.md` (Session entry with numbers, known gaps including any skipped e2e), `MEMORY.md` and `docs/LESSONS.md` if a lesson was learned.
- [ ] **Step 3:** Run the same gates as Task 6b Step 2. Expected: all pass.
- [ ] **Step 4:** Run the normal whole-branch review. Fix Critical and Important findings.
- [ ] **Step 5:** Commit `[docs] US-0066: close out EPIC-0002`, push, open the PR into `develop`, wait for green CI. Do not merge without the owner's say-so. The release (suggested v0.2.0, possibly after PR 1 alone) is the owner's decision and a separate step.
