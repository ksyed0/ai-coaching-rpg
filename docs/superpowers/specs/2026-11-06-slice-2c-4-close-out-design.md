# Slice 2c-4: EPIC-0002 close-out (US-0060 AI-role guarantees, console and CLI polish)

Addendum to `2026-10-26-web-client-design.md` (sections 5.8 and 7) and `2026-11-06-slice-2c-3-facilitator-reports-design.md`. Where they differ, this one wins. Revision 1, 2026-11-06.

## 1. Purpose and success

Every planned EPIC-0002 story (US-0052 to US-0065) is Done on `develop` except US-0060, which has two open criteria: AC-0321 (AI roles are labelled AI in reports and exports) and AC-0322 (an AI-filled role gets no report-access credential). This slice finishes those two, adds the facilitator and operator pieces carried over from slice 2c-3, and lets US-0060 and EPIC-0002 be marked Complete. It adds no new product surface beyond those pieces.

Success: AC-0321 and AC-0322 are ticked with tests that would fail if the behaviour regressed; a facilitator can edit a participant's summary in the console; `moderate status` and `history` attribute a web event to its link; the cheap, safe deferred minors are fixed and the rest are filed.

**Decisions fixed with the owner (2026-11-06):**
- Scope: all four items: the credential guard for AI roles, the console edit-summary control, the credential id in the moderate CLI, and the deferred minors worth fixing. Checking AC-0321 and AC-0322 on the web side is part of the first item.
- Two PRs, in order: **PR 1** AI-role guarantees (US-0060), **PR 2** console and CLI polish (a new small story, filed in the plan). Sequential, because both touch the console report files.
- The credential id is shown as its **first 8 characters** in the CLI; the full id stays in `review.jsonl`.
- Minors are fixed only if they are under about 30 lines, tested and change no wire shape. Everything else is filed as a BUG or story, not squeezed in.
- The release (suggested v0.2.0) is decoupled from PR 2: it may be cut after PR 1. The owner decides when.

**Out of scope:** the evaluator, the review schema, the wire shape of any existing field, new report features (participant-view and amending-export menu entries), idempotency keys for resent responses, redaction of forwarded links, migration of pre-`/2` reviews, and any change to how overview answers are ordered or retried.

## 2. Findings that shaped this design

- `requireLinkable` (`services/control/src/reports.ts`) issues or reissues a link only when the role has a draft or released report. The evaluator writes no report for an AI role, so an AI role is refused with `NO_REPORT` today. That refusal is indirect: it holds only while the review folder contains no AI-role subject, and control does not check.
- `links()` lists a role if it has a released report, a draft or a live credential. A role with a live link stays listed even when its report was withdrawn so the facilitator can still revoke it (comment at `reports.ts:94`). Any change to what `links()` hides must keep revoke possible.
- The supervisor already knows the live AI roles (`aiRolesOf(id)`). The evaluator derives the authoritative set from the session log (`aiRolesOf(events, scenario)` in `evaluator/ai-players.ts`).
- A required field in a control answer makes the web app fail closed without it (`scoreByHand`, slice 2c-3), which is why control deploys before web. A new required field would add the same constraint.
- The edit-summary control and BFF routes exist (16 KB cap); the console has no UI for them. `SubjectView.tsx` is where criteria are edited.
- Web events are recorded with a `participant_session` actor holding `role` and `credentialId` (`review/types.ts`); the CLI shows only the role.

## 3. PR 1: AI-role guarantees (US-0060: AC-0321, AC-0322)

**3.1 Explicit guard in control.** `requireLinkable` also resolves the session's AI roles and refuses an AI role with a new fixed sentence ("AI players do not get report links."), checked before the report lookup. Source of the set: the supervisor for a live session; for an ended or restarted session, the session log through a read-only runtime reader (the plan names the function), using the same fold the evaluator uses. If the set cannot be read, or the log is inconsistent (the evaluator calls this "invalid"), the call fails closed with the existing `reportsDown` 503. It never answers open. `revoke` is unchanged and still works for any role.

**3.2 `links()` display flag.** An AI role is not listed unless it has a live credential. When it does, the entry carries an optional `ai: true` and offers no issue or reissue; revoke stays. The flag is optional on the wire: the web app reads a missing flag as "not AI". That keeps old control with new web working, so the existing deploy order and rollback note do not change. The flag is display only; the guard in 3.1 is what protects. Source for the flag: the review's own record of AI subjects if the plan finds a cheap reader; otherwise the supervisor set for live sessions, and the flag is simply absent for others. If neither is available the page still works.

**3.3 Labels on the web (AC-0321).** First a test pins what a released group report containing an "(AI player)" quote looks like on `/report`, in the print view and in the Markdown download. Report text is rendered as escaped plain text, so the label should survive; this is verified, not assumed. If a path drops it, that path is fixed. No AI-specific logic is added to `ReportView`. This check runs first: if it finds a gap, PR 1 grows to fix it.

**3.4 Console and exports.** The Report panel subject list shows the "AI player, not scored" row from the review index with no actions. The export menu does not list an AI role.

**3.5 Docs.** `docs/THREAT_MODEL.md` gains the AI-role guard and the fail-closed rule; `docs/ROLLBACK.md` notes that the `ai` flag is optional so rolling back control alone is safe.

## 4. PR 2: console and CLI polish (new story under EPIC-0002)

Built in this order, so the riskiest item can split out without blocking the rest.

