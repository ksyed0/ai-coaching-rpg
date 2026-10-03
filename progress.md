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
- Next: US-0021 demo runner (in progress on `feature/EPIC-0006-followups-and-demo-runner`), then the EPIC-0006 stories by priority.
