# Evaluator calibration: design

Status: draft for owner review (2026-10-07). Scope: the "trustworthy scores first" slice of EPIC-0005. The moderation workflow (ASM-04), participant self-assessment (ASM-07) and result visibility (ASM-09) are a later slice and are out of scope here.

## 1. Purpose and success criteria

The post-session evaluator (`pnpm evaluate`, US-0028 to US-0031) scores each player and the group per criterion on a four-level BARS rubric, with verified quotes and a confidence level. In practice it is lenient and its three players score alike. Nothing measures whether its scores are right, so nobody can say how far to trust them.

This slice makes the scores measurable, improves them only where the measurement says they need improving, and tells every reader how far a given report can be trusted.

The slice is done when:

1. Any scenario can carry its own calibration probes, and `pnpm calibrate --scenario <dir>` runs them against one or two judges and writes a report, with no scenario-specific code.
2. The report shows, per judge, how well the evaluator separates players of visibly different quality (the headline), how lenient or harsh it is, how often it agrees with the expected level, and how often it fails to produce a usable verdict.
3. A baseline of the current evaluator (`v1`) has been recorded on a probe set of at least 20 probes, and a documented decision says whether prompt variants are needed.
4. Every evaluation report states which judge and prompt variant produced it and the measured calibration it is backed by, or says plainly that it is not calibrated.

What this slice does not claim: that the scores are accurate for real sessions. Probes are a proxy. Section 8 states the limits.

## 2. Terms

- **Judge:** a model plus endpoint that plays the evaluator's role (for example `gemma-4-31b-it-qat-mxfp4` on the local Osaurus server). Judges are configuration, never code.
- **Probe:** a short transcript with a known expected result for one rubric criterion.
- **Contrast probe:** a transcript in which two or three players behave at visibly different levels on the same criterion; the expected result is an ordering and a minimum gap.
- **Variant:** a named, versioned evaluator prompt. `v1` is the current behaviour, frozen.
- **Tune and holdout:** the two halves of the probe set. Variants are developed against `tune` and accepted or rejected on `holdout`.

## 3. Probe format (per scenario, flexible)

Probes are data files in `scenarios/<id>/calibration/<probe-id>.yaml`, validated by a schema. A scenario with no `calibration/` directory simply has no probes. Nothing in the runner names a scenario.

```yaml
id: discovery-weak-01
kind: single                  # single | contrast
criterion: client_discovery   # must exist in the scenario's rubric
source: handwritten           # handwritten | drafted | excerpt
drafter: null                 # model id when source is drafted
approved_by: null             # required when source is drafted
approved_at: null
split: tune                   # tune | holdout; see below
subject: tech_lead            # single: the one participant scored
expected: 2                   # single: 1..4 or not_observed
acceptable: [1, 2]            # optional range; defaults to [expected]
transcript:                   # same shape the evaluator reads
  - { scene: s1_huddle, role: tech_lead, text: "..." }
```

A contrast probe replaces `subject`, `expected` and `acceptable` with:

```yaml
kind: contrast
players: { tech_lead: 4, account_manager: 2, delivery_lead: 1 }   # expected level per player
min_gap: 1                    # required level difference between adjacent players in the ordering
```

Rules:

- `criterion` must resolve against the scenario's rubric, and a rubric change that orphans a probe fails validation loudly instead of silently dropping the probe.
- An `excerpt` is a short stretch lifted from a real session log (demo sessions only, see section 9) with a human-assigned level.
- `split` is assigned deterministically from a hash of the probe id (about 50/50 on sets under 40 probes, about 70/30 above), and stored in the file so it never moves. The holdout needs at least 10 probes before an acceptance decision is allowed.
- The probe-set linter warns when expected levels are unbalanced or mid-heavy (a set without level 1 and level 4 probes cannot catch an "always 3" judge), when a criterion has fewer than 4 probes ("thin"), and when the whole set has fewer than 20 probes.

## 4. Components

All under `services/runtime/src/calibration/`. None knows any scenario.

- **Probe loader and validator:** schema, rubric resolution, expected-level validity, approval required for drafted probes; reports every problem in one pass.
- **Log adapter:** builds a synthetic session log in the shape the evaluator reads, so the evaluator's quote verification (a quote must appear in the transcript) is exercised for real.
- **Judge configuration:** `{ name, model, baseUrl }` from flags or environment. The primary judge defaults to the existing evaluator settings; a second judge is optional.
- **Runner:** feeds each probe to the existing evaluator engine unchanged, so what is measured is the code that scores real sessions, and collects verdicts per judge, optionally repeated (`--repeat n`) and filtered (`--only`).
- **Metrics and report:** section 5.
- **Draft helper (`--draft-probes`):** section 6.

