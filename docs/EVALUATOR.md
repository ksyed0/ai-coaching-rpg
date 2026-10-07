# Post-session evaluator

The evaluator turns a recorded session into draft feedback: a score per criterion for each player, a score per criterion for the team, learning-objective results, and a personal report for each player plus a group report with talking points for the facilitator. It is the first version of EPIC-0005 (US-0028 to US-0031). Everything it produces is a **draft**: it is held for facilitator review, and the review and edit workflow is a planned follow-up (ASM-04).

**Visibility: all participants (prototype setting; per-participant isolation is planned).** For now every participant may see every score and report. There is no access control yet (ASM-09 is planned).

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
- No line may contain hidden or bidirectional control characters ("Trojan Source"): C0 controls other than tab and newline, DEL and C1 controls, U+061C, the zero-width characters and direction marks U+200B to U+200F, U+2028 to U+202E (line and paragraph separators, bidi embeddings and overrides), the isolates U+2066 to U+2069 and U+FEFF. They would make the text you review differ from the text the judges read. The error names the line (`transcript.<n>.text`); drafted replies and excerpts containing them are refused before anything is written. Curly quotes, accents, emoji and any script (CJK, Arabic, Hebrew) are fine.
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

- **`draft`** asks a drafter model (`--drafter label,model[,baseUrl]`, required: no model is called without it; an OpenAI-compatible server like a second judge, `LOCAL_API_KEY` only for the `LOCAL_BASE_URL` host) for one candidate transcript per individual criterion (or `--criterion`), per level 1 to 4 and per `--per-level` (1 to 3, default 1); it prints the planned call count (criteria x 4 x per-level) first. The drafter must be of a **different model family** from the primary judge (`EVAL_MODEL`, else `NPC_MODEL`), because a judge scoring its own family's drafts measures self-agreement; `--allow-same-family` overrides this, and is also needed when the primary model is not set. The prompt carries only public scenario data (title, context, role ids, AI characters' name, title and persona, scene ids and participants) and the target anchor verbatim; never a hidden fact, an `earned_when` condition, a player's brief or private facts, or the facilitator notes. Each reply is capped at 64 KiB and 8 lines and checked like a probe (known scenes and roles, speakers in their scene, the subject with at least 2 lines, no hidden fact, no prototype keys); a failing, hanging (`EVAL_TIMEOUT_MS`) or invalid reply is reported (`draft <id>: <reason>`) and skipped, the others are written (exit 1 when some failed). Drafts go to `calibration/drafts/draft-<criterion>-l<level>-<n>.yaml` (numbered after existing drafts and probes, created exclusively with mode 0600 in a 0700 directory; a symbolic link in place of `calibration/` or `drafts/` is refused) with `source: drafted`, the drafter's model id, no approval and no split. `--subject` picks the player (default: the first player role by id).
- **`excerpt`** cuts a draft from a real session log (`--log`, a `.jsonl` file, read with the usual size cap): the utterances with event seq `--from` to `--to`, each with the scene active at that seq. It has no `expected` level (a human rates it at approval) and `source: excerpt`. It refuses a subject with fewer than 2 lines in the range, a line spoken outside any scene, a range outside the log, a log of another scenario, more than 80 lines, an id that is not file-safe or longer than 58, and a range in which an AI character says one of its hidden facts (`excerpt contains a hidden fact of <role>: choose another range`; the fact is never printed). **A real customer session needs consent and redaction first** (AGENTS section 12): the repository is public.
- **Review**: open the draft, check that the subject's lines show exactly the expected level (no higher), edit freely. `calibration/drafts/` is git-ignored and never read by a run.
- **`approve`** is run by **the owner only**: an agent never approves on the owner's behalf. It reads the draft, records `approved_by` (`--by`, 1 to 120 printable characters) and `approved_at` (now, ISO-8601), takes `--expected` (required for an excerpt; for a drafted probe it overrides the drafted level), assigns a split when the draft has none (`assignSplit(id, n + 1)`, n being the probe files in `calibration/` that parse as probes), and checks the result exactly like the loader (schema and every rule above), listing every problem when it refuses. The final id is the draft id without `draft-` (or `--id`). It writes `calibration/<id>.yaml` exclusively (it never overwrites a probe) and only then deletes the draft, so a crash leaves the draft, or both (approve then refuses the duplicate and you delete the draft), never neither.
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

