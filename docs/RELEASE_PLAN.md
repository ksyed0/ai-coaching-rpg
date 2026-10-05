# Release Plan — AI Coaching RPG

Source of truth for scope and sequencing. Design: `docs/ARCHITECTURE.md`; implementation plan for EPIC-0001: `docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md`.

## Epics

```
EPIC-0001: Slice 1 — script package and text-only runtime
Description: A scenario written in YAML is loaded, validated and played in text by three people over a LAN against AI NPCs with a Game Master, from one laptop with one command. Proves the core loop before voice, 3D and scoring.
Release Target: MVP
Status: Planned
Dependencies: None
```

```
EPIC-0002: Slice 2 — web lobby, session view and reconnect
Description: Browser lobby with consent and role assignment, text session view, minimal facilitator console, replay-from-seq reconnect.
Release Target: MVP
Status: Planned
Dependencies: EPIC-0001
```

```
EPIC-0003: Slice 3 — voice over LiveKit
Description: LiveKit rooms, per-track STT with speaker attribution, NPC TTS bot tracks, latency instrumentation against the budget in ARCHITECTURE.md section 4.
Release Target: MVP
Status: Planned
Dependencies: EPIC-0002
```

```
EPIC-0004: Slice 4 — 3D scene
Description: Babylon.js scene as a pure consumer of scene events, library levels, avatar selection, idle/speaking/action animations.
Release Target: MVP
Status: Planned
Dependencies: EPIC-0002
```

```
EPIC-0005: Slice 5 — evaluator and reports
Description: Post-session rubric scoring with quoted evidence and confidence, facilitator moderation, participant and group reports with ASM-09 visibility.
Release Target: MVP
Status: Planned
Dependencies: EPIC-0003
```

```
EPIC-0006: Slice 1 follow-ups — hidden facts, access control, resilience and demo tooling
Description: Work deliberately deferred while delivering Slice 1: releasing NPC hidden facts, protecting facilitator access and limiting abuse, resuming a session after a restart, lowering model cost, keeping identifier rules in one place, and an unattended demo and test runner.
Release Target: MVP
Status: Planned
Dependencies: EPIC-0001
```

## User stories and tasks

```
US-0001 (EPIC-0001): As a developer, I want a pnpm monorepo with TypeScript and Vitest, so that every package builds and tests with one command.
Priority: High
Estimate: S
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: None
Acceptance Criteria:
  - [ ] AC-0001: `pnpm install && pnpm test && pnpm typecheck` succeed from a clean clone
  - [ ] AC-0002: packages import each other as @acr/<name> workspace links
```

```
TASK-0001 (US-0001): Scaffold workspace, base tsconfig, Vitest workspace, .env.example
Type: Infra
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0002 (EPIC-0001): As the runtime, I want typed session events and a pure reducer, so that session state is always a projection of the event log.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0001
Acceptance Criteria:
  - [ ] AC-0003: reduce() rejects out-of-order seq
  - [ ] AC-0004: visibleTranscript() returns only scenes the role participated in
  - [ ] AC-0005: pause, resume, scene entry/exit, injects and NPC updates are reflected in state
```

```
TASK-0002 (US-0002): Implement events.ts and state.ts with reducer tests
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0003 (EPIC-0001): As a scenario author, I want my YAML scenario folder loaded and validated, so that mistakes are reported before a session starts.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0002
Acceptance Criteria:
  - [ ] AC-0006: loadScenario reads scenario.yaml, roles/*.yaml and script.yaml
  - [ ] AC-0007: a missing roles/ directory fails with one message naming the folder
  - [ ] AC-0008: validator errors on unknown participants and duplicate inject ids
  - [ ] AC-0009: validator warns on injects past the time box and objectives with no criteria
  - [ ] AC-0010: a JSON Schema is exported for editors
```

```
TASK-0003 (US-0003): Implement Zod schema, loader, validator and fixtures
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0004 (EPIC-0001): As the runtime, I want a scene state machine, so that scenes exit on time box, facilitator advance or a Game Master verdict.
Priority: High
Estimate: S
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0003
Acceptance Criteria:
  - [ ] AC-0011: evaluateExit honours only the conditions a scene lists
  - [ ] AC-0012: dueInjects returns timed injects once
```

```
TASK-0004 (US-0004): Implement fsm.ts with exit evaluation, next scene and due injects
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0005 (EPIC-0001): As the runtime, I want a ModelProvider adapter with a mock and an Anthropic implementation, so that NPCs run in tests without a key and with a real model in play.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0004
Acceptance Criteria:
  - [ ] AC-0013: the contract suite passes for the mock and (with a key) for Anthropic
  - [ ] AC-0014: MockModelProvider replays scripted replies and records calls
  - [ ] AC-0015: no file outside packages/adapters imports a provider SDK (lint)
```

