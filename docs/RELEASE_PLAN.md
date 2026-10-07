# Release Plan — AI Coaching RPG

Source of truth for scope and sequencing. Design: `docs/ARCHITECTURE.md`; implementation plan for EPIC-0001: `docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md`.

## Epics

```
EPIC-0001: Slice 1 — script package and text-only runtime
Description: A scenario written in YAML is loaded, validated and played in text by three people over a LAN against AI NPCs with a Game Master, from one laptop with one command. Proves the core loop before voice, 3D and scoring.
Release Target: MVP
Status: Complete
Dependencies: None
```

```
EPIC-0002: Slice 2 — web lobby, session view and reconnect
Description: Browser lobby with consent and role assignment, text session view, minimal facilitator console, replay-from-seq reconnect.
Release Target: MVP
Status: In Progress
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
Description: Post-session rubric scoring with quoted evidence and confidence, facilitator moderation, participant and group reports with ASM-09 visibility. Built so far (US-0028 to US-0031): BARS rubrics as YAML, the evaluator engine with verified quotes, draft participant and group reports, `pnpm evaluate` and the showcase `--evaluate` check S-16. Not built yet: facilitator moderation and edit workflow (ASM-04), participant self-assessment and response (ASM-07), and per-participant visibility and access control (ASM-09; reports are visible to all participants for now). Calibration (ASM-08) has started: the probe format, loader, log adapter and Friday starter probes are built (US-0035); `pnpm calibrate`, metrics, probe drafting and the calibration stamp on reports are planned (US-0036..US-0039).
Release Target: MVP
Status: In Progress
Dependencies: EPIC-0003
Notes: Pulled forward on 2026-10-06 (Planned -> In Progress) as a first version of the post-session evaluator: BARS rubrics (US-0028), the evaluator engine (US-0029), draft reports (US-0030) and the CLI and demo integration (US-0031). Product decisions: participants may see each other's scores and reports for now (a 'Visibility: all participants' line is printed; per-participant isolation and ASM-09 are planned); scoring uses a Behaviourally Anchored Rating Scale with four levels and 'Not observed'. Planned follow-ups: the facilitator moderation and edit workflow with history (ASM-04), participant self-assessment and response (ASM-07), and isolation and access control (ASM-09), not yet filed as stories. The calibration slice (ASM-08) is filed as US-0035..US-0039.
```

```
EPIC-0006: Slice 1 follow-ups — hidden facts, access control, resilience and demo tooling
Description: Work deliberately deferred while delivering Slice 1: releasing NPC hidden facts, protecting facilitator access and limiting abuse, resuming a session after a restart, lowering model cost, keeping identifier rules in one place, and an unattended demo and test runner.
Release Target: MVP
Status: In Progress
Dependencies: EPIC-0001
```

## User stories and tasks

```
US-0001 (EPIC-0001): As a developer, I want a pnpm monorepo with TypeScript and Vitest, so that every package builds and tests with one command.
Priority: High
Estimate: S
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: None
Acceptance Criteria:
  - [x] AC-0001: `pnpm install && pnpm test && pnpm typecheck` succeed from a clean clone
  - [x] AC-0002: packages import each other as @acr/<name> workspace links
```

```
TASK-0001 (US-0001): Scaffold workspace, base tsconfig, Vitest workspace, .env.example
Type: Infra
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0002 (EPIC-0001): As the runtime, I want typed session events and a pure reducer, so that session state is always a projection of the event log.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0001
Acceptance Criteria:
  - [x] AC-0003: reduce() rejects out-of-order seq
  - [x] AC-0004: visibleTranscript() returns only scenes the role participated in
  - [x] AC-0005: pause, resume, scene entry/exit, injects and NPC updates are reflected in state
```

```
TASK-0002 (US-0002): Implement events.ts and state.ts with reducer tests
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0003 (EPIC-0001): As a scenario author, I want my YAML scenario folder loaded and validated, so that mistakes are reported before a session starts.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0002
Acceptance Criteria:
  - [x] AC-0006: loadScenario reads scenario.yaml, roles/*.yaml and script.yaml
  - [x] AC-0007: a missing roles/ directory fails with one message naming the folder
  - [x] AC-0008: validator errors on unknown participants and duplicate inject ids
  - [x] AC-0009: validator warns on injects past the time box and objectives with no criteria
  - [x] AC-0010: a JSON Schema is exported for editors
```

```
TASK-0003 (US-0003): Implement Zod schema, loader, validator and fixtures
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0004 (EPIC-0001): As the runtime, I want a scene state machine, so that scenes exit on time box, facilitator advance or a Game Master verdict.
Priority: High
Estimate: S
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0003
Acceptance Criteria:
  - [x] AC-0011: evaluateExit honours only the conditions a scene lists
  - [x] AC-0012: dueInjects returns timed injects once
```

```
TASK-0004 (US-0004): Implement fsm.ts with exit evaluation, next scene and due injects
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0005 (EPIC-0001): As the runtime, I want a ModelProvider adapter with a mock and an Anthropic implementation, so that NPCs run in tests without a key and with a real model in play.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0004
Acceptance Criteria:
  - [x] AC-0013: the contract suite passes for the mock and (with a key) for Anthropic
  - [x] AC-0014: MockModelProvider replays scripted replies and records calls
  - [x] AC-0015: no file outside packages/adapters imports a provider SDK (lint)
```

```
TASK-0005 (US-0005): Implement model adapter types, mock, Anthropic, selector and SDK-import lint
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0006 (EPIC-0001): As a facilitator, I want a session engine that runs the script, so that scenes advance, injects fire and every turn is logged.
Priority: High
Estimate: L
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0005
Acceptance Criteria:
  - [x] AC-0016: start() enters the first scene and fires its opening inject
  - [x] AC-0017: say() is refused while paused or when the role is not in the scene
  - [x] AC-0018: timed injects fire once on tick
  - [x] AC-0019: scenes exit on time box, advance or GM verdict and the session ends after the last scene
  - [x] AC-0020: events persist to a JSONL log with monotonic seq
```

```
TASK-0006 (US-0006): Implement SessionEngine, EventLog (memory, JSONL) and Clock
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0007 (EPIC-0001): As a participant, I want NPCs to reply in character, so that the role-play feels real.
Priority: High
Estimate: L
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0006
Acceptance Criteria:
  - [x] AC-0021: the persona prefix is cacheable and contains goals, knowledge, guardrails and the scene goal
  - [x] AC-0022: hidden facts and other roles' briefs never appear in NPC prompts
  - [x] AC-0023: on timeout or empty reply the fallback line is spoken and the facilitator is alerted
  - [x] AC-0024: NPCs stay silent while paused or outside their scene
```

```
TASK-0007 (US-0007): Implement buildNpcRequest and NpcAgent with timeout and fallback
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0008 (EPIC-0001): As a facilitator, I want the Game Master to detect scripted exit conditions, so that scenes move on when the team achieves the goal.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0007
Acceptance Criteria:
  - [x] AC-0025: the GM evaluates gm_detects conditions every N utterances, not per turn
  - [x] AC-0026: a true verdict exits the scene in the same tick and is logged with reasoning
  - [x] AC-0027: unparseable or false verdicts leave the scene running
```

```
TASK-0008 (US-0008): Implement gm-prompt.ts and GameMaster
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0009 (EPIC-0001): As a participant, I want to join a session over WebSocket with my role, so that I can play from any machine on the LAN.
Priority: High
Estimate: L
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0008
Acceptance Criteria:
  - [x] AC-0028: a second participant claiming a taken role is refused with role_taken
  - [x] AC-0029: players receive only events for scenes and injects addressed to them; the facilitator receives everything
  - [x] AC-0030: the facilitator can start the session and send commands; players cannot
```

```
TASK-0009 (US-0009): Implement SessionHost, protocol, ws-server and main.ts
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0010 (EPIC-0001): As a participant or facilitator, I want a terminal client, so that the slice is playable without a web UI.
Priority: High
Estimate: S
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0009
Acceptance Criteria:
  - [x] AC-0031: pnpm play joins as a role or as facilitator and renders events
  - [x] AC-0032: facilitator slash-commands map to protocol messages
```

```
TASK-0010 (US-0010): Implement play.ts and render.ts
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0011 (EPIC-0001): As a scenario author, I want the Friday Escalation scenario to run end to end in a simulation test, so that the slice is proven against a real script.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0010
Acceptance Criteria:
  - [x] AC-0033: the scenario validates with no errors or warnings
  - [x] AC-0034: a scripted play-through passes all three scenes and ends
  - [x] AC-0035: NPC prompts never contain hidden facts or player private facts
```

```
TASK-0011 (US-0011): Write the scenario YAML and the simulation test
Type: Test
Assignee: Agent
Status: Done
Branch: feature/EPIC-0001-US-0001-monorepo
Notes: See the implementation plan task of the same number.
```

```
US-0012 (EPIC-0001): As a facilitator, I want to start the whole MVP with one command, so that a session can run from a laptop.
Priority: High
Estimate: S
Status: Complete
Branch: feature/EPIC-0001-US-0001-monorepo
Dependencies: US-0011
Acceptance Criteria:
  - [x] AC-0036: ./run.sh --dev starts the runtime and three terminals can play
  - [x] AC-0037: the Docker image builds and runs the runtime
  - [x] AC-0038: CI runs typecheck, tests and the SDK-import check
```

