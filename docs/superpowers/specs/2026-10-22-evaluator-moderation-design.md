# Evaluator moderation, release, visibility and self-assessment: design

Status: draft for owner review (2026-10-22). Scope: the remainder of EPIC-0005 as engine and CLI only (ASM-04 moderation with history, ASM-09 result visibility and audit, ASM-07 self-assessment, response and dispute). The web UI, SSO and real participant logins belong to EPIC-0002. Inputs: `docs/PRODUCT_SPEC.md` section 7.2 steps 5 and 6, section 7.3, ASM-04/07/09, `docs/EVALUATOR.md`, `docs/THREAT_MODEL.md`, lessons L-0007, L-0016, L-0017, L-0019. The design was reviewed by an independent architect (Opus) on 2026-10-22; its findings are folded in and listed in section 13.

## 1. Purpose and success criteria

`pnpm evaluate` writes draft reports that every participant can read and that no human has reviewed. The product spec says scores are reviewed by a facilitator before anyone sees them, that the facilitator can change any score with a recorded reason, that participants can respond and self-assess, and that results reach a defined audience with an audit trail. None of that exists.

This slice is done when:

1. A facilitator can review an evaluation, accept or edit each criterion with a reason, and release each subject (a player or the group), with every action kept in an append-only history.
2. A subject cannot be released while any criterion that needs review is unresolved.
3. A released report can be amended (new version, reason required) or withdrawn, and earlier versions stay in history.
4. Who may see what is decided by one pure function over a policy table, with unreleased and withdrawn reports facilitator-only, and the group report and `index.md` never showing peers' individual scores to a participant.
5. Participants can rate themselves blind before release, see self against final after release, respond, and dispute; the facilitator records a tracked outcome.
6. Every export of a report is recorded; the documentation states what file access defeats.

Not claimed: access control against anyone who can read the reports directory. Until EPIC-0002 supplies identities and a server-side participant channel, the trust boundary is the facilitator's machine and user account (section 10).

## 2. Terms

- **Draft layer:** the immutable files `pnpm evaluate` writes (`acr.report/1`).
- **Review:** the human layer on top of one evaluation directory: a log plus the current view derived from it.
- **Subject:** a player role or `group`. Each is released on its own.
- **Current view:** the pure fold of the drafts and the review log.
- **Version:** a release or amendment of a subject, identified by the `seq` of the event that created it.
- **Principal:** who is acting or viewing: `facilitator`, `participant:<role>`; the inert audiences `line_manager`, `ld`, `hr`, `sponsor` exist only in the policy table.
- **Needs review:** a criterion that has any flag, is invalid, or has confidence below high.

## 3. Layers and the review log

**Draft layer.** The files in `<out>/<session-id>/` are never modified. The writer also changes: new drafts print "Draft, not reviewed by a facilitator" and no longer claim "visible to all participants" or "editing is planned"; directories written before this change are treated as legacy drafts (section 12).

**Review log.** `review.jsonl` in the same directory, owner-only (0600), created exclusively, written through a small dedicated `ReviewLog` built from the same primitives as the session log (exclusive create, no symlink following, fdatasync, directory fsync, byte-capped reads). It does not generalise `JsonlEventLog`: that module requires session event types and a session id on every line, and changing the safety-critical session log is out of scope.

**Header event `review.opened`.** Records: schema `acr.review/1`; policy version; session instance (the SHA-256 of the session log and its start time, because session ids are reused, `local` by default); scenario id and the scenario file hash; rubric hash; the SHA-256 of every draft file; and a snapshot of the per-role join-code records (salt and hashes only, never codes), because the live codes file is replaced when the next session starts. If any draft file no longer matches its hash, every review command refuses.

**Events.** Every event has a contiguous `seq`, an injected-clock timestamp (ordering uses `seq`, never the timestamp), an actor and a type:

