# Progress

## Session 1 — 2026-10-01

- Product specification completed (Claude doc) and Architecture.md written and aligned: MVP runs locally on a laptop first; Teams and cloud from v1; application-level encryption out of MVP.
- Repository created; PlanVisualizer installed; implementation plan for EPIC-0001 (slice 1) written and self-reviewed.
- Next: review the plan, choose an execution method, start TASK-0001.

## Session 2 — 2026-10-02/03

- Slice 1 (EPIC-0001, US-0001 to US-0012) built, reviewed and merged to `develop` via PR #3, plus US-0014 (OpenRouter and local OpenAI-compatible providers, optional Anthropic base URL, default model claude-sonnet-5-5) and US-0015 (NPC timeouts configurable, 10 s first-token default).
- CI pipeline, branch protection on `main` and `develop`, README, CHANGELOG and the product spec snapshot (`docs/PRODUCT_SPEC.md`) added.
- Follow-ups captured in `docs/RELEASE_PLAN.md` as EPIC-0006: US-0016 release hidden facts, US-0017 facilitator token and limits, US-0018 resume after restart, US-0019 model cost, US-0020 shared id rules, US-0021 unattended demo runner; bugs BUG-0001 (heartbeat test timing) and BUG-0002 (custom Anthropic endpoint error message). US-0013 (reconnect replay) stays in EPIC-0002.
- Known limitations: no facilitator authentication, server binds all interfaces, hidden NPC facts never released, sessions not resumed after a restart.
- US-0021 demo runner built on `feature/EPIC-0006-followups-and-demo-runner`: `pnpm demo` (mock, `--live`, `--url`, `--json`), 29-check feature checklist, tests and a non-required `Demo Run` CI job.
- Next: the EPIC-0006 stories by priority.

## Session 2 (continued) — 2026-10-05

- PR #5 merged (US-0021 demo runner, EPIC-0006 backlog). GitHub Pages enabled with the Actions source; `develop` added as an allowed deploy branch of the `github-pages` environment; the Plan Visualizer dashboard now deploys (plan-status.html, dashboard.html).
- Real demo runs captured (mock x2, paced x1, live x3 against OpenRouter nvidia/nemotron-3-ultra-550b-a55b:free): all exit 0. Live runs showed 2 of 6 main-story NPC replies were the canned fallback line (free-tier "Service temporarily overloaded" on about 4 of 10 direct calls).
- Local model configured for the runtime: osaurus at http://127.0.0.1:1337/v1, model qwen3.8-27b-mxfp8. First token takes 32-95 s on this machine, so `NPC_FIRST_TOKEN_TIMEOUT_MS=120000` and `NPC_REPLY_TIMEOUT_MS=180000` are set in the git-ignored `.env`.
- Filed: US-0022 (retry transient model errors), US-0023 (demo live-mode fallback evidence), BUG-0003 (demo check F-23 weak evidence).

## Session 3 — 2026-10-05