```
TASK-0012 (US-0012): Add compose, Dockerfile, run.sh, CI and README
Type: Infra
Assignee: Agent
Status: Done
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
Status: In Progress
Branch: feature/EPIC-0002-US-0013-reconnect
Dependencies: US-0012, US-0017 (limits), US-0018 (resume rebuilds the replay window from the log), US-0033 (one generic refusal)
Acceptance Criteria:
  - [x] AC-0039: a client sending a last-seen seq receives the events after it (optional `lastSeq` on `join` and `join_facilitator`; `joined.replay` then the event frames; ws-server.replay.test.ts, demo F-22)
  - [x] AC-0170: the replay goes through the same default-deny `viewFor` as live delivery: for every role and every seq it is exactly what that role received live after it, so a whisper to another role, NPC goals and released hidden facts, Game Master verdicts and reasoning, `gm.no_verdict`, facilitator alerts, participant names and join codes are never replayed to a player (session-host-replay.test.ts, every role x every seq; demo F-22, F-37)
  - [x] AC-0171: no event is lost or duplicated between the replay and the live stream: the replay is read from the engine's in-memory window and the subscription is made in the same synchronous step as the snapshot, while every event is applied, retained and delivered in one synchronous step of the engine's emit; `toSeq` equals the snapshot's `lastSeq` and every later frame has a higher seq (ws-server.replay.test.ts: an append started inside the replay, and appends interleaved with the join; demo F-25)
  - [x] AC-0172: replay volume is bounded: the engine keeps the last 4096 events (`MAX_RETAINED_EVENTS`), one rejoin returns at most 1000 events and 256 KiB of JSON (`MAX_REPLAY_EVENTS`, `MAX_REPLAY_BYTES`) and never more than fits in the 1 MiB send buffer beside the join snapshot (review fix I2), a rejoin never reads the log from disk; a range that is older or larger gets `complete: false` and no events (never a partial list with a gap) and the client relies on its join snapshot
  - [x] AC-0173: a `lastSeq` that is negative, a fraction, a string, null, infinite or above 2^53-1 is a `bad_message` before authentication (also with a wrong join code: a malformed message is rejected before the code is checked); one past the session's last event is a `bad_message` only after the join is authorised, and claims and takes over nothing; neither crashes the server or closes the connection
  - [x] AC-0174: a refused or unauthenticated join with `lastSeq` gets nothing but the refusal: the single generic `unauthorized` (US-0033: no or a wrong code, an AI or unknown role, an unknown session, a wrong facilitator token) or `role_taken`; the head of the log is not revealed before authorisation (demo F-02)
  - [x] AC-0175: after a restart (US-0018) the window is rebuilt from the log, so a client's `lastSeq` from before the crash replays the same seqs plus what the restart added (`session.resumed` for players; with the facilitator-only alert for the facilitator); an event on disk that no client saw before a fail-stop is replayed; the facilitator rejoins the same way (demo F-34, F-37)
  - [x] AC-0176: backward compatible: a join without `lastSeq` behaves exactly as before (snapshot then live events, no `replay` field); the protocol is documented for future clients in `MIGRATION_LOG.md` and the README
  - [x] AC-0177: the terminal client takes `--last-seq <n>`, prints on a dropped connection the value to rejoin with (after a complete replay: its `afterSeq`, advanced by each frame that arrives, so a drop mid-replay loses nothing; review fix I1), names a hidden fact released in the replayed range (M1), shows the history up to `lastSeq` then the replayed events, and drops a duplicate event frame (cli tests)
  - [x] AC-0178: demo checks F-02, F-20, F-22, F-25, F-34 and F-37 are extended (no new check): `pnpm demo --fast` keeps 29, `--security --resume` 42 and `--showcase --fast` 14, offline and deterministic
  - [x] AC-0179: README, CHANGELOG, `docs/THREAT_MODEL.md` (what replay may and may not reveal, the bounds) and `docs/TEST_CASES.md` (TC-0013 to TC-0016) are updated
```

```
TASK-0013 (US-0013): Add replay-from-seq to the protocol (slice 2)
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0002-US-0013-reconnect
Notes: See the implementation plan task of the same number. Delivered by TASK-0052 to TASK-0054. Story stays In Progress until the independent review and the controller's checks.
```

```
TASK-0052 (US-0013): Retained event window in the engine, SessionHost.replayFor and the lastSeq join in the WebSocket server
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0002-US-0013-reconnect
Notes: engine/recent-events.ts (ring of 4096, contiguous seqs), SessionEngine.eventsAfter (filled in emit after the reducer and before the subscribers; rebuilt by restore and adopted only for a running session), SessionHost.replayFor (the same viewFor, utterance scene by binary search, caps), protocol `lastSeq` and `joined.replay`, ws-server (beyond-head check after authorisation, replay and subscribe in one synchronous step). Tests: recent-events, session-engine-replay, session-host-replay, ws-server.replay.
```

```
TASK-0053 (US-0013): Terminal client --last-seq, rejoin hint and duplicate guard
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0002-US-0013-reconnect
Notes: cli/commands.ts (`--last-seq`, joinMessage), cli/client.ts (last seen seq, dedupe after a replay, hint on disconnect), cli/render.ts (history up to lastSeq, catching-up line, validated replay summary). The client does not reconnect by itself: it exits and prints the `--last-seq` to rejoin with.
```

```
TASK-0054 (US-0013): Demo checks, threat model, README, CHANGELOG, migration log and test cases
Type: Test
Assignee: Agent
Status: Done
Branch: feature/EPIC-0002-US-0013-reconnect
Notes: F-02 (a refused claim with lastSeq gets one message), F-20 (malformed and beyond-head lastSeq), F-22 (replay equals what the old connection received live, inject and whisper included), F-25 (live after the replay, once, in order), F-34 (facilitator replay after the restart), F-37 (players after the restart; tech_lead from seq 0 gets only scene 1). Counts unchanged.
```

```
US-0016 (EPIC-0006): As a facilitator, I want to release an NPC's hidden fact during a session, so that hidden information can surface when a participant earns it.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Dependencies: US-0011
Acceptance Criteria:
  - [x] AC-0049: a facilitator `release_hidden` command (role and fact index) is recorded as an event and the NPC's next prompt contains that fact
  - [x] AC-0050: players never receive the event or the fact text, and unreleased facts stay out of every prompt
  - [x] AC-0051: the terminal client offers `/release <role> <n>` and shows the facilitator which hidden facts a role has
  - [x] AC-0052: the README and CHANGELOG limitation about unreleased hidden facts is removed
  - [x] AC-0150: `release_hidden {roleId, fact}` takes a 1-based fact number (1 to 50, the same numbering in the protocol, the engine and the terminal client); the engine refuses an unknown role (`unknown_role`, also for prototype keys such as `__proto__`), a player role (`npc_role`), a number the character has no fact for (`unknown_fact`) and a fact that is already released (`already_released`), appending nothing; a valid release records a `facilitator.command` that carries no fact text, then a facilitator-only `npc.updated` with the text; it works while paused and there is no unrelease
  - [x] AC-0151: the fact text reaches only facilitator connections: `viewFor` and `filterFor` deny both events and `snapshotFor` drops NPC state for a player, the facilitator's `joined` message carries `hiddenFacts` only after a facilitator join (behind `FACILITATOR_TOKEN` when it is set; a refused join gets nothing), and a reconnecting facilitator sees the released state
  - [x] AC-0152: a released fact appears in a separate last prompt section `## What you may now share` of that character only, with the line that the earlier hidden-information rules no longer apply to it, judged by time (a prompt built before the release never holds it), and never in another character's, a player's or the Game Master's prompt
  - [x] AC-0153: `/hidden` lists each character's facts numbered with their released status and `/release <role> <n>` validates and sends the command; fact text and ids are sanitised, the list is bounded, and a player client has neither command
  - [x] AC-0154: the scenario schema bounds a character's hidden facts (at most 50, non-empty, at most 1000 characters each, unique within the character), prototype keys are refused as role and scene ids, and role lookups from client ids use own properties
  - [x] AC-0155: the extended showcase script may hold scripted facilitator steps (`facilitator: [{after_line, release_hidden: {role, fact}}]`, validated against the scenario); scene s5 releases the CFO's fact 1 after line 1 and the narration, transcript and report say `facilitator released hidden fact number 1 of cfo` without the text (recorded live 2026-10-06 on local gemma-4-31b-it-qat-mxfp4, first version of the share-section wording: scene 5 ended by the Game Master (5 of 6 scenes, only s2 by facilitator advance; 12 of 12 verdicts strict), the CFO used the released fact in her own words ('I will approve this change request now that it is a fixed-fee tied to a firm date'), the narration and transcript showed only 'facilitator released hidden fact number 1 of cfo'; single run; a rerun on the final prompt wording is recorded below if it differs)
  - [x] AC-0156: checks S-06, S-07 and S-15 audit it: an unreleased fact in no AI character or generated player prompt, a released fact only in its own character's share section (with a positive control), no release command in a player inbox; the S-07 hidden-fact observation no longer counts released facts or strings a player said earlier in the same scene
  - [x] AC-0157: the demo checks stay at 29 (default), 14 (showcase), 15 (`--evaluate`) and 32 (`--security`); no live model call is made by the tests
  - [x] AC-0158: the narration, the Markdown transcript, the `--json` report and the evaluation reports never contain a released fact's text, except inside that character's own later utterances (dialogue) and the facilitator's own client; the release is shown by role and number
  - [x] AC-0159: the README and CHANGELOG describe the command, the terminal client commands, the prompt section, the showcase step and what a live run must confirm
