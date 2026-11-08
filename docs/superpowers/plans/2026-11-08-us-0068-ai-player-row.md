# US-0068: "AI player, not scored" row in the console report list — implementation plan

> Story: US-0068 (EPIC-0002, Low, S), AC-0389 to AC-0391. Task: TASK-0105. Test cases: TC-0158 to TC-0160. Branch: `feature/EPIC-0002-US-0068-ai-player-row`, cut from `develop`.
> Origin: the owner's 2026-11-06 decision on Deviation 3 of slice 2c-4 (`docs/superpowers/specs/2026-11-06-slice-2c-4-close-out-design.md`, section 3.4): the list gets the row, as a follow-up.
> Execution: subagent-driven or inline, TDD per task (write the failing test, see it fail for the stated reason, then the code). One PR; no merge without green CI.

> **Revision 2026-11-08 (independent Opus review, 14 findings, all accepted).** Section 6 lists each amendment; where it conflicts with sections 2 and 3, **section 6 wins** and the body below has been edited to match.

## 1. Goal and the facts the plan rests on

After the session the console's Report panel lists one row per subject (each human role and the group). An AI-filled role has no report (the evaluator writes none for it), so it is simply absent, and a facilitator cannot tell "missing" from "not scored on purpose". Add one read-only row per AI-filled role that says so.

Verified in the code on `develop` (7834ca2):

- The list is `SubjectList` (`apps/web/src/components/console/report/SubjectList.tsx`), fed by `overview.subjects` from `ReportPanel`. Subjects come from the runtime's `moderationStatus` (`SubjectStatus`), which has no entry for an AI role.
- The overview travels runtime fold -> control `ModerationService.overview()` (`services/control/src/moderation.ts`, type `Overview`) -> web `toOverview()` in `apps/web/src/server/launcher-client.ts` (a strict parser: **only fields it names reach the browser**; `console-report-handlers.ts` forwards its output unchanged) -> browser `parseReportOverview()` in `apps/web/src/lib/console-api.ts` -> `ReportPanel`.
- The trusted AI-role source already exists: `aiRolesFor(config, list, id)` in `services/control/src/ai-roles.ts` (reads the session's own log against its scenario; `null` for anything unreadable or inconsistent; never throws). The link guard (US-0060) uses it, wired in `services/control/src/main.ts:75`. `ModerationService` is built at `main.ts:93` with `{ config, jobs, secrets }` and has no such dependency yet.
- The Markdown index already renders the AI row from the group draft's `ai_players.roles`; this plan deliberately does not use the draft (it is a copy of the evaluator's view, and the log is the source the link guard trusts, so both screens agree).

## 2. Design

| Question | Decision | Why |
| --- | --- | --- |
| Where does the data live? | An OPTIONAL `aiRoles: string[]` on the moderation overview, set only at stage `in_review`. | AC-0390. The subject list only exists in that stage. |
| Source | `ModerationService` gets an optional dependency `aiRoles?: (sessionId) => Promise<string[] \| null>`, wired in `main.ts` to the same `aiRolesFor` the link service uses. | One source of truth, no second reader of the log; optional so every existing test and caller still builds. |
| Unknown (`null`, absent dependency, a throw, a malformed list) | Omit the field at every layer. Control emits it only for an array of `isFileSafeId` strings, at most 64, no duplicates; the BFF and the browser DROP a malformed `aiRoles` (no rows) instead of failing the overview. | Display only; failing quiet is right. A malformed field must never take the Report panel down (the BFF's `bad()` would be a 502 and the browser's null parse the whole-panel `unreadable` banner). Scenario role ids can exceed 64 characters, so control cannot assume the BFF's rule holds. |
| Older control / older web | Older control: no field, web shows no rows. Older web: its strict parser ignores the unknown field. | AC-0390. Deploy control first so the field exists when web asks. |
| Row content | Role label (via `roleLabel`), the pill `MESSAGES.reportAiPlayer` ("AI player", class `pill ai`, as elsewhere in the console) and the small text "not scored (no report is written for an AI player)" held in `REPORT_CONSOLE`, so the row reads "AI player, not scored" as AC-0389 words it. No buttons, no export entry, not selectable, not counted in open items or the release bar. | AC-0389. |
| Placement | After the subject rows (so after "Group"), in the order control returns (scenario role order, not log order), own `<li>` with the same `code-row` styling. | Keeps the scored rows first. |
| Safety checks | The browser and BFF accept only file-safe ids (the existing `isFileSafeId`), at most 64 entries, no duplicates; a role that is also a subject row gets no AI row. | Defence in depth; a malformed list makes the parser return `bad()` like any other malformed field. |
| Accessibility | The meaning is in words; the pill is not colour only (`pill ai` plus text); the row is a list item with no interactive control. | AC-0391. |

Out of scope: any change to the review, the fold, exports, the runtime, the wire version, or the link panel's existing "AI player" label.

## 3. Tasks

### Task 1 — Control: `aiRoles` on the overview (TC-0158)

