# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it has a first tagged release.

## [Unreleased]

Slice 1 proof of concept: text-only play from a terminal against AI-played NPCs (EPIC-0001, US-0001 to US-0012).

### Added

- pnpm/TypeScript monorepo with Vitest: `packages/events`, `packages/script`, `packages/adapters`, `services/runtime` (US-0001).
- Session event types and a pure state reducer; session state is always a projection of the event log (US-0002).
- Scenario package: YAML schema, loader and validator with cross-kind id uniqueness checks and warnings for injects past a scene's time box (US-0003).
- Scene state machine: exit evaluation, next scene, timed injects (US-0004).
- `ModelProvider` adapter with a scripted mock and an Anthropic implementation, a shared contract test suite, and `pnpm lint:sdk` to keep provider SDKs inside `packages/adapters` (US-0005).
- Session engine with an append-only JSONL event log, serialized operations, scene control and facilitator commands (US-0006).
- NPC agents with a cacheable persona prompt, a first-token timeout and an overall reply deadline, each falling back to the character's scripted line plus a facilitator alert (US-0007).
- Game Master that evaluates scene exit conditions with the model beside the conversation (US-0008).
- Session host and WebSocket server with per-role event filtering and role reconnect tokens (US-0009).
- Terminal client: `pnpm play` for players and the facilitator (US-0010).
- CI pipeline (`.github/workflows/ci.yml`): lint, tests with an 80% coverage gate, build, orchestrator validation, dependency audit, TruffleHog secret scan and CodeQL.
- Friday Escalation scenario (YAML) and an end-to-end simulation test that plays it through with the mock model (US-0011).
- One-command start (US-0012): `./run.sh` runs the server in Docker (non-root user, pinned Node 22 Alpine base, healthcheck, `.dockerignore` keeping `.env` and host `node_modules` out of the image, bind-mounted `data/`); `./run.sh --dev` runs it with `tsx watch`; `./run.sh --help` lists usage. `.env` is created from `.env.example` when missing.
- Session-log rotation on restart: an earlier `<id>.jsonl` is moved aside as `<id>.<timestamp>.jsonl` and never overwritten (US-0009).
- `pnpm demo --showcase` (US-0024): a longer scenario, `scenarios/friday-escalation-extended` (6 scenes, 3 players, 2 AI characters including a new CFO, `showcase.yaml` script with a validating loader), played in mock mode (CI) or `--live` with the real Game Master ending scenes; flags `--scenario`, `--max-lines`, `--max-fallbacks`, `--watchdog`; source-labelled narration, an AI contribution summary, a `showcase` JSON section, checks `S-01` to `S-12`, and an extra CI step.
- US-0024 review fixes: optional `expectSceneId` on the WebSocket `say` and `command` messages (refused as `stale_scene`, nothing appended; old clients unaffected) so the showcase can never skip or mis-place a scene; an optional `fallback: true` marker on the NPC fallback `utterance`; a final Game Master evaluation before the safety-net advance; a fifth transcript tag `[UNVERIFIED]` for AI lines seen through `--url`; checks `S-13` (no scene skipped) and `S-14` (mock scripts not exhausted); Markdown escaping of tag-shaped tokens, GitHub autolinks and `$`; symlink and `--json`-collision refusal for `--transcript`.
- US-0024 review fixes, round 2: the `expectSceneId` guard no longer reveals the current scene to a role outside it (`not_in_scene` first); the final Game Master evaluation is bound to its scene; `--transcript` writes with `O_NOFOLLOW`, refuses symlinked parents and compares the `--json` file by inode; invisible and look-alike characters can no longer fake a tag in a transcript; effort numbers in the extended scenario agree (full module 6 person-weeks, phased 3).
- `--transcript <path.md>` (US-0024): a Markdown transcript of any demo mode with bold dialogue lines tagged `[SCRIPTED]`, `[GENERATED]` or `[FALLBACK]`, plain `[SYSTEM]` logging, and Markdown-safe escaping of model and server text.
- CI jobs for the TypeScript workspace, added beside the existing required checks: Workspace Typecheck, Workspace Tests (per-package 80% coverage gate via `pnpm test:coverage`), SDK Import Guard, Workspace Audit and Docker Build.
- `SESSION_ID` and `SCENARIO_DIR` documented (commented) in `.env.example`; `tsx` is now a dependency of `@acr/runtime` so the Docker image's start command works with a filtered install.
- OpenRouter and local OpenAI-compatible providers (Ollama, LM Studio, vLLM, llama.cpp) selected with `MODEL_PROVIDER=openrouter|local`, built on the global `fetch` with streaming SSE parsing and no new dependency; optional `ANTHROPIC_BASE_URL` for a custom Anthropic endpoint (US-0014).
- Compose maps `host.docker.internal` to the host gateway so a container can reach a model server on the host, also on Linux.
- PlanVisualizer v2.4.0 project tracking and the Agentic SDLC dashboard (`docs/`, `agents.config.json`).
- `README.md` and this changelog.
- `NPC_FIRST_TOKEN_TIMEOUT_MS` (default 10000) and `NPC_REPLY_TIMEOUT_MS` (default 20000) environment variables to configure the NPC first-token timeout and overall reply deadline; values are validated at startup (whole milliseconds, 500 to 600000, reply deadline at least the first-token timeout) (US-0015).
- `pnpm demo`: an unattended demo and test runner that plays the whole Friday Escalation with a facilitator bot and three player bots over real WebSockets and ends with a pass/fail checklist of 29 features (`--fast`, `--speed`, `--json <path|->`, `--live`, `--url ws://host:port`, `--session`, `--no-color`); exit code 0 when every executed check passed, 1 on a failure or the watchdog, 2 on a usage error. The default mode uses scripted mock models and a fake clock and is offline and deterministic; `--url` smoke-tests a running server such as the Docker container; a new non-required `Demo Run` CI job uploads the JSON report (US-0021).
- Retry of transient model errors (US-0022): the adapters classify failures with a typed `ModelProviderError` (`kind`, `transient`, `status`, `retryAfterMs`; sanitized message) for the OpenAI-compatible and Anthropic providers, and a `RetryingModelProvider` retries transient ones (HTTP 429/5xx/408, in-band overloaded or rate-limit errors, connection resets) before any text was yielded, with exponential backoff, jitter and `Retry-After`, inside the NPC first-token and reply deadlines. The runtime and the live demo wrap the NPC and Game Master providers; `MODEL_MAX_RETRIES` (0 to 5, default 2) and `MODEL_RETRY_BASE_MS` (100 to 10000, default 500) configure it. The mock provider can script typed errors.