| Event               | Payload                                                                    | Allowed when                                     |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `score.edited`      | subject, criterion, `from`, `to` (1 to 4 or Not observed), reason          | subject not released                             |
| `rationale.edited`  | subject, criterion, `from_hash`, new text, reason                          | subject not released                             |
| `summary.edited`    | subject, new summary (strengths, development points, next actions), reason | subject not released                             |
| `comment.added`     | subject, optional criterion, text, `visibility` (`internal` or `feedback`) | any time                                         |
| `score.accepted`    | subject, criterion                                                         | subject not released                             |
| `self.rated`        | role, criterion, level or none, optional note                              | before that subject's release; the last one wins |
| `report.released`   | `subjects[]` (one event even for several), `version` = its own `seq`       | gate passes (section 4)                          |
| `report.amended`    | subject, reason, based-on version                                          | subject released                                 |
| `report.withdrawn`  | subject, reason                                                            | subject released                                 |
| `response.added`    | role, optional criterion, text, optional `dispute: true`                   | after that subject's release                     |
| `dispute.resolved`  | response `seq`, outcome (`upheld`, `amended`, `declined`), reason          | a dispute exists                                 |
| `report.exported`   | subject, version, principal, destination label                             | subject released                                 |
| `review.superseded` | the replacement directory's draft hashes                                   | section 5                                        |

**Fold.** `currentView(drafts, events)` is pure and total. It produces, per subject and criterion: the AI level, the current level, the edit history, the status (`needs_review`, `accepted`, `edited`), the self-rating, the responses and disputes; per subject the release state and version history; and learning-objective scores recomputed with the existing pure `aggregateObjectives`, fed each criterion's mapped LO ids from the draft JSON. The fold itself rejects illegal sequences (an edit or self-rating after release, a release that fails the gate, a dispute without a response, a non-contiguous `seq`); a log that fails the fold is a corrupt review and every command refuses, so a hand-edited log cannot render.

**Concurrency.** Every command takes one lock for the check and the append (the existing single-writer lock applied to the reports directory). `score.edited` is compare-and-set: `from` must equal the folded current level or the command refuses and prints the current level. `release --all` appends one event. A crash cannot leave a partial multi-subject release.