## 5. Metrics and report

Per criterion and overall, for each judge:

1. **Agreement:** exact and within-one, shown as counts ("19 of 24") with the percentage beside them. The spec target is within one level on 85% of scores, but see the note on PASS below.
2. **Bias:** the signed mean of (judge level minus expected level); positive means lenient. Also shown per expected level, so inflation of weak behaviour is visible.
3. **Discrimination (the headline):** for contrast probes, ordering accuracy and the achieved gap against the required gap; for all probes, the spread (how many distinct levels the judge uses). A judge that answers 3 for everything scores zero here.
4. **Not observed:** precision and recall, to catch invented scores where the behaviour never occurred.
5. **Usability:** the rate of unparseable or invalid answers, quotes that could not be verified, scores capped for missing evidence, and the confidence distribution. A judge that often cannot produce a verdict is reported as unreliable and is not counted as disagreeing.
6. **Stability:** with `--repeat n`, per-probe score variance, which is the judge's own noise.

Cross-judge comparison, when a second judge is configured: judges score blind and never see each other's output. Report mean absolute difference and within-one agreement between them, list every probe where they disagree with each judge's level, rationale and verified quotes side by side, and score both against the expected levels.

Honesty flags: every metric can be split by `source` and by `drafter`. A drafter from the same model family as a judge gets a visible warning on that judge's agreement figure (self-agreement). A criterion under 4 probes is marked thin; a set under 20 probes is marked thin overall.

Labels and targets: each criterion and the overall result get PASS, WARN or FAIL. Defaults: contrast ordering 80% or better, absolute bias 0.3 levels or less, exact agreement at a level set by the first baseline. Within-one agreement is reported for traceability to the spec but does not decide PASS, because on a four-level scale a judge that always answers 2 is within one level of the truth for expected levels 1, 2 and 3. Targets can be overridden per scenario in `calibration/targets.yaml`.

Output: `calibration-report.md` and `calibration.json`. The Markdown opens with a one-screen summary (headline discrimination, bias, exact and within-one agreement, usability, labels) and puts the detail below it. `pnpm calibrate` exits 0 regardless of the labels; `--strict` exits non-zero on any FAIL, for CI. Calibration never blocks `pnpm evaluate`.

## 6. Authoring and drafting probes

- Hand-written probes are always allowed.
- `pnpm calibrate --draft-probes --scenario <dir>` asks a model to draft a candidate transcript for each rubric anchor, written to `calibration/drafts/`. Drafts are never used by a calibration run. A human reviews and edits a draft, then approves it, which moves it to `calibration/` and records the approver and time.
- The drafter defaults to a different model family from the primary judge. Models from other families are already served locally (Nemotron, Qwen), so drafting does not wait for a second judge. Until a second judge is configured, a baseline over Gemma-drafted probes is labelled as self-agreement and is not treated as meaningful.
- Each probe records its drafter, so reports can split agreement by drafter.

## 7. The improvement loop (a stage gate)

The leniency may be partly real: in the demos the players are LLM bots or scripted lines and may genuinely perform alike. So variants are built only if the baseline shows the judge is at fault.

1. **Baseline.** Run `v1` on the probe set (at least 20 probes, with contrast probes and at least 5 real excerpts). The baseline fails if `v1` gets a FAIL on contrast ordering, or an absolute bias above 0.3 levels. Record the result and the decision in `docs/EVALUATOR.md`.
2. **If the baseline passes:** do not build variants. Record that the leniency was in the demo players, and move effort to better players and scenarios.
3. **If the baseline fails:** build the candidates, cheapest first, one at a time:
   - `v2`, evidence-first scoring: list the best quote per level, then take the highest level whose anchor is fully evidenced; if torn between two levels, choose the lower.
   - `v3`, next-level challenge: after a tentative level L, state what is missing for L+1 and confirm the quotes show every part of L's anchor, downgrading if not. One more call per criterion.
4. **Variants change the prompt only.** The output schema, the parser and the quote verification are unchanged. `pnpm calibrate --variant v1,v2` runs variants side by side. Every report records its variant.
5. **Acceptance** is a human decision from the report, never an automatic switch. A variant becomes the default only if, on the holdout (at least 10 probes): contrast ordering is no worse and the achieved gap is closer to the required one; absolute bias is lower; exact agreement is not worse beyond the noise measured by `--repeat 3`; usability is not worse; and cost stays within 2x of `v1`'s calls (to be reviewed against real numbers). Holdout is a sanity check against overfitting, not a significance test, and results are worded that way. If the second judge's baseline usability is adequate, the variant must not regress on it either; otherwise record "second judge not usable" and do not block on it.
6. A default change is an ordinary PR with the before and after table, and `docs/EVALUATOR.md` is updated, so there is a committed record of why.