Files: `services/control/src/moderation.ts`, `services/control/src/main.ts`, `services/control/src/__tests__/moderation*.test.ts` (use the existing overview tests' fixtures).

1. Failing tests first: (a) `in_review` overview includes `aiRoles` from the injected function; (b) a function returning `null`, one that throws, and no function at all each leave the field out; (c) other stages (`not_ended`, `not_evaluated`, `evaluating`, `failed`, `ready_to_open`) never carry it and never call the function; (d) the function receives the session id; (e) a non-array, a non-string, an unsafe id, a duplicate and 65 entries each omit the field (mirror `readAiRoles` in `services/control/src/reports.ts:74-79`). Run `summary()` and the AI-roles lookup with `Promise.all`.
2. Add the optional `aiRoles?: string[]` to `Overview` and the optional dependency to the service options; fill it in the `in_review` branch next to `summary`, inside the existing `guard`, with a local try/catch so a throw cannot fail the overview.
3. Wire `aiRoles: (id) => aiRolesFor(config, list, id)` at `main.ts:93`, with the same `list` the link service gets.
4. Run: `pnpm --filter @acr/control test`, `pnpm -r typecheck`.

### Task 2 — BFF: parse and forward the field (TC-0158 continued)

Files: `apps/web/src/server/launcher-client.ts` (`ReportOverview`, `toOverview`), `apps/web/src/server/__tests__/console-report-handlers.test.ts`.

1. Failing tests: a control answer with `aiRoles: ["ai1"]` is forwarded; an answer without the field is forwarded unchanged (no `aiRoles` key); a non-array, a non-string entry, an unsafe id, a duplicate and 65 entries each yield an overview WITHOUT the field (the rest of the overview is still forwarded); the existing "extra fields dropped" test (`console-report-handlers.test.ts` ~:272) already proves an older web ignores the field. Tests live in `apps/web/src/server/__tests__/console-report-handlers.test.ts` (`OVERVIEW` fixture ~:46), not `launcher-client.test.ts`.
2. Implement with the existing helpers (`isStr`, `isFileSafeId`) but with a local validator that returns `undefined` instead of calling `bad()`; add `aiRoles?: string[]` to `ReportOverview`; include it in the result only when present.

### Task 3 — Browser: parse the field (TC-0159)

Files: `apps/web/src/lib/console-api.ts` (`ReportOverviewView`, `parseReportOverview`), the new test file above, `components/console/report/__tests__/fixtures.ts` (add `aiRoles: []` to the overview fixture).

1. Failing tests: absent -> `aiRoles: []`; present and valid -> kept in order; the same malformed cases give `aiRoles: []` and a valid overview (never `null`). Put the tests in a new `apps/web/src/lib/__tests__/console-api.report-overview.test.ts` (no existing test file covers `parseReportOverview` directly).
2. Implement; the view type always carries `aiRoles: string[]` (empty by default) so components never branch on undefined.

### Task 4 — The row component (TC-0159)

Files: `apps/web/src/components/console/report/SubjectList.tsx` (new `aiRoles?: string[]` prop), `ReportPanel.tsx` (pass `overview.aiRoles`), `__tests__/lists.test.tsx`, `__tests__/ReportPanel.test.tsx`, `__tests__/fixtures.ts`.

1. Failing tests: one AI row per listed role, after the subject rows, with the role label, the words "AI player" and "Not scored"; it has no button, no Review/Amend/Withdraw/Export, is not selectable; `openItems`, the release bar and the export menu are unchanged by it; a listed role that is also a subject renders only its subject row; an empty or absent list renders nothing extra; a ReportPanel render with `aiRoles: ["ai1"]` shows the row beside a human subject.
2. Implement the row (`<li className="code-row">`, `<span className="code-role">`, `<span className="pill mut">AI player</span>`, `<span className="small">Not scored: an AI player has no report.</span>`). The pill text is `MESSAGES.reportAiPlayer`; the sentence lives once in `REPORT_CONSOLE` (`apps/web/src/lib/messages.ts`). Use a realistic role id in component tests (`tech_lead`, "Tech lead"; `ai1` labels as "Ai1") and exact-text queries ("AI player" would match two elements under a regex). The assertions that `openItems`, the release bar and the export menu are unchanged, and that nothing is called outside `in_review`, pass before the code exists: keep them as regression guards. The tests that must FAIL first are: Task 1 (a),(d),(e); BFF present -> forwarded; browser absent -> `[]`, present -> kept; the row renders; the dedupe.

### Task 5 — Accessibility check (TC-0160)

File: `apps/web/e2e/axe.spec.ts` (~:239-268). That in_review case runs the REAL launcher stack with all roles human, so the overview carries no AI role and nothing intercepts it (the only `.route(` calls are on the participant `/api/v1/report*` endpoints).

1. In that case, after `seedDraft`, add `fac.route("**/api/v1/console/sessions/*/report", ...)` that fetches the real answer and fulfils it with `data.aiRoles = ["tech_lead"]` added (the glob must not catch `/report-links` or `/report/subjects/...`), then `fac.reload()`; alternatively run Axe inside `report-ai-role.spec.ts` where `tech_lead` really is an AI role. Run Axe on the Report panel with that row; run Axe on the Report panel; assert zero violations and that the row text is visible.
2. Run after `next build --webpack`: `pnpm --filter @acr/web exec playwright test axe --trace off`, with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` as in earlier sessions.

### Task 6 — End to end (TC-0158, real stack; MANDATORY)

This is the only test of the `main.ts` wiring. `apps/web/e2e/report-ai-role.spec.ts` already reaches an opened review (the human `issue` succeeds, which needs a live review, ~:96-101); `report-moderation.spec.ts` ~:62-69 shows a seeded review reaching `in_review` in the console. After `seedDraft`, call `fac.reload()` (the panel polls only while `evaluating`), then assert the "Tech lead" AI row and that there is no "Review Tech lead" button. If this proves impossible, add a `main.test.ts` wiring test instead and say so in the PR; do not drop both.

### Task 7 — Documents and close-out

- `docs/RELEASE_PLAN.md`: TASK-0105 (Dev, Agent, branch above); tick AC-0389 to AC-0391 when verified; US-0068 Complete only after the PR merges; update the EPIC-0002 note (the row exists).
- `docs/TEST_CASES.md`: TC-0158 (positive: control, BFF and browser carry the field, the real stack shows the row), TC-0159 (the row component and parse), TC-0160 (Axe), **TC-0161 (negative and edge: null, a throw, no dependency, a malformed or oversized list, other stages, an older web, a role that is also a subject: no field and no row, the panel intact)**. `docs/ID_REGISTRY.md`: TC next free TC-0162 / last TC-0161 (TASK-0106 is already next).
- `docs/THREAT_MODEL.md`, section "AI roles in the credential path": one paragraph, the row is display only and omits itself when the log cannot be read.
- `docs/ROLLBACK.md`: a section for this slice (deploy control before web; control alone back: the row disappears, nothing else; web alone back: the field is ignored).
- Also: `docs/AI_COST_LOG.md` and `PROMPT_LOG.md` per CLAUDE.md / AGENTS.md section 14 if the regenerate step touches them; the AC-0321 note (`RELEASE_PLAN.md` ~:1822) and the EPIC-0002 note (~:21) now say the row exists. No `MIGRATION_LOG.md` entry: the field is additive and optional, so non-breaking (AGENTS.md section 15; precedent `includeInGroup`, `launcher-client.ts` ~:234).
- `CHANGELOG.md` `[Unreleased]` Added entry; README step 10 sentence; MEMORY.md fact; `progress.md` session entry with the verification numbers.
- Gates before the PR: `pnpm -r typecheck`; `pnpm test:coverage` twice (once under `yes > /dev/null` x8); `next build --webpack`; Playwright `axe report-moderation report-release report-ai-role`; `npm run plan:generate`; `npx jest tests/unit/id-registry.test.js`; `pnpm lint:sdk`; eslint. Independent review of the diff before the PR leaves draft (a Sonnet or Opus reviewer given the diff, not this plan's conclusions).

## 4. Risks and rulings to confirm

1. **Source of truth** is the session log (via `aiRolesFor`), not the group draft. This deviates from spec section 3.4 ("from the review index"), which the owner should confirm. The alternative is not "the review fold": control may not import `@acr/runtime/review` (its import guard allows only moderation, participant, players, reports and run-summary, `services/control/src/__tests__/bots/imports.test.ts`), so it would have to go through a new `@acr/runtime/moderation` export.
2. **Fail quiet** on an unreadable or malformed value (no row, panel intact), where the link guard fails closed. The row informs and guards nothing.
3. **Cost:** nothing polls while `in_review` (the panel polls every 2 s only while `evaluating`; reads happen on mount, after actions and on one retry). Each in_review overview now reads the session log (up to 64 MiB) and loads the scenario a second time, so run it concurrently with `summary()`. The links memo is closure-local to `createReportService` and `requireLinkable` deliberately reads fresh, so do not share it.
4. **Not in the plan:** an "AI player" count in the release bar or any wording about the group score, which the group report already carries.

## 5. Definition of done

AC-0389 to AC-0391 ticked with a named test each; all gates in Task 7 green; control deploys before web (documented); no change to the wire version, the review schema or any existing field.

## 6. Review amendments (Opus, 2026-11-08)

1 Task 5 premise corrected (no interception exists; add one). 2 Malformed `aiRoles` can no longer fail the panel: control validates, BFF and browser drop. 3 Task 6 is mandatory and reloads after `seedDraft`. 4 TC-0161 added for negative paths. 5 Row text follows AC-0389 ("AI player, not scored"). 6 Cost claim corrected. 7 Order is scenario order; AI rows follow "Group". 8 and 9 Test files named correctly. 10 Reuse `MESSAGES.reportAiPlayer`, `pill ai`, `REPORT_CONSOLE`. 11 Realistic fixture ids and exact-text queries. 12 Which tests must fail first versus regression guards. 13 Close-out list completed. 14 Risk 1's alternative corrected and the spec deviation flagged.
