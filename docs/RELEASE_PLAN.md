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