```
TASK-0005 (US-0005): Implement model adapter types, mock, Anthropic, selector and SDK-import lint
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0006 (EPIC-0001): As a facilitator, I want a session engine that runs the script, so that scenes advance, injects fire and every turn is logged.
Priority: High
Estimate: L
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0005
Acceptance Criteria:
  - [ ] AC-0016: start() enters the first scene and fires its opening inject
  - [ ] AC-0017: say() is refused while paused or when the role is not in the scene
  - [ ] AC-0018: timed injects fire once on tick
  - [ ] AC-0019: scenes exit on time box, advance or GM verdict and the session ends after the last scene
  - [ ] AC-0020: events persist to a JSONL log with monotonic seq
```

```
TASK-0006 (US-0006): Implement SessionEngine, EventLog (memory, JSONL) and Clock
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0007 (EPIC-0001): As a participant, I want NPCs to reply in character, so that the role-play feels real.
Priority: High
Estimate: L
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0006
Acceptance Criteria:
  - [ ] AC-0021: the persona prefix is cacheable and contains goals, knowledge, guardrails and the scene goal
  - [ ] AC-0022: hidden facts and other roles' briefs never appear in NPC prompts
  - [ ] AC-0023: on timeout or empty reply the fallback line is spoken and the facilitator is alerted
  - [ ] AC-0024: NPCs stay silent while paused or outside their scene
```

```
TASK-0007 (US-0007): Implement buildNpcRequest and NpcAgent with timeout and fallback
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0008 (EPIC-0001): As a facilitator, I want the Game Master to detect scripted exit conditions, so that scenes move on when the team achieves the goal.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0007
Acceptance Criteria:
  - [ ] AC-0025: the GM evaluates gm_detects conditions every N utterances, not per turn
  - [ ] AC-0026: a true verdict exits the scene in the same tick and is logged with reasoning
  - [ ] AC-0027: unparseable or false verdicts leave the scene running
```

```
TASK-0008 (US-0008): Implement gm-prompt.ts and GameMaster
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0009 (EPIC-0001): As a participant, I want to join a session over WebSocket with my role, so that I can play from any machine on the LAN.
Priority: High
Estimate: L
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0008
Acceptance Criteria:
  - [ ] AC-0028: a second participant claiming a taken role is refused with role_taken
  - [ ] AC-0029: players receive only events for scenes and injects addressed to them; the facilitator receives everything
  - [ ] AC-0030: the facilitator can start the session and send commands; players cannot
```

```
TASK-0009 (US-0009): Implement SessionHost, protocol, ws-server and main.ts
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0010 (EPIC-0001): As a participant or facilitator, I want a terminal client, so that the slice is playable without a web UI.
Priority: High
Estimate: S
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0009
Acceptance Criteria:
  - [ ] AC-0031: pnpm play joins as a role or as facilitator and renders events
  - [ ] AC-0032: facilitator slash-commands map to protocol messages
```

```
TASK-0010 (US-0010): Implement play.ts and render.ts
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0011 (EPIC-0001): As a scenario author, I want the Friday Escalation scenario to run end to end in a simulation test, so that the slice is proven against a real script.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0010
Acceptance Criteria:
  - [ ] AC-0033: the scenario validates with no errors or warnings
  - [ ] AC-0034: a scripted play-through passes all three scenes and ends
  - [ ] AC-0035: NPC prompts never contain hidden facts or player private facts
```

```
TASK-0011 (US-0011): Write the scenario YAML and the simulation test
Type: Test
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0012 (EPIC-0001): As a facilitator, I want to start the whole MVP with one command, so that a session can run from a laptop.
Priority: High
Estimate: S
Status: Planned
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0011
Acceptance Criteria:
  - [ ] AC-0036: ./run.sh --dev starts the runtime and three terminals can play
  - [ ] AC-0037: the Docker image builds and runs the runtime
  - [ ] AC-0038: CI runs typecheck, tests and the SDK-import check
```

