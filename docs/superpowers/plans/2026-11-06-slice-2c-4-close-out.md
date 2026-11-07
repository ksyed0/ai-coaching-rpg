# Slice 2c-4: EPIC-0002 Close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish US-0060 (AC-0321, AC-0322) with an explicit, fail-closed AI-role guard and verified AI labels on the web, then add the console edit-summary control, a shorter credential id in the moderate CLI and the cheap deferred minors, so EPIC-0002 can be marked Complete.

**Architecture:** PR 1 adds one runtime reader (`aiRolesFromLog`) and one control dependency (`aiRoles`) that `createReportService` uses to refuse AI roles and to flag them in `links()`; the web side reads the flag as optional. PR 2 is independent polish on the console report files and the review fold. No evaluator, schema or existing-field changes.

**Tech Stack:** TypeScript, pnpm workspaces (`@acr/runtime`, `@acr/control`, `@acr/web`), Vitest, Next.js (webpack build), Playwright, Axe.

**Spec:** `docs/superpowers/specs/2026-11-06-slice-2c-4-close-out-design.md`. Where this plan differs from the spec (see "Deviations"), this plan wins; the spec gets a one-line pointer in Task 0. Revision 2 (applies the independent Opus review of revision 1).

## Global Constraints

- New refusal sentence, verbatim: `AI players do not get report links.` Constant name `AI_LINK_REFUSED` (not `AI_ROLE_REFUSED`: `services/control/src/supervisor.ts:62` already has that name for a different sentence and code). Copied in three places that must change together: `services/control/src/reports.ts`, `apps/web/src/lib/console-api.ts`, and `KNOWN_CONFLICTS` in `apps/web/src/server/report-handlers.ts` (the same rule as `NOT_READY` and `NO_REPORT`).
- Fail closed: an AI-role set that cannot be read, or a log the evaluator calls inconsistent, answers the existing `REPORTS_UNREADABLE` 503 (`reportsDown()`); it never issues a link. The `aiRoles` dependency of `createReportService` is **required**, never optional (a missing dependency would fail open).
- The only wire change is an **optional** `ai: true` on a `links()` role entry. A missing or malformed flag means "not AI" on the web. No required field is added anywhere (control deploys before web; rollback is the reverse).
- The credential id is shown as its **first 8 characters** in terminal output; the full id stays in `review.jsonl`.
- Edit-summary uses the existing route and its **16 KB** body cap (UTF-8 bytes of the JSON body), at most 50 items per list and 400 characters per item; no server changes.
- A minor is fixed only if it is under about 30 lines, has a test and changes no wire shape; otherwise it is filed as a BUG.
- New regexes over ids use `isSafeId` (the US-0020 id-rule guard failed on the last two slices).
- Commits: `[TYPE] ID: short imperative description (max 72 chars)`, ending with the attribution line the harness gives for the session. Types: feat, fix, test, docs, refactor, chore, style, perf.
- Coverage stays at or above 80%. No new dependencies. Strings from reports render as React text nodes, never HTML.

## Review Focus

Each line has a test in the task named in brackets.

1. The session log is missing, unreadable, or has an inconsistent AI record; the session list or a session id is corrupt: issue and reissue answer 503 and never mint a credential. [Task 3]
2. A stale live credential for an AI role: the role is listed with `ai: true`, offers no issue or reissue, and revoke still works. [Task 3, Task 4]
3. Old control answer with no `ai` flag, or a malformed one (`ai: "yes"`): the BFF drops it, the console renders and treats the role as not AI. [Task 4]
4. Role ids that are odd but valid (`__proto__`, `constructor`) must not confuse the AI-role lookup. [Task 3]
5. Edit-summary with all lists empty, an action line with no `LO-ID:`, an untouched actions box, and more than 16 KB: a fixed refusal sentence is shown, nothing is dropped from the existing summary, and what was typed stays. [Task 11]
6. A web actor whose credential id is shorter than 8 characters must not crash `moderate status`. [Task 7]