**Limits.** Reason 1 to 500 characters; comment, response and note 1 to 1,500 characters (below the renderer's 600-character cell cut so nothing is silently truncated: cells wrap long text across lines or the renderer shows the full text, decided in the plan); at most 10,000 events; the log is read with a byte cap. All free text passes the existing hidden-character strip (`stripHidden`) and secret scrubbing (`scrubDeep` with the current secrets) before it is stored, and the Markdown renderer escapes it (`safeMd`). `--by` names are validated like ids.

**Tamper resistance.** The draft hashes catch accidental change and a mismatched directory. They do not stop someone who can rewrite both the drafts and the log. Each event carries `prev`, the SHA-256 of the previous line, which catches edits in the middle of the log but not a full rewrite. The documentation says this in the style `THREAT_MODEL.md` uses for resume: anyone who can write the reports directory can forge a review.

## 4. Moderation and the release gate

**Needs review (rule).** A criterion needs review if it has any flag, is invalid, has confidence below high, or sits in a learning objective marked incomplete. Flags are free text in the drafts today (`parse.ts`); the plan adds structured flag codes to the draft JSON, and until a draft carries them every non-empty flag list counts.

**Gate.** `release` succeeds only if, for each named subject: every criterion that needs review has been accepted or edited; the evaluation did not fail (a failed subject can be released only after the facilitator has scored every criterion by hand, and the report is labelled "Facilitator-scored"); no `summary.edited` is pending for a score edit the facilitator chose to leave stale (see below); and the subject is not already released. Otherwise the command exits 1 and lists what is unresolved.

**Stale summary.** After any `score.edited` on a subject, the AI summary is marked "may be out of date (a score was changed)" in every report until the facilitator issues `summary.edited` or explicitly accepts the summary (`accept <subject> --summary`). Release requires one of the two.

**Group report.** Edits to a player change the group report's per-role learning-objective table. A group release freezes the table as of its own `seq`; a later player edit marks the released group report "per-role table out of date" for the facilitator and requires an amendment to refresh it.

**Commands (`pnpm moderate <reports-dir> ...`):** `status`; `edit <subject> <criterion> --level N|na --reason "..." --by <name>` (with `--rationale "..."` to change the text in the same event); `edit-summary`; `comment [--feedback]`; `accept <subject> <criterion> | --all-high | --summary`; `release <subject> | --all`; `amend <subject> --reason`; `withdraw <subject> --reason`. All write commands require `--by`.

**Rendering.** Reports are rendered from the current view. An edited criterion shows "Facilitator-adjusted", the AI's original level and the reason; the method note says the report was human-moderated by the named facilitator and states the stamp as "AI draft calibration" (US-0039), so the calibration of the AI judge is never read as the calibration of the final score. Unmoderated drafts keep the draft banner.

## 5. Re-runs and supersede

`pnpm evaluate` always writes a new directory (`<id>`, `<id>-2`, ...). A review is bound to one directory. Rules:

1. `moderate` refuses to open a review on a directory when an older directory of the same session instance (same log hash) already has a review with any release, unless the command is `moderate supersede <old> <new>`.
2. `supersede` appends `review.superseded` in the old review and opens the new review with a carried-forward record: for each subject whose draft is byte-identical in both directories, the moderation is copied (as events marked `carried_from`); a subject whose draft changed starts unreviewed. Released subjects stay released in the old directory and are not visible from the new one until released there.
3. A directory whose review is superseded is read-only and shows "superseded by <new>".

## 6. Visibility

**Policy (constant table, versioned).**

| Subject         | Audience (after release)                            |
| --------------- | --------------------------------------------------- |
| Personal report | the participant, line manager, facilitator, L&D, HR |
| Group report    | the same plus programme sponsor                     |

`canView(principal, subject, version, view)` is one pure function. The facilitator sees everything. An unreleased, withdrawn or superseded subject is visible only to the facilitator. A participant sees their own personal report. For the group report and `index.md` a non-facilitator sees team-level criteria and, in the per-role learning-objective table, only their own row; peers' individual scores are removed (not blanked) from the rendered file. L&D, HR, sponsor and line manager are in the table but cannot be resolved to a person until EPIC-0002, so `canView` returns false for them in every shipped command; the table is data, not a principal model.

**Policy version and consent.** `review.opened` records the policy version. Sessions recorded before this change were played under "visibility: all participants"; a review opened on such a session uses the narrow policy (participant and facilitator only) and the report says so. Widening to line manager and HR for a session needs a policy version recorded with the owner's consent text, which belongs to the consent screen in EPIC-0002.

**Superseded decisions.** This replaces "participants may see each other's scores for now" (EPIC-0005 notes in `docs/RELEASE_PLAN.md`) and the visibility line of AC-0106. Legacy directories are labelled as legacy drafts and are facilitator-only by convention (the documentation tells the facilitator not to distribute them).

**Exports.** `pnpm report export <reports-dir> <subject> --for <principal>` renders the viewer-specific version through `canView`, writes it to a named destination, and appends `report.exported` with the version. Viewing is not audited: reports are plain files and `cat` bypasses any "viewed" event, so a view event would be fiction. The documentation states that readers with file access are not audited, and why export is the audited path. Named shares are out of scope (an unauthenticated name means nothing without SSO).

## 7. Self-assessment, response and dispute (facilitator-attested)

**Self-rating.** `pnpm self-assess <reports-dir> --role R --by <facilitator>`: the facilitator runs it, or sits with the participant while they do. The command prints the rubric criteria and level anchors only, never scores, AI rationale or other participants' data. Events record `actor: participant:<role>` and `attestedBy`. Accepted only before that subject's release; the last rating wins. A join code is never taken on a command line (it would sit in shell history and the process list; threat model item 7); the attested path does not need one.

**At release.** The released personal report shows self against final per criterion. A self-rating never changes the score.

**Response and dispute.** After release a participant (attested) adds a response per criterion or overall; marking it `--dispute` sends it to the facilitator's `status` list. The facilitator resolves with `dispute.resolved` (outcome and reason). `amended` must be followed by an `amend` of that subject; `upheld` and `declined` leave the score. The released report shows responses and the dispute outcome to the same audience as the report. Facilitator comments are internal unless marked `feedback`; only `feedback` comments appear in participant-visible renderings.

**Why attested.** A participant who types a code into a shell on the facilitator's machine can read every draft (same OS user), which defeats both blindness and isolation. Attestation is honest about the trust boundary and adds no network surface. EPIC-0002 replaces it with real logins; the event shapes do not change.

## 8. Reports, data and compatibility

- Drafts stay `acr.report/1`; the S-16 check that reads them keeps passing. New drafts carry the structured flag codes and per-criterion mapped LO ids (additive fields) so the fold can recompute objectives without the scenario files.
- The renderers take the status, banner and visibility line as parameters (today they are literals: `status: "draft"`, `DRAFT_BANNER`, `VISIBILITY_LINE`) so the same code renders drafts and views. Rendered views use a new `acr.view/1` JSON with `ai_score`, `final_score`, `adjusted`, `reason`, `by`, `self`, `responses`, `version`.
- The loader that reads draft JSON for review validates it like any untrusted input (schema, sizes, ids).
- Mock demos stay deterministic: the fold is pure, the clock is injected, and demo checks S-01 to S-16 and the counts 29 / 39 / 42 / 14 / 15 are unchanged. One new offline check (S-17 or the next free id) drives a scripted review end to end and verifies the access matrix.
- The calibration stamp (US-0039, PR #43) is a prerequisite: `review.opened.rubricHash` comes from the drafts' `evaluator.rubricHash`.

## 9. Error handling

Every command exits 0 on success, 1 on a refused action that the user can fix (unresolved review items, compare-and-set mismatch, illegal state) and 2 on usage or input errors (bad flags, unreadable or corrupt files, hash mismatch). Messages say what to do next and never include absolute paths, secrets or free text from other participants. A corrupt log is reported as such; no command repairs it.

## 10. Security and privacy notes

- Trust boundary: the facilitator's machine and user account. Drafts, logs and exports are readable by anyone with that access. This is documented, not hidden.
- Free text from facilitators and participants is stored after hidden-character stripping and secret scrubbing and rendered through the escaping used for all report text.
- Join-code hashes are copied into the review at open; they are never printed and never accepted on a command line.
- The review log holds personal free text. Retention and deletion belong to ADM-03 (EPIC-0002+); until then the documentation tells the operator to delete the reports directory when the programme requires it.
- An agent never runs `release`, `amend` or `withdraw` unless the owner explicitly names the subjects, in the spirit of L-0019. The rule goes into `AGENTS.md` and `docs/EVALUATOR.md`.

## 11. Stories (ids reserved when the plan is written)

1. **Review log and moderation.** `ReviewLog`, fold, `moderate status/edit/accept/comment/edit-summary`, rendering from the current view, structured flags and mapped LO ids in drafts, supersede rules. Size: L.
2. **Release gate, amend and withdraw, export audit.** Gate, versions, `report.released/amended/withdrawn/exported`, `pnpm report export`. Size: M.
3. **Visibility.** Policy table, `canView`, group report and `index.md` redaction, legacy and policy-version handling, the offline demo check. Size: M. Must land before story 4 (blind rating is not blind while every draft is readable).
4. **Self-assessment, response and dispute.** `pnpm self-assess`, response, dispute, resolution. Size: M.

Order: US-0039 (PR #43) merged, then 1, 2, 3, 4. Each story is its own branch, review loop and PR.

## 12. Testing

Fold tests over legal and illegal event sequences (including property-style shuffles that must be rejected); tamper tests (changed draft, broken `prev`, non-contiguous `seq`); concurrency tests (two writers racing an edit and a release, compare-and-set); gate tests for every release precondition including the stale summary and the failed-subject case; an access matrix covering every principal against every state (draft, released, amended, withdrawn, superseded, legacy); redaction tests proving no peer score is present in any byte of a participant's group report or index; CLI tests for every command and exit code; export audit tests; hostile-input tests for free text and `--by`; Linux container run for the file and lock tests (AGENTS.md section 8); no absolute-time assertions.

## 13. Review findings folded in, and decisions

Owner decisions (2026-10-22): engine and CLI now; full audience policy with partial resolution; blind self-rating then response; review flagged items before release (extended to anything below high confidence); append-only review log; facilitator-attested participant entry; peers redacted from group report and index for non-facilitators; amend with versions after release.

Architect review (Opus, 2026-10-22) findings addressed: concurrency rules and compare-and-set; separate `ReviewLog`; binding to the session instance and join-code snapshot; re-run and supersede rules; export audit instead of view audit; disputes; amend and withdraw; medium confidence; stale AI summary; group report redaction; superseded earlier visibility decisions; visibility before self-assessment; cut named shares, view events and the principal model for inert audiences; four stories; US-0039 as prerequisite.

## 14. Open items for the plan stage

- Whether the renderer wraps long comments or shows them whole (section 3, limits).
- The exact structured flag codes (derived from the flags `parse.ts` emits today).
- Name and number of the new demo check.
- Whether `moderate` and `report export` and `self-assess` are one CLI with subcommands (the calibrate pattern) or three scripts; the plan should follow `pnpm calibrate`.
