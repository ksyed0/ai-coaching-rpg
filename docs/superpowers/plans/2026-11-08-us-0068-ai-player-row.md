# US-0068: "AI player, not scored" row in the console report list — implementation plan

> Story: US-0068 (EPIC-0002, Low, S), AC-0389 to AC-0391. Task: TASK-0105. Test cases: TC-0158 to TC-0160. Branch: `feature/EPIC-0002-US-0068-ai-player-row`, cut from `develop`.
> Origin: the owner's 2026-11-06 decision on Deviation 3 of slice 2c-4 (`docs/superpowers/specs/2026-11-06-slice-2c-4-close-out-design.md`, section 3.4): the list gets the row, as a follow-up.
> Execution: subagent-driven or inline, TDD per task (write the failing test, see it fail for the stated reason, then the code). One PR; no merge without green CI.

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
| Unknown (`null`, absent dependency, a throw) | Omit the field. The panel shows no AI rows (today's behaviour). | Display only; failing quiet is right. Unlike the link guard it protects nothing, and a wrong "not scored" row would be worse than none. |
| Older control / older web | Older control: no field, web shows no rows. Older web: its strict parser ignores the unknown field. | AC-0390. Deploy control first so the field exists when web asks. |
| Row content | Role label (via `roleLabel`), a pill with the words "AI player", and the sentence "Not scored: an AI player has no report." No buttons, no export entry, not selectable, not counted in open items or the release bar. | AC-0389. |
| Placement | After the subject rows, in log order, own `<li>` with the same `code-row` styling. | Keeps the scored rows first. |
| Safety checks | The browser and BFF accept only file-safe ids (the existing `isFileSafeId`), at most 64 entries, no duplicates; a role that is also a subject row gets no AI row. | Defence in depth; a malformed list makes the parser return `bad()` like any other malformed field. |
| Accessibility | The meaning is in words; the pill is not colour only (`pill mut` plus text); the row is a list item with no interactive control. | AC-0391. |

Out of scope: any change to the review, the fold, exports, the runtime, the wire version, or the link panel's existing "AI player" label.

## 3. Tasks

### Task 1 — Control: `aiRoles` on the overview (TC-0158)

Files: `services/control/src/moderation.ts`, `services/control/src/main.ts`, `services/control/src/__tests__/moderation*.test.ts` (use the existing overview tests' fixtures).

1. Failing tests first: (a) `in_review` overview includes `aiRoles` from the injected function; (b) a function returning `null`, one that throws, and no function at all each leave the field out; (c) other stages (`not_ended`, `not_evaluated`, `evaluating`, `failed`, `ready_to_open`) never carry it and never call the function; (d) the function receives the session id.
2. Add the optional `aiRoles?: string[]` to `Overview` and the optional dependency to the service options; fill it in the `in_review` branch next to `summary`, inside the existing `guard`, with a local try/catch so a throw cannot fail the overview.
3. Wire `aiRoles: (id) => aiRolesFor(config, list, id)` at `main.ts:93`, with the same `list` the link service gets.
4. Run: `pnpm --filter @acr/control test`, `pnpm -r typecheck`.

### Task 2 — BFF: parse and forward the field (TC-0158 continued)

Files: `apps/web/src/server/launcher-client.ts` (`ReportOverview`, `toOverview`), its test file, `console-report-handlers.test.ts`.

1. Failing tests: a control answer with `aiRoles: ["ai1"]` is forwarded; an answer without the field is forwarded unchanged (no `aiRoles` key); a non-array, a non-string entry, an unsafe id, a duplicate and 65 entries each make the parser fail like any malformed overview (the handler answers its closed "unavailable").
2. Implement with the existing helpers (`list`, `isStr`, `isFileSafeId`, `bad`); add `aiRoles?: string[]` to `ReportOverview`; include it in the result only when present.

### Task 3 — Browser: parse the field (TC-0159)

Files: `apps/web/src/lib/console-api.ts` (`ReportOverviewView`, `parseReportOverview`), `apps/web/src/lib/__tests__/console-api*.test.ts`.

1. Failing tests: absent -> `aiRoles: []`; present and valid -> kept in order; same rejection cases as Task 2 return `null`.
2. Implement; the view type always carries `aiRoles: string[]` (empty by default) so components never branch on undefined.

### Task 4 — The row component (TC-0159)

Files: `apps/web/src/components/console/report/SubjectList.tsx` (new `aiRoles?: string[]` prop), `ReportPanel.tsx` (pass `overview.aiRoles`), `__tests__/lists.test.tsx`, `__tests__/ReportPanel.test.tsx`, `__tests__/fixtures.ts`.

1. Failing tests: one AI row per listed role, after the subject rows, with the role label, the words "AI player" and "Not scored"; it has no button, no Review/Amend/Withdraw/Export, is not selectable; `openItems`, the release bar and the export menu are unchanged by it; a listed role that is also a subject renders only its subject row; an empty or absent list renders nothing extra; a ReportPanel render with `aiRoles: ["ai1"]` shows the row beside a human subject.
2. Implement the row (`<li className="code-row">`, `<span className="code-role">`, `<span className="pill mut">AI player</span>`, `<span className="small">Not scored: an AI player has no report.</span>`). The sentence lives once, as a constant in `SubjectList.tsx`.

### Task 5 — Accessibility check (TC-0160)

File: `apps/web/e2e/axe.spec.ts` (the console report cases already intercept the overview; follow the nearest one).

1. Add a case whose intercepted overview has `aiRoles` and one human subject; run Axe on the Report panel; assert zero violations and that the row text is visible.
2. Run after `next build --webpack`: `pnpm --filter @acr/web exec playwright test axe --trace off`, with `PLAYWRIGHT_CHROMIUM_EXECUTABLE` as in earlier sessions.

### Task 6 — End to end (TC-0158, real stack; optional to keep the story S)

File: `apps/web/e2e/report-ai-role.spec.ts` already runs a session with AI roles through the real control service. Add one assertion there: the console's subject list shows the AI row for the AI role and no Review button for it. If the seeded review cannot reach `in_review` in that spec without extra seeding, record that in the PR and rely on Tasks 1 to 5 (the same limit as slice 2c-4 PR 1).

### Task 7 — Documents and close-out

- `docs/RELEASE_PLAN.md`: TASK-0105 (Dev, Agent, branch above); tick AC-0389 to AC-0391 when verified; US-0068 Complete only after the PR merges; update the EPIC-0002 note (the row exists).
- `docs/TEST_CASES.md`: TC-0158 (control and BFF carry the field; older control/web tolerated), TC-0159 (browser parse and the row), TC-0160 (Axe). `docs/ID_REGISTRY.md`: next free TASK-0106, TC-0161.
- `docs/THREAT_MODEL.md`, section "AI roles in the credential path": one paragraph, the row is display only and omits itself when the log cannot be read.
- `docs/ROLLBACK.md`: a section for this slice (deploy control before web; control alone back: the row disappears, nothing else; web alone back: the field is ignored).
- `CHANGELOG.md` `[Unreleased]` Added entry; README step 10 sentence; MEMORY.md fact; `progress.md` session entry with the verification numbers.
- Gates before the PR: `pnpm -r typecheck`; `pnpm test:coverage` twice (once under `yes > /dev/null` x8); `next build --webpack`; Playwright `axe report-moderation report-release report-ai-role`; `npm run plan:generate`; `npx jest tests/unit/id-registry.test.js`; `pnpm lint:sdk`; eslint. Independent review of the diff before the PR leaves draft (a Sonnet or Opus reviewer given the diff, not this plan's conclusions).

## 4. Risks and rulings to confirm

1. **Source of truth** is the session log (via `aiRolesFor`), not the group draft. If the owner prefers the draft's `ai_players.roles`, Task 1 changes to read it from the review fold; the web tasks are identical.
2. **Fail quiet** on an unreadable log (no row), where the link guard fails closed. Chosen because the row informs and guards nothing.
3. **Cost:** `aiRolesFor` re-reads the log on each overview poll while `in_review`. The link service memoises (64 entries). If the poll rate makes that visible, reuse the same memo; otherwise leave it (the overview already reads the log for the run summary).
4. **Not in the plan:** an "AI player" count in the release bar or any wording about the group score, which the group report already carries.

## 5. Definition of done

AC-0389 to AC-0391 ticked with a named test each; all gates in Task 7 green; control deploys before web (documented); no change to the wire version, the review schema or any existing field.