## Deviations from the spec (found while reading the code)

1. **No `history` command exists** in the moderate CLI, and `who()` (`fold.ts`) is reached only for facilitator comments, so it never renders a web actor. The credential-id item is therefore: the fold carries a short link id (`via`) on each self-rating and each response, and `moderate status` prints it. `who()` is left alone.
2. **The supervisor is not used for the AI-role set.** AI roles are frozen once `session.started` is written (`supervisor.ts:548-553`), so the session log is the one authoritative source for any session a link can be issued for. Control memoises a successful read per session (a stable log), and `links()` reads it only when a review exists or a live credential does.
3. **The "AI player, not scored" row is not added to the console subject list.** The data exists (the group draft records `ai_players.roles` and `index-view.ts` renders the row for `index.md`), so this is a scope cut, not a code constraint: it would add an optional field to the moderation overview and a row component. It is **pending owner sign-off**. Default if not reversed: Task 5 is a control-side test that an AI role is not an overview subject and cannot be exported, and "AI player" shows only on the link row of an AI role that still has a live credential.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `services/runtime/src/run-summary/log.ts` (+ `index.ts` export) | `aiRolesFromLog`: AI roles of a recorded session, `null` when unreadable or inconsistent | 2 |
| `services/control/src/ai-roles.ts` (new) | `aiRolesFor`: session id to AI roles or `null`, never throws | 3 |
| `services/control/src/reports.ts`, `main.ts` | `AI_LINK_REFUSED`, required `aiRoles` dependency, guard in `requireLinkable`, `ai` flag and memo in `links()` | 3 |
| `apps/web/src/lib/console-api.ts`, `apps/web/src/server/report-handlers.ts`, `apps/web/src/server/launcher-client.ts` | Sentence copy, optional `ai` flag through the BFF | 3, 4 |
| `apps/web/src/components/ReportLinksPanel.tsx` | "AI player" label, no issue or reissue for an AI role | 4 |
| `services/runtime/src/review/fold.ts`, `services/runtime/src/review/cli.ts` | `shortLinkId`, `via` on self-ratings and responses, status lines | 7 |
| `apps/web/src/components/console/report/{SubjectList,ReportPanel,SubjectView}.tsx`, `SummaryEditor.tsx` (new) | Withdraw, blockers, edit-summary section | 8, 11 |
| `apps/web/src/components/SelfRatingForm.tsx` | Whitespace-only note rule | 9 |
| `apps/web/src/lib/console-api.ts`, `apps/web/src/lib/messages.ts` | `editSummary` call, copy | 8, 11 |

---

## PR 1: AI-role guarantees (branch `feature/EPIC-0002-US-0060-ai-role-guarantees`, story US-0060)

### Task 0: Branches and ids

**Files:** Modify `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`; note in the spec.