```

```
TASK-0016 (US-0016): Add the release_hidden facilitator command, engine and reducer support, and the client command
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Notes: Plan gap found in the Slice 1 final review: `SessionEngine.updateNpc(..., {released})` is only called by tests, so `hidden` facts can never surface at runtime. Architecture section 4 expects a release path.
```

```
TASK-0046 (US-0016): Protocol, engine, host and prompt support for release_hidden, scenario limits
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Notes: packages/events (command type), packages/script (hidden-fact limits), host/protocol.ts, engine/session-engine.ts, host/session-host.ts (`hiddenFacts`, viewFor), host/ws-server.ts (`joined.hiddenFacts`), agents/npc-prompt.ts (`## What you may now share`). Tests in each package, host/__tests__/ws-server.release.test.ts.
```

```
TASK-0047 (US-0016): Terminal client /hidden and /release
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Notes: cli/commands.ts, cli/render.ts, cli/client.ts with tests.
```

```
TASK-0048 (US-0016): Showcase facilitator step, S-06/S-07/S-15 audits, README and CHANGELOG
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0016-release-hidden-facts
Notes: demo/showcase-script.ts (`facilitator` steps), demo/showcase.ts, demo/release-note.ts, scenarios/friday-escalation-extended/showcase.yaml (s5 release, CFO mock reply 2), tests/gm-cases/showcase.json rebuilt, demo/__tests__/showcase-release.test.ts. The controller confirms live that scene 5 now ends by the Game Master.
```

```
US-0017 (EPIC-0006): As an operator, I want facilitator access protected by a token and connections and message rates limited, so that the server can be run outside a fully trusted network.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Dependencies: US-0009
Acceptance Criteria:
  - [x] AC-0053: when `FACILITATOR_TOKEN` is set, `join_facilitator` without the matching token is refused (constant-time comparison) and the token is never logged or echoed
  - [x] AC-0054: a configurable cap on concurrent connections and a per-connection message rate limit close or throttle abusers without affecting other clients
  - [x] AC-0055: the threat model is documented, and the README limitation states exactly what the token does and does not protect (claiming an unclaimed player role is covered separately)
  - [x] AC-0140: with `FACILITATOR_TOKEN` unset the server stays open and prints one loud startup warning that contains no secret; `run.sh` writes a random token only into a new `.env` and never overwrites an existing `.env` or token (failing closed is a later release; per-role join codes are US-0033)
  - [x] AC-0141: a missing, empty, wrong or over-long token is refused with a generic `unauthorized` and the connection is closed after one failed attempt; more than 5 failures per address per minute block that address; the token never appears in a log, alert, event or any client's inbox
  - [x] AC-0142: connection caps (total and per address) and the Origin check (`ALLOWED_ORIGINS`) refuse a handshake before a WebSocket exists; a connection that does not join within `WS_JOIN_TIMEOUT_MS` is closed
  - [x] AC-0143: each connection has its own token bucket (`WS_MSG_RATE`, `WS_MSG_BURST`) and a queue cap; repeated drops or a full queue close that connection with 1008 and never affect another client; frames are capped at 16 KiB
  - [x] AC-0144: `FACILITATOR_TOKEN`, `RUNTIME_HOST`, `ALLOWED_ORIGINS`, `TRUST_PROXY` and the `WS_*` variables are validated at startup like the other settings, with errors that name the variable and its range and never show the token; ranges are documented in the README and `.env.example`
  - [x] AC-0145: the terminal client takes the token from `FACILITATOR_TOKEN`, `--token-file` or a hidden prompt and never from argv (`--token` is refused); the token is never printed
  - [x] AC-0146: `docs/THREAT_MODEL.md` states what the token protects and does not (no TLS with a reverse-proxy recommendation, unclaimed player roles, a role freed on disconnect, logs at rest, the model provider, denial of service beyond the caps)
  - [x] AC-0147: `pnpm demo --security` adds offline, deterministic checks F-31 to F-33 (token, flood isolation, caps, Origin, join timeout) while the default run keeps its 29 checks, and `pnpm demo --url` passes `FACILITATOR_TOKEN` to a protected server
```

```
TASK-0017 (US-0017): Add facilitator token check, connection cap and per-connection rate limiting to the WebSocket server
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Notes: Known limitation of Slice 1: anyone who can reach the port can join as facilitator or claim an unclaimed player role. The server binds all interfaces.
```

```
TASK-0043 (US-0017): Token check, throttle, caps, Origin check, rate limit, queue cap, join timeout and env validation in the runtime
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Notes: services/runtime/src/host/security.ts (helpers and env parsing), ws-server.ts, main.ts. Unit and abuse-case tests in host/__tests__.
```

```
TASK-0044 (US-0017): Terminal client token delivery, run.sh token generation, .env.example and compose notes
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Notes: cli/token.ts, cli/play.ts, run.sh with scripts/run-sh-token.test.sh.
```

```
TASK-0045 (US-0017): Demo security room (F-31 to F-33), --url token, THREAT_MODEL.md, README and CHANGELOG
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0017-facilitator-token-and-limits
Notes: demo/security.ts behind `pnpm demo --security`; the default 29-check run is unchanged.
```

```
US-0018 (EPIC-0006): As a facilitator, I want a session to resume from its event log after a server restart, so that a crash does not lose a session in progress.
Priority: Medium
Estimate: L
Status: Complete
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Dependencies: US-0006, BUG-0005 (pause freezes the scene clock). US-0013 is no longer a blocker: AC-0057 is met by the per-viewer join snapshot.
Acceptance Criteria:
  - [x] AC-0056: starting the server with an existing session log replays it into the engine state instead of rotating it aside
  - [x] AC-0057: clients that rejoin receive their visible history (delivered through the per-viewer `joined` snapshot: the transcript of the scenes the role took part in; replay-from-seq of injects and whispers stays with US-0013)
  - [x] AC-0058: starting a fresh session over an old log stays possible through an explicit option, with the old log rotated aside
  - [x] AC-0160: a resumed session comes back paused, with a `session.resumed` event (players see it) and a facilitator alert giving the downtime; `/resume` continues it; the downtime counts as paused time, so no overdue inject fires and no time box ends on resume
  - [x] AC-0161: the log records `logFormat` 1 and the scenario's SHA-256 in `session.started`; resume is refused, with the log untouched and a message naming `SESSION_START=fresh`, for corruption beyond a cut-off last line (seq gap, duplicate or reordering, another session's event, unknown event type, malformed middle line), a newer log format, or other scenario files; a format-0 log resumes on a matching scenario id and version
  - [x] AC-0162: a cut-off last line is cut before the first append, with its size in the restart alert; nothing else in a log is ever rewritten; an operation of several events cut short by a crash (scene exit then the next scene, inject then its effect, start, opening inject) is completed on restart and noted in the alert, also when a crash cuts that completion short (an exhaustive crash-cut test covers every prefix of a full session and every cut inside the completion)
  - [x] AC-0163: a player line left unanswered by the crash is answered exactly once, after `/resume`; a Game Master evaluation lost in the crash runs again at its next cadence; nothing else is re-run
  - [x] AC-0164: a session lock `<id>.lock` (exclusive create, no symlinks, mode 0600, heartbeat) refuses a second server even with `SESSION_START=fresh`; documented stale-lock takeover (no heartbeat for `SESSION_LOCK_STALE_MS`, or a dead process or reused pid on this host); a server whose lock was lost stops writing
  - [x] AC-0165: every append is followed by fdatasync and the log is fail-stop (a failed write, sync or lock check refuses everything after it, clients get an unlogged notice and the process exits non-zero for a restart: Docker Compose restarts it up to 5 times); logs and locks are created 0600 (one link, own user) and the data directory 0700 (never widened; refused when it stays writable by others); the directory is synced after create and rotation; reads stream the log with a 64 MiB cap and replay in linear time
  - [x] AC-0166: a restart over an ENDED session moves its log aside and starts fresh (demo check F-24 stays valid)
  - [x] AC-0167: replaying a log gives exactly the live engine state (property test over random sessions); timestamps never go backwards across a restart and paused and active time are never negative
  - [x] AC-0168: `pnpm demo --fast --resume` runs the resume room, checks F-34 to F-43, offline and deterministic (39 checks); the default run keeps 29; CI runs it
  - [x] AC-0169: README (Resuming a session, `SESSION_START`, `SESSION_LOCK_STALE_MS`, `./run.sh --fresh`), `.env.example`, CHANGELOG and `docs/THREAT_MODEL.md` (logs at rest, the lock, the resume trust model) are updated
