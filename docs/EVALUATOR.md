# Post-session evaluator

The evaluator turns a recorded session into draft feedback: a score per criterion for each player, a score per criterion for the team, learning-objective results, and a personal report for each player plus a group report with talking points for the facilitator. It is the first version of EPIC-0005 (US-0028 to US-0031). Everything it produces is a **draft**: it is held for facilitator review, and the facilitator review is `pnpm moderate` (below); release to participants and self-assessment are planned follow-ups (ASM-04, ASM-07, ASM-09).

**Visibility: facilitator only until released.** Draft reports are for the facilitator. A moderated view marks each facilitator-adjusted score with the AI original and the reason, and is labelled "IN REVIEW" until it is released.

## Method

The scoring system is a **Behaviourally Anchored Rating Scale (BARS)**, a standard approach in learning and development: each level of each criterion is described by a written example of observable behaviour, so a score says what was seen rather than an impression.

| Level | Label | Meaning |
| --- | --- | --- |
| 1 | Not yet demonstrated | There was a clear opportunity to show the behaviour and it was absent from the participant's own words, or the participant worked against the aim |
| 2 | Developing | Parts of the behaviour were seen: partial, unplanned or inconsistent |
| 3 | Proficient | The behaviour was seen clearly and did its job |
| 4 | Advanced | The behaviour was seen at a high standard |
| N/O | Not observed | No opportunity to show the behaviour, or no usable evidence either way; no score, left out of every average |
| Invalid | Invalid (evaluator error) | The AI's answer for the criterion was unusable even after one re-ask (omitted, or a score that is not a whole number 1 to 4): left out of the averages and the learning objective is marked incomplete. Never the same as N/O |

There is no midpoint, to avoid the central-tendency habit of rating everyone as average.

