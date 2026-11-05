# PROJECT.md: Project Constitution

The rules this project holds itself to. [AGENTS.md](AGENTS.md) says how agents work; this file says what the product is, what it must never do, and what must stay true. Change it only when a schema changes, a rule is added or the architecture is modified (AGENTS.md section 3). Detail lives in the documents linked from each section; this file does not repeat them.

## 1. Discovery answers (Protocol 0)

| Question | Answer |
| --- | --- |
| **North Star** | Make high-quality, repeatable, measurable team practice available on demand: a team plays a scripted workplace scenario with AI counterparts, and gets consistent, evidence-linked feedback that a facilitator reviews before anyone sees it. ([Product spec](docs/PRODUCT_SPEC.md) section 1.) |
| **Integrations** | Model providers behind one `ModelProvider` interface: Anthropic, OpenRouter, a local OpenAI-compatible server (Ollama, LM Studio), and a scripted mock (the default). No other external service. Credentials live in the git-ignored `.env`. |
| **Source of truth** | The append-only session log, `data/sessions/<session-id>.jsonl`. Everything else (state, transcripts, scores, reports) is derived from it. Scenarios are YAML in `scenarios/`. |
| **Delivery payload** | Live: events over WebSocket to the terminal client, the web client and the facilitator console. After the session: draft evaluation reports in `data/reports/<session>/`, moderated by the facilitator with `pnpm moderate`, then released per participant. |
| **Behavioral rules** | Section 3 below. |

## 2. Data schemas

The shapes are defined in code and validated at the boundary; this table says where. A schema change is a change to this file.

| Data | Defined in | Notes |
| --- | --- | --- |
| Session event (`session.started`, `scene.entered`, `utterance`, `facilitator.command`, `session.ended`, ...) | `packages/events/src/events.ts` | Zod schemas. The log header carries a `format` number; a newer format is refused, never guessed. Format 3 only for sessions with AI roles. |
| Session state | `packages/events/src/state.ts` | A pure reducer over the events. Players get allowlisted copies (`player-view.ts`), never the full state. |
| Scenario (roles, scenes, injects, exit conditions, rubrics) | `packages/script` | Validated on load; a SHA-256 of the loaded scenario is recorded in the log. |
| WebSocket protocol, join codes, facilitator token | `services/runtime/src/server` | Frames are size-limited and strictly validated. |
| Control-service IPC and API | `services/control/src/protocol.ts`, `api.ts` | The runtime and control copies of the IPC schema must stay identical (drift test). |
| Evaluation report (individual, group, index, method, review log) | `services/runtime/src/evaluator`, [EVALUATOR.md](docs/EVALUATOR.md) | Every score links to a quoted line; the calibration stamp is part of the report. |

Identifiers for planning artefacts (EPIC, US, TASK, AC, TC, BUG, L) are issued from [docs/ID_REGISTRY.md](docs/ID_REGISTRY.md) and never reused.

## 3. Behavioral rules

**Do Not**
- Do not put a hidden fact, an NPC's private knowledge, another role's whisper or a facilitator-only event in anything a participant can receive. Participant views are built by allowlist (pick fields, never spread).
- Do not let a model, a participant or a script write to the session log except through the engine.
- Do not use a canned or scripted line to cover a failed AI player turn: skip it and alert the facilitator.
- Do not score an AI player individually. AI players' lines count toward the group only when the facilitator's option says so, and always labelled as AI.
- Do not release, amend or withdraw a report, or record a self-assessment, response or dispute, unless the owner names the subjects and supplies the words ([AGENTS.md](AGENTS.md)).
- Do not merge a pull request with a failing or pending check, and do not skip a hook or force-push.
- Do not put a secret, a join code, a facilitator token or a player's display name in a log line, a prompt or a model request.

**Do**
- Show participants, in every client, which seats and lines belong to AI players.
- Get consent before a session starts; the consent notice version must name AI players when AI roles are used.
- Keep evaluation reports facilitator-only until released.
- Write the rollback note in [docs/ROLLBACK.md](docs/ROLLBACK.md) before a change that affects a deployed shape, and update [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) when a trust boundary moves.

## 4. Architectural invariants