### Changed

- The facilitator alert for a failed model call now says how many attempts were made and the error kind, e.g. `NPC cfo: model error after 3 attempts (overloaded): ...; used fallback line` and `GM: model error after 3 attempts (overloaded) for "<condition>": ...` (still ending in `used fallback line`; the `utterance.fallback` marker is unchanged) (US-0022).
- NPC first-token timeout default raised from 4 s to 10 s, so reasoning and slower models no longer trip the fallback line (US-0015).
- `pnpm demo` hardening (US-0021): `pnpm -s demo --fast --json -` now writes only the JSON report to stdout (the root script is silent; use `-s` so pnpm's own banner stays out); `--url` prints exactly what it will send to the target server before running; a check that did not run (other than the intended `--live`/`--url` mode skips) is a failure; `--url` lists everything it sends and warns that it ends the target's session; Ctrl-C/SIGTERM clean up the temp directory and exit 130/143; the bot clients cap frames (1 MiB) and inbox size (5,000 frames) against a hostile server.

### Security

- Provider secrets (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `LOCAL_API_KEY`) are never logged or put in URLs or error messages; the startup log shows a fixed provider label and a yes/no for "custom endpoint" only (no host or path), and the scenario-dir log line was removed. This addresses the CodeQL `js/clear-text-logging` alert on the provider log line in `services/runtime/src/main.ts`.
- Endpoint URLs (`ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`, `LOCAL_BASE_URL`) are validated at startup: userinfo, query strings and fragments are rejected, hosted endpoints must use https (plain http only on localhost), and errors name the variable without echoing the value. The OpenAI-compatible client and a custom Anthropic endpoint refuse redirects so credentials are never forwarded (the default Anthropic path is unchanged), caps error and JSON bodies, and truncates and sanitizes upstream error text.
- Players only receive events they are allowed to see (default-deny filter); other participants' ids, NPC goals, whispers and private facts are never sent to them.
- NPC and Game Master prompts never contain rubrics, other roles' private material or participant display names; the Game Master frames participant text as data so one participant cannot forge another's line.
- The terminal client sanitizes all server-supplied text so control or escape sequences from other participants or the model cannot manipulate a terminal.
- A role can only be taken over by a client presenting that role's reconnect token.
- Live-model tests are opt-in only (`RUN_LIVE_MODEL_TESTS=1` plus an API key); the default test run never reaches the network.

### Changed

- Default model is now `claude-sonnet-5-5` (Anthropic) / `anthropic/claude-sonnet-5.5` (OpenRouter); set `NPC_MODEL` / `GM_MODEL` to keep the previous one (US-0014).

### Fixed

- Session-log rotation falls back to an exclusive file copy (never overwriting) when the filesystem refuses hard links (EPERM, ENOTSUP, EXDEV, EOPNOTSUPP), so a Docker restart works on such bind mounts; a failed removal after the copy is reported explicitly (US-0009).
- `./run.sh` no longer starts the container as root when run as root or with sudo; it falls back to 1000:1000 unless `HOST_UID`/`HOST_GID` are set (US-0012).
- Root `package.json` license corrected from ISC to MIT to match `LICENSE`.

### Fixed (final review wave)

- WebSocket heartbeat: the server pings every connection every 15 s and drops one that did not answer the previous ping, so a player whose machine slept no longer keeps their role until TCP gives up (US-0009).
- A blank `NPC_MODEL`/`GM_MODEL` in `.env` now falls back to the default model instead of sending an empty model name.
- A facilitator whisper to an NPC role is rejected (`npc_role`) instead of being logged and never seen.
- The CLI prints the visible transcript (last 50 lines, sanitized) when you join or rejoin (US-0010).
- A player's join snapshot no longer lists scenes they are not in.

### Known limitations

- No authentication: any client that can reach the server can join as facilitator (full event stream, whispers, NPC goals, GM reasoning, start/command control) or claim any unclaimed player role and read its brief. Use a trusted local network only.
- NPC hidden facts are loaded and kept out of prompts, but nothing releases them yet, so they never surface in play; a facilitator release command is planned.
- Sessions are not resumed after a restart; the old log is rotated aside as `<id>.<timestamp>.jsonl`.
- Two server processes on the same data directory and session id rotate each other's log file.
- One session per server process; text only (no voice, web or Teams client); no scoring yet.

<!-- Add new entries under [Unreleased]; on release, rename it to the version and date and start a fresh [Unreleased]. -->