- US-0024 built on `feature/EPIC-0006-US-0024-showcase-demo` (stacked on PR #6): `scenarios/friday-escalation-extended` (6 scenes, 2 AI characters incl. a new CFO, showcase.yaml), `pnpm demo --showcase` (mock for CI, `--live` with the real Game Master) with `--scenario`, `--max-lines`, `--max-fallbacks`, `--watchdog`, checks S-01 to S-12, an AI contribution summary and a `showcase` JSON section; `--transcript <path.md>` (all modes) writes a Markdown transcript tagged SCRIPTED / GENERATED / FALLBACK. CI Demo Run job gained the showcase step.
- Review fix round 1 (R42-R44): UNVERIFIED tag for `--url`, scene guards (`expectSceneId`, `stale_scene`), exact fallback marker, final GM evaluation, S-13/S-14, safer Markdown. AC-0078 is unticked until a real live run is recorded.
- Next: the controller runs the real live showcase; then US-0022 / US-0023 (note AC-0075 is now partly delivered by `--max-fallbacks` for the showcase).
- First real live showcase recorded (extended scenario, OpenRouter nvidia/nemotron-3-ultra-550b-a55b:free, 2026-10-05): exit 0 in 279 s, 12 of 20 AI replies generated, 8 canned fallbacks (first-token timeouts), 4 real Game Master evaluations, 1 scene exited by the Game Master and 5 by the recorded facilitator safety net. US-0024 closed; US-0025 (Game Master reliability with real models) filed.

## Session 4 — 2026-10-05

- US-0022 built on `feature/EPIC-0006-US-0022-retry-transient-model-errors`: typed `ModelProviderError` classification in the OpenAI-compatible and Anthropic adapters (mock can script typed errors), `RetryingModelProvider` (bounded, backoff with jitter, Retry-After, abortable so retries never outlive the NPC deadlines, never retries after the first chunk), `MODEL_MAX_RETRIES` / `MODEL_RETRY_BASE_MS` read in `bootstrap()` and the live demo paths, alerts that state attempts and kind (`used fallback line` kept). Verified with fakes only; the controller measures the real-provider fallback rate afterwards. Review round R46: Anthropic SSE error events and custom-endpoint connection failures classified correctly, SDK retries off under the wrapper, Game Master deadline max(reply timeout, 60 s), quota 429 permanent, retry history in deadline alerts. Bounds: a retry waits base x 2^(n-1) (+/-25%, cap max(4 s, base)) or Retry-After up to 10 s; deadlines cut it. Real run after review: 10 of 20 fallbacks without retries, 0 of 20 with.

## Session 5 — 2026-10-06

- EPIC-0005 pulled forward (Planned -> In Progress) on `feature/EPIC-0005-evaluator-feedback`, stacked on US-0027: US-0028 (BARS rubric schema, loader, validator, two rubrics), US-0029 (evaluator engine with verified evidence, aggregation, re-ask), US-0030 (participant and group reports, index, method), US-0031 (`pnpm evaluate`, `pnpm demo --showcase --evaluate`, check S-16). Decisions: scores visible to all participants for now; BARS with four levels and Not observed. Follow-ups not filed: moderation workflow (ASM-04), self-assessment (ASM-07), isolation (ASM-09). No live model calls were made; the controller runs the real evaluations.


- US-0032 built on `feature/EPIC-0006-ai-character-voices` (from the evaluator branch): NPC role fields `seniority`, `responds_with`, `only_you_say`, `defer_to` (content for Priya and Helena), `## Who else is in the room` and `## How you respond` prompt sections, `<silent/>` turns (max 2 in a row, never recorded, counted in memory), junior-first reply order, echo metric and silent counts in the showcase report. Next: the controller records the live comparison (AC-0119 stays unticked).
- US-0032 fix round (independent review): forced last speaker per round, silence markers folded and stripped before cleaning, roster tags, generic prompt wording and `defers_text`, echo metric limited to different roles and the same player line (`echoes / eligiblePairs`), participant-order ties, bounded silence memory, S-06 cross-character prompt audit.

- US-0016 built on `feature/EPIC-0006-US-0016-release-hidden-facts`: `release_hidden` facilitator command (1-based fact number), engine rules, `joined.hiddenFacts`, the `## What you may now share` prompt section, `/hidden` and `/release`, a scripted s5 release in the extended showcase, S-06/S-07/S-15 audits and the S-07 observation fix. No live model call was made; the controller confirms live that scene 5 now ends by the Game Master on Gemma.

## Session 6 — 2026-10-06/07 (close)

**Completed and merged to `develop` (PRs #6 to #19, all CI-green, no PRs open):**
- Planning and tooling: housekeeping (plan statuses reconciled, ID-registry unit test, stop-hook path fix, BUG-0001/2/3), US-0024 showcase and transcripts, US-0022 retry, US-0026 token budgets and reasoning-only replies, BUG-0004 (characters speaking for others, transcript line breaks), BUG-0005 (pause freezes the scene clock).
- AI quality: US-0027 generated players with logged intents, US-0032 distinct AI voices (seniority, silence, junior-first), US-0025 Game Master reliability (nonce-signed verdicts, one re-ask, `gm-eval`), US-0016 hidden-fact release (the CFO now settles scene 5; the Game Master ended 5 of 6 scenes on Gemma).
- Product: US-0028..US-0031 the evaluator (BARS rubrics, verified-evidence scoring, draft reports, `pnpm evaluate`, `--evaluate`).
- Operations and safety: US-0017 facilitator token, caps and limits (open with a warning when unset), US-0018 resume after restart (auto-resume paused, fail-stop log, single-writer lock, crash-cut completion, `--resume` demo room).
- Housekeeping at close: cost rows salvaged from the stale PR #4 into #19 and #4 discarded; finished worktrees and merged local branches removed; `MEMORY.md` and its topic files, `PROMPT_LOG.md` (77 prompts, secrets redacted), `MIGRATION_LOG.md`, 10 new lessons (L-0002..L-0011) added.
- Local model decision: Gemma-4-31B for all demo and acceptance runs; Raptor-8B dropped; a Hugging Face survey produced candidate second models (see `docs/memory/models-and-providers.md`).

**Findings worth keeping:** independent reviews found real Critical and Important bugs in the newest code (forged Game Master verdicts, a failed `fdatasync` splitting the engine from the log, a crash window leaving a resumed session with no scene, a Linux-only inode-reuse race in the lock takeover); CI caught two Linux-only problems the macOS runs hid (a `/proc` path that hung a job for 20 minutes, a timing-dependent lock test). See `docs/LESSONS.md` L-0002..L-0009.

**Security incident (AGENTS.md section 11):** an OpenRouter API key was pasted into the chat prompt on 2026-10-02. It is stored only in the git-ignored `.env` files and is redacted in `PROMPT_LOG.md`; it appears in no committed file. **The owner must rotate it.**

**Test status at close:** see the coverage block below. Last CI on `develop`: green (all 14 checks) for the merge of #19.

**Open items / blockers:**
- Owner actions: rotate the OpenRouter key; download a second local model if an independent judge is wanted (tell the agent its id); decide whether to delete merged remote branches and the old `chore/ai-cost-log-session-1` branch; `docs/pitch/` is an untracked folder in the main checkout that agents did not create.
- Next stories: US-0033 per-role join codes, US-0034 Game Master suggests releases, US-0013 rejoin replay, evaluator moderation and calibration (EPIC-0005), US-0019 model cost. EPIC-0002/3/4 untouched.
- Load-sensitive tests: a few tests assert wall-clock bounds or count `acr-demo-*` temp directories in the shared `/tmp` and fail under load (see the coverage block); tracked as BUG-0006.
- The Stop hook records cumulative totals per snapshot in `docs/AI_COST_LOG.md`; do not sum its rows.

## Session 7 — 2026-10-07 (owner housekeeping, US-0033, US-0034 and US-0013 shipped)

**Done**
- Owner housekeeping: `docs/pitch/` (executive pitch deck, ~6 MB .pptx) committed and merged as PR #22; the 15 remote branches merged into `develop` deleted (`chore/ai-cost-log-session-1` kept, it is not merged); merged worktree and local branch removed.
- **US-0033 per-role player join codes merged (PR #23, all 14 CI checks green).** One random 12-symbol code per player role, shown once on stdout, stored only as a salted SHA-256 in `data/sessions/<id>.codes.json` (0600), required on `join`; every refusal is one byte-identical `unauthorized`, charged to the failed-login throttle; the facilitator token and the reconnect token stay separate; codes survive a resume and are re-issued on a fresh, empty or rotated log; unseen codes are withdrawn when a start fails; terminal client reads `JOIN_CODE`, `--code-file` or a hidden prompt (never argv); `pnpm demo --url` reads `JOIN_CODES`. ACs AC-0120..AC-0122 ticked; TC-0001..TC-0007 added (story stays In Progress until a human live check).
- Review loop: implementer (opus) -> independent review (needs fixes: 1 Important, 6 Minor) -> fix round -> scoped re-review (needs fixes: 1 more Important) -> fix round -> narrow re-review (ready to push). Details in `docs/LESSONS.md` L-0012 and L-0013.
- Gates on the final commit: typecheck ok; eslint 0 errors (37 old warnings in `tools/`); `pnpm lint:sdk` ok; `pnpm test:coverage` green twice (once under `yes` x8 load), runtime 88 files / 1708 tests, 96.4% statements / 98.6% lines; `npm run plan:test` 1241 passed; `pnpm demo --fast` 29/29, `--security --resume` 42/42, `--showcase --fast` 14/14; the join-code test files green in `node:22` as root and as `--user node`. No live model calls (no prompt change).

**Also shipped overnight (autonomous run, merged on green CI, 14 of 14 checks each)**
- **US-0034 Game Master suggests hidden-fact releases (PR #25).** Optional per-fact `earned_when` condition; the Game Master judges pending conditions (nonce-signed, one re-ask, at most 2 checks per round, none in a round whose exit verdict is true); a true verdict records one facilitator-only `gm.fact_earned` event (role and number, never the text) and the facilitator is told `/release <role> <n>`; never repeated (folded from the log, survives restart); nothing is released without `release_hidden` unless `GM_AUTO_RELEASE=1` (off by default, recorded as a Game Master action, crash window repaired on resume). Review: no Critical or Important; Minor M1..M6 fixed. TC-0008..TC-0012.
- **US-0013 rejoin replay (PR #26).** Optional `lastSeq` on `join` / `join_facilitator`; `joined.replay {afterSeq,toSeq,events,complete}` then exactly those event frames, filtered by the same default-deny `viewFor`; exactly-once against the live stream (replay, snapshot and subscribe in one synchronous block, last 4096 events kept in memory); caps 1000 events / 256 KiB and bounded by the snapshot size; terminal client `--last-seq` and a correct rejoin hint. Reviews found 3 Important (wrong rejoin seq after a mid-replay drop, replay cap ignoring snapshot bytes, untested facilitator ordering), all fixed and re-reviewed. TC-0013..TC-0016. EPIC-0002 is now In Progress (protocol slice only).
- **Simulation runs (live Gemma, generated players, `--evaluate`):** see `docs/memory/demo-and-testing.md`. After US-0034 the real model judged the CFO condition true in scene 4 and the Game Master suggested the release; the Game Master ended 5 of 6 scenes; 0 fallbacks. Mock demos stay 29 / 42 / 14 / 15.

**In progress**
- Nothing is in flight at the time of writing. Next: US-0019 (model cost per session), US-0020, US-0023 and the EPIC-0005 remainder; see `docs/memory/backlog-and-decisions.md` for the follow-ups collected from the reviews.

**Open items / blockers**
- Owner: rotate the OpenRouter key pasted into chat on 2026-10-02 (still outstanding); download a second local model (recommended: Ministral-3-14B-Instruct-2512) and give its id; decide on `chore/ai-cost-log-session-1`.
- Known limitation (US-0033, in `docs/THREAT_MODEL.md`): a crash between re-issuing codes on a resume and showing them keeps codes nobody saw; recovery is moving `<id>.codes.json` aside. Player typos share the per-address failed-login throttle (Docker Desktop shares one address).
- Tooling follow-up (not filed): `@typescript-eslint/no-misused-promises` is not enabled because eslint lints only JS under `tools/`, `orchestrator/`, `tests/`, never the TypeScript sources; an async function used as a void callback slipped past two reviews once (L-0012).
- Next stories after US-0034: US-0013 rejoin replay, EPIC-0005 remainder (moderation, self-assessment, visibility, calibration with a second judge), US-0019, US-0020, US-0023.

**Overnight run, part 2 (2026-10-07, merged on 14/14 green CI each):** PR #28 US-0020 shared id rules (one module `packages/events/src/ids.ts`, 0 divergences over 282,271 ids at 26 sites, hostile ids refused before any file is touched, lock tracked by device and inode so a case-variant id is refused as already open, plan text corrected); PR #29 BUG-0007 (a timed-out demo run leaked its temp directory and kept running: temp dirs own their cleanup, bounded 5 s wait after an abort, real small timers in the tests replaced by hand-fired ones, lesson L-0014); PR #30 US-0023 (live-run evidence: fallback counts, sanitised alerts linked to the affected reply, `--max-fallbacks` outside the showcase, run summary; sanitiser hardened over three review rounds: all join-code forms, Bearer after newlines, hidden facts with invisible characters or cut off by a truncated provider error).

**NOT merged: US-0019 (model cost), branch `feature/EPIC-0006-US-0019-model-cost` (worktree `../ai-coaching-rpg.worktrees/US-0019`, commits up to 13af04f, reviewed twice: ready to push, but not pushed).** Reason: its last live Gemma showcase (final code, generated players, `--evaluate`) passed 15 checks but the Game Master ended only 3 of 6 scenes (14 evaluations, 3 true), against 5 of 6 in the two earlier live runs (pre-fix branch and after US-0034). It may be variance in the generated players, but a prompt change should not merge on an unexplained drop (L-0009). To do next: run the live showcase 2 to 3 times on `develop` and on the branch and compare Game Master exits; read the transcript for scenes 2, 4 and 6 (did the bounded window or the kept-lines selection hide a condition? the shipped scenes are 6 to 25 lines against the default window of 40, so the window should not cut); also record `cache_read_input_tokens` for the Anthropic cache claim. The branch needs `git merge origin/develop` (conflicts expected in docs and registry; follow the runbook in `docs/memory/process.md`: take the max registry ids, `npm ci`, `npm run plan:generate` before committing).

**Other open items:** EPIC-0005 remainder (stories not yet filed), the review follow-ups listed in `docs/memory/backlog-and-decisions.md`, the `__proto__`-style ids kept as valid session ids (verified harmless), the OpenRouter key rotation (still owed by the owner), a decision on `chore/ai-cost-log-session-1`.

