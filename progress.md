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