**4.1 Credential id in the moderate CLI.** In `moderate status` and `history`, a `participant_session` event reads like `Priya via web link 3fa9c1d2` (role, then the first 8 characters of the credential id). The formatter lives with the other CLI rendering; the id is not a secret, and a short form is enough to tell two links apart in pasted output.

**4.2 Minors in scope** (each under about 30 lines, with a test, no wire change):
- Withdraw is offered on an amending row (the server already allows it).
- A whitespace-only note with no level no longer blocks the save (the server treats it as absent).
- `ReportPanel` blockers for a missing row default to blocked, not none, so the dialog fails closed (the server still refuses; this is UX).
- The Axe fixture for the throttled state uses the BFF's real code `rate_limited`.
- The unused `REPORT_CONSOLE.resolved` is removed.
- Route-level tests are added for the specific part B 409 and 503 codes named in `progress.md` (Session 31); other gaps are filed, not chased.
- The export menu's Blob URL revoke delay: the session notes say it was raised to 30 seconds in PR B's fix wave while `progress.md` still lists it as open. The plan checks the code; if it is fixed, it is dropped from the list.

**4.3 Minors filed, not fixed:** a response resent after a BFF timeout stored twice (needs an idempotency key); a forwarded link using up its owner's 50 response slots, and redaction; reviews opened before schema `/2` cannot take web writes; overview answers out of order and the first read never retrying; participant-view and amending-export menu entries; edits lost when the draft clears during a save.

**4.4 Edit-summary control (last).** `SubjectView.tsx` gets a "Summary" section beside the criteria: three lists (strengths, developments, actions) and a required reason. Deliberately plain: one textarea per list, one entry per line, no reordering, no inline editing. It shows only while the subject is editable, requires the typed author name like every other write, keeps what was typed after a refusal, and renders every string as a React text node. It uses the existing route and its 16 KB cap. If it runs long it becomes its own PR.

## 5. Threat-model changes

- AI roles get an explicit, fail-closed refusal in the credential path instead of an incidental one (PR 1).
- The credential id appears in operator terminal output as 8 characters; the token and full id do not (PR 2). Recorded in `docs/THREAT_MODEL.md` with the reason.
- No new routes, no new inputs from the browser apart from the edit-summary form, which posts to an existing, capped route.

## 6. Tests

- Control: the guard refuses an AI role for `issue` and `reissue`; an unreadable set and an inconsistent log both answer 503 and never issue; `revoke` still works for an AI role with a live credential; `links()` lists such a role with `ai: true` and no actions, and omits an AI role without a credential.
- Web: the label-survival test for `/report`, print view and download; a missing `ai` flag reads as not AI; the subject-list AI row has no actions; the export menu omits an AI role.
- Optional e2e: a session with an AI role gets no link and shows "AI player, not scored". Added only if seeding an AI session is cheap, otherwise recorded as a known gap (see BUG-0028 on seeded e2e folders).
- PR 2: the CLI formatter (8 characters, missing id handled); a component test for each in-scope minor; a component test and, if the seed supports it, one e2e step for edit-summary; Axe for the new section.
- Gates before each push: `pnpm -r typecheck`; `pnpm test:coverage` twice, once under load (8 `yes` burners); `next build --webpack` then the affected Playwright specs (`report-moderation`, `report-release`, `axe`) on the installed Chromium; `npm run plan:generate`; `npx jest tests/unit/id-registry.test.js`. New regexes over ids use `isSafeId` (the US-0020 guard failed on the last two slices).

## 7. Acceptance criteria

Ids are taken from `docs/ID_REGISTRY.md` when the plan files them. Existing: **AC-0321** and **AC-0322** (US-0060). New, in the PR 2 story or US-0060 as the plan decides:
- An AI role is refused a report link, fail-closed, with a fixed sentence (PR 1).
- A released report's "(AI player)" labels are present on the report page, print view and download (PR 1).
- `links()` keeps an AI role with a live credential revocable, and an old control answer without the flag still renders (PR 1).
- A facilitator can edit a participant's summary in the console with a reason and the typed name (PR 2).
- `moderate status` and `history` show the first 8 characters of a web event's credential id (PR 2).
- The in-scope minors in 4.2 are fixed with tests, and the rest are filed (PR 2).

## 8. PR split, review and release

- **PR 1** on `feature/EPIC-0002-US-0060-ai-role-guarantees`, then **PR 2** on a branch named after the new story, both from `develop`. Squash-merge on green CI, PR 1 first.
- PR 1 gets an independent review (it touches the credential path); PR 2 gets the normal whole-branch review.
- On both merged: US-0060 and EPIC-0002 go to Complete in `docs/RELEASE_PLAN.md`; `CHANGELOG.md` `[Unreleased]`, `progress.md`, `MEMORY.md`, the registry, TEST_CASES and the threat model are updated.
- Release: suggested v0.2.0 from `develop` via `release/0.2.0` (merge commit into `main`, tag). It may follow PR 1 alone; PR 2 would then ship in 0.2.1. Deploy the control service before the web app and roll back in the reverse order; `docs/ROLLBACK.md` gets a 0.2.0 entry. The owner decides when.

## 9. Open items settled at the start of the plan

- Which runtime reader gives control the AI-role set for an ended session, and whether the review index offers a cheap source for the display flag (3.1, 3.2).
- Whether an AI session can be seeded cheaply for the optional e2e (section 6).
- Whether the Blob URL revoke delay is already fixed (4.2).
- The story id and title for PR 2, and whether the new acceptance criteria sit under it or under US-0060.