```
TASK-0012 (US-0012): Add compose, Dockerfile, run.sh, CI and README
Type: Infra
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0014 (EPIC-0001): As an operator, I want to configure OpenRouter or a local OpenAI-compatible endpoint, or a custom Anthropic endpoint, so that the NPCs and Game Master are not tied to one hosted provider.
Priority: Medium
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0005
Acceptance Criteria:
  - [x] AC-0040: MODEL_PROVIDER selects mock, anthropic, openrouter or local, and an unknown value lists the valid ones
  - [x] AC-0041: openrouter and local stream through an OpenAI-compatible client (SSE, JSON fallback, abort) that passes the shared provider contract
  - [x] AC-0042: ANTHROPIC_BASE_URL, OPENROUTER_BASE_URL and LOCAL_BASE_URL are validated (no userinfo, https unless loopback or local) and errors name the variable
  - [x] AC-0043: local requires NPC_MODEL and GM_MODEL; the defaults are claude-sonnet-5-5 (anthropic) and anthropic/claude-sonnet-5.5 (openrouter)
  - [x] AC-0044: API keys never appear in logs, URLs or error messages, and startup logs only a fixed provider label and the endpoint host
```

```
TASK-0014 (US-0014): Add OpenRouter and local OpenAI-compatible providers and a custom Anthropic endpoint
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: packages/adapters/src/model/openai-compatible.ts, endpoint.ts, select.ts; log fix in services/runtime/src/main.ts.
```

```
US-0015 (EPIC-0001): As an operator, I want to configure the NPC first-token and reply timeouts, so that slower or reasoning models do not constantly trigger the fallback line.
Priority: Medium
Estimate: S
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0007
Acceptance Criteria:
  - [x] AC-0045: The NPC first-token timeout defaults to 10 000 ms and the reply deadline to 20 000 ms, from one shared set of constants used by NpcAgent, SessionHost and bootstrap
  - [x] AC-0046: NPC_FIRST_TOKEN_TIMEOUT_MS and NPC_REPLY_TIMEOUT_MS override them at startup (real environment wins over .env) and reach every NPC agent
  - [x] AC-0047: Values must be whole base-10 milliseconds from 500 to 600000 with the reply deadline at least the first-token timeout; an invalid value stops startup with an error naming the variable and the allowed range
  - [x] AC-0048: README, .env.example, CHANGELOG and ARCHITECTURE document the 10 s default and the two variables
```

```
TASK-0015 (US-0015): Make the NPC timeouts configurable with a 10 s first-token default
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: services/runtime/src/agents/timeouts.ts (constants and validation), npc-agent.ts, host/session-host.ts, main.ts. Ruling R36.
```

```
US-0013 (EPIC-0002): As a participant, I want to reconnect and receive the events I missed, so that a dropped connection does not lose the session.
Priority: Medium
Estimate: M
Status: Planned
Branch: feature/EPIC-0002-US-0013-reconnect
Dependencies: US-0012
Acceptance Criteria:
  - [ ] AC-0039: a client sending a last-seen seq receives the events after it
```

```
TASK-0013 (US-0013): Add replay-from-seq to the protocol (slice 2)
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0002-US-0013-reconnect
Notes: See the implementation plan task of the same number. Deferred to slice 2.
```

```
US-0016 (EPIC-0006): As a facilitator, I want to release an NPC's hidden fact during a session, so that hidden information can surface when a participant earns it.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Dependencies: US-0011
Acceptance Criteria:
  - [ ] AC-0049: a facilitator `release_hidden` command (role and fact index) is recorded as an event and the NPC's next prompt contains that fact
  - [ ] AC-0050: players never receive the event or the fact text, and unreleased facts stay out of every prompt
  - [ ] AC-0051: the terminal client offers `/release <role> <n>` and shows the facilitator which hidden facts a role has
  - [ ] AC-0052: the README and CHANGELOG limitation about unreleased hidden facts is removed
```

```
TASK-0016 (US-0016): Add the release_hidden facilitator command, engine and reducer support, and the client command
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Notes: Plan gap found in the Slice 1 final review: `SessionEngine.updateNpc(..., {released})` is only called by tests, so `hidden` facts can never surface at runtime. Architecture section 4 expects a release path.
```

```
US-0017 (EPIC-0006): As an operator, I want facilitator access protected by a token and connections and message rates limited, so that the server can be run outside a fully trusted network.
Priority: High
Estimate: M
Status: Planned
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Dependencies: US-0009
Acceptance Criteria:
  - [ ] AC-0053: when `FACILITATOR_TOKEN` is set, `join_facilitator` without the matching token is refused (constant-time comparison) and the token is never logged or echoed
  - [ ] AC-0054: a configurable cap on concurrent connections and a per-connection message rate limit close or throttle abusers without affecting other clients
  - [ ] AC-0055: the threat model is documented, and the README limitation states exactly what the token does and does not protect (claiming an unclaimed player role is covered separately)
```

```
TASK-0017 (US-0017): Add facilitator token check, connection cap and per-connection rate limiting to the WebSocket server
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Notes: Known limitation of Slice 1: anyone who can reach the port can join as facilitator or claim an unclaimed player role. The server binds all interfaces.
```

