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
- PlanVisualizer v2.4.0 project tracking and the Agentic SDLC dashboard (`docs/`, `agents.config.json`).
- `README.md` and this changelog.

### Security

- Players only receive events they are allowed to see (default-deny filter); other participants' ids, NPC goals, whispers and private facts are never sent to them.
- NPC and Game Master prompts never contain rubrics, other roles' private material or participant display names; the Game Master frames participant text as data so one participant cannot forge another's line.
- The terminal client sanitizes all server-supplied text so control or escape sequences from other participants or the model cannot manipulate a terminal.
- A role can only be taken over by a client presenting that role's reconnect token.
- Live-model tests are opt-in only (`RUN_LIVE_MODEL_TESTS=1` plus an API key); the default test run never reaches the network.

### Known limitations

- No authentication: any client that can reach the server can join as facilitator. Use a trusted local network only.

<!-- Add new entries under [Unreleased]; on release, rename it to the version and date and start a fresh [Unreleased]. -->