1. **The log is the truth.** State is rebuilt from the log on every restart; every event is flushed (`fdatasync`) before anyone sees it; a write failure stops the server (fail-stop).
2. **One module owns each provider.** Only `packages/adapters` imports a provider SDK (`pnpm lint:sdk`). Tests and the default demo use the mock and never touch the network.
3. **Deterministic logic around probabilistic models.** Models draft, judge and play characters; code decides who sees what, what is allowed and what gets recorded.
4. **The browser never talks to the runtime.** The web app's server side (the BFF) does, with a sealed `HttpOnly` cookie for a seat; the control service holds the facilitator token and the AI players' join codes in memory only.
5. **Least privilege by default.** Reports use a default-deny `canView` policy; only the facilitator and `participant:<role>` resolve today.
6. **Sessions without AI roles are unchanged.** Their logs and reports stay byte-identical to the build before AI players existed (golden test).
7. **Time and randomness are injected** so tests are deterministic.
8. **Monorepo layout:** `packages/{events,script,adapters}`, `services/{runtime,control}`, `apps/web`; legacy PlanVisualizer tooling in `tools/` and `orchestrator/` with its own jest tests.

Design detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 5. User profile

Design for these people, not an abstract user ([Product spec](docs/PRODUCT_SPEC.md) section 2).

- **Facilitator** (the main user of the console): a programme lead, coach or team manager, comfortable with web tools but not with a terminal or a command line. Runs a 45-minute session with under 30 minutes of prep, often watching a live session while talking to the group. Needs to see at a glance who has joined and agreed, act with one click, and never be surprised by an irreversible action: destructive actions ask first and say who will see what.
- **Participant**: a team member, 3 to 8 per session, who joins from a link and a code on a laptop (a phone is possible). Not technical, possibly nervous, not a gamer. Needs a clear role brief, a visible timer, a say box that always works, and to know what is private to them. Joining must take under a minute.
- **Scenario author**: an L&D designer or subject-matter expert who writes YAML without engineering help (a studio is planned, not built).
- **Programme sponsor**: wants cohort-level trends and an audit trail (planned).

Reading level is plain business English. Any text a participant sees is fixed, short and says what to do next.

## 6. Design system

The tokens live in [apps/web/src/lib/tokens.css](apps/web/src/lib/tokens.css), which is the authority; new views use the tokens, not values copied from earlier views. EPIC-0007 will replace this minimal set with the full brand design system.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` page / `--panel`, `--panel2` surfaces | #eef0f2 / #ffffff, #f5f6f8 | #12171c / #1b222a, #222b35 |
| `--ink` text / `--muted` secondary text | #16202b / #5a6672 | #e6ebf0 / #97a3af |
| `--line` borders | #d5dae0 | #33404c |
| `--accent` (+ `-soft`, `-ink`) | #1f5f7a | #6bb6d3 |
| `--ok`, `--warn`, `--crit` (+ `-soft`) | #1d7a4d, #8a5100, #b3261e | #5fcf93, #e8b25a, #f08a82 |
| `--ai` (+ `-soft`): AI players only | #5b4aa0 | #b3a6ee |

- Fonts: the system font stack and the system mono stack only; no third-party fonts or resources. `--gutter: 16px`, `--radius: 8px`.
- Light and dark follow `prefers-color-scheme`; a page can force a theme with `data-theme` on `<html>`. Both must pass.
- AI is always shown in the `--ai` colour and with the words "AI player"; colour alone never carries meaning (status always has text).
- Accessibility is a gate: Axe checks at 400 px and 1280 px, light and dark, keyboard focus visible and focus moves to the result or error after an action.
- Reference implementations: the facilitator console (`apps/web/src/components/console/`) and the player page (`apps/web/src/components/session/`).

## 7. Maintenance log

Newest first. One line per release or operational event; the details are in [CHANGELOG.md](CHANGELOG.md) and [docs/ROLLBACK.md](docs/ROLLBACK.md).

| Date | Version | What | Rollback / notes |
| --- | --- | --- | --- |
| 2026-11-05 | v0.1.0 | First tagged release: runtime and terminal client, participant web client, control service and facilitator console, live AI players and the group-score option, evaluator and moderation tools. Merge commit 9779300 on `main`. | Nothing is deployed to a shared environment yet; see ROLLBACK.md. 3b and 3c (AI players) roll back together. |
| 2026-11-05 | (develop) | Code-scanning alerts 1 to 6 fixed in the sync tooling (#96); not in v0.1.0. | Reaches `main` with the next release. |

**Operating the service.** Run `./run.sh` (Docker) or `./run.sh --dev`; the facilitator console needs `pnpm control` and the web app in launcher mode ([README](README.md), sections 4 and 5). Session logs, join-code hashes and reports are on disk under `data/`: treat that directory like `.env` and delete logs you no longer need. Dependency audit at the start of each release cycle: `pnpm audit --prod`, logged in [findings.md](findings.md).