```
US-0018 (EPIC-0006): As a facilitator, I want a session to resume from its event log after a server restart, so that a crash does not lose a session in progress.
Priority: Medium
Estimate: L
Status: Planned
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Dependencies: US-0006, US-0013
Acceptance Criteria:
  - [ ] AC-0056: starting the server with an existing session log replays it into the engine state instead of rotating it aside
  - [ ] AC-0057: clients that rejoin receive their visible history (builds on the replay-from-seq protocol in US-0013)
  - [ ] AC-0058: starting a fresh session over an old log stays possible through an explicit option, with the old log rotated aside
```

```
TASK-0018 (US-0018): Rebuild engine and host state from the JSONL log on startup and add an explicit fresh-session option
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Notes: Slice 1 rotates a stale log aside (US-0009 rotation) and never resumes. NPC agent, Game Master and ticker state must be reconstructed from events only.
```

```
US-0019 (EPIC-0006): As an operator, I want model calls to cost less per session, so that sessions stay affordable as they get longer.
Priority: Low
Estimate: S
Status: Planned
Branch: feature/EPIC-0006-US-0019-model-cost
Dependencies: US-0008
Acceptance Criteria:
  - [ ] AC-0059: the Game Master prompt uses a bounded transcript window instead of the whole scene transcript
  - [ ] AC-0060: the Game Master stops evaluating the remaining conditions of a scene after a condition is judged true
  - [ ] AC-0061: the NPC persona prompt puts stable content before changing goals and knowledge so the cached prefix survives NPC updates
```

```
TASK-0019 (US-0019): Bound the Game Master transcript, short-circuit after a true verdict, reorder the NPC prompt prefix
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0019-model-cost
Notes: Deferred minor findings from Tasks 7 and 8 and the final review. Behavior must stay covered by the existing leak and guardrail tests.
```

```
US-0020 (EPIC-0006): As a developer, I want one shared definition of identifier rules and accurate plan text, so that scenario ids, protocol ids, session ids and the docs cannot drift apart.
Priority: Low
Estimate: S
Status: Planned
Branch: feature/EPIC-0006-US-0020-shared-id-rules
Dependencies: US-0012
Acceptance Criteria:
  - [ ] AC-0062: scenario, protocol, terminal client and session-id validation use one exported set of identifier rules
  - [ ] AC-0063: the Slice 1 plan's self-review text is corrected (`SessionEngine.alert()` replaced the planned public `emit`) and records where later rulings changed the plan
```

```
TASK-0020 (US-0020): Extract shared identifier rules and correct the Slice 1 plan text
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0020-shared-id-rules
Notes: Three id rules currently live in schema.ts, protocol.ts, commands.ts and event-log.ts. Mismatches are harmless today but easy to drift.
```

```
US-0021 (EPIC-0006): As a developer or evaluator, I want an unattended demo and test runner that plays the whole scenario and checks every feature, so that I can verify or show the system without anyone at the keyboard.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0006-followups-and-demo-runner
Dependencies: US-0012
Acceptance Criteria:
  - [x] AC-0064: `pnpm demo` starts an in-process server and scripted bot participants (a facilitator and three players) over real WebSocket connections and plays Friday Escalation to the end without any input
  - [x] AC-0065: the run prints a narrated, paced transcript (adjustable speed, instant with `--fast`) and ends with a pass/fail checklist of the features it verified and a non-zero exit code on any failure
  - [x] AC-0066: it uses the mock provider by default and a `--live` mode with the configured provider, where checks are limited to what a real model cannot make flaky
  - [x] AC-0067: it can target an already running server (`--url`), for example the Docker container, as a smoke test
  - [x] AC-0068: it can write a machine-readable report (`--json`) for CI
```

```
TASK-0021 (US-0021): Build the demo runner: bot participants, narration, feature checklist, report and CLI
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-followups-and-demo-runner
Notes: Requested by the user as an automated runner that can test the features unattended in a demo-like mode. Code in services/runtime/src/demo/ (args, narrator, bots, checks, harness, story, lab, audit, report, runner, run); CI job Demo Run.
```

