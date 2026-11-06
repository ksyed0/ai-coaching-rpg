# Slice 2c-2: participants rate themselves and respond in the browser (US-0063)

Addendum to `2026-11-05-slice-2c-reports-design.md` (section 3, "2c-2, outlined") and `2026-10-26-web-client-design.md` section 5.8. Where they differ, this one wins. It designs the second story of slice 2c in full. Owner decisions made in the brainstorm of 2026-11-05 are marked **[owner]**.

## 1. Understanding

A participant who holds a report link can, from a browser and with no terminal and no facilitator attesting for them:

- **rate themselves** on each criterion before their report is released (the rating is blind: the participant has not seen the evaluator's levels), and
- **respond to** their released report, and mark a response as a **dispute**, after release.

The facilitator still releases reports and resolves disputes from the terminal until slice 2c-3.

Success: a participant opens the link on a phone, rates themselves without seeing any evaluator level, and after release sees their report, their own ratings next to the evaluator's levels, can respond or dispute, and sees the outcome of a dispute. A forwarded link cannot read another role's data or write for another role, and a revoked link stops writing at once.

Decisions made in the brainstorm **[owner]**:

1. **The link works before release.** A link can be issued once a role has a draft report in the live review. Before release it shows only the self-rating form; after release it shows the report and the response form. This changes 2c-1's rule "links only for released reports". Blind self-rating is kept.
2. **Ratings are saved by one submit.** The browser keeps a draft; one "Save my ratings" writes all criteria in one locked append. It can be pressed again until release.
3. **The participant sees their responses and the outcomes**, including the facilitator's reason for a resolution made in a `/2` review.
4. **Approach A for the schema:** `acr.review/2` is dual-read; new reviews open as `/2`; a live `/1` review refuses web writes.
5. **"Rated X of Y"** is shown to the facilitator in the console and in `moderate status`, because releasing closes self-rating and nothing else warns them.
6. **A write-capable link is an accepted, documented limit.** There is no response redaction in 2c-2.
7. **The page keeps the report as it is** (escaped markdown block) and adds sections around it.

## 2. Findings that shape the design

- Self-rating is blind by construction: `fold.ts` refuses `self.rated` once a player's report has a released version (or `selfClosed` is set), and `cli.ts` says so. `response.added` is the reverse and needs a released version and a state other than `withdrawn`. The `amending` state keeps responses open.
- 2c-1 issued links only for released roles (`requireReleased` in `services/control/src/reports.ts`), so a link holder could respond but could never self-rate. Decision 1 resolves this.
- `canView` (`review/policy.ts`) lets a participant see only a released or amending report, so the pre-release form needs its own narrow read path.
- `ParticipantReport` (`evaluator/report-model.ts`) already carries `self` (the participant's ratings per criterion id with label and note). The released read needs the responses and dispute outcomes added, not the ratings.
- `withReviewLock` refuses a held lock at once ("try again in a moment"). Retrying is the caller's job.
- The review chain is unkeyed (`THREAT_MODEL.md`, review log section). An actor label proves nothing against someone who can write the reports directory.

## 3. Review schema and actor

1. `REVIEW_SCHEMA` becomes `"acr.review/2"`. A new `REVIEW_SCHEMAS = ["acr.review/1", "acr.review/2"]` lists what is accepted. `checkOpened` in `fold.ts`, `loadReview` in `store.ts` and the opener tests accept both. `moderate open` and supersede write `/2` openers.
2. New actor kind `{ kind: "participant_session"; v: 1; role: string; credentialId: string }`. `credentialId` is the report-access credential's id (the lookup half of the token; the secret half is hashed and never stored in a log). `checkActor` in `store.ts` and the actor check in `fold.ts` validate it: `role` file-safe, `credentialId` matching the credential id shape, `v` exactly 1.
3. Fold rules, failing closed:
   - `self.rated` and `response.added` accept the attested kind (CLI) or `participant_session`.
   - `participant_session` is accepted only when the review opener is `/2`, `v === 1`, and `actor.role === event.role`.
   - Every other event type refuses `participant_session` (`facilitator()` already rejects non-facilitator actors for `resolve`, release and the rest; tests pin each type).
   - An unknown `v` is illegal, never ignored.
4. All existing rules apply to the new kind through the same code: self-rating after release is illegal, a response before release is illegal, the 50-response and text limits hold.
5. `who()` shows `alice (web link <credentialId>)`.
6. A live `/1` review cannot hold the new actor. A web write to it is refused with the fixed sentence "Ask your facilitator to re-open the review." The terminal path is unchanged. Supersede carries participant events with their original actors.
7. Dispute resolutions record the schema of the review they were written in (the opener already does). A resolution's reason is shown to the participant only when the review is `/2` (section 4.4).

## 4. Runtime module `@acr/runtime/participant`

A new subpath export. The control import guard (`services/control/src/__tests__/bots/imports.test.ts`) is extended to allow `@acr/runtime/participant` in addition to `players` and `reports`, and nothing else. The module has no timers and never sleeps. Expected refusals are returned results, never exceptions, and carry no path, id or role. The reports folder is untrusted input, as in `reports/index.ts`: the session id is validated, symbolic links are never followed, no role builds a path.

1. **`readSelfAssessForm(reportsDir, sessionId, role)`** returns `{ kind: "form", criteria: [{ id, title, description, levels: [{ level, label }] }], existing: Record<criterionId, { level, note? }>, rated: boolean } | { kind: "closed" } | { kind: "none" } | { kind: "unavailable" }`. It never contains evaluator levels, rationale, evidence, comments, peers or any other role's data. A test builds a review with a recognisable evaluator level and rationale and scans the whole result for them. Level labels come from the rubric recorded in the review.
2. **`submitSelfRatings({ reportsDir, sessionId, role, credentialId, ratings, now, secrets })`** takes the review lock once and appends once. `ratings` is `[{ criterion, level: 1|2|3|4|null, note? }]`. Notes go through the CLI's `cleanText` with the secrets list. It writes only ratings that differ from the current rating or note (a note-only change counts). Writing nothing is `ok`. Results: `ok`, `closed`, `invalid`, `busy`, `legacy` (a `/1` review), `none`, `unavailable`.
3. **`submitResponse({ …, criterion?, text, dispute? })`** applies the CLI's checks (released, not withdrawn, at most `LIMITS.responses`, criterion exists in the report). Inside the lock, a response identical in criterion, text and dispute flag to this role's most recent response is a duplicate and returns `ok` without writing. Results add `not_released`, `withdrawn`, `too_many`.
4. **`readReleasedView`** (in `reports`) adds the role's responses to `own`: for each, its criterion, text, dispute flag, and the resolution outcome. The resolution reason is included only when the review is `/2`. It also returns the self-ratings already in `own.self`.
5. **`selfRatingProgress(reportsDir, sessionId)`** returns `{ role, rated, total }` for each human player with a draft report, read-only, for the console and `moderate status`. `rated` means at least one criterion has a rating. It takes no lock.
6. **Export.** `renderSubjectMarkdown` (and any export built from it) neutralises Markdown link and image syntax (`[x](url)`, `![x](url)`, reference-style links) in participant-written notes and responses, so an exported file cannot carry a live link a participant wrote. The page is safe regardless: it never parses markdown.
7. **`resolve` copy.** The terminal help for `resolve --reason` says the reason is shown to the participant.

## 5. Control service

1. **Routes** (same style as the 2c-1 read, keyed by credential):
   - `PUT /sessions/:id/reports/:credentialId/self-ratings` with `{ ratings: [{ criterion, level, note? }] }`.
   - `POST /sessions/:id/reports/:credentialId/responses` with `{ criterion?, text, dispute? }`.
   - Neither body has a role field. Control checks the credential is live and belongs to the session, then takes the role from the credential.
   - A refused credential is the same neutral 404 as the read. A store problem is a 503.
   - Body cap about 16 KB, JSON only. Ratings cannot exceed the criteria count. Writes have a per-credential rate limit separate from reads.
2. **Read.** `GET …/reports/:credentialId` gains `state: "self_assess"` with the form while the report is a draft, `released` as before (plus responses), and `not_released` for anything else, such as withdrawn. A successful write returns the new view.
3. **Outcome mapping** (fixed sentences only): `ok` 200; `closed`, `not_released`, `withdrawn`, `too_many`, `legacy` 409, one sentence each; `invalid` 400; `busy` after retries 503 with code `busy`; `unavailable` 503.
4. **Lock retry.** Control retries `busy` up to 5 attempts at 100, 200, 400 and 800 ms with ±25% jitter (about 1.5 s), then answers `busy`. `sleep` and `random` are injected.
5. **Links.** `issue` and `reissue` require a human player with a draft or released report in the live review (`requireLinkable`, replacing `requireReleased`). Withdrawn roles get no new link; revoke works whatever the state. `links()` lists draft and released roles and gives each draft role `selfRated: { rated, total }` from `selfRatingProgress`. The "reports are not ready" sentence now means no live review exists, and its wording is updated.
6. **Reissue** keeps the participant's data: their ratings and responses are found by role, not by credential id.

## 6. BFF and page

1. **BFF routes** `PUT /api/v1/report/self-ratings` and `POST /api/v1/report/responses`, as plain Request→Response handlers in `src/server/report-handlers.ts` wired in `routes.ts`, like the existing ones. They apply `checkOrigin` and `checkFetchSite`, require JSON, cap the body, read the credential id from the sealed cookie, and call control. They clear the cookie only on a control 404, pass `busy` through, add a write throttle and send `Cache-Control: no-store`. The BFF holds no report data.
2. **Page.** The report stays the escaped markdown block in a `<pre>`. New sections around it:
   - **Self-rating form** (draft state, instead of the report): a `fieldset` and `legend` per criterion with radios for levels 1 to 4 and "Not observed" labelled from the rubric, an optional note with a character counter, "Save my ratings". A line says the report appears after the facilitator releases it.
   - **Comparison table** (released state): criterion, the evaluator's level, the participant's rating, their note. Built from the structured `own` report and escaped as text.
   - **Your responses**: each response with its criterion, a dispute marker, and the outcome and (for `/2`) the reason once resolved; "n of 50 used".
   - **Response form**: criterion select ("The whole report" by default), text with counter, "I disagree with this", Send.
3. **Drafts.** Held in `sessionStorage` under one fixed key, written only after the participant touches a field, cleared on a successful save and on a refused link. Every storage call is in try/catch and the form works without storage.
4. **States.** Saving (button disabled, `aria-busy`, visible "Saving…"), saved (status region), busy ("Busy, try again", draft kept), closed ("Ratings closed, the report was released"), plus the 2c-1 states. Errors go in a summary that takes focus.
5. **Accessibility and print.** Forms are `no-print`; the printout is the report, the comparison table and the responses. All participant text is rendered as React text nodes. Axe runs at 400 and 1280 px in light and dark, covering the throttled, not-released, busy and closed states as well as the new ones.

## 7. Console and terminal

- The "Participant reports" panel lists draft roles as well as released ones, with "Rated X of Y" for draft roles and the existing expiry and last-used time. The link is still shown once. A line before release warns that releasing closes self-rating for everyone, and the panel copy says what the link allows before and after release.
- `moderate status` prints the same "rated X of Y".
- The `resolve` help and the console say the reason is shown to the participant.

## 8. Threat-model changes (extend "Report access" in `docs/THREAT_MODEL.md`)

- **Write-capable bearer link.** In 2c-1 a forwarded link only read. Now it can post permanent responses and disputes as the participant. Mitigations: revoke and reissue, the credential id on every event, `lastUsedAt`. There is no redaction in 2c-2; a forwarded link cannot be told from its owner (known limit).
- **Role from the credential, never the request.** Cross-role writes are not expressible.
- **Blind rating is enforced by the fold and the runtime read path**, not the page. The BFF and the page never receive evaluator levels before release.
- **Unkeyed chain.** A `participant_session` label can be forged by anyone who can write the reports directory; control is the only web writer.
- **Participant text** is scrubbed (hidden characters, secrets), length-limited, escaped in the page, and has link and image syntax neutralised in exports.
- **Inherited limits** from 2c-1 stand.

## 9. Tests (mapped to AC-0331 to AC-0335)

- **Fold and actor (AC-0331, AC-0335):** `participant_session` accepted only for `self.rated` and `response.added`; refused for every other event type, in a `/1` review, with `v` other than 1, and with a role mismatch. The attested CLI path still works, including a log that mixes both kinds. `/1` logs still load. `who()` format.
- **Blind read (AC-0332):** the form contains no evaluator level, rationale, evidence, comment or peer data (scan with a recognisable fixture).
- **Writes:** an unchanged resubmit writes nothing; a note-only change writes; self-rating after release and responding before release are refused; the 50-response cap; two concurrent identical responses write one event; amending keeps responses open.
- **Lock (AC-0333):** `busy` retries with an injected sleep and then answers `busy`; a concurrent CLI command leaves a valid chain.
- **Forging and cross-role (AC-0335):** a credential for role A cannot write for B; revoked, expired and wrong-session credentials get the neutral 404; the body cannot name a role.
- **BFF:** Origin, Fetch-Metadata, content type, size, throttle; cookie cleared only on 404; `busy` passed through.
- **Page (AC-0332, AC-0334):** draft survives a reload and clears on save; storage failure degrades; saving, busy and closed states; participant text escaped; the comparison table; print view; Axe states from section 6.5.
- **Export (AC-0334):** link and image syntax neutralised in notes and responses.
- **Console and terminal:** "rated X of Y"; the panel rows for draft roles; the `resolve` copy.
- **Link rules:** draft roles can be linked, withdrawn roles cannot, 2c-1's tests for released roles still pass (the `not_released` meaning changes, so these are the most likely to break quietly).
- **End to end (Playwright):** issue a link on a draft; rate with the runtime exited; release; see the report and the comparison table; respond and dispute; resolve; see the outcome; revoke while a cookie exists. The seeder opens `/2` reviews.

## 10. Delivery

Branch `feature/EPIC-0002-US-0063-participant-report`, cut from `develop`. Two PRs, as in 2c-1:

- **PR 1, no browser:** the schema and actor in the fold and store, `@acr/runtime/participant` (form, writes, progress, `readReleasedView` additions, export neutralising), the import-guard allowance, the control routes, retry and link-rule change, `selfRated`, `moderate status`, the `resolve` copy. The first task confirms what `ParticipantReport` and `readReleasedView` already carry. Testable from curl and the control tests.
- **PR 2, browser:** BFF routes, the page and its sections, the console panel, Playwright and Axe, the threat-model section, CHANGELOG and plan documents.

Plan documents: amend AC-0327 and AC-0332 for links before release and the new "not ready" wording; new ids start at AC-0369, TC-0127 and TASK-0101 (TASK-0092 and AC-0331 to AC-0335 already belong to US-0063). The plan is written after an independent review of this spec.

## 11. Risks carried into the plan

- A facilitator who releases before everyone has rated closes self-rating for them. The "rated X of Y" line and the warning in the console are the mitigation.
- A forwarded link can write permanent responses. Revoke, reissue and the credential id on each event are the mitigation; redaction is left to 2c-3 if wanted.
- Reviews opened before this ships (`/1`) cannot take web writes. The fixed sentence tells the participant what to ask for.
- The 2c-1 `not_released` meaning changes; its tests are re-run first.
- The duplicate-response rule hides a genuine immediate repeat of identical text. That trade is accepted.
- Open follow-ups touching this area: BUG-0027, BUG-0028.