- **Evidence rule.** Every score of **3 or 4 must rest on at least one verified quote**; a 1 or 2 may stand without one (flagged, Low confidence). A quote is verified by the program: `seq` must be an utterance by that role (any player for the group) and the quote, after whitespace is normalised and quote marks, ellipses at the edges and invisible characters are removed, must be an exact, case-sensitive substring of that recorded utterance. It needs at least 8 characters and a letter or digit; a quote that **keeps a 3 or 4 needs at least 15 characters and 3 words** (shorter verified quotes stay as flagged evidence for a 1 or 2). A quote contained in or overlapping an already accepted quote from the same line is dropped. A 3 or 4 with no qualifying quote is **capped at 2 and flagged**. A stored quote longer than 300 characters is cut to that length (still a verbatim prefix). Only the participant's own words are evidence for them (first-person-only rule).
- **What verification does not prove.** It proves a quote exists in the participant's own words, not that it shows the behaviour. A participant can write rating language into their own line to sway the scorer; evidence whose quote contains such language (score, rating, rate me, assessor, ignore ... instructions) is flagged in the report and caps nothing. Facilitator review is required.
- **Confidence** (High, Medium, Low) is the lower of what the number of DISTINCT lines with a verified quote supports (3 or more distinct lines High, 2 Medium, fewer Low; for a 3 or 4 only qualifying quotes count) and what the model said (a missing or unusable statement counts as Medium). A capped score is always Low. The model can lower a confidence but never raise it above the evidence.
- **Aggregation.** A learning-objective (LO) score is the mean of the observed scores of the criteria mapped to it **that are in scope** (individual criteria for a participant, group criteria for the team), rounded to one decimal. The label of the rounded value is: below 1.5 Not yet demonstrated, below 2.5 Developing, below 3.5 Proficient, otherwise Advanced. There is **no single overall grade**. An LO with no observed criterion is Not observed; one with an invalid criterion is marked incomplete. When no LO maps to a group criterion the group report says so and has no team LO table.
- **Limitations.** AI-drafted and needs facilitator review; a small sample (the scenario's player count, one session); one session is a snapshot, not a measure of general ability; only what was said is assessed; evidence is first-person only; roles with little opportunity for a criterion (a tech lead on commercial negotiation) will show Not observed; a long session may be trimmed before it is sent (the report says so).

The same text is printed in every report (`## How this was scored`), in `method.md`, and stored in every JSON file under `method`. Reports from the scripted offline evaluator say so (`demo: true` in the JSON, a note in every report and the index).

## Data flow

```
session JSONL log ──► readSessionLog (bounded, seq checked with the reducer)
scenario + rubrics ─► loadScenario / loadRubrics (validated)
        │
        ▼
buildTranscript: every utterance (players and AI characters, with seq, role, time, scene),
                 injects, scene boundaries and Game Master verdicts as context lines
        │  trimmed to EVAL_TRANSCRIPT_CHARS (a hard cap) when needed (every speaker keeps a proportional share; injects, Game Master
        │  lines and scene details are shortened or dropped too only if they alone exceed the budget, and the report says so)
        ▼
one model call per player role ──► strict JSON {criteria, strengths, development_points, next_actions}
one model call for the team    ──► strict JSON {criteria, talking_points, notable_moments}
        │  tolerant parsing (code fence, prose around the JSON), one bounded re-ask naming exactly what to fix
        ▼
normaliseCriteria: unknown ids ignored; an omitted criterion or a score that is not a whole number 1 to 4 (0, 5, 2.5, "none") is a
                   problem list for the re-ask and, if still wrong, an Invalid criterion (never N/O); quotes verified,
                   3/4 without a qualifying quote capped at 2, confidence derived from distinct lines
        ▼
aggregateObjectives (pure) ──► per-LO score and label
        ▼
reports: <out>/<session-id>/<role>.md + .json, group.md + .json, index.md, method.md
```

The model goes through the same provider path as the AI characters (`selectModelProvider`, the retry layer with the SDK's own retries off) and the same bounded reply collector (first-token timeout, overall deadline, abort).

**Prompt injection.** The transcript is data between delimiters that carry a random nonce, and the system prompt says to ignore any instruction inside it. Line breaks inside an utterance are folded to spaces, so a line cannot forge another speaker's line or a scene marker. Because quotes are verified programmatically and scores are checked, text in the transcript cannot make the evaluator invent evidence.

**Failure handling.** A participant with fewer than 2 utterances gets "insufficient evidence" (all Not observed) with no model call. A reply that cannot be used (not JSON, no criterion id matched) or that has fixable problems (an omitted criterion, a score that is not 1, 2, 3, 4 or null) is re-asked once, naming exactly what to fix and asking for shorter rationales; after the re-ask a reply with only fixable problems is accepted and those criteria are marked Invalid. A reply cut off at the token budget fails with "raise EVAL_MAX_TOKENS". If a participant's evaluation fails (timeout, error, or an unusable reply after the re-ask) their report says `evaluation failed: <reason>`, the other reports are still written, and the exit code is non-zero. The number of model calls is reported (re-asks count; retries of transient errors inside the provider do not). If writing the report files fails midway the partial directory is removed and the error says so. Next actions that name an unknown learning objective are dropped (the report notes it).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVAL_MODEL` | `NPC_MODEL` | Model for the evaluator |
| `EVAL_MAX_TOKENS` | `3000` | Token budget per evaluator call, `200` to `8000` |
| `EVAL_TEMPERATURE` | `0.2` | Sampling temperature, `0` to `2` |
| `EVAL_TIMEOUT_MS` | `180000` | Deadline per call, `500` to `600000`. The effective deadline is exactly `max(EVAL_TIMEOUT_MS, NPC_REPLY_TIMEOUT_MS)` (no other floor). The first-token wait is `max(NPC_FIRST_TOKEN_TIMEOUT_MS, 60 s)`, capped at the deadline |
| `EVAL_TRANSCRIPT_CHARS` | `60000` | Hard cap on the transcript sent in one call, `5000` to `400000` |

With `MODEL_PROVIDER=mock` (the default) the evaluator uses a **scripted offline evaluator** that answers from the recorded session: deterministic, nothing leaves the machine, and the scores are demo data. It deliberately includes one invented quote (dropped, and a 4 capped at 2) and one malformed reply followed by a valid one (the re-ask path).

## Running it

```bash
pnpm evaluate data/sessions/local.jsonl                       # scenario found by the id in the log; reports in data/reports/local/
pnpm evaluate data/sessions/local.jsonl --scenario scenarios/friday-escalation-extended --out reports
pnpm -s evaluate data/sessions/local.jsonl --json -           # a machine-readable summary on stdout
pnpm demo --showcase --fast --evaluate                        # the showcase, then the reports (check S-16)
pnpm demo --showcase --live --evaluate --eval-out reports     # live: sends the transcript to the provider, may cost money
```

Exit codes: 0 reports written, 1 an evaluation failed (reports for the others are still written), 2 usage or input error (bad flags, unreadable log, invalid scenario or rubrics, invalid settings). A one-line notice says the transcript is sent to the model provider. Reports are written into a fresh directory (`<session-id>`, then `<session-id>-2`, ...) with exclusive file creation: nothing is overwritten and nothing is written outside it.

Check **S-16** (only with `--evaluate`) reads the written files back and verifies that every player has a report, every quoted piece of evidence is a verbatim substring of an utterance in the recorded log (by that player for a personal report), the method section and visibility line are present, and every score is 1 to 4 or Not observed. The detail says "N of M players evaluated". In a mock run it also requires that the scripted evaluator did not fail; a **live run passes S-16 when at least one player was evaluated and the files verify**: evaluation failures of individual players are recorded as observations and in the `--json` `evaluation.failures`, not as a failed check. With `--live --evaluate` the showcase watchdog (the default 30 minutes, or an explicit `--watchdog`) is extended by the evaluator's worst case: `EVAL_TIMEOUT_MS` x (players + 1 calls) x 2 (each call may be re-asked), 24 minutes with the defaults and 3 players.

## Authoring rubrics

A scenario's `scenario.yaml` lists its rubrics (`rubrics: [individual_delivery_v2, group_collaboration_v1]`); each is a file `rubrics/<id>.yaml` in the scenario folder.

```yaml
id: individual_delivery_v2          # must match the file name
name: Individual delivery performance under scope pressure
scope: individual                    # individual: scored per player; group: scored once for the team
version: "2"
criteria:
  - id: discovery                    # unique across all of the scenario's rubrics; lowercase, digits, _ or -
    name: Discovery
    description: Finds out what the client actually needs and why.
    what_to_look_for:                # observable indicators
      - Asks open questions about the purpose or the deadline
    levels:                          # all four are required
      1: { anchor: "Responds to the request as worded without asking anything." }
      2: { anchor: "Asks a closed or logistical question.", examples: ["Is Friday a hard deadline?"] }   # examples required at 2 and 4
      3: { anchor: "Asks about the purpose and reflects the need back." }
      4: { anchor: "Reframes around the need and tests it with the client.", examples: ["So what you really need is..."] }
```

Write anchors as **observable behaviour in the participant's OWN words**, for the scenario's persona, not as traits: an anchor must be something a quote from that participant can evidence. Avoid anchors that depend on other people's behaviour ("the other side agrees") or on pure absence; for level 1 write "there was an opportunity to ... and the participant's own lines contain no such behaviour", because level 1 is only right when there was an opportunity (otherwise the criterion is Not observed). Use "at least two of the following" for level 3 rather than requiring three behaviours at once, and make sure the level 2 to level 3 step is explicit. Give each criterion its own key behaviour so two criteria do not score the same sentence twice (state the individual versus team distinction in the descriptions). Keep examples generic: no scenario-specific figures or names. Put these two sentences in the file header: level 1 / Not observed as defined above, and "if a participant sits between two anchors, choose the lower only when the higher anchor's key behaviour is clearly missing". The validator (`loadRubrics`) checks the schema, that all four levels have an anchor, that criterion ids are unique, that levels 2 and 4 have example phrases, and that every `rubric_criteria` id of every learning objective names a criterion in a loaded rubric (an error otherwise). Learning-objective ids are 1 to 64 letters, digits, `_` or `-`. Files are size-capped (256 KiB) and limited in YAML aliases. A scenario whose `rubrics:` is empty loads as "no rubrics" with a warning (and cannot be evaluated). The two Friday Escalation scenarios carry identical copies of their rubric files (a test keeps them byte-identical).

## Reading a report

- **Summary.** Strengths, development points and 2 to 3 next actions, each tied to a learning objective (`LO1`...). The wording is the model's and should be read as a draft.
- **Learning objectives.** Each LO's score (one decimal) and label, and how many of its criteria were observed. A score based on one criterion of two is thinner than one based on both.
- **Criteria.** The level and its label, the confidence and the rationale. Flags in brackets matter: `capped from 4 to 2: no verified quote ...`, `N quote(s) could not be verified ... and were dropped`, `no verified quote`, `only short quotes`, `a quote contains rating language`. Not observed (N/O) is not a low score; `Invalid (evaluator error)` means the AI's answer was unusable and the learning objective is marked incomplete.
- **Evidence.** The verified quotes with scene number, time since the start of the session (wall clock, pauses included, not active scene time) and the line number (`#12` is the event sequence number in the log).
- **Group report.** Group criteria, LO coverage across the team (players by LO), the scenario author's facilitator notes next to the model's talking points, and notable moments.
- **index.md** links everything and shows the LO table for everyone.
- **Calibration stamp.** One line in `index.md`, `group.md` and every personal report (and, with the prompt variant and the rubric hash, in the `evaluator` block of each JSON file: `variant`, `rubricHash`, `calibration` and `calibration_line`). It states what `pnpm calibrate` measured for this judge model, prompt variant and rubric, and nothing more; it never says the scores are accurate. It has four states:
  - **Calibrated** ("Scored by `<model>`, prompt `v1`. Calibration on 40 probes (2026-01-15): 36 of 40 exact, bias +0.2 levels, 5 of 5 contrast groups ordered, label PASS." The numbers here are invented for illustration. A positive bias means the judge scores more leniently than the labelled probes, a negative one more harshly.): a summary file for this exact model and variant exists, its rubric hash matches the current rubrics, and the numbers are not thin. The label (PASS, WARN or FAIL) is the one `pnpm calibrate` gave that judge, so a FAIL judge is stamped as such.
  - **Thin** (the same line plus "Thin: ..."): treat the numbers as indicative only. A result is thin when it rests on fewer than 20 probes, or when contrast was measured on fewer usable groups than there were contrast probes, or on fewer than 3 groups (the line then says "contrast was measured on few groups"; the contrast count is printed either way).
  - **Stale** ("not calibrated for this rubric or prompt version"): the rubric hash or the prompt variant in the summary differs from the current one, so the old numbers say nothing about this run.
  - **Not calibrated**: no summary for this model (EVAL_MODEL, else NPC_MODEL), a file that is missing, corrupt or of the wrong shape, or a file that names another model. The scripted offline evaluator (`MODEL_PROVIDER=mock`) is always "not calibrated", without a lookup.

  The summary is read from `data/calibration/<scenario-id>/` next to where you run `pnpm evaluate`. A missing or corrupt file never breaks a report. Only `pnpm calibrate` writes it, and only after a complete run, so the stamp is as current as your last full calibration. Every Markdown report also has a "Prompt variant ..., rubric ..." row (a line in `index.md`), and the JSON records the model (EVAL_MODEL, else NPC_MODEL), variant and rubric hash. Prompt variants other than `v1` do not exist yet (US-0038), so the variant is always `v1`. Bump the prompt variant whenever the evaluator prompt or parser changes: a calibration only goes stale when the rubric or the variant changes.

## Moderating a report (`pnpm moderate`)

`pnpm moderate <subcommand> <reports-dir> [options]` is the facilitator's review of a draft directory written by `pnpm evaluate`. It writes an append-only, hash-chained log (`review.jsonl`) beside the drafts and never changes a draft file. Paths (including `--to` of `export`) are relative to the repository root, because `pnpm` runs the command from there; use absolute paths from elsewhere.

```bash
pnpm moderate open data/reports/local --by kamal [--session-log data/sessions/local.jsonl] [--codes-dir data/sessions]
pnpm moderate status data/reports/local
pnpm moderate show data/reports/local delivery_lead            # Markdown of the report as it stands, marked IN REVIEW
pnpm moderate edit data/reports/local delivery_lead discovery --level 3 --reason "heard it at 00:12" --by kamal [--rationale "new text"] [--expect 2]
pnpm moderate accept data/reports/local delivery_lead discovery --by kamal   # or: accept <dir> <subject> --summary --by kamal
pnpm moderate comment data/reports/local delivery_lead --text "good scene 2" --by kamal [--criterion listening] [--feedback]
pnpm moderate edit-summary data/reports/local delivery_lead --reason "tighter" --by kamal --strength "..." --development "..." --action "LO2:State two options"
pnpm moderate release data/reports/local delivery_lead tech_lead --by kamal   # or: release <dir> --all --by kamal
pnpm moderate amend data/reports/local delivery_lead --reason "new evidence" --by kamal
pnpm moderate withdraw data/reports/local delivery_lead --reason "wrong session" --by kamal
pnpm moderate export data/reports/local delivery_lead --for facilitator --to out/delivery_lead --by kamal
pnpm moderate export data/reports/local delivery_lead --for participant:delivery_lead --to out/mine --by kamal   # or: group | index
pnpm moderate supersede data/reports/local data/reports/local-2 --by kamal   # after a re-run of a released session
```

**Reading order.** `open` once per directory, then `status` to see what needs review, `edit` or `accept` per criterion (and `accept --summary` or `edit-summary`), `comment` for notes, and `show` to read the report as it stands before you move on.

A subject is a player role or `group`. `--level` is 1 to 4 or `na`; every edit needs a `--reason` (up to 500 characters); `--expect <level>` makes an edit a compare-and-set (refused, with the current level shown, if the score changed meanwhile). `--feedback` makes a comment visible to the participant once released; otherwise it is internal. `open` refuses a directory that holds files `pnpm evaluate` did not write (the message names the file); move them out.

Free text is stored after hidden characters are stripped and secrets and machine paths are scrubbed. Line breaks in `--text`, `--reason` and the like are stored as a visible ` ⏎ ` marker, so one comment is always one line and cannot forge a log or report line. Exit codes: 0 done, 1 refused (fix and retry), 2 usage error or damaged review or draft file. Any unexpected failure prints a short generic message and exits 2.

**Releasing, versions, amending and withdrawing (US-0042).** `release` is the gate between a draft and a report that may be shown to a participant. It succeeds only if, for every subject named (or every subject still in draft or amendment with `--all`):

- every criterion that needs review has been accepted or edited;
- if the AI evaluation of that subject failed, the facilitator has scored every criterion by hand;
- the summary is not out of date after a score change: it has been edited (`edit-summary`) or accepted (`accept <subject> --summary`);
- the subject is not already released, and is not withdrawn.

Otherwise the command exits 1, lists every unresolved item of every named subject and writes nothing. Naming several subjects, or `--all`, is one event: all are released or none. A release makes **version N**, where N is the sequence number of the release event, and freezes a snapshot of the scores, rationales, summary, learning-objective results and the comments made before the release (comments added later are not part of that version). While a report is released, scores, accepts and summaries cannot change (exit 1). Participants keep seeing the last released snapshot (US-0043 builds that view) while an amendment is open.

`amend <subject> --reason` (based on the current version) reopens a released report for edits; the next `release` makes a new version, and earlier versions stay in the log. `withdraw <subject> --reason` takes a released report back; it is terminal (an amended report can be withdrawn, a withdrawn one cannot be amended or released again). A group report's per-role learning-objective table is built from the players' last released snapshots and frozen when the group is released; a later release or withdrawal of a player marks it out of date, and amending and re-releasing the group refreshes it. `status` shows "per-role table out of date" on the group, `show group` and the group export carry the same note, and `release` and `withdraw` print a hint when they caused it.

**Agents: never release for yourself.** An agent never runs `pnpm moderate release`, `amend` or `withdraw` unless the owner explicitly names the subjects.

**Export and its audit.** `export <subject> --for facilitator --to <dir> --by <name>` writes the subject's last **released** snapshot (never the live draft or an unfinished amendment) as `<subject>.md` and `<subject>.json` (`acr.view/1`) into `<dir>`, rendered through the same safe renderers as `show`, with the banner "Released (version N)" (the version is in both files) and secret values redacted in the JSON as in the Markdown. Version and content are taken from the same locked read of the log. `--to` is a new directory (created exclusively with mode 0700; if it appears meanwhile the export fails and nothing in it is touched) or an existing plain directory that does not already hold those two names. Files are mode 0600, created exclusively, written under a temporary name and then linked into place: nothing is overwritten, a symbolic link at the destination or at a file name is refused and never followed, and a failure leaves no partial file: only files this run created are removed, and the directory only if this run created it and it is empty (never a recursive delete). The destination is checked again (not a symbolic link, real path unchanged) right before the files are staged; a swap in the few microseconds between that check and the writes is a residual window that file access to the output parent would be needed to exploit. Export text is scrubbed as strictly as `show` (hidden and control characters removed, secrets and home or temp paths redacted) in both files. `--for` takes `facilitator` or `participant:<role>`; a malformed principal exits 2, and every other audience (line manager, L&D, HR, sponsor) is refused with exit 1 because it cannot be identified yet. The event `report.exported` (subject, version, principal, a label made from the destination's last name, never the path) is appended **before** any file is written: a record of an export that then failed is safer than an export nobody recorded. If the files then cannot be written the command exits 2 and says that an export event was recorded in the review but no files were produced. A refusal that can be seen up front (draft subject, existing file, symlinked destination) exits 1 and records nothing.

**Export for a participant (US-0043).** `export <subject|group|index> --for participant:<role>` goes through the audience policy (`canView`). The role must be a participant of this review. A participant gets only their own report, the group report and the index, and only once released; during an amendment of an already-released version they keep getting the last released snapshot (the facilitator's own export of an amending subject stays refused). The file is built from the snapshot frozen at the release only: a score, rationale, summary or comment changed after the release, an internal comment, or an unfinished amendment never reaches it, and a feedback comment appears only after the release that follows it. Review state (accepted, rationale edited, needs review, summary state, out-of-date notes) is removed from the JSON and the Markdown; only the "Facilitator-adjusted" disclosure remains. The participant's group report has the other players' individual results removed (not blanked) and no facilitator notes, talking points or moment notes. `index` is a list of what that participant may read (their own report if released, the group report, and a table of their own and the team's learning-objective results); it follows the group's state, so a participant cannot get `index.md` until the group is released, and an `index` export is audited under subject `group`. The facilitator's `index` export lists every subject with its state and open items and also needs a released group. The audit event records the principal (`participant:<role>`) and the destination label; the fold accepts only `facilitator` or `participant:<role of this review>` there.

**Viewing is not audited, and why.** Only `export` (a copy leaving the review) is recorded. `show` and reading the report files are not: the reports directory is plain files, so anyone who can read it can read a report with `cat` and no command could log that; recording some reads would suggest all of them were recorded.

**Re-runs and `supersede`.** A second `pnpm evaluate` of the same session writes a new directory. While no earlier directory of that session has a release, `open` works on it freely. Once one has been released, `open` on a sibling is refused (exit 1) and tells you to run `supersede <old> <new> --by <name>`. Supersede copies the moderation (score and summary edits, accepts, comments) of every subject whose draft file is byte-identical in the new run, marks the copies `carriedFrom`, and starts changed subjects clean (it prints both lists). The new review is written first and the old one is marked superseded last, so a crash leaves the old review live; the old review is then read-only. Directories are matched by session id and `startedAt`, not by log hash (a new directory has no log yet; a deliberate deviation from the spec). A sibling directory of the session whose `review.jsonl` is damaged (cut-off line, broken chain, forged opener) makes `open` fail with exit 2 naming the directory (`supersede` does not look at siblings, only at the two directories you name), because its release state cannot be known; a directory with no log is skipped. Subjects the earlier review has but the new run does not are listed in the output ("not in the new run") and their moderation is not carried. `supersede X X`, or two spellings of one path, is a usage error (exit 2).

**After a crash.** The two writes are not atomic. If the process dies between them, the new directory already holds its review (the copies) while the old one is not yet marked superseded, so **both reviews are briefly live**. Nothing is lost: the old review is untouched. Run the same `supersede <old> <new> --by <name>` again: when the new log is exactly the copies that command would write, it only appends the missing marker to the old log and prints "completed an interrupted supersede". Any other review in the new directory is refused with a message saying so. Stuck cases: if the crash happened while the new log was being written, `review.jsonl` in the new directory may end in a cut-off line, and `supersede` refuses it (exit 2, naming the directory); the file then holds only copies, so move it aside and run supersede again. A new log that holds only some of the copies is not completed automatically: move it aside the same way. A successful completion says that the new review already held the opener and the carried copies and that the earlier review is now marked superseded.

**Limits worth knowing.**
- Sibling detection looks only in the same parent directory as the new one; a re-run written to another directory bypasses the refusal on `open`.
- A rationale-only edit at the same level is refused by design: a rationale changes in the same event as the level (`edit --level ... --rationale ...`).
- The session binding is the session id plus `startedAt`. The session log's SHA-256 is recorded only when you pass `--session-log` and is not re-verified later.
- `supersede` also works on a review that was never released.

**What file access defeats.** The review is plain files. Anyone who can write the reports directory can forge a review: the hash chain catches an edit in the middle of the log, a changed draft file or a cut-off line, but not a rewrite of the whole log or cutting whole lines off its end (the chain has no key, so a truncated tail is undetectable), and `cat` of a report is not audited. The `--by` name is a label, not an identity. Treat the reports directory like the session logs (see `docs/THREAT_MODEL.md`).

## Calibration

`pnpm calibrate` measures how far the evaluator's scores can be trusted, per judge model. It feeds **probes** through the real evaluator (the same prompt, parser and quote verification that score real sessions) and compares what the judge answers with what a human expects.

**A probe** is a short synthetic transcript with a human-assigned expected level for one criterion, in `scenarios/<id>/calibration/<probe-id>.yaml` (the file name is the id). A `single` probe expects one level (or `not_observed`) for one player; a `contrast` probe expects different levels for two or more players in the same conversation, which is what tests discrimination. Probes may contain only demo or synthetic text (the repository is public).

```yaml
kind: single                  # single | contrast
id: disc-l1                   # 1 to 58 of a-z, 0-9, _ or -; must match the file name
criterion: discovery          # an individual criterion of the scenario's rubrics
source: handwritten           # handwritten | drafted | excerpt (drafted needs drafter, approved_by, approved_at; excerpt needs approved_by, approved_at and no drafter)
split: tune                   # tune | holdout (stored, never recomputed)
subject: delivery_lead        # single: the player scored
expected: 1                   # single: 1 to 4 or not_observed
acceptable: [1, 2]            # optional; defaults to [expected]
transcript:                   # 2 to 80 lines; every scored player needs at least 2 lines
  - { scene: s2_client_call, role: client_sponsor, text: "Can you confirm that today?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that for you." }
  - { scene: s2_client_call, role: delivery_lead, text: "Consider it done; we keep the launch date." }
# contrast instead of subject/expected/acceptable:
#   kind: contrast
#   players: { delivery_lead: 4, account_manager: 1 }
#   min_gap: 2                # required level difference between adjacent players
```

**Writing probes: rules the loader checks.**

- An `excerpt` probe (a real, redacted session range) needs `approved_by` and `approved_at` (an ISO-8601 datetime such as `2026-10-08T09:30:00Z`), because a human assigned its level; its `drafter` stays empty. A `drafted` probe needs `drafter` too.
- Every speaker of a line must be a participant of that line's scene in `script.yaml` (a role that is not in the scene is an error).
- No line may contain a hidden fact of a role (a fact of 20 characters or more, compared ignoring case and spacing): the model would be judging a leak. The error names the role, never the fact.
- No line may contain invisible or bidirectional characters ("Trojan Source", "ASCII smuggling"), and neither may `drafter` or `approved_by`: they would make the text you review differ from the text the judges read. Refused, from one table (`services/runtime/src/calibration/hidden-chars.ts`): C0 controls other than tab and newline, DEL and the C1 controls, the soft hyphen U+00AD, U+034F, U+061C, the Hangul and Khmer fillers (U+115F, U+1160, U+17B4, U+17B5, U+3164, U+FFA0), U+180E, U+200B to U+200F (zero-width space, the zero-width **non-joiner and joiner U+200C and U+200D**, direction marks), U+2028 to U+202E (line and paragraph separators, bidi embeddings and overrides), U+2060 to U+206F (word joiner, invisible operators, bidi isolates), U+2800, the variation selectors U+FE00 to U+FE0D, U+FEFF, U+FFF0 to U+FFFB, the Egyptian hieroglyph, shorthand and musical format controls (U+13430 to U+1343F, U+1BCA0 to U+1BCA3, U+1D173 to U+1D17A), the tag characters U+E0000 to U+E007F and the unassigned U+E0080 to U+E00FF and U+E01F0 to U+E0FFF. The list is curated: it is not the whole Unicode Default_Ignorable_Code_Point property. The error names the line (`transcript line <n> contains hidden or bidirectional control characters`); drafted replies and excerpts containing them are refused before anything is written. The hidden-fact check folds case, spacing and compatibility forms (NFKC: fullwidth letters) and strips these characters and every variation selector (U+FE00 to U+FE0F, U+E0100 to U+E01EF) before comparing, so a fact with invisible characters inside it is still caught. **Known limit:** it does not catch look-alike letters (a fact retyped with Cyrillic а, е, о is not detected); the human review is the guard there. Fine: accents, Cyrillic, CJK, Arabic, Hebrew and Indic scripts, emoji (with skin-tone modifiers and the presentation selectors U+FE0E and U+FE0F; the supplementary variation selectors U+E0100 to U+E01EF are allowed too), curly quotes, dashes and visible spaces (U+00A0, U+2000 to U+200A, U+202F, U+205F). Not supported, because they need U+200C or U+200D: ZWJ emoji sequences (families, professions) and Persian or Indic text that relies on ZWNJ/ZWJ.
- Balance (warning): with 8 or more expectations, each of levels 1 to 4 should hold 15% to 40% of them (single probes' `expected` and every contrast player). The older mid-heavy warning stays.
- Unscored speakers (warning): the evaluator scores every player with 2 or more lines, so a player who speaks twice but is not the subject or a contrast player costs a model call whose result is dropped; give them one line or make them a subject.

**Drafting, reviewing and approving probes.** Hand-written probes are always allowed. To get candidates faster, the workflow is **draft (or excerpt) → human review → owner approval**; nothing a model writes ever reaches a run without that approval.

```bash
pnpm calibrate draft --scenario scenarios/friday-escalation --drafter drafter,qwen3-30b-a3b,http://127.0.0.1:1234/v1 --criterion discovery --subject delivery_lead
pnpm calibrate excerpt --scenario scenarios/friday-escalation --log data/sessions/<session>.jsonl --from 40 --to 58 --subject delivery_lead --criterion discovery --id excerpt-disc-01
pnpm calibrate approve --scenario scenarios/friday-escalation --draft draft-discovery-l2-1 --by "Kamal Syed"           # drafted: --expected optional
pnpm calibrate approve --scenario scenarios/friday-escalation --draft excerpt-disc-01 --by "Kamal Syed" --expected 3    # excerpt: --expected required
pnpm calibrate assign-splits --scenario scenarios/friday-escalation
```

- **`draft`** asks a drafter model (`--drafter label,model[,baseUrl]`, required: no model is called without it; an OpenAI-compatible server like a second judge, `LOCAL_API_KEY` only for the `LOCAL_BASE_URL` host) for one candidate transcript per individual criterion (or `--criterion`), per level 1 to 4 and per `--per-level` (1 to 3, default 1); it prints the planned call count (criteria x 4 x per-level) first. The drafter must be of a **different model family** from the primary judge (`EVAL_MODEL`, else `NPC_MODEL`), because a judge scoring its own family's drafts measures self-agreement; `--allow-same-family` overrides this, and is also needed when the primary model is not set. The prompt carries only public scenario data (title, context, role ids, AI characters' name, title and persona, scene ids and participants) and the target anchor verbatim; never a hidden fact, an `earned_when` condition, a player's brief or private facts, or the facilitator notes. An unknown `--subject`, or a criterion id over 47 characters (its draft id `draft-<criterion>-l<level>-<n>` would exceed 58), is refused with exit 2 before the planned call count is printed. Each reply is capped at 64 Ki characters (UTF-16 code units) and 8 lines and checked like a probe (known scenes and roles, speakers in their scene, the subject with at least 2 lines, no hidden fact, no prototype keys); a failing, hanging (`EVAL_TIMEOUT_MS`) or invalid reply is reported (`draft <id>: <reason>`) and skipped, the others are written (exit 1 when some failed). Drafts go to `calibration/drafts/draft-<criterion>-l<level>-<n>.yaml` (numbered after existing drafts and probes, created exclusively with mode 0600 in a 0700 directory; a symbolic link in place of `calibration/` or `drafts/` is refused) with `source: drafted`, the drafter's model id, no approval and no split. `--subject` picks the player (default: the first player role by id).
- **`excerpt`** cuts a draft from a real session log (`--log`, a `.jsonl` file, read with the usual size cap): the utterances with event seq `--from` to `--to`, each with the scene active at that seq. It has no `expected` level (a human rates it at approval) and `source: excerpt`. It refuses a subject with fewer than 2 lines in the range, a line spoken outside any scene, a range outside the log, a log of another scenario, more than 80 lines, an id that is not file-safe or longer than 58, and a range in which an AI character says one of its hidden facts (`excerpt contains a hidden fact of <role>: choose another range`; the fact is never printed). **A real customer session needs consent and redaction first** (AGENTS section 12): the repository is public.
- **Review**: open the draft, check that the subject's lines show exactly the expected level (no higher), edit freely. `calibration/drafts/` is git-ignored and never read by a run.
- **`approve`** is run by the owner. An agent may run it only on the owner's explicit instruction naming the items to approve, and the approval records that (see Limits). It refuses (exit 2) a `calibration/` or `calibration/drafts/` that is a symbolic link or a file, before reading or deleting anything. It reads the draft, records `approved_by` (`--by`, 1 to 120 printable characters) and `approved_at` (now, ISO-8601), takes `--expected` (required for an excerpt; for a drafted probe it overrides the drafted level), assigns a split when the draft has none (`assignSplit(id, n + 1)`, n being the probe files in `calibration/` that parse as probes), and checks the result exactly like the loader (schema and every rule above), listing every problem when it refuses. The final id is the draft id without `draft-` (or `--id`). It writes `calibration/<id>.yaml` exclusively (it never overwrites a probe) and only then deletes the draft, so a crash leaves the draft, or both (approve then refuses the duplicate and you delete the draft), never neither. A write that fails midway (a full disk) removes the partial file, for drafts, excerpts and probes alike, so no truncated file is left.
- **`assign-splits`** adds a `split` to every probe file that has none (deterministic from the id and the same count of probe files as approve, so both give a probe the same split; a `split: null` counts as missing, any other value that is not `tune` or `holdout` is reported and left alone), rewriting each such file atomically and keeping its comments; an existing split is never changed, and a file that does not parse is reported and left alone.

An invalid probe fails the run with a list of every problem (exit 2), before any model call. Targets can be overridden per scenario in `calibration/targets.yaml` (`contrastOrdering`, default 0.8; `maxAbsBias`, 0.3; `exactAgreement`, unset; `minUsable`, 0.9).

**Running it.** The primary judge is the evaluator's own configuration (`MODEL_PROVIDER`, its key, `EVAL_MODEL` or `NPC_MODEL`, the `EVAL_*` settings); `MODEL_PROVIDER=mock` is refused, because the scripted evaluator's numbers would mean nothing. An optional second judge on an OpenAI-compatible server is given with `--judge label,model[,baseUrl]` (without a base URL, `LOCAL_BASE_URL` is used; `LOCAL_API_KEY` is sent only to that same host). The judges run one after the other and never see each other's output.

```bash
pnpm calibrate --scenario scenarios/friday-escalation                       # primary judge only
MODEL_PROVIDER=local LOCAL_BASE_URL=http://127.0.0.1:1234/v1 NPC_MODEL=gemma-4-31b-it-qat-mxfp4 \
  pnpm calibrate --scenario scenarios/friday-escalation --judge second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1
pnpm calibrate --scenario scenarios/friday-escalation --repeat 3 --only disc-l1,listening-contrast-01
pnpm -s calibrate --scenario scenarios/friday-escalation --json - --strict  # CI style: JSON on stdout, exit 1 on any FAIL
```

**Run time.** Local models are slow: the full Friday set (34 probes, 282 planned calls) with two judges at `--repeat 3` took 6 h 24 min (23,018 s) on 2026-10-08, so start it where it can run unattended, or use `--only` and `--repeat 1` to try something small first.

Flags: `--repeat n` (1 to 5) scores every probe n times to measure the judge's own noise; `--only id,id` runs a subset; `--criteria all` (default) has the judge score every individual criterion as in a real evaluation, `probe` only the probe's criterion; `--variant v1` (the only prompt variant so far); `--out <dir>` (default `data/calibration`, git-ignored); `--json -` or `--json <file>`; `--strict`. Before the first call the run prints the **planned call count**: per probe, every player with at least 2 lines in its transcript (scored or not, because the evaluator scores each of them) times `--repeat` times the number of judges, plus at most one re-ask per unusable reply. Exit codes: 0 results written, whatever the labels; 1 with `--strict` when a judge is labelled FAIL, or when the results could not be written after the run; 2 usage or input error (nothing was run).

A judge that is down or answers garbage is recorded as **unusable**, not as disagreeing, and the other judge still runs. If a judge's run breaks off, the probes it finished are kept; Ctrl-C stops the run and writes what was finished (exit 130). Each run is written to a new directory `data/calibration/<scenario-id>/<start time>/` (`calibration-report.md` and `calibration.json`, exclusive creation, private file modes), and the latest result per judge to `data/calibration/<scenario-id>/<model>-<variant>.json` (replaced atomically), for the calibration stamp that reports will show later. That summary file is created or replaced **only by a complete run** of that judge: every probe (no `--only`), `--criteria all`, no failure and no abort, and a usable fraction of answers at least `minUsable` (0.9 by default; a judge that degrades mid-run records its lost calls as unusable, so it is caught here; every `--repeat` run counts, so `--repeat 5` gives five slots per scored player), and at least half of the contrast probes usable (a judge can lose every contrast answer while overall usability stays high). `--only` naming every probe still counts as a full run. Otherwise the run directory is still written, the old summary is kept and the run prints `summary for <label> (<model>) not updated: <reason>`. A summary holds the scenario, rubric hash, variant, judge label and model, start time, probe counts (total, tune, holdout), `exact` (`n` exact matches of `of` usable singles), `bias`, `contrast` (`ordered` of `of` usable contrast probes, out of `probes` contrast probes), `usable` (usable answer slots of all slots) and the label. Two judges with the same model id share one summary file; the last complete one wins. Everything written to disk or printed has the environment's secret values redacted.

**Reading the summary.** The report (and the terminal) opens with one screen per judge: the label, contrast ordering (`ordered N of M usable`: the headline), bias (signed mean of judge level minus expected level; positive means lenient), exact and within-one agreement as counts, and usable answers; then the reasons, warnings and lint. The detail follows: per criterion, by split (tune/holdout), by source and by drafter, bias by expected level, not-observed precision and recall, stability (with `--repeat`), usability (capped scores, dropped quotes, spread of levels used), and with two judges the cross-judge comparison (numeric pairs, mean absolute difference, within one) with every disagreement listed with the probe's expected level for that role (and the acceptable levels when wider) beside both judges' rationales and quotes.

- **FAIL**: contrast ordering below target, absolute bias above target, or a flat judge (it uses fewer distinct levels than the probes need: a judge that always answers 3 cannot pass).
- **WARN**: discrimination not measured (no contrast probes) or thinly measured (under half of them usable), no usable evidence, usability below target, or exact agreement below a target set for the scenario.
- **PASS**: none of these. Within-one agreement is shown for traceability but never decides PASS (on a four-level scale a judge that always answers 2 is within one level for expected levels 1 to 3).
- **Warnings** on the figures: `thin` (fewer than 20 probes, or fewer than 4 for a criterion), `partial` (the run was cut short), and self-agreement (a probe drafted by a model from the judge's own family).

**Limits.** Probes are a proxy for real sessions. Synthetic and drafted transcripts are cleaner than real speech, which is why real (consented, redacted) excerpts are required before a default change. The 7 excerpts in the Friday set do NOT meet that bar: they were cut from demo sessions played by weaker local models (Gemma, Nemotron-nano and the foundation model), not by people, so they are model-played text and there is no genuine level-4 excerpt. The Friday set has 34 probes: 16 tune and 18 holdout (splits hand-set), 27 drafted (the 8 starters and 19 more written by claude-sonnet-5-5, a Claude model, so neither the Gemma primary judge nor the Holo3 second judge gets a self-agreement warning on them) and 7 excerpts, with 2 contrast probes. The 36 expected levels are level 1 nine times, level 2 ten, level 3 nine and level 4 eight (each contrast player counted). By criterion (tune/holdout): listening 6/1, negotiation 4/3, team_alignment 2/4, discovery 2/3, role_clarity 1/4, commercial_judgement 1/3; stakeholder_management has no probe. Approval records: the starter probes' approval was recorded by an agent from the owner's explicit chat instruction (2026-10-07, 19:58 EDT). The 19 new drafts and the 7 excerpts were approved by an agent (`approved_by: Kamal`) on the owner's explicit chat instruction of 2026-10-08 ("approve the 19 drafts you recommended ... approve the excerpts you recommend"); the owner did not review each item (owner review of the excerpt levels is pending). The levels of the excerpts were assigned by the controlling agent session (claude-sonnet-5-5) under the owner's delegation, with an `acceptable` range on all 7 (7 of 7: [2, 3] for listening-01, listening-02, negotiation-01, role_clarity-02 and team_alignment-01, [1, 2] for negotiation-02 and team_alignment-02); the drafted levels are the drafter's intended levels, and an independent review found no level disagreement on the 26 new probes. All of this is visible in the commit history and open to the owner's edits. The owner-approved text of five probes was adjusted by an agent afterwards for consistency with scenario 1.3 (levels unchanged, `approved_by` and `approved_at` untouched): role_clarity-l4-1 and team_alignment-l4-1 (the tech lead is not on the client call, so the data-layer follow-up is handled in the next call or in writing), commercial_judgement-l4-1 (scope is the phased version and the date is four weeks after go-live, so 48,000 matches the cost fact) and role_clarity-l3-1 (the tech lead is asked to size, the delivery lead stays the timeline owner). Known limits of the set: all 19 new drafted probes score the account_manager (24 of the 32 single probes do, 7 score the delivery_lead), the tech_lead is scored once (the role_clarity excerpt), there are only 2 contrast probes so the contrast ordering rests on two comparisons, listening-l2-1 and negotiation-l2-1 closely echo the rubric's own anchor examples (a judge may match the anchor text), exc-team_alignment-02 contains a greeting to Priya who is not in scene 1 (a model artefact), exc-listening-01's Priya context calls a phased delivery a failure although her 1.3 earned_when would accept it (context only, Priya is not scored), and the linter lists 11 unscored-speaker warnings on drafted probes (a context role that speaks twice; each costs a model call and changes no score; friday-set.test.ts pins them). The hand-set starter probes share the client's setup lines across splits (disc-l2 and disc-l4 in holdout and disc-l3 in tune share "We need the reconciliation module before go-live. It is a must-have."; neg-l1 in holdout and neg-l4 in tune share "We need the module before go-live. Can you do it for the same fee?"): these are not scored player lines, so the effect is weak, but the splits are not fully independent. Calibration is per judge, per prompt variant and per rubric version; a result says nothing about another model, another variant or a changed rubric. It reports measurements and never claims the scores are accurate. The report does not yet show a confidence distribution (spec section 5, usability). Not built yet: prompt variants other than `v1`, and the calibration stamp on evaluation reports.

## Baseline

The first live baseline of the Friday Escalation set, run on 2026-10-08. It measures the unchanged prompt (`v1`); it says nothing about another model, variant or rubric version. Positive bias means lenient.

| Item | Primary judge | Second judge |
| --- | --- | --- |
| Date | 2026-10-08 | 2026-10-08 |
| Judge | `gemma-4-31b-it-qat-mxfp4` | `holo3-35b-a3b-jangtq4` |
| Prompt variant | v1 | v1 |
| Rubric hash | `38e0284af8f82d44` | `38e0284af8f82d44` |
| Scenario | esc-scope-creep-01 v1.3 | esc-scope-creep-01 v1.3 |
| Probes | 34 (16 tune, 18 holdout; 7 excerpts, 27 drafted; 2 contrast) | same 34 |
| Repeat | 3 | 3 |
| Exact agreement | 27 of 32 (84%) | 28 of 32 (88%) |
| Within one level | 31 of 32 (97%) | 31 of 32 (97%) |
| Bias | +0.16 | +0.10 |
| Contrast ordered | 2 of 2 | 2 of 2 |
| Usable answers | 108 of 108 | 108 of 108 |
| Stability (mean per-probe variance) | 0.02 | 0.01 |
| Label | PASS | PASS |

The exact and within-one counts are over the 32 single probes (the 2 contrast probes are measured by ordering). 282 model calls were planned for the two judges at `--repeat 3`; the run took 23,018 s of wall time (6 h 24 min) on the local models. Command (the Osaurus server at `http://127.0.0.1:1337/v1` served both models):

```bash
MODEL_PROVIDER=local NPC_MODEL=gemma-4-31b-it-qat-mxfp4 EVAL_MODEL=gemma-4-31b-it-qat-mxfp4 \
  pnpm calibrate --scenario scenarios/friday-escalation \
  --judge second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1 --repeat 3
```

The report is in the git-ignored `data/calibration/esc-scope-creep-01/2026-10-08T16-24-23-440Z/` (`calibration-report.md`, `calibration.json`); the two per-judge summaries `gemma-4-31b-it-qat-mxfp4-v1.json` and `holo3-35b-a3b-jangtq4-v1.json` in the parent folder come from this complete run.

**Per criterion** (probes; exact; within one; bias; label), Gemma / Holo3 where they differ:

| Criterion | Probes | Exact | Within one | Bias | Label |
| --- | --- | --- | --- | --- | --- |
| commercial_judgement | 4 | 4 of 4 / 4 of 4 | 4 of 4 / 4 of 4 | 0.00 / 0.00 | WARN / WARN |
| discovery | 5 | 3 of 5 / 3 of 5 | 5 of 5 / 5 of 5 | +0.40 / +0.40 | FAIL / FAIL |
| listening | 7 | 5 of 6 / 5 of 6 | 6 of 6 / 6 of 6 | +0.17 / +0.17 | PASS / PASS |
| negotiation | 7 | 5 of 6 / 5 of 6 | 5 of 6 / 5 of 6 | -0.20 / -0.20 | PASS / PASS |
| role_clarity | 5 | 5 of 5 / 5 of 5 | 5 of 5 / 5 of 5 | +0.20 / +0.20 | WARN / WARN |
| team_alignment | 6 | 5 of 6 / 6 of 6 | 6 of 6 / 6 of 6 | +0.33 / 0.00 | FAIL / WARN |

The WARN labels on commercial_judgement, role_clarity and team_alignment (Holo3) are the report's "discrimination not measured" warning: those criteria have no contrast probe.

**By source** (Gemma / Holo3):

| Source | Probes | Exact | Within one | Bias |
| --- | --- | --- | --- | --- |
| drafted | 27 | 21 of 25 / 22 of 25 | 25 of 25 / 25 of 25 | +0.08 / +0.04 |
| excerpt | 7 | 6 of 7 / 6 of 7 | 6 of 7 / 6 of 7 | +0.50 / +0.33 |

By split the two are close: holdout 15 of 17 exact, bias +0.18 (Gemma), 16 of 17, +0.12 (Holo3); tune 12 of 15, +0.14 and 12 of 15, +0.07.

**Bias by expected level** (Gemma / Holo3; scored answers in brackets):

| Expected level | Bias |
| --- | --- |
| 1 (7) | +0.14 / 0.00 |
| 2 (10) | +0.20 / +0.20 |
| 3 (8) | +0.38 / +0.25 |
| 4 (6) | -0.17 / -0.17 |

**Cross-judge** (primary against second): 35 numeric pairs, mean absolute difference 0.06, within one level in 35 of 35. Two disagreements: `exc-team_alignment-02` (expected 1, acceptable 1 or 2; Gemma 2, Holo3 1) and `team_alignment-l3-1` (expected 3; Gemma 4, Holo3 3). Each judge used 4 distinct levels; no scores were capped for missing evidence and no quotes were dropped as not verbatim.

**How to read this baseline.**

- Contrast was measured on 2 probes only (both ordered by both judges). That is not a meaningful test against the 80 percent contrast-ordering target: one miss would have read 50 percent.
- Discovery is FAIL for both judges: bias +0.40, which is 2 of its 5 probes scored one level high. team_alignment is FAIL for Gemma (+0.33) but 0.00 for Holo3.
- Level 3 is the most inflated expected level (+0.38 Gemma, +0.25 Holo3); level 4 is scored slightly low.
- Excerpts show the most leniency (+0.50 Gemma, +0.33 Holo3), but their expected levels were assigned by an agent and have not been reviewed by the owner (AC-0191), so part of that gap may be the labels.
- Both judges score probes drafted by Sonnet from the same rubric text, so their agreement may partly be phrase matching against the anchors rather than judgement.
- The leniency seen earlier on demo sessions is not reproduced on the synthetic probes (overall bias +0.16 and +0.10).

**Stage-gate decision (ruling R32).** The gate (a judge-level FAIL on contrast ordering, or an absolute bias above 0.3) was not triggered: both judges are labelled PASS. Task 12 (prompt variants `v2` and `v3`) was not run. US-0038 is Deferred (not Cancelled) because contrast is measured on only 2 probes, which is not meaningful against the 80 percent target, and because the excerpt levels are unreviewed; its ids stay reserved. Revisit after the second Sonnet batch (contrast, tech_lead and messier probes) and the owner's review of the excerpt levels.

## Limits and planned follow-ups

Not built yet: a participant-facing screen (US-0043 provides `export --for participant:<role>`), participant self-assessment and response (ASM-07), calibration against human raters (ASM-08; `pnpm calibrate` above measures a judge against human-labelled probes, not against human raters scoring the same sessions), and result isolation and access control (ASM-09). The evaluator has not been validated against human raters, so treat its scores as a conversation starter for the debrief.
