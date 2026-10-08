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

1. Everything on `develop` is a text-only terminal MVP: scripted scenario -> session host + WebSocket server -> AI characters, a Game Master, an evaluator. Nothing is built for web, voice or 3D yet.
2. The best local model so far is `gemma-4-31b-it-qat-mxfp4` served by Osaurus at `http://127.0.0.1:1337/v1`; `.env` (git-ignored) already points at it. Raptor-8B was dropped for quality, Qwen3.8-27B is a slow reasoning model.
3. Mock mode is the default and needs no key; every test and the default demo run offline and deterministically.
4. Merge a PR only when the owner says so. CI must be fully green first; fix the cause of a red check, never merge over it.
5. The OpenRouter key pasted into chat on 2026-10-02 is still to be rotated; the owner deferred it (it is only in the git-ignored `.env`; the public repo and history hold placeholders only).
6. Calibration (EPIC-0005): the Friday set of 34 probes exists and was approved by an agent on the owner's instruction; the next step is the Task 11 baseline live run. An agent may run `approve` only on the owner's explicit instruction (L-0019).