```
US-0022 (EPIC-0006): As an operator, I want transient model errors retried within the first-token budget, so that a brief capacity blip or an overloaded free-tier model does not turn into a canned fallback line.
Priority: Medium
Estimate: M
Status: Planned
Branch: feature/EPIC-0006-US-0022-retry-transient-model-errors
Dependencies: US-0014, US-0015
Acceptance Criteria:
  - [ ] AC-0069: a transient upstream failure (an in-band overloaded or rate-limit error, HTTP 429 or 5xx, or a connection reset before any token) is retried a bounded number of times with backoff, inside the configured first-token and reply deadlines
  - [ ] AC-0070: non-transient errors (401, 403, 404 unknown model, 400 bad request) are not retried and surface immediately as the fallback line plus a facilitator alert
  - [ ] AC-0071: a retry never produces a duplicate or partial utterance, never outlives the deadlines, and the facilitator alert and log state how many attempts were made and why the last one failed (sanitized, no keys or URLs)
  - [ ] AC-0072: the model adapters classify failures as transient or permanent through a typed error, and the shared adapter contract tests cover the classification for the mock, Anthropic and OpenAI-compatible providers
```

```
TASK-0022 (US-0022): Add a typed transient/permanent error classification to the adapters and a bounded retry in the NPC agent and Game Master
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0022-retry-transient-model-errors
Notes: Found in a live demo run: about 4 of 10 calls to a free OpenRouter model failed within 0.4 s with 'Upstream error from Nvidia: Service temporarily overloaded' and each became the canned fallback line.
```

```
US-0023 (EPIC-0006): As a developer or evaluator, I want the demo runner's live mode to report fallback lines and alert reasons, so that a run cannot pass while the characters only spoke canned lines.
Priority: Medium
Estimate: S
Status: Planned
Branch: feature/EPIC-0006-US-0023-demo-live-evidence
Dependencies: US-0021
Acceptance Criteria:
  - [ ] AC-0073: in live mode the runner counts NPC replies that were the persona's fallback line and shows the count in the narration, in the checklist evidence and in the JSON report
  - [ ] AC-0074: facilitator alert messages raised during the run are captured (sanitized) with their reason and shown next to the affected reply
  - [ ] AC-0075 (the showcase-only part, `--max-fallbacks` for `pnpm demo --showcase`, is delivered by US-0024; the 29-check run still needs it): an option such as `--max-fallbacks <n>` fails the run when more than n replies were fallback lines; without it the count is reported as a warning
```

```
TASK-0023 (US-0023): Count fallback replies and capture alert reasons in the demo runner, with an optional failure threshold
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0006-US-0023-demo-live-evidence
Notes: In three live runs 2 of 6 main-story replies were canned fallback lines, yet check F-08 passed because a fallback line is non-empty.
```

```
US-0024 (EPIC-0006): As an evaluator, I want a longer demo scenario and a showcase mode, so that a live demo shows the AI characters and the Game Master doing substantial real work.
Priority: High
Estimate: L
Status: In Progress
Branch: feature/EPIC-0006-US-0024-showcase-demo
Dependencies: US-0021
Acceptance Criteria:
  - [x] AC-0076: `scenarios/friday-escalation-extended` (6 scenes, 3 players, 2 AI characters including a new CFO, time boxes, gm_detects exit conditions, timed and private injects) loads and validates with zero errors and zero warnings, and a validated `showcase.yaml` script drives the bot players
  - [x] AC-0077: `pnpm demo --showcase --fast` runs offline in mock mode and passes its own checks (S-01 to S-12), and CI runs it as a step of the Demo Run job
  - [ ] AC-0078: `pnpm demo --showcase --live` uses the configured provider for the AI characters and for the Game Master, scene exits are decided by the real Game Master, and the facilitator advance is only a recorded safety net (verified so far only against an in-process fake OpenAI-compatible server; to be ticked after a recorded real live run)
  - [x] AC-0079: the run ends with an AI contribution report (replies per character split into real model output and canned fallback lines, latency, Game Master evaluations and exits, advances, alerts, wall time), also in the JSON report, with `--max-fallbacks` and `--watchdog` limits
  - [x] AC-0080: the flags, the run-time guidance, the privacy and cost notice and a real output excerpt are documented in the README and CHANGELOG
  - [x] AC-0081: `--transcript <path.md>` writes a Markdown transcript in every demo mode with bold dialogue lines tagged [SCRIPTED], [GENERATED] or [FALLBACK], plain [SYSTEM] logging, and Markdown-safe escaping that lets no model or server text forge a tag, heading, table or link
```

```
TASK-0024 (US-0024): Build the extended scenario, the showcase script and loader, the showcase story, report and transcript
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0024-showcase-demo
Notes: Requested by the user (R40, R41) after a live demo showed only one real model line. Code in services/runtime/src/demo/ (showcase, showcase-script, showcase-report, provenance, transcript, transcript-md). Overlaps AC-0075 of US-0023, which asked for --max-fallbacks; US-0023 still owns the live fallback evidence for the 29-check run.
```