- [ ] **Step 1:** Land this spec and plan on `develop` through a docs PR (or cherry-pick both files onto each feature branch); then create `feature/EPIC-0002-US-0060-ai-role-guarantees` from the current `origin/develop` tip.
- [ ] **Step 2:** Re-read `docs/ID_REGISTRY.md` and reserve, in one commit, from the next free ids (values below are the expected ones at 2026-11-06; use the registry's actual next free if it moved): story **US-0066** "EPIC-0002 close-out polish" (Priority Medium, Estimate M, Planned, under EPIC-0002); TASK-0103 (PR 1) and TASK-0104 (PR 2); ACs and TCs as follows, with the owner of each recorded in `RELEASE_PLAN.md`:
  - Under **US-0060**: AC-0379 an AI role is refused a report link, fail-closed, with the fixed sentence (TC-0145 Task 3 guard, TC-0146 Task 3 reader/wiring); AC-0380 a released report's "(AI player)" labels are present on the report page, print view and facilitator export (TC-0147 Task 1); AC-0381 `links()` keeps an AI role with a live credential revocable and an old control answer without the flag still renders (TC-0148 Tasks 4 and 5, TC-0149 Task 6).
  - Under **US-0066**: AC-0382 a facilitator can edit a participant's summary in the console (TC-0150 Task 11); AC-0383 `moderate status` shows the first 8 characters of a web link id (TC-0151 Task 7); AC-0384 the in-scope minors are fixed with tests and the rest are filed (TC-0152 Tasks 8 to 10).
  - Add a "Reserved blocks (2026-11-06, slice 2c-4)" paragraph in the registry's existing style.
- [ ] **Step 3:** Append to the spec's section 9: "Settled in the plan (revision 2): log-only AI-role source with a memo; no subject-list AI row pending owner sign-off; CLI work is the fold's `via` and `status`; AC-0379 to AC-0381 under US-0060, AC-0382 to AC-0384 under US-0066."
- [ ] **Step 4:** Run `npx jest tests/unit/id-registry.test.js`. Expected: 8 passed.
- [ ] **Step 5:** Commit `[docs] EPIC-0002: reserve ids for slice 2c-4`.

### Task 1: Pin that AI labels survive the page, print view and export (AC-0380, run first)

**Files:** Test `apps/web/src/components/__tests__/ReportView.ai-label.test.tsx`; Test `services/runtime/src/reports/__tests__/ai-label-export.test.ts`; Modify only if a test fails.

**Interfaces:** Consumes `readReleasedView` (`services/runtime/src/reports/index.ts`) and `exportReport` (`services/runtime/src/moderation/write-b.ts:367`, the facilitator's Markdown download, reached through `console-report-handlers.ts`). Fixtures: the AI-player fixtures in `services/runtime/src/review/__tests__/ai-players.test.ts` and `fixtures.ts`, and `makeReportWorld` in `services/control/src/__tests__/report-fixture.ts`.

- [ ] **Step 1: Write the tests.**
  - Runtime: `released group report keeps the (AI player) marker in readReleasedView markdown` and `... in the exportReport output`, for a released group report holding an `ai: true` quote.
  - Web: `ReportView renders "(AI player)" in a quote as text`, `the quote is not inside a .no-print element` (the print view is the same DOM, `window.print()` at `ReportView.tsx:142`), and `a <script> variant of the same quote renders as literal text and creates no element`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/reports/__tests__/ai-label-export.test.ts` and `pnpm --filter @acr/web exec vitest run src/components/__tests__/ReportView.ai-label.test.tsx`. PASS means the label half of AC-0321 already holds; FAIL means a path drops it.
- [ ] **Step 3:** If a test fails, fix that path only (no AI logic in `ReportView`; fix the renderer or exporter that dropped the text) and re-run until PASS; name the broken path in the commit body.
- [ ] **Step 4:** Commit `[test] US-0060: AI player labels survive the report page and export`.

### Task 2: `aiRolesFromLog` reader

**Files:** Modify `services/runtime/src/run-summary/log.ts`, `services/runtime/src/run-summary/index.ts`; Test `services/runtime/src/run-summary/__tests__/ai-roles-from-log.test.ts`.

**Interfaces:** Produces `aiRolesFromLog(logPath: string, scenarioDir: string): Promise<string[] | null>` exported from `@acr/runtime/run-summary`. Returns the AI roles in scenario order, `[]` when the log records none, and `null` when the log or scenario cannot be read or `aiRolesOf` returns `"invalid"`. Never throws.

- [ ] **Step 1: Write the failing tests** (reuse the fixtures of the `evaluationCallBoundFromLog` tests): `returns the AI roles of a log with aiRoles`, `returns [] when the log records none`, `returns null for an inconsistent record (aiRoles naming a non-player role)`, `returns null for two session.started events`, `returns null when the log file is missing`, `returns null when the scenario dir is missing`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/run-summary/__tests__/ai-roles-from-log.test.ts`. Expected: FAIL, not exported.
- [ ] **Step 3:** Implement beside `evaluationCallBoundFromLog` (`log.ts:21`), reading with `readSessionLog` and `loadScenario` as it does and mapping `"invalid"` to `null`. Export from `index.ts`.
- [ ] **Step 4:** Re-run the file. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0060: read a session's AI roles from its log`.

### Task 3: Control guard, wiring and `links()` flag

**Files:** Create `services/control/src/ai-roles.ts`; Modify `services/control/src/reports.ts`, `services/control/src/main.ts`, `apps/web/src/lib/console-api.ts`, `apps/web/src/server/report-handlers.ts`, `services/control/src/__tests__/reports.test.ts` (calls at lines 30, 87, 201, 216, 231, 242, 263, 376, 392), `services/control/src/__tests__/api.reports.test.ts` (lines 49, 109), `services/control/src/__tests__/main.test.ts` (lines 23, 72 wrap the factory; adjust only if typecheck fails); Test `services/control/src/__tests__/reports.ai-roles.test.ts`, `services/control/src/__tests__/ai-roles.test.ts`.

**Interfaces:**
- Consumes: `aiRolesFromLog` (Task 2).
- Produces: `export const AI_LINK_REFUSED = "AI players do not get report links."` in `reports.ts`; `aiRolesFor(config: Pick<ControlConfig, "sessionsDir" | "scenariosDir">, list: Pick<SessionList, "read">, sessionId: string): Promise<string[] | null>` in `ai-roles.ts` (validates the session id with the validator `report-access.ts` uses, finds the entry's `scenarioId` in `list.read()`, calls `aiRolesFromLog(<sessionsDir>/<id>.jsonl, scenarioDir(<scenariosDir>, scenarioId))`, catches everything and returns `null`); `createReportService` takes a **required** dependency `aiRoles: (sessionId: string) => Promise<string[] | null>`; each `links()` role entry gains optional `ai?: true`.

- [ ] **Step 1: Write the failing tests.**
  - `reports.ai-roles.test.ts` (fake `aiRoles`): `issue refuses a role that has a draft but is listed by aiRoles (inject ["alice"]) with AI_LINK_REFUSED and mints nothing`; the same for `reissue`; `issue and reissue answer 503 when aiRoles returns null`; `a lobby session with no review still answers NOT_READY, not 503, when aiRoles returns null` (the AI check runs after `reviewStatus`); `a human role with a draft is still issued a link`; `a role named __proto__ or constructor is not AI unless listed`; `revoke still works for an AI role with a live credential`; `links lists an AI role with a live credential as ai: true`, `links omits an AI role without a credential`, `links leaves human roles unchanged`; `links does not call aiRoles when there is no review and no live credential`; `aiRoles is read once per session across repeated links calls` and `a null result is not cached`.
  - `ai-roles.test.ts` (real temp dirs, no fakes for the reader): `returns null for a missing log`, `for an empty log`, `for a log with two session.started`, `for a missing scenario folder`, `for a corrupt sessions.json`, `for an invalid session id`; and `returns the roles for a valid ended session`.
  - In the existing `reports.test.ts`, change the two AI-role tests (about lines 85-91 and 293-297) to inject `["ai1"]` and expect `AI_LINK_REFUSED`; every other existing call passes `aiRoles: async () => []`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/reports.ai-roles.test.ts src/__tests__/ai-roles.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. In `requireLinkable` the order is: `reviewStatus` (none gives `NOT_READY`, unavailable gives `reportsDown()`), then the AI guard (`null` throws `reportsDown()`, a listed role throws `new ControlError("conflict", AI_LINK_REFUSED)`), then the released and draft lookups. In `links()` call `aiRoles` only when `st.kind === "found"` or a live credential exists; treat `null` as unknown (do not mark, do not hide). Memoise successful reads per session id in a `Map` capped at 64 entries (drop the oldest). Wire `aiRoles: (id) => aiRolesFor(config, list, id)` in `main.ts`.
- [ ] **Step 4:** Add the sentence to `console-api.ts` (next to `REPORT_NOT_READY`) and to `KNOWN_CONFLICTS` in `report-handlers.ts`; extend the existing sentence-equality test so the three copies stay equal.
- [ ] **Step 5:** Run `pnpm -r typecheck`, then the control tests `pnpm --filter @acr/control test` and `pnpm --filter @acr/web exec vitest run src/server`. Expected: PASS.
- [ ] **Step 6:** Commit `[feat] US-0060: refuse report links for AI roles, fail closed`.

### Task 4: Optional `ai` flag through the BFF to the console

**Files:** Modify `apps/web/src/server/launcher-client.ts` (`ReportLinkRow` and the links mapping near line 639), `apps/web/src/server/report-handlers.ts` (the links handler that rebuilds each role as `{ role, credential, selfRated, draft }`, near line 355), `apps/web/src/lib/console-api.ts` (`ReportLinkRole`, `parseReportLinks`), `apps/web/src/components/ReportLinksPanel.tsx`; Test `apps/web/src/server/__tests__/report-handlers.test.ts`, `apps/web/src/lib/__tests__/console-api.report-links-ai.test.ts`, `apps/web/src/components/__tests__/ReportLinksPanel.ai.test.tsx`.

**Interfaces:** Consumes control's optional `ai: true` (Task 3). Produces `ReportLinkRole` with `ai: boolean` (false unless the flag is exactly `true`); the BFF forwards `...(r.ai === true ? { ai: true } : {})`.

- [ ] **Step 1: Write the failing tests:** BFF links handler `forwards ai: true` and `drops ai: "yes" and a missing flag`; `parseReportLinks reads ai: true`, `treats a missing or "yes" ai as false`; panel: `shows "AI player" for an ai role and offers no "Issue link" or reissue button, only revoke`, `a human role row is unchanged`.
- [ ] **Step 2:** Run each new file with `pnpm --filter @acr/web exec vitest run <file>`. Expected: FAIL.
- [ ] **Step 3:** Implement the type, the parse, the BFF forwarding and the panel (copy in `lib/messages.ts`; "AI player" as text, not colour alone).
- [ ] **Step 4:** Re-run the three files plus `pnpm --filter @acr/web exec vitest run src/components/__tests__/ReportLinksPanel`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0060: mark AI roles on the console link list`.

### Task 5: An AI role is never a report subject or exportable (control side)

**Files:** Test `services/control/src/__tests__/moderation.ai-role-absent.test.ts`.

- [ ] **Step 1:** Using `makeReportWorld({ aiRoles: ["ai1"] })` from `report-fixture.ts`, write `the moderation overview has no ai1 subject` and `exporting ai1 is refused`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/moderation.ai-role-absent.test.ts`. Expected: PASS immediately (it pins existing behaviour; a failure is a bug to fix).
- [ ] **Step 3:** Commit `[test] US-0060: AI roles are never report subjects`.
- (If the owner reverses Deviation 3, replace this task with an optional overview field and a console row, with its own tests.)

### Task 6: e2e for an AI role and report links

**Files:** Create `apps/web/e2e/report-ai-role.spec.ts`; reuse `apps/web/e2e/helpers/console.ts` (`makeAiPlayer`) and the pattern in `apps/web/e2e/ai-players.spec.ts`.

- [ ] **Step 1:** Write one test: create a session, `makeAiPlayer` for a role in the lobby, start, end, `seedDraft` for the human roles, then POST the issue-link route for the AI role and expect the refusal sentence `AI players do not get report links.`; also assert the link list shows no "Issue link" for it.
- [ ] **Step 2:** Run it after `next build --webpack` with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` set to the installed Chromium 1223. Expected: pass.
- [ ] **Step 3:** If seeding turns out to need launcher work beyond a small helper change, skip, and record "AI-role e2e not added" under Known gaps in Task 6b.
- [ ] **Step 4:** Commit `[test] US-0060: e2e for AI roles and report links`.

### Task 6b: PR 1 documentation, gates and review

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** THREAT_MODEL: "AI roles in the credential path" (explicit refusal after the review check, fail-closed on an unreadable or inconsistent log, `links()` keeps a live credential revocable, and the availability cost: because the set is validated against the current scenario, an edited or removed scenario folder makes issue answer 503 for that session). ROLLBACK: the `ai` flag is optional, so rolling back control alone is safe. TEST_CASES: file TC-0145 to TC-0149 as in Task 0. RELEASE_PLAN: tick AC-0321, AC-0322 and AC-0379 to AC-0381 with pointers to the tests and mark **US-0060 Done**. CHANGELOG `[Unreleased]`, `progress.md` (a Session 32 entry with numbers and known gaps), `MEMORY.md`.
- [ ] **Step 2:** Run the gates: `pnpm -r typecheck`; `pnpm test:coverage` twice, the second under load (`yes > /dev/null` x8, then kill them); `pnpm --filter @acr/web exec next build --webpack`; Playwright with the installed Chromium (`report-moderation`, `report-release`, `report-access`, `ai-players`, `report-ai-role`, `axe`); `npm run plan:generate`; `npx jest tests/unit/id-registry.test.js`. Expected: all pass, coverage at or above 80%.
- [ ] **Step 3:** Run an independent review of the whole PR 1 diff (it touches the credential path): a fresh reviewer on the most capable model, given the diff and the spec, not this plan's conclusions. Fix Critical and Important findings; file Minor ones.
- [ ] **Step 4:** Commit `[docs] US-0060: close out the AI-role guarantees`, push, open the PR into `develop`, wait for green CI. Do not merge without the owner's say-so.

---

## PR 2: Console and CLI polish (branch `feature/EPIC-0002-US-0066-close-out-polish`, story US-0066, from `develop` after PR 1 merges)

### Task 7: Short web-link id in `moderate status` (AC-0383)

**Files:** Modify `services/runtime/src/review/fold.ts` (self-rating record near line 723, response record near line 749), `services/runtime/src/review/cli.ts` (`statusLines`, lines 155 to 183); Test `services/runtime/src/review/__tests__/cli-status-web.test.ts`, `services/runtime/src/review/__tests__/fold-participant-session.test.ts`, `services/runtime/src/moderation/__tests__` (the read-model mapping test).

**Interfaces:** Produces `export const shortLinkId = (id: string): string => id.slice(0, 8)` in `fold.ts`; `c.self.via: string | null` and `response.via: string | null` (short id when `e.actor.kind === "participant_session"`, else `null`). `who()` is unchanged.

- [ ] **Step 1: Write the failing tests:** fold: `a self.rated from a web link records via as the 8-character id`, `a facilitator-attested self.rated has via null`, `shortLinkId keeps ids of 8 characters or fewer whole`; CLI: `status appends " via web link <ids>" (the distinct short ids) to "<id>: rated N of M criteria"`, `appends " via web link <id>" to an open dispute from a web link`, `leaves facilitator-attested lines unchanged`, `does not throw for a web actor with a short id`; read model: `services/runtime/src/moderation/read.ts:148` still maps explicitly and sends no `via` over the wire.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/review/__tests__/cli-status-web.test.ts src/review/__tests__/fold-participant-session.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the fold fields and the status lines. The review log on disk is unchanged.
- [ ] **Step 4:** Run `pnpm --filter @acr/runtime exec vitest run src/review src/moderation`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0066: show a web link's short id in moderate status`.

### Task 8: Console minors, batch A (AC-0384)

**Files:** Modify `apps/web/src/components/console/report/SubjectList.tsx` (Withdraw on an amending row), `apps/web/src/components/console/report/ReportPanel.tsx` (blockers for a missing row), `apps/web/src/lib/messages.ts`; Test `apps/web/src/components/console/report/__tests__/lists.test.tsx`, `after-release.test.tsx`, `ReportPanel.test.tsx`.

- [ ] **Step 1: Write the failing tests:** `an amending row offers Withdraw`, `a released row still offers Amend and Withdraw`, `a withdrawn row offers neither`, `ReportPanel treats a subject with no status row as blocked and the release dialog lists it with the sentence REPORT_CONSOLE.blockerMissing`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `REPORT_CONSOLE.blockerMissing = "This report's status could not be read, so it cannot be released yet."` The server rules are unchanged.
- [ ] **Step 4:** Re-run `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: PASS. (The export menu already uses `REVOKE_AFTER_MS = 30_000` and `after-release.test.tsx` covers `saveMarkdown`; add an assertion on 30000 only if one is missing.)
- [ ] **Step 5:** Commit `[fix] US-0066: Withdraw on amending rows and fail-closed blockers`.

### Task 9: Console minors, batch B

**Files:** Modify `apps/web/src/components/SelfRatingForm.tsx` (line 85), `apps/web/e2e/axe.spec.ts`, `apps/web/src/lib/messages.ts`; Test `apps/web/src/components/__tests__/SelfRatingForm.test.tsx`.

- [ ] **Step 1: Write the failing tests:** `a whitespace-only note with no level is not blocking and is not sent`; `a real note with no level still blocks`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/SelfRatingForm.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Change the check at `SelfRatingForm.tsx:85` to `(ratings[c.id]?.note ?? "").trim() !== ""`. In `axe.spec.ts` change the intercepted throttled body's code from `throttled` to `rate_limited`. Delete `REPORT_CONSOLE.resolved` after a search shows nothing references it.
- [ ] **Step 4:** Run the test file and `pnpm -r typecheck`. Expected: PASS and clean.
- [ ] **Step 5:** Commit `[fix] US-0066: whitespace note rule, Axe fixture code, dead copy`.

### Task 10: Route tests for uncovered part B codes (capped)

**Files:** Test `services/control/src/__tests__/moderation-routes.part-b-codes.test.ts`.

- [ ] **Step 1:** List the `ModOutcome` codes that the part B routes (`release`, `resolve`, `export`, `amend`, `withdraw`) map to 409 or 503 in `services/control/src/moderation-routes.ts` and mark each one that no existing test reaches. That list is the whole scope.
- [ ] **Step 2:** Write one test per unmarked code asserting status and fixed body; run `pnpm --filter @acr/control exec vitest run src/__tests__/moderation-routes.part-b-codes.test.ts`. Expected: PASS (a failure is a bug: fix or file it).
- [ ] **Step 3:** Commit `[test] US-0066: route tests for part B 409 and 503 codes`.

### Task 11: Edit-summary section in the console (AC-0382; last, split into its own PR if it runs long)

**Files:** Create `apps/web/src/components/console/report/SummaryEditor.tsx`; Modify `apps/web/src/components/console/report/SubjectView.tsx`, `apps/web/src/lib/console-api.ts`, `apps/web/src/lib/messages.ts`; Test `apps/web/src/components/console/report/__tests__/SummaryEditor.test.tsx`, `apps/web/src/lib/__tests__/console-api.edit-summary.test.ts`.

**Interfaces:**
- Produces `editSummary(sessionId: string, subject: string, input: { reason: string; strengths: string[]; developments: string[]; actions: { lo: string; text: string }[]; by: string }, f?: typeof fetch): Promise<ApiResult<...>>`, posting to `/api/v1/console/sessions/:id/report/subjects/:subject/edit-summary` (shape per `ReportEditSummaryInput`, `launcher-client.ts:335`). Edit-summary **replaces the whole summary**, and an action is `{ lo, text }` on every layer (`moderation-routes.ts:39-41`, `write.ts:206-270`).
- `SummaryEditor` props: `{ sessionId: string; subject: string; author: string | null; summary: { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] }; editable: boolean; fetch?: typeof fetch; onChanged?: () => void }`.

- [ ] **Step 1: Write the failing tests:**
  - `editSummary posts strengths, developments, actions as {lo, text} and the reason`, and returns the parsed refusal sentence on a 4xx.
  - `SummaryEditor is not rendered when the subject is not editable`.
  - `all three boxes are pre-filled from the current summary` and `saving with only a new reason re-posts the existing entries unchanged` (nothing is dropped).
  - `Save is disabled without a valid author name and without a reason`.
  - `one entry per line: blank lines dropped; an actions line "LO-1: Do the thing: now" posts {lo: "LO-1", text: "Do the thing: now"} (split on the first colon)`.
  - `an actions line with no LO-ID: prefix is refused before sending with a fixed sentence`.
  - `all lists empty is refused before sending with a fixed sentence`.
  - `more than 50 items in a list, an item over 400 characters, or a JSON body over 16 KB (UTF-8 bytes via TextEncoder) is refused before sending`.
  - `a server refusal keeps what was typed and shows one fixed sentence`.
  - `every string renders as text` (an `<img onerror>` entry appears as literal text) and `labels and the error line have accessible names and are keyboard reachable`.
- [ ] **Step 2:** Run both files with `pnpm --filter @acr/web exec vitest run <file>`. Expected: FAIL.
- [ ] **Step 3:** Implement `editSummary` and `SummaryEditor` (one textarea per list, one entry per line, a required reason, no reordering, no inline editing), mount it in `SubjectView` under the criteria when the subject is editable, call `onChanged` on success, and add copy to `messages.ts`. Membership of an LO id in the report's objectives is checked by the server; the client shows its fixed refusal.
- [ ] **Step 4:** Re-run both files and `pnpm --filter @acr/web exec vitest run src/components/console/report`. Expected: PASS.
- [ ] **Step 5:** Add an Axe test for the new section in `apps/web/e2e/axe.spec.ts`. If `seedDraft` supports an editable subject, add one step to `report-moderation.spec.ts`; otherwise record it as a known gap.
- [ ] **Step 6:** Commit `[feat] US-0066: edit a participant's summary from the console`.

### Task 12: PR 2 close-out, filing leftovers and the epic

**Files:** Modify `docs/BUGS.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`, `docs/LESSONS.md`.

- [ ] **Step 1:** File one BUG each (next free ids, Severity Low, Open) for the six deferred items in spec section 4.3: resent response stored twice; forwarded link exhausting the 50 response slots and redaction; reviews before schema `/2` cannot take web writes; overview answers out of order and the first read never retrying; participant-view and amending-export menu entries; edits lost when a draft clears during a save.
- [ ] **Step 2:** In `RELEASE_PLAN.md` mark US-0066 Done with AC-0382 to AC-0384 ticked and **EPIC-0002 Complete**; update TEST_CASES (TC-0150 to TC-0152), the registry, THREAT_MODEL (the 8-character id in terminal output and why), CHANGELOG, `progress.md` (numbers and known gaps, including any skipped e2e), `MEMORY.md`, and `docs/LESSONS.md` if a lesson was learned.
- [ ] **Step 3:** Run the same gates as Task 6b Step 2. Expected: all pass.
- [ ] **Step 4:** Run the normal whole-branch review. Fix Critical and Important findings.
- [ ] **Step 5:** Commit `[docs] US-0066: close out EPIC-0002`, push, open the PR into `develop`, wait for green CI. Do not merge without the owner's say-so. The release (suggested v0.2.0, possibly after PR 1 alone) is the owner's decision and a separate step.