Not done in this slice: subtracting measured bias from scores (it hides the problem and is not an honest judgement), judge ensembles, and per-criterion isolated calls.

## 8. The calibration stamp on reports

Every evaluation's JSON and Markdown records an `evaluator` block: judge name and model, prompt variant, rubric id and a hash of its content. Calibration results are written to `data/calibration/<scenario>/<judge>-<variant>.json` (git-ignored, per machine). A report looks up the latest result matching the judge, variant and rubric hash and prints one plain line in the footer, in `index.md` and in each personal report, for example: "Scored by gemma-4-31b, prompt v1. Calibration on 24 probes (2026-10-08): 15 of 24 exact, bias +0.4 levels, 6 of 8 contrast groups ordered." It reports measurements and never claims the scores are accurate.

States: **not calibrated** (no result), **stale** (the rubric hash or variant changed since the last calibration, shown as "not calibrated for this rubric version"), and **thin** (the probe set is under 20). The stamp changes nothing about who can see a report and does not block release. It is the groundwork for moderation (a facilitator sees how far to trust a score).

Limits to state in `docs/EVALUATOR.md`: probes are a proxy for real sessions; synthetic and drafted transcripts are cleaner than real speech, which is why real excerpts are required before a default change; a small probe set gives noisy numbers; calibration is per judge, per variant and per rubric version.

## 9. Security and data rules

The repository is public. Probes may contain only demo or synthetic transcripts. An excerpt from a real customer session needs consent and redaction first (AGENTS section 12), and the documentation says so. Probe text is untrusted input to the judge, so the evaluator's existing protections (escaping, the evidence rule, no hidden facts in prompts) apply unchanged. Calibration output is written outside tracked paths by default.

## 10. Stories and order

Each story has its own branch, independent review and PR, as in earlier slices. New ids are reserved from `docs/ID_REGISTRY.md` when the plan is written.

1. **Probe format and starter set:** schema, loader, validator, linter, deterministic split, log adapter, and a starter set of 8 to 10 Friday probes including a couple of contrast probes and some real excerpts from demo transcripts.
2. **`pnpm calibrate`:** judge configuration, runner, all metrics, the two-layer report, `--repeat`, `--only`, `--strict`, the blind second-judge comparison, the usability accounting, and the first numbers on the starter set (labelled thin).
3. **`--draft-probes`:** the drafting helper, the `drafts/` folder, the approval step, and scaling the Friday set to at least 20 probes with at least 5 real excerpts.
4. **Baseline run (not a code story):** run `v1` live with Gemma, and with the second judge when available; record the result and the stage-gate decision.
5. **Prompt variants and the acceptance report:** only if the baseline fails.
6. **The calibration stamp:** the `evaluator` block, the lookup, the footer line, and the not-calibrated, stale and thin states.

Value arrives early: stories 1 and 2 already give the first real numbers. The plan is expected to be revisited after the baseline.

## 11. Testing and errors

- A scripted fake judge returns known verdicts, so every metric is unit-tested exactly (agreement, bias by level, contrast ordering and gap, spread, not-observed precision and recall, usability counts, the split, the stamp states). Golden files pin the report layout.
- CI makes no live model calls. Live runs are done by the controller and recorded in the plan, as in earlier slices.
- Tests follow AGENTS section 8: no wall-clock assertions, injected clocks, private temp directories, explicit generous timeouts for real-process tests, and no asynchronous function used as a synchronous check (L-0012).
- An invalid probe fails the run with a list of every problem. A judge that is unreachable or returns unusable output is recorded as unusable, not as disagreeing, and the other judge still runs. Partial results are written, so a long run is never lost.

## 12. Open points

- The second judge is `OsaurusAI/Holo3-35B-A3B-JANGTQ4`. It is an agent-tuned model and may not be a usable judge. It must be downloaded and its served model id recorded before the cross-judge comparison can run; until then calibration runs single-judge.
- Default thresholds (contrast ordering 80%, bias 0.3 levels, exact agreement level) are starting points to confirm once real numbers exist.
- The 2x cost cap on variants is to be reviewed against real call counts.
- Whether calibration results should become a committed, shared artifact (instead of per machine) is deferred until the first variant is adopted.
