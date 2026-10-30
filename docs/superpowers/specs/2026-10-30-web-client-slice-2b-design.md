# EPIC-0002 slice 2b: facilitator console, control service and AI players (design)

Date: 2026-10-30. Status: draft for owner review. Epic: EPIC-0002. Stories: US-0057 to US-0061 (AC-0300 to AC-0326). Parent design: `docs/superpowers/specs/2026-10-26-web-client-design.md` (sections 5.6, 5.7, 5.9, 6 and 7 describe 2b in outline). This document supersedes the parent where they differ; section 12 lists every difference. Slice 2a is merged (PRs #53 to #58) and closed out.

## 1. Purpose and success criteria

A facilitator runs a whole session from a browser with no terminal: signs in, creates a session, gets the room ready, runs the scene, steps in, and ends it. A player role that has no human can be filled by an AI player until the start.

Success means:

- A facilitator who knows only a URL and a secret can create a session and start it from the browser (US-0057, US-0058, US-0059).
- The browser never holds a runtime facilitator token, a join code after it was shown once, or a service token.
- A participant cookie never works on a console route and a facilitator cookie never works on a player route.
- An AI-filled role is labelled AI everywhere, is never scored individually, and never sees more than a human in that role would (US-0060, US-0061).
- Every runtime change passes the node:22 container recipe (`AGENTS.md` section 8) and the offline Web E2E job.

Out of scope: accounts, SSO and email (EPIC-0008), reports in the browser (slice 2c, US-0062 to US-0064), voice, 3D, the design system (EPIC-0007; 2b uses the minimal token file from 2a), terminal AI roles, and any multi-client work.

## 2. Decisions taken for 2b (owner, 2026-10-30)

| Decision | Choice |
|---|---|
| Decomposition | One design spec, three plans and PR stacks in order: **2b-1 Control plane** (US-0057, US-0058), **2b-2 Console** (US-0059), **2b-3 AI players** (US-0060, US-0061) |
| Finding a runtime | **Dual mode.** `LAUNCHER_URL` set: the BFF asks the control service which runtime serves a session id. Unset: today's single `RUNTIME_URL` behaviour, unchanged (used by 2a, `pnpm demo --web`, the terminal facilitator and the existing E2E specs). The console exists only in launcher mode |
| Facilitator name | Typed at login with the secret, sealed in the console cookie, recorded as an attested label on logged interventions (not proof of identity) |
| Process model | A separate control service, **one runtime process per session** |
| AI player turn-taking | **Reactive** policy, plus a facilitator **Prompt AI player** action that makes the bot respond now (section 8.3) |
| Remove a participant | One console action, **Remove**, always reissues that seat's code (two runtime primitives underneath) |

## 3. Slices and order

| Sub-slice | Stories | Usable result |
|---|---|---|
| 2b-1 Control plane | US-0057, US-0058 | Sign in, create a session, get its codes once, reissue codes. Facilitating is still done from a terminal client |
| 2b-2 Console | US-0059 | Run the whole session from the browser, remove a participant, end now |
| 2b-3 AI players | US-0060, US-0061 | Fill a role with an AI player; choose whether AI lines count in group scores |

Each has its own plan and PRs. 2b-2 needs 2b-1; 2b-3 needs 2b-2. 2c (reports) needs 2b-1 and 2b-2 and is not part of this spec.

## 4. Architecture

```
Browser --> BFF (apps/web) --loopback HTTP + service token--> Control service (services/control, new)
              |  sealed cookies: player | facilitator             |  fork() + IPC, one child per session, owns the session list
              |                                                    v
              +--- WebSocket per participant / per console ---> Runtime (127.0.0.1:port, one process per session)
```

| Unit | One job | Changes in 2b |
|---|---|---|
| Control service (`services/control`, new workspace package) | Create, supervise, resume and reissue codes for runtimes; run AI-player bots; later serve released reports | New |
| Runtime (`services/runtime`) | Run one session | `NO_DOTENV`, parent IPC channel, code reissue, `end_now`, `remove_participant`, `aiRoles` and the scoring option in `session.started`, a `by` label on facilitator commands, bot module extraction |
| BFF (`apps/web`) | Authenticate the browser, hold all tokens | Runtime lookup in dual mode, facilitator login and cookie, console API routes, a facilitator socket per console tab |
| Console pages (`/console/*`) | Presentation only | New, `noindex` |

Boundaries:

- The browser never talks to the control service or a runtime.
- Facilitator tokens exist only in memory, in the control service and the BFF. They are never written to disk and never sent to a browser.
- "The control service owns the data directory" means it creates and chooses the directory, owns the session list, and (in 2c) the review store and report-access files. Each runtime still writes its own event log, credentials, consent and codes files.

## 5. Control service and runtime protocol (2b-1)

### 5.1 Parent channel

The control service starts each runtime with `fork()`, so parent and child share one two-way IPC channel. This replaces the one-way dedicated file descriptor and the separate parent-pipe watch in the parent design with a single mechanism.

- **`ready` message, on every start (new or resumed):** `{ port, logIdentity, status, modelLabel, codes? }`. `codes` is present only when this start issued them. `modelLabel` is the fixed provider label from `describeModelProvider` (never an endpoint or key).
- The IPC sender plugs into the existing `showJoinCodes` hook in `bootstrap`, so the current rule holds: if delivery fails the start aborts and the issued codes are withdrawn. Codes never go through the log channel.
- **Parent gone:** on `disconnect` the runtime stops and exits, so a control-service crash or restart leaves no orphan holding a session lock.
- **Reissue:** the parent sends `{ reissue, roleId }`; the runtime replies `{ reissued, roleId, code }`. It revokes that role's credential, closes that role's socket with a distinct code, builds a new `JoinCodes` with a new code for that role (a new `withRole(roleId)` method on the immutable class), writes it with the existing atomic `writeJoinCodesFile` (the session lock check runs before commit), and replaces the instance in the server's code map. Only the parent can call it, so no new network surface exists. A whole-session reissue stays "stop, move the codes file aside, start again".
- Runtimes standalone (terminal) have no IPC channel; `process.send` is absent and none of this runs.
- **`NO_DOTENV=1`** skips the `<root>/.env` merge in `bootstrap` for control-service runtimes. A non-empty `FACILITATOR_TOKEN` in the environment already wins over `.env`.

The control service sets every lifecycle and security variable explicitly: `SESSION_ID`, `SESSION_START`, `SCENARIO_DIR`, `RUNTIME_HOST=127.0.0.1` (the default is `0.0.0.0`), `RUNTIME_PORT=0`, `TRUST_PROXY=1`, the connection caps, `FACILITATOR_TOKEN` (a fresh 32-byte random value per start), `NO_DOTENV=1`, and no `GM_TRACE_FILE`.

### 5.2 Control service API

Loopback only, service token header, callable only by the BFF. Bodies are validated; errors use the same envelope as the BFF.

| Route | Behaviour |
|---|---|
| `POST /sessions { scenarioId }` | `scenarioId` must be in an allowlist built from the scenarios folder and pass the existing loader. Capped by `MAX_SESSIONS` (default 10, live sessions only). Generates an unguessable session id that satisfies `isValidSessionId`. Returns `{ sessionId, status, port, modelLabel, codes }` once |
| `GET /sessions`, `GET /sessions/:id` | `{ sessionId, scenarioId, status, port }`; status is `running`, `stopped` or `ended` |
| `GET /sessions/:id/facilitator` | The runtime's facilitator token, for the BFF only |
| `POST /sessions/:id/codes/reissue { roleId? }` | Per role via IPC, or the whole session by restart. Returns the new codes once |
| `POST /sessions/:id/restart` | Resume a `stopped` session from its log, paused, with a fresh token |
| `POST /sessions/:id/ai-roles` | 2b-3 (section 8) |

### 5.3 Lifecycle

- **Session list:** `sessions.json` holds `sessionId, scenarioId, status` only. It is written atomically, mode 0600, with the existing `secure-json-file` helper.
- **Start up:** the service resumes every non-ended session paused, with fresh tokens. It never relaunches an ended session.
- **Crash:** a child that exits unexpectedly becomes `stopped`. **Restart is manual only**; there is no auto-restart, so a bad scenario or a lost lock cannot loop.
- **Ended sessions:** after `session.ended` the child is stopped after a grace period. An ended session does not count against `MAX_SESSIONS`. The control service later serves released reports without a runtime (2c, AC-0329).
- **Logs:** each child's stdout and stderr go to a per-session log file in the control service's directory. Codes travel only over IPC, so these logs need no redaction.
- **Secret handling:** the session-id-to-port mapping lives in the control service and BFF, never in a cookie.

## 6. Facilitator login and BFF (2b-1)

- `POST /api/v1/console/login { secret, name }` compares the secret in constant time against `FACILITATOR_SECRET`, is throttled per address and fails closed when saturated, and sets a sealed cookie (`__Host-scenecoach-fac`) with a different audience tag from the player cookie. `name` is cleaned and limited like a display name.
- The console is disabled with a loud message when `FACILITATOR_SECRET` or `LAUNCHER_URL` is unset.
- All `/console` pages and `/api/v1/console/*` routes send `noindex, nofollow` and are disallowed in `robots.txt`.
- State-changing console requests check `Origin` and a custom header, as the player routes do.
- New environment variables (documented in `.env.example`, `MEMORY.md` and the README): `FACILITATOR_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN`, `MAX_SESSIONS`, and the control service's own settings.

## 7. Console (2b-2)

### 7.1 Channel

The BFF opens one `join_facilitator` WebSocket per console tab, using the token it fetched from the control service, and forwards frames as SSE with the seq as id and `Last-Event-ID` replay, as for players. Commands go through `POST /api/v1/console/command`. Co-facilitators each have their own socket; the existing `expectSceneId` guards protect against conflicting clicks.

### 7.2 Facilitator name

`facilitator.command` events gain an optional `by` field (cleaned, at most 60 code points). The BFF attests it on the `command` client message. Terminal facilitators send none. The threat model states that `by` is a label, not proof of identity.

### 7.3 Pages

| Page | Purpose |
|---|---|
| `/console` | Login (secret and name); then the session list with Create, Open, and Restart for `stopped` sessions |
| `/console/new` | Pick an allowlisted scenario; the response shows the codes once, with a warning that they cannot be shown again |
| `/console/[id]` | One state-driven page. **Before the start:** the readiness view (roster with joined, consented and connected, `modelLabel`, per-role reissue, Start disabled until the start gate is met). **After the start:** the live view (scene status and timers, the transcript with Game Master notices and alerts, talk time, and controls) |

The runtime remains the authority on the start gate. The console reads the roster to explain why Start is disabled; the runtime refuses an early `start` exactly as today.

### 7.4 Controls

pause, resume, advance, inject, whisper, release hidden fact (including one click on a Game Master suggestion), NPC stance, end now. Irreversible or audience-affecting actions use one confirmation that names the subject and the audience (for example "Release fact 2 of Dana to everyone in the room").

### 7.5 New runtime commands

- **`end_now { message? }`** appends `session.ended` with reason `facilitator_end` and a new optional participant-visible `message` (capped, rendered as text), stops the scene clock and the Game Master. The engine, fold, player-view policy and docs all handle the new case.
- **`remove_participant { roleId }`**, before the start only: revokes the credential, closes the socket with a distinct code, clears consent and frees the seat. The removed person sees "the facilitator removed you". The console's **Remove** action calls this and then the reissue primitive in one step, so a replacement can take the seat.

### 7.6 Rendering and accessibility

All transcript, name, alert and message text is untrusted and rendered as text under the nonce CSP. The layout works at laptop width. The transcript is a polite live region, focus order and labels are checked with Axe in the Playwright run.

## 8. AI-filled player roles (2b-3)

### 8.1 Why this is more than moving a file

The existing `PlayerBotGenerator.speak()` rewrites a scripted line slot: the scripted text is used as a private intent and the run supplies the timing. A live AI player has no script. A new component decides when to speak and what to intend.

### 8.2 Shared bot module

`services/runtime/src/players/` (exported as a subpath so the demo and the control service both import it) holds the generator, prompt builder, line cleaning and the new `TurnPolicy`. Extraction also removes the bot's dependency on `demo/showcase-script` (`MAX_LINE_CHARS` moves to the module). The demo keeps working through the same module. The bot has its own `PLAYER_MODEL` and `PLAYER_TEMPERATURE`, falling back to the NPC model.

### 8.3 Turn policy (reactive)

The bot speaks when an NPC addresses its role or the previous speaker finishes, or after a quiet-time nudge. It respects a minimum gap between its lines and a per-scene line cap. The intent comes from the role's brief and the scene goal. A model failure, timeout or empty reply **skips the turn and raises a facilitator alert** ("AI player <role> could not speak"); it never speaks a canned line. Every model call has a hard timeout and its own error handling, because bots run inside the control service for the local stage (moving them to child processes later is a small change behind the shared module).

### 8.3a Facilitator prompt

The live view offers **Prompt AI player** on each AI-filled role. It makes that bot respond now, without waiting for the policy.

- **Behaviour.** The prompt skips the quiet-time nudge and the minimum gap, and does not count against the per-scene line cap (the facilitator asked for the line). It still uses the same model call, the same cleaning and the same hard timeout, and the result is an ordinary utterance labelled AI.
- **Optional hint.** The facilitator may add a short steer, at most 300 characters, for example "push back on the deadline". The hint is added to that turn's private intent only. It is untrusted text: it is cleaned like other input, never shown to participants, and appears in the facilitator-only intent log.
- **Audit.** A new facilitator command `prompt_ai { roleId, hint? }` is accepted by the runtime and logged as a facilitator-only `facilitator.command` carrying `by`. It changes no session state. The runtime refuses it unless the role is AI-filled and the session is running (not paused, not ended, not before the start).
- **Order.** The BFF sends the runtime command first and, only when that succeeds, asks the control service to trigger the bot (`POST /sessions/:id/ai-roles/:roleId/prompt`). If logging fails, nothing runs. If the trigger fails after logging, the facilitator sees an alert and may retry.
- **Limits.** At most one prompt or policy turn is in flight per bot; a prompt during an in-flight turn is refused with a plain message. The control service also applies a short per-bot debounce so a double click cannot produce two lines.
- **Failure.** As for the policy: the turn is skipped and a facilitator alert is raised; no canned line is spoken.

### 8.4 Mechanism and marking

- The control service starts a bot per AI-filled role, connected as an ordinary player with its own credential. The bot sees only that role's player view.
- The toggle is available from creation until the start. Switching a joined human to AI asks for confirmation, revokes that person's credential and consent and tells them "the facilitator has filled this role". Switching back stops the bot, revokes its credential and issues a new code, shown once.
- `session.started` records `aiRoles` and the group-score option. The display name becomes "AI player" plus the role title. The console, transcript, roster, reports and exports label the role AI; no frame shows an AI line unlabelled.
- AI roles skip consent. The start gate counts human seats and connected bots separately. The consent notice says some roles may be played by an AI.
- The bot's intent log is facilitator-only and never reaches a participant stream.
- An AI-filled role gets no individual report, no report-access credential and no self-assessment; its report index row reads "AI player, not scored".

### 8.5 Group-score option and evaluator

- **Include AI players in group scores** defaults to on, can change until the start, and is recorded in `session.started`.
- On: the group rubric treats AI lines as team evidence, labelled AI in quoted evidence. Off: AI lines are context only, as AI character lines are today. Individual criteria never score an AI player.
- This changes the evaluator's evidence rule, so it has its own independent review and tests for both settings (AC-0326).
- Reports that include AI players carry a calibration caveat. US-0039 (the calibration stamp) is still Planned, so 2b-3 ships a standalone caveat line and US-0039 absorbs it later. The plan confirms how much of the stamp already exists in `evaluator/report-model.ts` and `calibration/stamp.ts`.

## 9. Security and privacy

Threat-model additions (to `docs/THREAT_MODEL.md`): the control service as a trust boundary and its loopback service token; the IPC channel (parent-only reissue); the facilitator cookie and shared-secret login; the attested facilitator name; the BFF holding every live facilitator token (accepted at the local stage because the BFF already holds all participant credentials); AI labelling; the bot's player-view-only access; the control service's log files.

- A participant cookie is rejected on every `/console` route and a facilitator cookie on every player route.
- Participant streams still reuse the runtime's default-deny `viewFor`. The leak scan is extended: no participant frame may carry facilitator-only events, the bot intent log, codes or tokens.
- Console login: constant-time secret comparison, per-address throttle, neutral refusal message.

## 10. Errors

- Control service unreachable: the console shows a reconnecting banner with backoff (injected clock in tests); the player routes in single-runtime mode are unaffected.
- A child crash shows `stopped` with Restart. A failed create returns a neutral message and leaves no half-created session (the session list entry and files are rolled back).
- Bot failures are alerts, never canned speech. No stack traces, paths, ports or internal ids reach the browser.

## 11. Testing and rollout

- Unit and contract tests for each unit above, with the mock provider so everything runs offline and deterministically. Coverage stays at or above the repository thresholds.
- Runtime changes (`main.ts`, IPC, reissue, `end_now`, `remove_participant`) are written test first and run through the node:22 container recipe, as root and as `node`.
- The Web E2E job gains a launcher-mode run covering login, create, join, consent, start, intervene, remove, end, and an AI seat. `pnpm demo --web` gains console checks.
- Explicit tests for the prompt action: logged before the bot runs; refused for a human role, a paused, ended or not-yet-started session; hint length and cleaning; one turn in flight; the hint never reaches a participant stream.
- Explicit tests: the evaluator on a log that ended early with `facilitator_end`; both group-score settings; cookie separation in both directions; the extended leak scan; the IPC reissue revoking the old credential.
- The plan begins with a short spike confirming that `fork()` works under `tsx` in this repository.
- `docs/ROLLBACK.md` gains a note for the new optional event fields (`by`, `message`, `aiRoles`, the scoring option). The plan decides whether they require log format 3, as 2a's changes required format 2.
- Each PR adds its user-visible change to `CHANGELOG.md` under `[Unreleased]`.

## 12. Differences from the parent design and story wording

To be applied when the plan files the acceptance criteria (new ids come from `docs/ID_REGISTRY.md` at that time):

| Item | Change |
|---|---|
| AC-0305 to AC-0307 | "dedicated file descriptor" and "parent pipe" become the `fork()` IPC channel and `disconnect` |
| AC-0306 | Add `modelLabel` to the `ready` message |
| AC-0308 | Per-role reissue is an IPC call; a joined person removed by the facilitator gets the combined Remove action |
| AC-0309 | Reworded as in the boundaries in section 4 |
| AC-0310 | The model status comes from `modelLabel` |
| AC-0312 | The name is the login-typed label carried as `by` |
| AC-0319 | Add the new `TurnPolicy` as its own criterion; the bot module is more than a move |
| New | Manual restart only; ended sessions stop and free their slot; per-session child log files; a bot failure skips the turn and alerts |
| New | Facilitator **Prompt AI player** with an optional hint, logged as `prompt_ai` (section 8.3a); it is a 2b-3 criterion with tests for refusal when paused, ended, not started or not an AI role |

## 13. Open items for the plan

1. Confirm `fork()` under `tsx` (spike, first task).
2. Confirm the runtime allows more than one facilitator connection per session, and the cap that applies.
3. Confirm the talk-time projection used by the live view already exists, or add it.
4. Decide whether the new optional event fields need log format 3.
5. Confirm how much of the calibration stamp exists (section 8.5).
6. Choose the subpath-export mechanism for `players/` (package `exports` map).