```

```
TASK-0018 (US-0018): Rebuild engine and host state from the JSONL log on startup and add an explicit fresh-session option
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Notes: Slice 1 rotates a stale log aside (US-0009 rotation) and never resumes. NPC agent, Game Master and ticker state must be reconstructed from events only. Delivered by TASK-0049 to TASK-0051.
```

```
TASK-0049 (US-0018): Log format 1, session.resumed, restore() with fail-closed refusals, a durable owner-only log and the session lock
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Notes: packages/events (LOG_FORMAT, EVENT_TYPES, session.resumed reducer), engine/event-log.ts (one handle, fdatasync, 0600, streaming validated scan, tail repair), engine/log-files.ts (SessionLock, rotation, private dir), SessionEngine.restore/markResumed, ts clamping. Property test: replay equals live state.
```

```
TASK-0050 (US-0018): Host and Game Master reconstruction, the pending line on /resume, SESSION_START modes and ./run.sh --fresh
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Notes: engine/session-store.ts openSession (lock, resume, ended and fresh rotation), bootstrap wiring, SessionHost.resumeFrom, GameMaster.restore, SESSION_LOCK_STALE_MS. A real SIGKILL crash and restart is a unit test.
```

```
TASK-0051 (US-0018): Demo resume room (pnpm demo --resume, F-34 to F-43), CI step and documentation
Type: Test
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0018-resume-after-restart
Notes: The crash is simulated in process (connections cut, lock and log abandoned). README, CHANGELOG, .env.example and THREAT_MODEL updated.
```

```
US-0019 (EPIC-0006): As an operator, I want model calls to cost less per session, so that sessions stay affordable as they get longer.
Priority: Low
Estimate: S
Status: In Progress
Branch: feature/EPIC-0006-US-0019-model-cost
Dependencies: US-0008
Acceptance Criteria:
  - [x] AC-0059: the Game Master prompt uses a bounded transcript window instead of the whole scene transcript (at least the latest `GM_TRANSCRIPT_WINDOW` utterances of the current scene, default 40, 10 to 500 and at least `GM_EVERY_N_UTTERANCES`, validated in the server, the demo and `gm-eval --live`; widened per condition to every line since its last answered prompt, also when lines arrive during a slow round, capped at 500 with a facilitator alert; the scene's first 2 lines and each AI character's last 2 lines, each with the line before it, kept outside the cut; window, coverage and alert count taken synchronously with the prompt build (re-review m-1); `{"omitted": n}` records in place and a numbers-only system note; no summary; nonce, verdict format, parser, re-ask and escaping unchanged; exit and earned_when prompts alike; the trace records the window; the shipped scenes fit, so the demo Game Master prompts are byte-identical to develop apart from the nonce; residual risk documented in THREAT_MODEL: a player's objection flooded out of view can allow a false exit; review fix round I-1, I-2, M-2, M-3; TC-0020; a live run on a real model is still to be recorded)
  - [x] AC-0060: the Game Master stops evaluating the remaining conditions of a scene after a condition is judged true (once a true verdict is recorded in the round, for the tick and `finalEvaluation`; a stale refused verdict, a false, no verdict or a model error go on; the US-0034 earned_when checks were already skipped in such a round; TC-0021)
  - [x] AC-0061: the NPC persona prompt puts stable content before changing goals and knowledge so the cached prefix survives NPC updates (`stableNpcPrefix`: instructions, persona, guardrails, voice; then goals, knowledge, scene, room, response rules, last lines, released facts last; `ChatRequest.cachePrefixChars` marks the prefix and the Anthropic adapter puts its cache breakpoint there, never inside a surrogate pair; a test asserts byte-identical prefixes through goal, knowledge and release updates and a scene change; S-06 asserts it for every captured prompt; TC-0022. Caveat: the shipped prefixes are about 420 to 520 tokens, probably below the minimum cacheable length (512 for claude-sonnet-5-5), so the saving is not measured; the story stays In Progress until `cache_read_input_tokens` is recorded on a real run)
```

```
TASK-0019 (US-0019): Bound the Game Master transcript, short-circuit after a true verdict, reorder the NPC prompt prefix
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0019-model-cost
Notes: Deferred minor findings from Tasks 7 and 8 and the final review. Behavior must stay covered by the existing leak and guardrail tests. Done 2026-10-07: gm-config (`GM_TRANSCRIPT_WINDOW`), gm-prompt (window, omission line), game-master (window, short-circuit, trace `window`), session-host/main/demo/gm-eval wiring, adapters (`cachePrefixChars`, Anthropic two-block system), npc-prompt (`stableNpcPrefix`, reorder), S-06 extended (no new check: 29, 14, 15, 42). Test cases TC-0020..TC-0022. Review fix round (2026-10-07): I-1 per-condition coverage of new lines (cap 500 with an alert), I-2 opening and AI character lines kept outside the cut with `{"omitted": n}` markers, M-1 caching caveat, M-2 singular wording, M-3 non-finite window, M-6 surrogate-safe split, stale-verdict test relabelled. Not done here: a live run on a real model; the live check of the reordered NPC prompt (M-4) is pending with the controller
```

```
US-0020 (EPIC-0006): As a developer, I want one shared definition of identifier rules and accurate plan text, so that scenario ids, protocol ids, session ids and the docs cannot drift apart.
Priority: Low
Estimate: S
Status: In Progress
Branch: feature/EPIC-0006-US-0020-shared-id-rules
Dependencies: US-0012
Acceptance Criteria:
  - [x] AC-0062: scenario, protocol, terminal client and session-id validation use one exported set of identifier rules (`packages/events/src/ids.ts`, imported by the scenario and rubric schemas, the validator, the rubric loader, the protocol, the terminal client, the demo, the session log, the lock, the join-codes file and the evaluator's report names; every accepted and refused value unchanged, pinned by characterisation tests written first; session ids are refused by every function that turns one into a file name, before anything is created; property-style tests over hostile ids; a test fails if another source spells an id character class; TC-0023, TC-0024)
  - [x] AC-0063: the Slice 1 plan's self-review text is corrected (`SessionEngine.alert()` replaced the planned public `emit`) and records where later rulings changed the plan (inline *Built differently* notes in Tasks 7 and 8, the corrected Interfaces bullet and a Revision notes table of ten rulings; plan-text.test.ts keeps it true; TC-0024)
```

```
TASK-0020 (US-0020): Extract shared identifier rules and correct the Slice 1 plan text
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0020-shared-id-rules
Notes: Three id rules currently live in schema.ts, protocol.ts, commands.ts and event-log.ts. Mismatches are harmless today but easy to drift. Delivered: packages/events/src/ids.ts (scenario ids: lower case, any length; file-safe ids: lower case, 1 to 64; safe and session ids: either case, 1 to 64; client ids: 1 to 128 and no control character; reserved ids; the JOIN_CODES role key), consumers updated, `assertSessionId` in log-files.ts and a first-line check in `openSession`; tests id-rules.characterisation (script and runtime), ids.test.ts, id-rules.files.test.ts, plan-text.test.ts. Known, unchanged difference: a scenario id has no length limit while a role id used as a report file name is limited to 64 (refused when reports are written). The story stays In Progress until review. Test cases TC-0023, TC-0024.
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
Status: Complete
Branch: feature/EPIC-0006-US-0022-retry-transient-model-errors
Dependencies: US-0014, US-0015
Acceptance Criteria:
  - [x] AC-0069: a transient upstream failure (an in-band overloaded or rate-limit error, HTTP 429 or 5xx, or a connection reset before any token) is retried a bounded number of times with backoff, inside the configured first-token and reply deadlines (verified with fakes: loopback servers and the mock provider. Real measurement by the controller after the review: a live OpenRouter run with the free Nemotron model, 30 s / 60 s timeouts, went from 10 of 20 canned fallbacks without retries to 0 of 20 with retries, wall time 315 s to 365 s; a single run on a shared free endpoint, a sample not a benchmark)
  - [x] AC-0070: non-transient errors (401, 403, 404 unknown model, 400 bad request) are not retried and surface immediately as the fallback line plus a facilitator alert
  - [x] AC-0071: a retry never produces a duplicate or partial utterance, never outlives the deadlines, and the facilitator alert and log state how many attempts were made and why the last one failed (sanitized, no keys or URLs)
  - [x] AC-0072: the model adapters classify failures as transient or permanent through a typed error, and the shared adapter contract tests cover the classification for the mock, Anthropic and OpenAI-compatible providers (the shared contract suite's typed-error case covers the mock, the OpenAI-compatible provider and the wrapper; the Anthropic classification is covered by separate tests built from the real SDK's error classes and by loopback tests of the real SDK, not by the shared contract suite)
```

```
TASK-0022 (US-0022): Add a typed transient/permanent error classification to the adapters and a bounded retry in the NPC agent and Game Master
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0022-retry-transient-model-errors
Notes: Found in a live demo run: about 4 of 10 calls to a free OpenRouter model failed within 0.4 s with 'Upstream error from Nvidia: Service temporarily overloaded' and each became the canned fallback line. Delivered as ModelProviderError classification in the adapters, RetryingModelProvider, MODEL_MAX_RETRIES / MODEL_RETRY_BASE_MS, and attempt count plus kind in the NPC and GM alerts. The Game Master call now has its own deadline of max(NPC_REPLY_TIMEOUT_MS, 60 s) and retries stop at it; the wait per retry is the backoff (base x 2^(n-1), +/-25%, capped at 4 s or the base) or a Retry-After up to 10 s, so the worst case is the attempts times 10 s, cut by the deadline. The Anthropic SDK's own retries are off when the provider is wrapped.
```

```
US-0023 (EPIC-0006): As a developer or evaluator, I want the demo runner's live mode to report fallback lines and alert reasons, so that a run cannot pass while the characters only spoke canned lines.
Priority: Medium
Estimate: S
Status: In Progress
Branch: feature/EPIC-0006-US-0023-demo-live-evidence
Dependencies: US-0021
Acceptance Criteria:
  - [x] AC-0073: in live mode the runner counts NPC replies that were the persona's fallback line and shows the count in the narration, in the checklist evidence and in the JSON report
  - [x] AC-0074: facilitator alert messages raised during the run are captured (sanitized) with their reason and shown next to the affected reply
  - [x] AC-0075 (the showcase part, `--max-fallbacks` for `pnpm demo --showcase`, came from US-0024; US-0023 adds it to the 29-check run, check F-08): an option such as `--max-fallbacks <n>` fails the run when more than n replies were fallback lines; without it the count is reported as a warning
```

```
TASK-0023 (US-0023): Count fallback replies and capture alert reasons in the demo runner, with an optional failure threshold
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0023-demo-live-evidence
Notes: In three live runs 2 of 6 main-story replies were canned fallback lines, yet check F-08 passed because a fallback line is non-empty. Done 2026-10-07: services/runtime/src/demo/live-evidence.ts (collectLiveEvidence, sanitizeAlert, alertsForReply), F-08 evidence and `--max-fallbacks`, the alert beside the affected reply in the narration, an end-of-run summary in the audit act, `liveEvidence` in the JSON report, sanitized alert text in the Markdown transcript. Test cases TC-0017..TC-0019. Not done here: a live run on a real model (the owner's); the showcase's own alert narration is unchanged.
```

```
US-0024 (EPIC-0006): As an evaluator, I want a longer demo scenario and a showcase mode, so that a live demo shows the AI characters and the Game Master doing substantial real work.
Priority: High
Estimate: L
Status: Complete
Branch: feature/EPIC-0006-US-0024-showcase-demo
Dependencies: US-0021
Acceptance Criteria:
  - [x] AC-0076: `scenarios/friday-escalation-extended` (6 scenes, 3 players, 2 AI characters including a new CFO, time boxes, gm_detects exit conditions, timed and private injects) loads and validates with zero errors and zero warnings, and a validated `showcase.yaml` script drives the bot players
  - [x] AC-0077: `pnpm demo --showcase --fast` runs offline in mock mode and passes its own checks (S-01 to S-12), and CI runs it as a step of the Demo Run job
  - [x] AC-0078: `pnpm demo --showcase --live` uses the configured provider for the AI characters and for the Game Master, scene exits are decided by the real Game Master, and the facilitator advance is only a recorded safety net (verified in a recorded real run on 2026-10-05 with OpenRouter nvidia/nemotron-3-ultra-550b-a55b:free: 4 real Game Master evaluations, 1 scene exited by the Game Master, 5 scenes ended by the recorded facilitator safety net, 12 of 20 AI replies generated and 8 canned fallbacks; the Game Master exit rate was low with this model, see US-0025)
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

```
US-0025 (EPIC-0006): As a facilitator, I want the Game Master to give a usable verdict reliably with real models, so that scenes end on the Game Master's judgement instead of needing a facilitator advance.
Priority: High
Estimate: M
Status: In Progress
Branch: feature/EPIC-0006-US-0025-game-master-reliability
Dependencies: US-0008, US-0024
Acceptance Criteria:
  - [x] AC-0082: a Game Master reply that is not strict JSON (prose around the JSON, a code fence, a verdict only in the model's reasoning, an empty reply) is handled by a tolerant, tested parser or one bounded re-ask, so 'no usable verdict' becomes rare
  - [x] AC-0083: the Game Master prompt and exit conditions are tuned so that, in a recorded live showcase on a real model, the Game Master ends more than half of the scenes whose scripted lines satisfy their condition (recorded 2026-10-06 on local gemma-4-31b-it-qat-mxfp4 only; Raptor was dropped from testing for its lower quality; final code after two review rounds: showcase 4 of 6 scenes ended by the Game Master (s2 and s5 by facilitator advance; baseline before this story 61% of scenes), 13 usable verdicts all read strictly with the 16-hex nonce (0 re-asks, 0 no-verdict, 0 no_nonce), 1 early exit (s4 after 2 lines, in a scene with AI characters, may be legitimate); gm-eval live x3: 100% usable verdicts, agreement with labels 95%, precision 100%, recall 89% (positives answered true 16 of 18 runs, the misses are s4 full), 0 of 24 false exits on the 8 negative controls; trace replay under the stored nonce reads 13 of 13; an earlier round's s6 cut-2 label was found indefensible in review and replaced by a hard negative; caveats: single model, one showcase run, labels are the implementer's)
  - [x] AC-0084: a Game Master call has its own configurable timeout and transient-error retry (shared with US-0022), and a failed evaluation is shown in the narration with its reason
  - [x] AC-0130: the Game Master verdict parser is a pure, total function (it never throws, whatever the reply) that drops `<think>` blocks and code fences, reads a reply that is exactly one JSON object as strict, otherwise takes the last brace-balanced JSON object with a usable `verdict` (a boolean or exactly "true"/"false", never 1, "yes" or null), then `verdict: true` as plain text, then a bare true/false, and names why it failed (`empty`, `no_json`, `bad_verdict`, `truncated`, `reasoning_only`, `conflict`, `no_nonce`); a verdict must carry the per-evaluation nonce id from the system prompt, disagreeing, truncated, quoted, duplicate-key and array-wrapped verdicts are never accepted; covered by table-driven, injection and fuzz tests
  - [x] AC-0131: a reply with no usable verdict is asked again at most once inside the same deadline (a model error, the deadline and a stale scene are not re-asked; a reasoning-budget error counts as a parse failure), and the result is the facilitator-only event `gm.no_verdict {sceneId, condition, reason, attempts}` that players never receive (the re-ask runs on its own fresh abort signal and a deadline in it keeps the first reply's reason); `gm.decision` carries an optional `via` (strict, tolerant, reask)
  - [x] AC-0132: `GM_TIMEOUT_MS` (500 to 600000, default max(NPC_REPLY_TIMEOUT_MS, 60 s)), `GM_REASK` (0 or 1, default 1) and `GM_EVERY_N_UTTERANCES` (1 to 20, default 3) are validated at start-up, in the server and in the demo, with errors that name the variable
  - [x] AC-0133: the Game Master prompt judges only the condition (the scene goal is labelled background), asks for the reasoning before the verdict and treats an unopposed proposal as not agreed (product-owner decision): true needs the condition stated and agreed or confirmed
  - [x] AC-0134: the extended showcase scene 3 has an assent after "Are we all happy with that plan?", the mock Game Master script holds one fenced reply and one malformed-then-valid reply, and check S-04 proves the tolerant and the re-ask paths whenever the mock served them
  - [x] AC-0135: a failed evaluation is visible: the narration prints the no-verdict reason ("after the re-ask"), the summary has a Game Master reliability line, and the JSON `showcase.gm` has `noVerdicts`, `noVerdictByReason`, `reasks` and `via`; the 29-check F-13 expects the re-ask then gm.no_verdict
  - [x] AC-0136: `pnpm gm-eval` runs offline with labelled cases (`tests/gm-cases/`: each scene in full is met, a cut before the agreement is a negative control), a parser corpus and a check that the cases are in step with `showcase.yaml`, and with `--live [--runs n]` measures usable-verdict rate, agreement, precision, recall, false exits, attempts and latency of a real model
  - [x] AC-0137: `--gm-trace <file>` (demo) and `GM_TRACE_FILE` (server) record every raw Game Master reply and its parse in an owner-only (0600) file, off by default and never in the session log; `pnpm gm-eval --trace <file>` replays it offline and reports parse rate by reason and drift
  - [x] AC-0138: a live showcase run has check S-18 (scenes the Game Master ended of the total, early exits (before the scripted agreement), no-verdict rate by reason) that fails only with `--min-gm-exits <n>` (below it) or an explicit `--max-false-exits <n>` (early exits in scenes without AI characters)
  - [x] AC-0139: the S-07 observation no longer calls a matched phrase a hidden-fact recital: it counts apart the phrases shared with the scenario's hidden-fact or rubric text and the whole hidden facts word for word, and says a match is an echo or shared wording (an unreleased hidden fact never enters a prompt)
```

```
TASK-0025 (US-0025): Make Game Master verdict parsing tolerant, tune the prompt and conditions, add a timeout and retry
Type: Dev
Assignee: Agent
Status: In Progress
Branch: feature/EPIC-0006-US-0025-game-master-reliability
Notes: Found in the first real live showcase (OpenRouter free Nemotron): 4 Game Master evaluations, 3 verdicts false, 1 true, and several 'GM: no usable verdict' alerts; 5 of 6 scenes ended on the facilitator safety net.
```

```
TASK-0040 (US-0025): Tolerant Game Master parser, one bounded re-ask, the gm.no_verdict event and the GM_* settings
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0025-game-master-reliability
Notes: gm-parse.ts, gm-evaluate.ts (the one production evaluation path, also used by gm-eval), gm-config.ts; new event type in packages/events; AC-0082, AC-0084, AC-0130 to AC-0132.
```

```
TASK-0041 (US-0025): Reword the Game Master prompt, edit showcase scene 3 and the mock script, show failure reasons, S-04, S-18 and the S-07 label
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0025-game-master-reliability
Notes: AC-0133 to AC-0135, AC-0138, AC-0139. AC-0083 was recorded on gemma-4-31b-it-qat-mxfp4 only (Raptor dropped): at least 4 of 6 scenes ended by the Game Master, at most 1 false exit on the negative controls, baseline 61%.
```

```
TASK-0042 (US-0025): The offline gm-eval harness with labelled cases and the --gm-trace capture
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0025-game-master-reliability
Notes: services/runtime/src/gm-eval, tests/gm-cases/, GM_TRACE_FILE and --gm-trace; AC-0136, AC-0137.
```

```
US-0026 (EPIC-0006): As a facilitator running a local reasoning model, I want AI character and Game Master replies to survive a model that thinks before it answers, so that a slow or reasoning model does not turn into canned fallback lines.
Priority: Medium
Estimate: S
Status: In Progress
Branch: feature/EPIC-0006-US-0026-reasoning-model-empty-replies
Dependencies: US-0014, US-0022
Acceptance Criteria:
  - [x] AC-0085: when an OpenAI-compatible server streams or returns a reasoning field (`reasoning_content` or `reasoning`) and an empty answer because the token budget ran out, the provider reports a distinct, retryable 'reasoning used the whole token budget' error instead of a silent empty reply, and the reasoning text is never shown to players as dialogue
  - [x] AC-0086: the NPC and Game Master token budgets are configurable (`NPC_MAX_TOKENS`, `GM_MAX_TOKENS`, validated range, documented), and the demo narration says an empty reply was caused by an exhausted budget
  - [ ] AC-0087: a recorded local showcase on Qwen3.8-27B-MXFP8 (2026-10-05: 5 empty replies and 3 first-token timeouts out of 17 AI lines) is rerun with the larger budget and the empty-reply count is reported
```

```
TASK-0026 (US-0026): Detect reasoning-only replies in the OpenAI-compatible provider, make the token budgets configurable, rerun the local showcase
Type: Dev
Assignee: Agent
Status: In Progress
Branch: feature/EPIC-0006-US-0026-reasoning-model-empty-replies
Notes: Found 2026-10-05 in the local showcase. Cause: the provider reads only `content` and ignores `reasoning_content`, and the budgets are fixed at 300 (NPC) and 200 (Game Master); probes with small budgets returned finish_reason length with empty content on both Qwen3.8-27B and raptor-v0.5-8b. The Raptor run was clean (0 fallbacks), so the budget matters mostly for slow or long-thinking models.
```

```
US-0027 (EPIC-0006): As a facilitator running the showcase, I want the player roles to be played by the model too (as humans normally would), so that a run varies between runs and scenes instead of repeating the same stilted scripted lines.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0006-US-0027-generated-players
Dependencies: US-0024, US-0026
Acceptance Criteria:
  - [x] AC-0088: `pnpm demo --showcase --live --players generated` (optional `--player-model <id>`, default the NPC model) has the model speak each player role's line slot; `--players` defaults to `scripted`, `generated` needs `--showcase` and `--live` (a one-line usage error otherwise), and the mock and CI runs are unchanged
  - [x] AC-0089: a player prompt holds only what that role may see (its brief and private facts, the scene, the injects it received, the conversation it can see) plus the scripted line as a private intent; it never holds NPC goals, hidden facts, the rubric, other roles' secrets or participant names
  - [x] AC-0090: a generated line is cleaned like an NPC reply (it cannot speak for others), bounded by the server's maximum line length and non-empty, and reaches the server only through `say`; on a model failure, an empty or an unusable reply the scripted line is spoken, tagged `[SCRIPTED]`, and the narration says why
  - [x] AC-0091: a spoken line is tagged `[GENERATED]` only when the model produced the recorded text; the transcript legend and the AI contribution summary count generated player lines apart from AI character replies and Game Master verdicts and report how many generated lines repeated the scripted line verbatim (an observation, not a failure)
  - [x] AC-0092: the AI character prompt states that the character IS that person (first person, never its own role or title in the third person) and Helena Brandt's persona is consistently she/her; the Game Master prompt format is unchanged
  - [x] AC-0093: a recorded live showcase with `--players generated` on a real model is run and compared with a scripted-player run (lines per role, fallbacks, repeats) (recorded 2026-10-06 on local gemma-4-31b-it-qat-mxfp4: 21 of 21 player lines generated, 1 verbatim repeat of the script, 0 fallbacks, 0 alerts, 13 checks passed, 520 s; generated players on Raptor-8B echoed each other, so the model matters; a first Gemma run leaked the private intent after a `***` separator in all 21 lines, fixed in this story)
  - [x] AC-0111: with `--players generated` each player's private intent (the scripted line it was asked to express) is logged as a `[SYSTEM]` entry right before its line in the transcript and narration, listed per slot in the JSON report and counted in the summary; it never reaches the session log, a client or the Game Master, and `--no-intents` hides it
```

```
TASK-0027 (US-0027): Add the generated player bots to the showcase, share the model-reply and prompt-turn logic with the AI characters, fix the CFO's third-person speech, record a live comparison
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0027-generated-players
Notes: Observed 2026-10-05: scripted player lines make every showcase run identical; an 8B model also had the CFO say 'the CFO' in the third person with 'he'.
```

```
US-0028 (EPIC-0005): As a scenario author, I want to write rubrics as YAML files with a behavioural anchor for every level of every criterion, so that scoring is judged against observable behaviour and each scenario can bring its own rubric.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0005-evaluator-feedback
Dependencies: US-0003
Acceptance Criteria:
  - [x] AC-0094: a rubric file (YAML) has an id, a name and criteria; each criterion has an id, name, description, observable `what_to_look_for` indicators and levels 1 to 4, each with a written behavioural anchor, plus example phrases at levels 2 and 4; the zod schema lives in `packages/script/src/rubric.ts`
  - [x] AC-0095: `loadRubrics(dir, scenario)` resolves the scenario's `rubrics:` ids from `<dir>/rubrics/<id>.yaml` and reports an error for a missing file, a missing level, a duplicate criterion id or a learning objective whose `rubric_criteria` id matches no loaded criterion
  - [x] AC-0096: rubric files obey the same size and alias limits as the showcase YAML loader (size cap, no alias expansion bombs); a scenario whose `rubrics:` is empty or absent loads as 'no rubrics' with a warning, not an error
  - [x] AC-0097: `scenarios/friday-escalation-extended/rubrics/individual_delivery_v2.yaml` and `group_collaboration_v1.yaml` hold real content for a delivery lead facing scope creep, and `scenarios/friday-escalation` carries copies so both scenarios validate
```

```
TASK-0028 (US-0028): Define the rubric schema, loader and validator and author the two rubrics
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0005-evaluator-feedback
Notes: Criteria: discovery, listening, negotiation, commercial_judgement, stakeholder_management, team_alignment and role_clarity (individual behaviours); shared_understanding, decision_quality, role_clarity_group and escalation_discipline (group, ASM-02). Review fix round 2026-10-06: anchors rewritten to be observable from the participant's own words, distinct key behaviours, "at least two of" at level 3, generic examples; the two scenario copies are kept byte-identical by a test.
```

```
US-0029 (EPIC-0005): As a facilitator, I want each player and the group scored per criterion from the recorded session log, with verified quoted evidence, a confidence level and a roll-up to the learning objectives, so that feedback rests on what people actually said.
Priority: High
Estimate: L
Status: Complete
Branch: feature/EPIC-0005-evaluator-feedback
Dependencies: US-0028, US-0002
Acceptance Criteria:
  - [x] AC-0098: from a session JSONL log and the scenario the evaluator builds a transcript of all utterances (players and AI characters), injects, scene boundaries and Game Master verdicts, makes ONE model call per player role and ONE for the group, and treats the transcript as data (delimited, with an instruction to ignore anything inside it)
  - [x] AC-0099: every score needs a verbatim, timestamped quote from that participant, verified programmatically as a substring (after whitespace normalisation) of the recorded utterance of that role at that seq; unverifiable quotes are dropped, a score of 3 or 4 with no verified quote is capped at 2 and flagged, unknown criterion ids are ignored, missing ones become Not observed, and scores outside 1 to 4 or non-integers are rejected
  - [x] AC-0100: aggregation is pure and property-tested: a learning-objective score is the mean of its observed criteria rounded to one decimal, labelled by the thresholds 1.5, 2.5 and 3.5; confidence is High, Medium or Low from the number of verified quotes and the model-stated confidence; no single overall grade is computed
  - [x] AC-0101: `EVAL_MODEL` (default the NPC model), `EVAL_MAX_TOKENS` (3000, 200 to 8000), `EVAL_TEMPERATURE` (0.2) and `EVAL_TIMEOUT_MS` (180000, never below the NPC reply timeout) are validated; replies are parsed tolerantly (code fences, prose) with one bounded re-ask; a failed participant is reported as 'evaluation failed: <reason>' without stopping the others; a participant with fewer than 2 utterances gets 'insufficient evidence' with no model call; the transcript sent is capped by a character budget and the report says when it was trimmed
  - [x] AC-0102: in mock mode the evaluator runs on scripted replies built by the demo harness, including one deliberately bad quote and one malformed-JSON-then-valid re-ask, and the number of model calls is reported
```

```
TASK-0029 (US-0029): Build the evaluator engine in services/runtime/src/evaluator
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0005-evaluator-feedback
Notes: Prompt-injection hardening and programmatic quote verification are the core of the design; see docs/EVALUATOR.md. Review fix round 2026-10-06: Invalid criteria and incomplete LOs, distinct-line confidence, quote overlap and minimum, hard transcript cap, method text aligned with the code.
```

```
US-0030 (EPIC-0005): As a participant and a facilitator, I want a draft personal report and a group report written from the scores, so that people get strengths, development points and next actions and the facilitator gets talking points.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0005-evaluator-feedback
Dependencies: US-0029
Acceptance Criteria:
  - [x] AC-0103: each player gets a Markdown report and a JSON twin (`schema: 'acr.report/1'`) with a header, a DRAFT banner, the visibility line, a summary of 2 to 3 strengths, 2 to 3 development points and 2 to 3 next actions each tied to an LO id, a learning-objectives table, a criteria table, the evidence quotes with scene, seq and relative time, and the 'How this was scored' section
  - [x] AC-0104: the group report holds the group criteria table, LO coverage across the team (players x LOs), the scenario's facilitator notes together with the model's talking points, notable moments with quotes and the method section
  - [x] AC-0105: all model and participant text goes through the demo's Markdown escaping and secret and path scrubbing; role ids are validated as safe file names; reports are written under `<out>/<session-id>/` in a fresh directory with exclusive create, never outside it
  - [x] AC-0106: `index.md` links every report and shows the per-LO table for all players, `method.md` holds the scale and method text, and every report and JSON carries the line 'Visibility: all participants (prototype setting; per-participant isolation is planned)'
```

```
TASK-0030 (US-0030): Render participant and group reports, the index and the method page
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0005-evaluator-feedback
Notes: The method text is defined once (rubric scale, evidence rule, confidence rule, aggregation, limitations) and printed in every report.
```

```
US-0031 (EPIC-0005): As a facilitator or developer, I want to run the evaluator on a session log and to have the showcase produce the reports at the end, so that feedback can be generated after any session and verified in the demo.
Priority: Medium
Estimate: M
Status: Complete
Branch: feature/EPIC-0005-evaluator-feedback
Dependencies: US-0029, US-0030, US-0024
Acceptance Criteria:
  - [x] AC-0107: `pnpm evaluate <session.jsonl> [--scenario <dir>] [--out <dir>] [--json -]` works with usage and `--help`, exit codes 0 (ok), 1 (an evaluation failed) and 2 (usage), and prints a one-line notice that the transcript is sent to the model provider
  - [x] AC-0108: `pnpm demo --showcase [--live] [--evaluate] [--eval-out <dir>]` runs the evaluator on the log of that run after the checks (always scripted and deterministic in mock mode), prints a short summary and adds check S-16 only with `--evaluate`: a report file per player, every quote a verbatim substring of its utterance, the method section present, scores 1 to 4 or Not observed; without `--evaluate` the run still has S-01 to S-14
  - [x] AC-0109: the `--json` report lists the report paths and the transcript Markdown stays unchanged
  - [x] AC-0110: README has a 'Scoring and feedback' section, `docs/EVALUATOR.md` describes the method, data flow, limits, rubric authoring and how to read a report, and the changelog and dashboard are updated
```

```
TASK-0031 (US-0031): Add the evaluate script and wire --evaluate into the showcase
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0005-evaluator-feedback
Notes: Live runs of the evaluator are done by the controller, not in this task. A real Gemma run (2026-10-06) worked; the review fix round also made S-16 read-back tests, the live watchdog extension and partial-write cleanup.
```

```
US-0032 (EPIC-0006): As a facilitator running a scene with two AI characters, I want each character to respond with its own kind of contribution and to stay silent when it has nothing of its own to add, so that a senior executive gives a decision, a condition or a number instead of echoing the sponsor.
Priority: High
Estimate: M
Status: Complete
Branch: feature/EPIC-0006-ai-character-voices
Dependencies: US-0027
Acceptance Criteria:
  - [x] AC-0112: an AI character role has optional `seniority` (integer 1 to 5, default 3), `responds_with` and `only_you_say` (up to 5 short strings each) and `defer_to` (role ids); the validator rejects an id that is not an NPC role (or the role itself), bounds the lengths, and both scenario folders carry them for Priya Raman and Helena Brandt
  - [x] AC-0113: the AI character prompt has a '## Who else is in the room' section (the other characters present: name, title, seniority relative to the speaker) built only from data already public to participants, and a '## How you respond' section from `responds_with` and `only_you_say`, with the rules not to restate, paraphrase or agree-and-repeat the previous speaker, to open with its own angle and, when a more junior character has just spoken for the client side, to add the decision, condition or number only it would give; `npcIntro` and the prompt size bounds are unchanged
  - [x] AC-0114: a character may reply exactly `<silent/>` (trimmed, case-insensitive) when it has nothing new that only it would say: this is no utterance, no fallback and no alert, it is counted, the session still advances (Game Master counting and in-flight guards unaffected), at most 2 turns in a row, and the marker never reaches a player, the log, the transcript or the evaluator, even when it appears inside a longer reply or a quote
  - [x] AC-0115: when several AI characters are in a scene they reply after a player line in seniority order, junior first (ties by the scene's participant order), deterministically; the last character of a round nobody has answered yet must speak, and a facilitator warning is raised if every character stays silent and under the existing serialisation guarantees; a scene with one AI character, or characters without seniority, behaves as before
  - [x] AC-0116: the showcase report, narration summary and `--json` `showcase` section count near-duplicate replies of two different AI characters to the same player line (echoes out of eligible pairs) (token-set Jaccard similarity of at least 0.6, a pure tested function) and the silent turns per character, as observations and never as failures
  - [x] AC-0117: the scripted mock providers and shipped showcase scripts keep working (`demo --fast` 29/29, `--showcase --fast` 14/14, `--evaluate` 15/15), and a loopback fake-model showcase run in generated-players mode proves a silent turn and a spoken turn by the CFO end to end
  - [x] AC-0118: README documents the new role fields, and the changelog and dashboard are updated
  - [x] AC-0119: a recorded live comparison on a real model shows the CFO's replies are distinct from the sponsor's (echo count compared with the run before this story) (recorded 2026-10-06 on local gemma-4-31b-it-qat-mxfp4 with generated players: 0 of 5 comparable AI reply pairs were near-duplicates, Priya stayed silent once, 0 alerts, 22 of 22 player lines generated, 13 checks passed, 673 s; the CFO now opens with a decision, a number or an ultimatum (for example 'I require a daily credit of two thousand dollars, or I will not sign the change request') and the sponsor relays and defers to her; sample is one run with 5 comparable pairs)
```

```
TASK-0032 (US-0032): Add voice fields to the schema, the roster and response sections to the NPC prompt, silence, seniority turn order and the echo metric
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-ai-character-voices
Notes: Observed 2026-10-06 in real Gemma runs of `pnpm demo --showcase --live --players generated`: both AI characters answered every player line and the CFO's reply rephrased the sponsor's point. Live comparison is recorded by the controller, not in this task. Fix round 2026-10-06 after an independent review: forced last speaker, silence forms folded before cleaning, roster tags, generic prompt wording, echo metric restricted to different roles answering the same player line, validator warnings, ordered silent-turn note, bounded silence memory, cross-character prompt audit in S-06.
```

```
US-0033 (EPIC-0006): As an operator, I want each player role to have its own join code, so that a person cannot claim a role that was meant for someone else.
Priority: Medium
Estimate: M
Status: In Progress
Branch: feature/EPIC-0006-US-0033-player-join-codes
Dependencies: US-0017, US-0018 (the codes must survive a restart)
Acceptance Criteria:
  - [x] AC-0120: when the server starts a session it creates one random join code per player role (stored only as a hash, never written to the event log), the operator can see the codes once at start, and a `join` for a player role must present that role's code (engine/join-codes.ts: 12 Crockford base32 symbols, salted SHA-256, timingSafeEqual; printed once by bootstrap's `showJoinCodes`, never through log/warn; hashes in `<id>.codes.json`; demo F-01, F-24, F-28)
  - [x] AC-0121: a `join` with a missing or wrong code is refused with one generic error that does not say whether the role exists or is taken, and the refusals count towards the existing connection and rate limits (one `unauthorized` for no or a wrong code, unknown, AI and reserved roles and an unknown session; 1008 close; charged in the failed-login throttle shared with the facilitator token; ws-server.join-codes.test.ts, demo F-02)
  - [x] AC-0122: the facilitator token (US-0017) remains separate, a rejoining player keeps using the reconnect token for a live session, and the README documents how to hand the codes out (a code never opens the facilitator stream nor the token a role; a live takeover needs the reconnect token and no code; codes survive a restart as hashes, US-0018; README "Player join codes" and "Handing out the join codes"; demo F-22, F-37, F-40, F-41)
```

```
TASK-0033 (US-0033): Generate and verify per-role join codes, add the code to the join message and the terminal client, document it
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0033-player-join-codes
Notes: Closes the gap US-0017 leaves open: with only a facilitator token, any connection can still claim an unclaimed player role. Also needed so that US-0018 (resume after restart) can keep roles protected across a restart (hashed codes only). Delivered: engine/join-codes.ts (issue, verify, record), engine/join-code-file.ts (`<id>.codes.json`: O_EXCL temp + fsync + rename under the lock, read through one fstat-judged descriptor), openSession `joinCodes` (kept on resume and on an empty log, new on fresh or after an ended session, the old file removed before the log is rotated, a malformed file refused like a corrupt log), ws-server `joinCodes` (generic refusal, throttle), bootstrap `showJoinCodes`/`printJoinCodes`, protocol `joinCode`, terminal client `JOIN_CODE`/`--code-file`/hidden prompt, demo servers and checks (counts unchanged), `pnpm demo --url` with `JOIN_CODES`. Test cases TC-0001 to TC-0007. Review fix round (I-1, M-1 to M-6): unseen codes are withdrawn when a start fails and an empty log always gets new codes, Crockford folding and an ASCII-only check, the same digest work for an unknown session, stale temp files swept, docs on the shared per-address throttle. Story stays In Progress until the re-review and the controller's checks.
```

```
US-0034 (EPIC-0006): As a facilitator, I want the Game Master to suggest releasing a hidden fact when a scenario `earned_when` condition is met (suggest-only, never auto-release by default), so that I do not have to watch for the moment a participant has earned it.
Priority: Medium
Estimate: M
Status: In Progress
Branch: feature/EPIC-0006-US-0034-gm-suggests-hidden-fact-release
Dependencies: US-0016, US-0025
Acceptance Criteria:
  - [x] AC-0123: a scenario may give a hidden fact an optional `earned_when` condition (plain text, validated like a scene exit condition), and a scenario without it behaves exactly as before (role field `earned_when: {<fact number>: <condition>}`, trimmed, 1 to 500 characters, the validator refuses a number the character has no fact for; without it the role loads without the key, so the scenario hash, the Game Master calls and the events are unchanged; TC-0008)
  - [x] AC-0124: when the Game Master judges an `earned_when` condition true for a fact that is not yet released, the facilitator (only) receives one alert that names the role and the fact index and says how to release it (`/release <role> <n>`); the fact text never reaches players, and the same suggestion is not repeated (the facilitator-only event `gm.fact_earned {sceneId, roleId, fact, reasoning, via}`, shown as `[alert] Game Master suggests releasing hidden fact #n of <role> (...): type /release <role> <n> to release it`; judged through the nonce-signed exit-condition path with a prompt that never holds the fact; at most once per fact per session, rebuilt from the log after a restart; players are denied the event and the snapshot state; TC-0009, TC-0010)
  - [x] AC-0125: nothing is released without the facilitator's `release_hidden` command, unless the operator explicitly sets an opt-in `GM_AUTO_RELEASE` option, which is off by default and records the release as a Game Master action (`GM_AUTO_RELEASE` 0 or 1, default 0, validated, a startup warning; with 1 the event carries `autoRelease: true` and is followed by the facilitator-only `npc.updated`, no facilitator command; a crash between the two appends is completed on resume, tested at every event boundary; TC-0011)
  - [x] AC-0126: the scripted mock provider covers the suggestion and the no-suggestion cases, the demo checks stay stable, and the README and CHANGELOG describe the feature (`showcase.yaml` `mock.gm_earned`: one false verdict then the suggestion in scene 4, before the scripted release in scene 5; S-04, S-06 and S-07 extended, no new check: 29, 14, 15 and 42 with `--security --resume`; `GM_AUTO_RELEASE=1` also runs end to end in the mock showcase with the same 14 checks; at most 2 earned_when checks per Game Master round; a live run on a real model is still to be recorded by the controller; TC-0012)
```

```
TASK-0034 (US-0034): Add earned_when to the schema, have the Game Master evaluate it and alert the facilitator, add the opt-in auto release
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0006-US-0034-gm-suggests-hidden-fact-release
Notes: Follow-up to the design notes for US-0016 and US-0025. US-0016 gives the facilitator the manual release command; this story only suggests it. Done 2026-10-07: packages/script (schema, validator, earnedWhenOf), packages/events (`gm.fact_earned`, `factsEarned`), engine (`pendingEarnedChecks`, `recordFactEarned`, repair `gm_release`), agents (`buildGmEarnedRequest`, GameMaster earned checks, `GM_AUTO_RELEASE`), host (viewFor, snapshotFor), terminal client, demo (showcase mock `gm_earned`, S-04/S-06/S-07). Test cases TC-0008..TC-0012. Not done here: a live showcase on a real model.
```

```
US-0035 (EPIC-0005): Calibration probe format, validator, log adapter and Friday starter set
Priority: High
Estimate: M
Status: In Progress
Branch: feature/EPIC-0005-US-0035-calibration-probes
Acceptance Criteria:
  - [x] AC-0180: a probe is a validated YAML file (`single` or `contrast`, `source`, `drafter`, `approved_by`, `split`, `acceptable`) in `scenarios/<id>/calibration/` (probe-schema.ts; probe-schema.test.ts; TC-0025)
  - [x] AC-0181: loading reports every problem in one list (unknown criterion, non-player subject, a scored player with fewer than 2 lines, bad ids, hostile YAML, drafted without approval) (probe-load.ts; probe-load.test.ts; TC-0025)
  - [x] AC-0182: a probe becomes a synthetic session log the real evaluator accepts, quote verification included (probe-events.ts; probe-events.test.ts and probe-evaluate.test.ts run the eight starter probes through the real `evaluateSession` with a scripted judge; TC-0026)
  - [x] AC-0183: the Friday scenario ships 8 starter probes (4 discovery levels, 2 negotiation levels, 2 contrast groups) that validate against its rubric, and the linter reports the set as thin (scenarios/friday-escalation/calibration; starter-set.test.ts; TC-0027)
```

```
TASK-0055 (US-0035): File the probe format, its validator, the log adapter and the Friday starter set
Type: Dev
Assignee: Agent
Status: Done
Branch: feature/EPIC-0005-US-0035-calibration-probes
Notes: Implementation plan Tasks 0-3b (docs/superpowers/plans, evaluator calibration, 2026-10-07): probe schema, loader, validator and linter, the events adapter, the eight Friday starter probes, and the fix rounds (rubric-example paraphrases, loader hardening, the package guard). Done 2026-10-07; test cases TC-0025..TC-0027. Not done here: `pnpm calibrate`, metrics, drafting and the stamp (US-0036..US-0039).
```

```
US-0036 (EPIC-0005): `pnpm calibrate`: judges, runner, metrics, report, second-judge comparison
Priority: High
Estimate: L
Status: Planned
Branch: feature/EPIC-0005-US-0036-calibrate-command
Dependencies: US-0035
Acceptance Criteria:
  - [ ] AC-0184: judges are configuration (`--judge label,model[,baseUrl]`, primary defaults to the evaluator settings) and a mock provider is refused
  - [ ] AC-0185: the runner feeds each probe to `evaluateSession` unchanged, supports `--repeat` (max 5), `--only`, and records unreachable or garbage judges as unusable
  - [ ] AC-0186: metrics: agreement (exact and within-one as counts), signed bias overall and per expected level, contrast ordering and gap, spread, not-observed precision and recall, usability, stability, split by source, drafter and tune/holdout, with same-family drafter warnings
  - [ ] AC-0187: a blind second-judge comparison lists every disagreement with both judges' levels, rationale and quotes
  - [ ] AC-0188: the report is Markdown plus JSON with a one-screen summary, PASS/WARN/FAIL labels per criterion from `targets.yaml` over documented defaults, `--strict` exits non-zero on FAIL, output is exclusive-create under git-ignored `data/calibration/`, and `pnpm calibrate` never blocks `pnpm evaluate`
```

```
TASK-0056 (US-0036): Build the calibrate command: judges, runner, metrics, report and second-judge comparison
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0005-US-0036-calibrate-command
Notes: Implementation plan Tasks 4-8 (docs/superpowers/plans, evaluator calibration, 2026-10-07).
```

```
US-0037 (EPIC-0005): Probe drafting, excerpts, approval, and the scaled Friday set
Priority: Medium
Estimate: M
Status: Planned
Branch: feature/EPIC-0005-US-0037-probe-drafting
Dependencies: US-0036
Acceptance Criteria:
  - [ ] AC-0189: `--draft-probes` writes candidate probes to `calibration/drafts/` using a drafter of a different model family from the primary judge unless `--allow-same-family`, and a run never reads drafts
  - [ ] AC-0190: `approve` validates a draft, records approver and time, assigns a split, and moves it into `calibration/`; `excerpt` drafts a probe from a real session log range for a human to rate
  - [ ] AC-0191: the Friday set reaches at least 20 approved probes, balanced across levels, with at least 5 real excerpts rated by a human and at least 10 holdout probes
```

```
TASK-0057 (US-0037): Add probe drafting, excerpts and approval, and scale the Friday set
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0005-US-0037-probe-drafting
Notes: Implementation plan Tasks 9-10 (docs/superpowers/plans, evaluator calibration, 2026-10-07).
```

```
US-0038 (EPIC-0005): Evaluator prompt variants and the acceptance report (conditional on the baseline)
Priority: Medium
Estimate: M
Status: Planned
Branch: feature/EPIC-0005-US-0038-prompt-variants
Dependencies: US-0036, US-0037
Acceptance Criteria:
  - [ ] AC-0192: the evaluator takes a named prompt variant, `v1` is byte-identical to today's prompt, and reports record the variant
  - [ ] AC-0193: `v2` (evidence-first, lower-level tie-break) and `v3` (next-level challenge) exist behind the variant name with the output schema, parser and quote verification unchanged
  - [ ] AC-0194: a variant becomes the default only through a PR carrying the holdout before/after table that meets the spec's acceptance rule
```

```
TASK-0058 (US-0038): Add evaluator prompt variants and the acceptance report
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0005-US-0038-prompt-variants
Notes: Implementation plan Task 12 (docs/superpowers/plans, evaluator calibration, 2026-10-07).
```

```
US-0039 (EPIC-0005): Calibration stamp on evaluation reports
Priority: High
Estimate: S
Status: Planned
Branch: feature/EPIC-0005-US-0039-calibration-stamp
Dependencies: US-0036
Acceptance Criteria:
  - [ ] AC-0195: every evaluation's JSON and Markdown records the judge, model, prompt variant and rubric hash
  - [ ] AC-0196: a one-line calibration stamp (footer, `index.md`, each personal report) states measured numbers and never claims accuracy, with states not calibrated, stale (rubric hash or variant changed) and thin
  - [ ] AC-0197: a corrupt or missing calibration file never breaks a report
```

```
TASK-0059 (US-0039): Stamp evaluation reports with the calibration state
Type: Dev
Assignee: Agent
Status: To Do
Branch: feature/EPIC-0005-US-0039-calibration-stamp
Notes: Implementation plan Task 13 (docs/superpowers/plans, evaluator calibration, 2026-10-07).
```
