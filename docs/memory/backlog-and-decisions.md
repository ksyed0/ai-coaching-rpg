# Backlog and decisions

## State on 2026-10-07 (session 7)
`develop` holds everything built so far (through PR #32; PR #33 US-0019 is open and the calibration stories are in build). Delivered stories: US-0001..US-0012 (Slice 1), US-0014..US-0018, US-0021, US-0022, US-0024..US-0034, US-0013 (protocol slice; the web lobby of EPIC-0002 is still untouched), bugs BUG-0001..BUG-0006.

## Open work, in the order I would take it
1. **EPIC-0005 remainder:** facilitator moderation and release of reports (ASM-04), participant self-assessment (ASM-07), per-participant visibility (ASM-09), calibration with a second judge (ASM-08). The evaluator is lenient and its three players score alike; a judge from a different model family is the plan.
2. **EPIC-0005 calibration slice (US-0035..US-0039):** US-0035 code-complete on its branch, then US-0036 `pnpm calibrate`, US-0037 drafting and the scaled probe set, the live baseline (decision gate), US-0038 variants only if the baseline FAILs, US-0039 the report stamp. Plan: `docs/superpowers/plans/2026-10-07-evaluator-calibration.md`.
3. Tooling: a lint rule or contributor note against short real timers and `/proc` in tests (three CI rounds were lost to them); a Linux test that forces real inode reuse in the lock takeover; a restart policy outside Docker.
4. Epics 2, 3, 4 (web lobby, voice over LiveKit, 3D) are all Planned and untouched.

Follow-ups from the US-0013 and US-0034 reviews (not filed as stories): announce the text of an auto-released fact found in a replay (N1); tests for a one-microtask yield in the join block and for the replay margin (N2); a log identity in `joined` so a pre-`fresh` `lastSeq` is detected; a per-address join rate limit; per-viewer event numbering (players see seq gaps for facilitator-only events); earned checks in the showcase reliability numbers; the terminal client does not reconnect by itself; a live `gm-eval` set for `earned_when`; a flaky real-timer watchdog test in `runner.test.ts` and an `atomic-write` concurrency test (seen to flake once under load).

Review follow-ups for the calibration code (deferred minors, not filed): see `.superpowers/sdd/2026-10-07-evaluator-calibration/progress.md` in the US-0035 worktree: item-4 test fixture that only the prototype-key defence can refuse; sanitise bidi and zero-width characters in loader messages; `O_NOFOLLOW` in `readCapped`; FIFO `.yaml` entries; ESLint does not lint any TypeScript in this repo (still true: type-aware lint is an open tooling item).

## Decisions taken (and why)
- Local model default Gemma-4-31B; Raptor dropped (repetition, echoing). 2026-10-06, owner.
- Participants may see each other's evaluation reports for now; isolation and security later "once we know this is working". 2026-10-06, owner.
- Scoring method: BARS with four levels, no midpoint, plus Not observed (common in L&D; avoids central tendency). Evidence rule and method text printed in every report.
- The server stays OPEN when no facilitator token is set (with a loud warning and a facilitator notice); `run.sh` generates a token into NEW `.env` files; fail-closed is a later release. 2026-10-06, product-owner defaults.
- Resume is automatic but always PAUSED until `/resume`; pause freezes the scene clock; downtime counts as paused time; an ended session's log rotates aside; the scenario hash makes any scenario edit block a resume (use `SESSION_START=fresh`).
- An unopposed proposal does NOT count as agreement for the Game Master; the extended showcase scene 3 got assent lines and scene 5 uses a scripted `release_hidden` step.
- AI characters reply junior-first by `seniority`, may stay silent with `<silent/>` (at most two turns in a row, and the last character of a round must speak).
- PR #4 (stale cost-log branch) was discarded; its rows were salvaged into #19.

- Player join codes (US-0033): per-role codes, hashes only, kept on resume, re-issued on fresh/empty log; the facilitator token stays separate. 2026-10-07, product-owner defaults.

- EPIC-0005 ("trustworthy scores first"), 2026-10-07, owner: calibration before moderation, self-assessment and visibility; standalone `pnpm calibrate`; probes per scenario (single, contrast, excerpt) with tune/holdout split; judges are configuration; second judge `OsaurusAI/Holo3-35B-A3B-JANGTQ4` (an agent-tuned model: may be unusable as a judge, so its usability is measured before its disagreements count); drafted probes use a different family than the judge; variants only if the baseline FAILs; reports carry a calibration stamp. Details in the spec.

## Only the owner can do
- **Rotate the OpenRouter key** that was pasted into chat on 2026-10-02 (it is in no committed file; it sits in the git-ignored `.env`).
- Add the second judge `OsaurusAI/Holo3-35B-A3B-JANGTQ4` to Osaurus (it is not served yet; the endpoint lists only foundation, gemma-4-31b, nemotron-3-nano-omni, qwen3.8-27b, raptor) and tell the agent its id from `/v1/models`; approve probes at Task 10 of the calibration plan.
- Say whether to delete the old `chore/ai-cost-log-session-1` branch (merged remote branches were deleted and `docs/pitch/` was committed on 2026-10-07).
