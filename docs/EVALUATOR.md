# Post-session evaluator

The evaluator turns a recorded session into draft feedback: a score per criterion for each player, a score per criterion for the team, learning-objective results, and a personal report for each player plus a group report with talking points for the facilitator. It is the first version of EPIC-0005 (US-0028 to US-0031). Everything it produces is a **draft**: it is held for facilitator review, and the review and edit workflow is a planned follow-up (ASM-04).

**Visibility: all participants (prototype setting; per-participant isolation is planned).** For now every participant may see every score and report. There is no access control yet (ASM-09 is planned).

## Method

The scoring system is a **Behaviourally Anchored Rating Scale (BARS)**, a standard approach in learning and development: each level of each criterion is described by a written example of observable behaviour, so a score says what was seen rather than an impression.

| Level | Label |
| --- | --- |
| 1 | Not yet demonstrated |
| 2 | Developing |
| 3 | Proficient |
| 4 | Advanced |
| N/O | Not observed (no evidence either way; no score, left out of every average) |

There is no midpoint, to avoid the central-tendency habit of rating everyone as average.

- **Evidence rule.** Every score needs at least one verbatim, timestamped quote from that participant. The quote is checked by the program: after whitespace normalisation it must be a substring of the recorded utterance, at the `seq` the model named, spoken by that role (any player for the group). A quote that cannot be found is dropped. A 3 or 4 with no verified quote is **capped at 2 and flagged**; a 1 or 2 with none is kept, flagged and shown with Low confidence. Only the participant's own words are evidence for them (first-person-only rule).
- **Confidence** (High, Medium, Low) is the lower of what the number of verified quotes supports (3 or more High, 2 Medium, fewer Low) and what the model said (a missing statement counts as Medium). A capped score is always Low. The model can lower a confidence but never raise it above the evidence.
- **Aggregation.** A learning-objective (LO) score is the mean of the observed scores of the criteria mapped to it, rounded to one decimal. The label of the rounded value is: below 1.5 Not yet demonstrated, below 2.5 Developing, below 3.5 Proficient, otherwise Advanced. There is **no single overall grade**: the overall picture is the list of LO results. An LO with no observed criterion is Not observed.
- **Limitations.** AI-drafted and needs facilitator review; a small sample (three players, one session); one session is a snapshot, not a measure of general ability; only what was said is assessed; evidence is first-person only; a long session may be trimmed before it is sent (the report says so).

The same text is printed in every report (`## How this was scored`), in `method.md`, and stored in every JSON file under `method`.

## Data flow

```
session JSONL log ──► readSessionLog (bounded, seq checked with the reducer)
scenario + rubrics ─► loadScenario / loadRubrics (validated)
        │
        ▼
buildTranscript: every utterance (players and AI characters, with seq, role, time, scene),
                 injects, scene boundaries and Game Master verdicts as context lines
        │  trimmed to EVAL_TRANSCRIPT_CHARS when needed (injects and scene boundaries kept, every speaker keeps a proportional share)
        ▼
one model call per player role ──► strict JSON {criteria, strengths, development_points, next_actions}
one model call for the team    ──► strict JSON {criteria, talking_points, notable_moments}
        │  tolerant parsing (code fence, prose around the JSON), one bounded re-ask with the parse error
        ▼
normaliseCriteria: unknown ids ignored, missing ids Not observed, scores that are not whole numbers 1 to 4 rejected,
                   quotes verified, 3/4 without a verified quote capped at 2, confidence derived
        ▼
aggregateObjectives (pure) ──► per-LO score and label
        ▼
reports: <out>/<session-id>/<role>.md + .json, group.md + .json, index.md, method.md
```

The model goes through the same provider path as the AI characters (`selectModelProvider`, the retry layer with the SDK's own retries off) and the same bounded reply collector (first-token timeout, overall deadline, abort).

**Prompt injection.** The transcript is data between delimiters that carry a random nonce, and the system prompt says to ignore any instruction inside it. Line breaks inside an utterance are folded to spaces, so a line cannot forge another speaker's line or a scene marker. Because quotes are verified programmatically and scores are checked, text in the transcript cannot make the evaluator invent evidence.

**Failure handling.** A participant with fewer than 2 utterances gets "insufficient evidence" (all Not observed) with no model call. If a participant's evaluation fails (timeout, error, or a reply that is still unusable after one re-ask) their report says `evaluation failed: <reason>`, the other reports are still written, and the exit code is non-zero. The number of model calls is reported (re-asks count; retries of transient errors inside the provider do not).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVAL_MODEL` | `NPC_MODEL` | Model for the evaluator |
| `EVAL_MAX_TOKENS` | `3000` | Token budget per evaluator call, `200` to `8000` |
| `EVAL_TEMPERATURE` | `0.2` | Sampling temperature, `0` to `2` |
| `EVAL_TIMEOUT_MS` | `180000` | Deadline per call, `500` to `600000`; never below `NPC_REPLY_TIMEOUT_MS` |
| `EVAL_TRANSCRIPT_CHARS` | `60000` | Largest transcript sent in one call, `5000` to `400000` |

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

Check **S-16** (only with `--evaluate`) reads the written files back and verifies that every player has a report, every quoted piece of evidence is a verbatim substring of an utterance in the recorded log (by that player for a personal report), the method section and visibility line are present, and every score is 1 to 4 or Not observed. In a mock run it also requires that the scripted evaluator did not fail.

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

Write anchors as **observable behaviour** for the scenario's persona, not as traits. The validator (`loadRubrics`) checks the schema, that all four levels have an anchor, that criterion ids are unique, that levels 2 and 4 have example phrases, and that every `rubric_criteria` id of every learning objective names a criterion in a loaded rubric (an error otherwise). Files are size-capped (256 KiB) and limited in YAML aliases. A scenario whose `rubrics:` is empty loads as "no rubrics" with a warning (and cannot be evaluated).

## Reading a report

- **Summary.** Strengths, development points and 2 to 3 next actions, each tied to a learning objective (`LO1`...). The wording is the model's and should be read as a draft.
- **Learning objectives.** Each LO's score (one decimal) and label, and how many of its criteria were observed. A score based on one criterion of two is thinner than one based on both.
- **Criteria.** The level and its label, the confidence and the rationale. Flags in brackets matter: `capped from 4 to 2: no verified quote`, `N quote(s) could not be verified ... and were dropped`, `no verified quote`. Not observed (N/O) is not a low score.
- **Evidence.** The verified quotes with scene number, time from the start of the session and the line number (`#12` is the event sequence number in the log).
- **Group report.** Group criteria, LO coverage across the team (players by LO), the scenario author's facilitator notes next to the model's talking points, and notable moments.
- **index.md** links everything and shows the LO table for everyone.

## Limits and planned follow-ups

Not built yet: the facilitator moderation and edit workflow with history (ASM-04), participant self-assessment and response (ASM-07), calibration against human raters (ASM-08), and result isolation and access control (ASM-09). The evaluator has not been validated against human raters, so treat its scores as a conversation starter for the debrief.
