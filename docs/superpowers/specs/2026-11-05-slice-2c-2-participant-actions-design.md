# Slice 2c-2: participants rate themselves and respond in the browser (US-0063)

Addendum to `2026-11-05-slice-2c-reports-design.md` (section 3, "2c-2, outlined") and `2026-10-26-web-client-design.md` section 5.8. Where they differ, this one wins. It designs the second story of slice 2c in full. Owner decisions made in the brainstorm of 2026-11-05 are marked **[owner]**. Choices made after the independent review, which the owner has not yet confirmed, are marked **[proposed]**.

Revision 2 (2026-11-05): folds in the independent Opus review (one Critical, ten Important, seven Minor findings; each was checked against the code before it was accepted). The review changed the log-capacity rules (4.2, 4.6), the form's data source (4.1), the resolution-reason rule (3.7, 4.4), the PR split (10) and the states the page can be in (5.2).

## 1. Understanding

A participant who holds a report link can, from a browser and with no terminal and no facilitator attesting for them:

- **rate themselves** on each criterion before their report is released (the rating is blind: the participant has not seen the evaluator's levels), and
- **respond to** their released report, and mark a response as a **dispute**, after release.

The facilitator still releases reports and resolves disputes from the terminal until slice 2c-3.

Success: a participant opens the link on a phone, rates themselves without seeing any evaluator level, and after release sees their report, their own ratings next to the evaluator's levels, can respond or dispute, and sees the outcome of a dispute. A forwarded link cannot read another role's data or write for another role, and no write starts after a revoke has returned.

Decisions made in the brainstorm **[owner]**:

1. **The link works before release.** A link can be issued once a role has a draft report in the live review. Before release it shows only the self-rating form; after release it shows the report and the response form. This changes 2c-1's rule "links only for released reports". Blind self-rating is kept.
2. **Ratings are saved by one submit.** The browser keeps a draft; one "Save my ratings" writes all criteria in one locked append. It can be pressed again until release.
3. **The participant sees their responses and the outcomes**, including the facilitator's reason for a resolution.
4. **Approach A for the schema:** `acr.review/2` is dual-read; new reviews open as `/2`; a live `/1` review refuses web writes.
5. **"Rated X of Y"** is shown to the facilitator in the console and in `moderate status`, because releasing closes self-rating and nothing else warns them.
6. **A write-capable link is an accepted, documented limit.** There is no response redaction in 2c-2.
7. **The page keeps the report as it is** (escaped markdown block) and adds sections around it.

Proposed after the review **[proposed]**:

8. **No `/2` gate on resolution reasons.** The shipped code already shows a resolution's reason to the participant for any review (see 2), so the honest change is to say so: the `resolve` help and the console tell the facilitator the reason is participant-visible, and the threat model records it. The alternative (hiding reasons in `/1` and carried resolutions) needs a schema marker on each resolution and is not worth it.
9. **No migration tool for `/1` reviews.** A review opened before this ships keeps working on the terminal path; its page says to ask the facilitator. The facilitator's way to move a session to `/2` is the existing evaluate re-run plus `supersede`.
10. **Capacity limits** for what a link holder can write (4.2, 4.3, 5.1).

## 2. Findings that shape the design

- Self-rating is blind by construction: `fold.ts` refuses `self.rated` once a player's report has a released version (or `selfClosed` is set), and `cli.ts` says so. `response.added` is the reverse and needs a released version and a state other than `withdrawn`. The `amending` state keeps responses open.
- 2c-1 issued links only for released roles (`requireReleased` in `services/control/src/reports.ts`), so a link holder could respond but could never self-rate. Decision 1 resolves this.
- `canView` (`review/policy.ts`) lets a participant see only a released or amending report, so the pre-release form needs its own narrow read path.
- `viewReport` (`review/view.ts`) already puts `self` and `responses` (with `resolution.outcome` and `resolution.reason`) into the participant's released `own` report, for any review, and the participant markdown already renders them. The released read therefore needs **no** addition for responses; the first task of PR 1 is to confirm this with a test, not to add it.
- A review records only `rubricHash`. Its criteria are `{ id, name }` (`CriterionView`). Criterion descriptions and level anchors live in the scenario's rubric file, not in the review. `DraftCriterion.level_label` is the **evaluator's** label and must never reach the form. The blind form's level names come from the generic scale (`buildMethod().scale` with `levelLabel`), which is what `self-assess --list` prints.
- One review log holds every role. `LIMITS.events` (10,000) and `LIMITS.logBytes` (16 MiB) are shared; once reached, `applyCommand` refuses every write including release and resolve, and supersede refuses when the carried events exceed the limit. A link holder who can write without limit can therefore block everyone's release.
- `isEventShape` in `review-log.ts` accepts only the actor kinds `facilitator`, `participant` and `system`. Any other kind reads back as `ReviewCorruptError`.
- Every control route reads its body through one global `MAX_BODY_BYTES = 4096`. One response of 1,500 characters can already be about 6 KB of UTF-8.
- `withReviewLock` throws the same `ReviewRefusedError` class for a held lock as for other refusals. `SessionLock` starts a heartbeat timer. Export already neutralises link and image syntax (`safeMd` and `mdEscape` in `transcript-md.ts`, applied to notes and responses in `report-md.ts`).
- The 2c-1 BFF treats an unknown read state as a failure (`launcher-client.ts`) and recognises control's "not ready" sentences by exact text (`KNOWN_CONFLICTS` in `report-handlers.ts`).
- The review chain is unkeyed (`THREAT_MODEL.md`, review log section). An actor label proves nothing against someone who can write the reports directory.

## 3. Review schema and actor

1. `REVIEW_SCHEMA` becomes `"acr.review/2"`. A new `REVIEW_SCHEMAS = ["acr.review/1", "acr.review/2"]` lists what is accepted. `checkOpened` and the actor check in `fold.ts`, `loadReview` in `store.ts`, **`isEventShape` in `review-log.ts`**, and the opener tests accept both. `moderate open` and supersede write `/2` openers. A round-trip test writes a web event and reads the log back through `readReview`.
2. New actor kind `{ kind: "participant_session"; v: 1; role: string; credentialId: string }`. `credentialId` is the report-access credential's id (the lookup half of the token; the secret half is hashed and never stored in a log). `checkActor` in `store.ts`, `isEventShape` and the fold validate it: `role` file-safe, `credentialId` matching the credential id shape, `v` exactly 1.
3. Fold rules, failing closed:
   - `self.rated` and `response.added` accept the attested kind (CLI) or `participant_session`.
   - `participant_session` is accepted only when the review opener is `/2`, `v === 1`, and `actor.role === event.role`.
   - Every other event type refuses `participant_session` (`facilitator()` already rejects non-facilitator actors for `resolve`, release and the rest; tests pin each type).
   - An unknown `v` is illegal, never ignored.
4. All existing rules apply to the new kind through the same code: self-rating after release is illegal, a response before release is illegal, the 50-response and text limits hold.
5. `who()` shows `alice (web link <credentialId>)`.
6. A live `/1` review cannot hold the new actor. A web write to it returns `old_schema`, and the page says: "This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal." The terminal path is unchanged. Supersede carries participant events with their original actors. A facilitator who wants the browser path for a `/1` session re-runs evaluate and supersedes (decision 9).
7. Resolution reasons are shown as they are today (decision 8). The `resolve --reason` help, the console and the threat model say the reason is participant-visible.

## 4. Runtime module `@acr/runtime/participant`

A new subpath export. The control import guard (`services/control/src/__tests__/bots/imports.test.ts`) is extended to allow `@acr/runtime/participant` in addition to `players` and `reports`, and nothing else. The module adds no timers of its own and never sleeps (the lock primitive keeps its own heartbeat). Expected refusals are returned results, never exceptions, and carry no path, id or role. The reports folder is untrusted input, as in `reports/index.ts`: the session id is validated, symbolic links are never followed, no role builds a path. A new `ReviewBusyError` (a subclass of `ReviewRefusedError`, so the CLI's behaviour is unchanged) is thrown by `withReviewLock` for a held lock, so `busy` is distinguishable from every other refusal.

1. **`readSelfAssessForm(reportsDir, sessionId, role)`** returns `{ kind: "form", criteria: [{ id, name }], scale: [{ level, label }], existing: Record<criterionId, { level, note? }> } | { kind: "closed" } | { kind: "old_schema" } | { kind: "none" } | { kind: "unavailable" }`. It reads only each criterion's `id` and `name` from the review, the generic scale from `buildMethod().scale`, and the role's own earlier ratings. It reads no other draft field. `closed` covers a released report, a withdrawn one, and a draft whose self-rating is closed by `selfClosed` after a supersede. A test builds a review with recognisable evaluator rationale and evidence strings and asserts they appear nowhere in the result, that the only per-criterion values are the role's own, and that the result's keys are exactly the listed ones.
2. **`submitSelfRatings({ reportsDir, sessionId, role, credentialId, ratings, now, secrets })`** takes the review lock once and appends once. `ratings` is `[{ criterion, level: 1|2|3|4|null, note? }]`. Rules:
   - a criterion listed twice in one submit is `invalid`; an unknown criterion is `invalid`;
   - a criterion left out is unchanged (there is no un-rate);
   - a missing or empty note means no note (a later rating without a note clears an earlier note, as in the fold);
   - notes go through the CLI's `cleanText` with the secrets list, and an empty or all-hidden note is treated as absent, not an error;
   - only ratings that differ from the current level or note are written (a note-only change counts); writing nothing is `ok`;
   - **a role may have at most `10 × criteria` `self.rated` events in the log**; a submit that would pass it returns `too_many` (decision 10).
   
   Results: `ok`, `closed`, `invalid`, `too_many`, `busy`, `old_schema`, `none`, `unavailable`.
3. **`submitResponse({ …, criterion?, text, dispute? })`** applies the CLI's checks (released, not withdrawn, at most `LIMITS.responses`, criterion exists in the report). Inside the lock, a response identical in criterion, **cleaned** text and dispute flag to this role's most recent response is a duplicate and returns `ok` without writing. Results add `not_released`, `withdrawn`.
4. **The released read.** `readReleasedView` already carries `self`, `responses` and each resolution's outcome and reason in `own`; no addition is needed (see 2). PR 1 adds a test that pins this.
5. **`selfRatingProgress(reportsDir, sessionId)`** returns, for each human player with a draft report, `{ role, rated, total }`: the number of criteria with a rating, out of the number of criteria. It is read-only and takes no lock, so it can meet a half-written last line; a log it cannot read gives that role `unknown`, never a failure of the whole call. Players with a released report are not listed.
6. **Supersede carries only the latest `self.rated` for each (role, criterion)**, not every earlier one, so a long run of saves cannot fill the new log. The hash chain and the carried-event rules are otherwise unchanged. A test supersedes a log with many resubmits and checks the carried count.
7. **Export.** Link and image syntax in notes and responses is already neutralised. PR 1 adds a regression test (inline, reference-style and image forms, in notes and in responses) so nothing is escaped twice or left live.
8. **`resolve` copy.** The terminal help for `resolve --reason` says the reason is shown to the participant.

## 5. Control service

1. **Routes** (same style as the 2c-1 read, keyed by credential):
   - `PUT /sessions/:id/reports/:credentialId/self-ratings` with `{ ratings: [{ criterion, level, note? }] }`.
   - `POST /sessions/:id/reports/:credentialId/responses` with `{ criterion?, text, dispute? }`.
   - Neither body has a role field. Control checks the credential is live and belongs to the session, then takes the role from the credential.
   - A refused credential is the same neutral 404 as the read. A store problem is a 503.
   - **Body caps are per route**, derived from the limits: responses 16 KB; self-ratings 64 KB (7 criteria × 1,500 characters × 4 bytes, doubled for JSON escapes, rounded up). The shared `readJsonBody` takes the cap as a parameter and keeps 4 KB as the default for every other route. The BFF's `readBody` uses the same two figures. Over the cap is 413 with a fixed sentence.
   - **Write throttle:** at most 20 writes per credential in any 10 minutes (both routes together), separate from the read throttle; over it is 429 with `Retry-After`.
2. **Read.** `GET …/reports/:credentialId` returns `state` as one of: `self_assess` (the form), `released` (as before), `not_released` (anything else, such as a withdrawn report), `closed` (a draft whose self-rating is closed), `old_schema` (a `/1` review). A successful write returns the new view. The BFF and page handle all five (6.4).
3. **Outcome mapping** (fixed sentences only): `ok` 200; `closed`, `not_released`, `withdrawn`, `too_many`, `old_schema` 409, one sentence each; `invalid` 400; too large 413; throttled 429; `busy` after retries 503 with code `busy`; `unavailable` 503. `busy` is added to the closed set of launcher reasons in the BFF.
4. **Lock retry and revoke.** Control retries `busy` up to 5 attempts at 100, 200, 400 and 800 ms with ±25% jitter (about 1.5 s), then answers `busy`. `sleep` and `random` are injected. **The credential is re-checked before every attempt**, so the guarantee is: no write starts after a revoke or reissue has returned. A test revokes between attempts and asserts no event is written.
5. **Links (ships with the browser, PR 2).** `issue` and `reissue` require a human player with a draft or released report in the live review (`requireLinkable`, replacing `requireReleased`). Withdrawn roles get no new link; revoke works whatever the state. `links()` lists draft and released roles and gives each draft role `selfRated: { rated, total }` (criteria rated out of criteria) and a summary `players: { rated, total }` (players with at least one rating out of players). The "reports are not ready" sentence now means no live review exists; its new wording and `KNOWN_CONFLICTS` in the BFF change in the same PR.
6. **Reissue** keeps the participant's data: their ratings and responses are found by role, not by credential id.
7. **Deployment.** Control now creates `review.lock` and appends to `review.jsonl` (mode `0600`). It must run as the same user as the `moderate` CLI, or share a group-writable review directory, and the reports volume must not be mounted read-only. If it cannot write, the web write answers `unavailable` and logs one fixed line. A control start-up check logs a fixed warning when the reports directory is not writable (it does not stop control). `docs/deploy` and the threat-model diagram are updated.

## 6. BFF and page

1. **BFF routes** `PUT /api/v1/report/self-ratings` and `POST /api/v1/report/responses`, as plain Request→Response handlers in `src/server/report-handlers.ts` wired in `routes.ts`, like the existing ones. They apply `checkOrigin` and `checkFetchSite`, require JSON, apply the same two body caps as control, read the credential id from the sealed cookie, and call control. They clear the cookie only on a control 404, pass `busy` and 413/429 through as fixed states, add a write throttle and send `Cache-Control: no-store`. The BFF holds no report data.
2. **Page.** The report stays the escaped markdown block in a `<pre>`. New sections around it:
   - **Self-rating form** (draft state, instead of the report): a `fieldset` and `legend` per criterion (the criterion's `name`) with radios for levels 1 to 4 and "Not observed", labelled from the generic scale, an optional note with a character counter, "Save my ratings". A line says the report appears after the facilitator releases it.
   - **Comparison table** (released state): criterion, the evaluator's level, the participant's rating, their note. Built from the structured `own` report and escaped as text.
   - **Your responses**: each response with its criterion, a dispute marker, and the outcome and reason once resolved; "n of 50 used".
   - **Response form**: criterion select ("The whole report" by default), text with counter, "I disagree with this", Send.
3. **Drafts.** Held in `sessionStorage` under one fixed key, written only after the participant touches a field. Because the page cannot know which credential it is, the draft is **cleared when a link is entered** (`/report/enter` success), on a successful save, on a refused link and on `closed`. Every storage call is in try/catch and the form works without storage.
4. **States.** Saving (button disabled, `aria-busy`, visible "Saving…"), saved (status region), busy ("Busy, try again", draft kept), too large, throttled, closed ("Ratings for this review are closed"), old schema (the sentence in 3.6), plus the 2c-1 states. Errors go in a summary that takes focus.
5. **Accessibility and print.** Forms are `no-print`; the printout is the report, the comparison table and the responses. All participant text is rendered as React text nodes. Axe runs at 400 and 1280 px in light and dark, covering the throttled, not-released, busy, closed and old-schema states as well as the new ones.

## 7. Console and terminal

- The "Participant reports" panel lists draft roles as well as released ones. A draft role shows "Rated k of n criteria"; the panel header shows "x of y players have rated". Released roles keep the expiry and last-used time. The link is still shown once. A line before release warns that releasing closes self-rating for everyone, and the panel copy says what the link allows before and after release. An `unknown` count is shown as "not available".
- `moderate status` prints the same two figures.
- The `resolve` help and the console say the reason is shown to the participant.

## 8. Threat-model changes (extend "Report access" in `docs/THREAT_MODEL.md`)

- **Write-capable bearer link.** In 2c-1 a forwarded link only read. Now it can post permanent responses and disputes as the participant. Mitigations: revoke and reissue (no write starts after they return), the credential id on every event, `lastUsedAt`. There is no redaction in 2c-2; a forwarded link cannot be told from its owner (known limit).
- **Capacity.** The shared log has fixed limits, so writes are bounded: at most `10 × criteria` ratings per role, 50 responses per role, 20 writes per credential per 10 minutes, supersede carries the latest rating only. A forwarded link can still use up its owner's 50 response slots and block the owner's own dispute; this is an accepted limit, reversible by revoke but not by deleting the responses.
- **Role from the credential, never the request.** Cross-role writes are not expressible.
- **Blind rating is enforced by the fold and the runtime read path**, not the page. The form reads only criterion ids and names and the generic scale, never a draft field. The BFF and the page never receive evaluator levels before release.
- **Control becomes a writer** of review folders. The deployment requirement is in 5.7. The earlier statement that control only reads is corrected.
- **Resolution reasons** are participant-visible (decision 8), including those already written under 2c-1.
- **Unkeyed chain.** A `participant_session` label can be forged by anyone who can write the reports directory; control is the only web writer.
- **Participant text** is scrubbed (hidden characters, secrets), length-limited, escaped in the page, and has link and image syntax neutralised in exports (already true; pinned by a test).
- **Inherited limits** from 2c-1 stand.

## 9. Tests (mapped to AC-0331 to AC-0335)

- **Fold and actor (AC-0331, AC-0335):** `participant_session` accepted only for `self.rated` and `response.added`; refused for every other event type, in a `/1` review, with `v` other than 1, and with a role mismatch. The attested CLI path still works, including a log that mixes both kinds. `/1` logs still load. A web event round-trips through `readReview` (`isEventShape`). `who()` format.
- **Blind read (AC-0332):** the form's keys are exactly `criteria`, `scale`, `existing`; evaluator rationale and evidence canaries appear nowhere; no level is tied to a criterion except the role's own.
- **Writes:** an unchanged resubmit writes nothing; a note-only change writes; a duplicate criterion in one submit is invalid; an empty note is no note; self-rating after release and responding before release are refused; the 50-response and `10 × criteria` caps; two concurrent identical responses write one event; amending keeps responses open; the duplicate check compares cleaned text.
- **Supersede:** many resubmits carry as one rating per criterion; carried ratings stay valid.
- **Lock (AC-0333):** `busy` retries with an injected sleep and then answers `busy`; a concurrent CLI command leaves a valid chain; a revoke between attempts writes nothing.
- **Forging and cross-role (AC-0335):** a credential for role A cannot write for B; revoked, expired and wrong-session credentials get the neutral 404; the body cannot name a role.
- **Control caps:** the per-route body caps (a full 7-criterion submit in multi-byte text passes; one byte over is 413); the write throttle.
- **BFF:** Origin, Fetch-Metadata, content type, size, throttle; cookie cleared only on 404; `busy` passed through; `busy` is a known launcher reason.
- **Page (AC-0332, AC-0334):** draft survives a reload and clears on enter and on save; storage failure degrades; saving, busy, closed and old-schema states; participant text escaped; the comparison table; print view; Axe states from 6.5.
- **Export (AC-0334):** link and image syntax neutralised in notes and responses.
- **Console and terminal:** the per-role and per-players counts; `unknown`; the panel rows for draft roles; the `resolve` copy.
- **Link rules (PR 2):** draft roles can be linked, withdrawn roles cannot; 2c-1's tests for released roles still pass.
- **End to end (Playwright):** issue a link on a draft; rate with the runtime exited; release; see the report and the comparison table; respond and dispute; resolve; see the outcome and reason; revoke while a cookie exists. The seeder opens `/2` reviews.

## 10. Delivery

Branch `feature/EPIC-0002-US-0063-participant-report`, cut from `develop`. Two PRs, split so that `develop` is never left with a control service that offers states the BFF cannot show:

- **PR 1, no browser, no change to what the 2c-1 page can see:** the schema and actor in the fold, store and `isEventShape`; `ReviewBusyError`; `@acr/runtime/participant` (form, writes, progress, caps); the supersede carry change; the import-guard allowance; the control write routes with per-route caps, throttle, retry and revoke re-check; the start-up writability check; `moderate status`; the `resolve` copy. The control read keeps returning the 2c-1 states and the link rule stays released-only. The first task confirms what `readReleasedView` already carries. Testable from curl and the control tests.
- **PR 2, browser:** the link-rule change, the new read states and the "not ready" wording together with `KNOWN_CONFLICTS`; `busy` in the launcher reasons; the BFF routes; the page and its sections; the console panel; Playwright and Axe; the threat-model section and deployment notes; CHANGELOG and plan documents.

Plan documents: amend AC-0327 and AC-0332 for links before release and the new "not ready" wording; new ids start at AC-0369, TC-0127 and TASK-0101 (TASK-0092 and AC-0331 to AC-0335 already belong to US-0063). The plan is written after the owner has approved this spec.

## 11. Risks carried into the plan

- A facilitator who releases before everyone has rated closes self-rating for them. The counts and the warning in the console are the mitigation.
- A forwarded link can write permanent responses and use up the owner's response slots. Revoke, reissue, the credential id on each event and the capacity limits bound it; redaction is left to 2c-3 if wanted.
- Reviews opened before this ships (`/1`) cannot take web writes; moving one to the browser path needs an evaluate re-run and supersede.
- Rolling control or the runtime back to a build that does not know `/2` makes every `/2` review unreadable ("unknown schema"). The release notes say so.
- A supersede interrupted under `/1` code and re-run under `/2` code is refused (the recovery compares the opener, which includes the schema). The refusal message should say to re-run with the same version.
- The duplicate-response rule hides a genuine immediate repeat of identical text. That trade is accepted.
- Open follow-ups touching this area: BUG-0027, BUG-0028.
