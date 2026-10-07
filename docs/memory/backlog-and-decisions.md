# Backlog and decisions

## State at the end of session 6 (2026-10-07)
`develop` holds everything built so far; no PRs are open. Delivered stories: US-0001..US-0012 (Slice 1), US-0014, US-0015, US-0016, US-0017, US-0018, US-0021, US-0022, US-0024..US-0032, bugs BUG-0001..BUG-0005.

## Open work, in the order I would take it
1. **US-0033** per-role player join codes (closes the unclaimed-role gap US-0017 left open; also after a restart every role is claimable). Priority Medium.
2. **US-0034** the Game Master suggests hidden-fact releases when a scenario `earned_when` condition holds (suggest-only, never auto-release by default). Depends on US-0016 and US-0025 (both done).
3. **US-0013** a rejoining client receives the injects and whispers it missed (replay-from-seq); today it gets only its filtered transcript. EPIC-0002 (web lobby) depends on it.
4. **EPIC-0005 remainder:** facilitator moderation and release of reports (ASM-04), participant self-assessment (ASM-07), per-participant visibility (ASM-09), calibration with a second judge (ASM-08). The evaluator is lenient and its three players score alike; a judge from a different model family is the plan.
5. **US-0019** model cost per session; **US-0020** shared id rules; **US-0023** demo live-mode fallback evidence.
6. Tooling: a lint rule or contributor note against short real timers and `/proc` in tests (three CI rounds were lost to them); a Linux test that forces real inode reuse in the lock takeover; a restart policy outside Docker.
7. Epics 2, 3, 4 (web lobby, voice over LiveKit, 3D) are all Planned and untouched.

## Decisions taken (and why)
- Local model default Gemma-4-31B; Raptor dropped (repetition, echoing). 2026-10-06, owner.
- Participants may see each other's evaluation reports for now; isolation and security later "once we know this is working". 2026-10-06, owner.
- Scoring method: BARS with four levels, no midpoint, plus Not observed (common in L&D; avoids central tendency). Evidence rule and method text printed in every report.
- The server stays OPEN when no facilitator token is set (with a loud warning and a facilitator notice); `run.sh` generates a token into NEW `.env` files; fail-closed is a later release. 2026-10-06, product-owner defaults.
- Resume is automatic but always PAUSED until `/resume`; pause freezes the scene clock; downtime counts as paused time; an ended session's log rotates aside; the scenario hash makes any scenario edit block a resume (use `SESSION_START=fresh`).
- An unopposed proposal does NOT count as agreement for the Game Master; the extended showcase scene 3 got assent lines and scene 5 uses a scripted `release_hidden` step.
- AI characters reply junior-first by `seniority`, may stay silent with `<silent/>` (at most two turns in a row, and the last character of a round must speak).
- PR #4 (stale cost-log branch) was discarded; its rows were salvaged into #19.

## Only the owner can do
- **Rotate the OpenRouter key** that was pasted into chat on 2026-10-02 (it is in no committed file; it sits in the git-ignored `.env`).
- Download a second local model (candidates in `models-and-providers.md`) and tell the agent its id from `/v1/models`.
- Say whether to delete the merged remote branches on GitHub and the old `chore/ai-cost-log-session-1` branch; `docs/pitch/` in the main checkout is untracked and was not created by the agents.
