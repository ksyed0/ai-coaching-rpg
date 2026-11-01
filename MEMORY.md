# Memory

Curated, topic-organised project knowledge (AGENTS.md section 3). Read this and every linked topic file at session start. Update or delete entries that are wrong; do not duplicate. Chronology lives in `progress.md`, rules learned the hard way in `docs/LESSONS.md`.

## Topics

| Topic | File | What it holds |
| --- | --- | --- |
| Models and providers | [docs/memory/models-and-providers.md](docs/memory/models-and-providers.md) | Providers, every environment variable and its default, the local model endpoint, which local models work and which do not |
| Demo, checks and testing | [docs/memory/demo-and-testing.md](docs/memory/demo-and-testing.md) | `pnpm demo` modes and their check counts, live-run recipes, `gm-eval`, `evaluate`, CI jobs, the Linux container recipe |
| Architecture and security conventions | [docs/memory/architecture-and-security.md](docs/memory/architecture-and-security.md) | Event-sourced engine, visibility filtering, log format, lock, fail-stop, hidden facts, scoring method, the CodeQL patterns to avoid |
| Process and workflow | [docs/memory/process.md](docs/memory/process.md) | Branches and PRs, the subagent build-and-review loop, reserved ids, plan-file conventions, merge rules |
| Backlog and decisions | [docs/memory/backlog-and-decisions.md](docs/memory/backlog-and-decisions.md) | What is open, decisions taken with their reasons, actions only the owner can do |

## The facts to know first

1. Everything on `develop` is a text-only terminal MVP: scripted scenario -> session host + WebSocket server -> AI characters, a Game Master, an evaluator. Nothing is built for voice or 3D yet. The participant web client (EPIC-0002 slice 2a: `apps/web` Next.js BFF, durable seats, consent gate, roster, `pnpm demo --web`) is built on stacked draft PRs #53..#57 plus the US-0065 branch, not yet on `develop` (2026-10-28); the facilitator uses the terminal, or (slice 2b-1, built 2026-10-30 on three stacked local branches, not pushed) a browser console backed by the control service `services/control` (`pnpm control`; `LAUNCHER_URL` switches the web app to per-session runtime lookup). Slice 2b-2a (runtime protocol for the live console, US-0059) adds `by` on commands, facilitator-only talk time and `end_now` (append order `scene.exited{facilitator_end}`, alert, `session.ended` last; a cut log is repaired on restore; the closing message reaches only players connected at the end); players get allowlisted copies (`PlayerSnapshot` = state without `talk`), and a resume repaired to ended sends `ended` right after `ready` (BUG-0016). See docs/memory/architecture-and-security.md (Web client; Control plane; Live console runtime protocol) and backlog-and-decisions.md (rulings R1..R11).
2. The best local model so far is `gemma-4-31b-it-qat-mxfp4` served by Osaurus at `http://127.0.0.1:1337/v1`; `.env` (git-ignored) already points at it. Raptor-8B was dropped for quality, Qwen3.8-27B is a slow reasoning model.
3. Mock mode is the default and needs no key; every test and the default demo run offline and deterministically.
4. Merge a PR only when the owner says so. CI must be fully green first; fix the cause of a red check, never merge over it.
5. The OpenRouter key pasted into chat on 2026-10-02 is still to be rotated; the owner deferred it (it is only in the git-ignored `.env`; the public repo and history hold placeholders only).
6. Calibration (EPIC-0005): the Friday set of 34 probes exists and was approved by an agent on the owner's instruction; the Task 11 baseline ran on 2026-10-08 (both judges PASS; see docs/EVALUATOR.md, Baseline); US-0038 (prompt variants) is Deferred, not Cancelled, until contrast is measured on more than 2 probes and the owner reviews the excerpt levels; the stamp (Task 13) is merged (#43). An agent may run `approve` only on the owner's explicit instruction (L-0019).
7. Moderation (EPIC-0005, merged 2026-10-26): `pnpm moderate` over a hash-chained `review.jsonl` (open, edit, accept, comment, release, amend, withdraw, export, supersede, self-assess, respond, resolve); default-deny `canView` policy, only the facilitator and `participant:<role>` resolve; self-assessment is facilitator-attested. An agent NEVER runs release/amend/withdraw unless the owner names the subjects, nor self-assess/respond/resolve unless the owner names the role and supplies the words (AGENTS.md). `--evaluate` showcase is now 16 checks (S-17 is scripted, skipped live); other demo counts 29/39/42/14. zod is v4 (advisory GHSA-mrhx-c7xc-m3w5 had no 3.x patch).
8. Demo counts after slice 2a are unchanged: 29 / 32 (`--security`) / 39 (`--resume`) / 42 (both) / 14 (showcase) / 16 (`--evaluate`); `pnpm demo --web` adds W-01..W-08 (8 checks, its own run). Every demo player now consents before the start (the start gate).