Flags: `--repeat n` (1 to 5) scores every probe n times to measure the judge's own noise; `--only id,id` runs a subset; `--criteria all` (default) has the judge score every individual criterion as in a real evaluation, `probe` only the probe's criterion; `--variant v1` (the only prompt variant so far); `--out <dir>` (default `data/calibration`, git-ignored); `--json -` or `--json <file>`; `--strict`. Before the first call the run prints the **planned call count**: per probe, every player with at least 2 lines in its transcript (scored or not, because the evaluator scores each of them) times `--repeat` times the number of judges, plus at most one re-ask per unusable reply. Exit codes: 0 results written, whatever the labels; 1 with `--strict` when a judge is labelled FAIL, or when the results could not be written after the run; 2 usage or input error (nothing was run).

A judge that is down or answers garbage is recorded as **unusable**, not as disagreeing, and the other judge still runs. If a judge's run breaks off, the probes it finished are kept; Ctrl-C stops the run and writes what was finished (exit 130). Each run is written to a new directory `data/calibration/<scenario-id>/<start time>/` (`calibration-report.md` and `calibration.json`, exclusive creation, private file modes), and the latest result per judge to `data/calibration/<scenario-id>/<model>-<variant>.json` (replaced atomically), for the calibration stamp that reports will show later. That summary file is created or replaced **only by a complete run** of that judge: every probe (no `--only`), `--criteria all`, no failure and no abort, and a usable fraction of answers at least `minUsable` (0.9 by default; a judge that degrades mid-run records its lost calls as unusable, so it is caught here; every `--repeat` run counts, so `--repeat 5` gives five slots per scored player), and at least half of the contrast probes usable (a judge can lose every contrast answer while overall usability stays high). `--only` naming every probe still counts as a full run. Otherwise the run directory is still written, the old summary is kept and the run prints `summary for <label> (<model>) not updated: <reason>`. A summary holds the scenario, rubric hash, variant, judge label and model, start time, probe counts (total, tune, holdout), `exact` (`n` exact matches of `of` usable singles), `bias`, `contrast` (`ordered` of `of` usable contrast probes, out of `probes` contrast probes), `usable` (usable answer slots of all slots) and the label. Two judges with the same model id share one summary file; the last complete one wins. Everything written to disk or printed has the environment's secret values redacted.

**Reading the summary.** The report (and the terminal) opens with one screen per judge: the label, contrast ordering (`ordered N of M usable`: the headline), bias (signed mean of judge level minus expected level; positive means lenient), exact and within-one agreement as counts, and usable answers; then the reasons, warnings and lint. The detail follows: per criterion, by split (tune/holdout), by source and by drafter, bias by expected level, not-observed precision and recall, stability (with `--repeat`), usability (capped scores, dropped quotes, spread of levels used), and with two judges the cross-judge comparison (numeric pairs, mean absolute difference, within one) with every disagreement listed with the probe's expected level for that role (and the acceptable levels when wider) beside both judges' rationales and quotes.

- **FAIL**: contrast ordering below target, absolute bias above target, or a flat judge (it uses fewer distinct levels than the probes need: a judge that always answers 3 cannot pass).
- **WARN**: discrimination not measured (no contrast probes) or thinly measured (under half of them usable), no usable evidence, usability below target, or exact agreement below a target set for the scenario.
- **PASS**: none of these. Within-one agreement is shown for traceability but never decides PASS (on a four-level scale a judge that always answers 2 is within one level for expected levels 1 to 3).
- **Warnings** on the figures: `thin` (fewer than 20 probes, or fewer than 4 for a criterion), `partial` (the run was cut short), and self-agreement (a probe drafted by a model from the judge's own family).

**Limits.** Probes are a proxy for real sessions. Synthetic and drafted transcripts are cleaner than real speech, which is why real (consented, redacted demo) excerpts are required before a default change. A small probe set gives noisy numbers: the Friday starter set has 8 probes and is labelled thin. Calibration is per judge, per prompt variant and per rubric version; a result says nothing about another model, another variant or a changed rubric. It reports measurements and never claims the scores are accurate. The report does not yet show a confidence distribution (spec section 5, usability). Not built yet: prompt variants other than `v1`, and the calibration stamp on evaluation reports. The Friday set is still the 8-probe starter set until it is scaled with drafted, excerpted and owner-approved probes.

## Limits and planned follow-ups

Not built yet: the facilitator moderation and edit workflow with history (ASM-04), participant self-assessment and response (ASM-07), calibration against human raters (ASM-08; `pnpm calibrate` above measures a judge against human-labelled probes, not against human raters scoring the same sessions), and result isolation and access control (ASM-09). The evaluator has not been validated against human raters, so treat its scores as a conversation starter for the debrief.
