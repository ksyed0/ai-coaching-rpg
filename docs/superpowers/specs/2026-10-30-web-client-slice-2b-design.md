# EPIC-0002 slice 2b: facilitator console, control service and AI players (design)

Date: 2026-10-30. Status: draft for owner review, revised after an independent Opus review against the code (section 14). Epic: EPIC-0002. Stories: US-0057 to US-0061 (AC-0300 to AC-0326). Parent design: `docs/superpowers/specs/2026-10-26-web-client-design.md` (sections 5.6, 5.7, 5.9, 6 and 7 describe 2b in outline). This document supersedes the parent where they differ; section 12 lists the differences. Slice 2a is merged (PRs #53 to #58) and closed out.

## 1. Purpose and success criteria

A facilitator runs a whole session from a browser with no terminal: signs in, creates a session, gets the room ready, runs the scene, steps in, and ends it. A player role that has no human can be filled by an AI player until the start.

Success means:

- A facilitator who knows only a URL and a secret can create a session and start it from the browser (US-0057, US-0058, US-0059).
- The browser never holds a runtime facilitator token, a join code after it was shown once, or a service token.
- A participant cookie never works on a console route and a facilitator cookie never works on a player route.
- An AI-filled role is labelled AI everywhere, is never scored individually, and sees no more than a human in that role would (US-0060, US-0061).
- Nothing the facilitator does reaches a participant unless it is meant to: the facilitator's name, the bot's intent and the prompt hint stay facilitator-only.
- Every runtime change passes the node:22 container recipe (`AGENTS.md` section 8) and the offline Web E2E job.

Out of scope: accounts, SSO and email (EPIC-0008), reports in the browser (slice 2c, US-0062 to US-0064), voice, 3D, the design system (EPIC-0007; 2b uses the minimal token file from 2a), terminal AI roles, and multi-client work.

## 2. Decisions taken for 2b (owner, 2026-10-30)

| Decision | Choice |
|---|---|
| Decomposition | One design spec, three plans and PR stacks in order: **2b-1 Control plane and readiness** (US-0057, US-0058 and the readiness half of US-0059), **2b-2 Live console** (rest of US-0059), **2b-3 AI players** (US-0060, US-0061) |
| Finding a runtime | **Dual mode.** `LAUNCHER_URL` set: the BFF asks the control service which runtime serves a session id. Unset: today's single `RUNTIME_URL` behaviour, unchanged (used by 2a, `pnpm demo --web`, the terminal facilitator and the existing E2E specs). The console exists only in launcher mode |
| Facilitator name | Typed at login with the secret, sealed in the console cookie, recorded as an attested label on logged interventions (not proof of identity) and never shown to participants |
| Process model | A separate control service, **one runtime process per session** |
| AI player turn-taking | **Reactive** policy, plus a facilitator **Prompt AI player** action that makes the bot respond now (section 8.3) |
| Remove a participant | One console action, **Remove**, always reissues that seat's code (two runtime primitives underneath) |
| Reissue after the start | **Rebinds the seat's existing consent** to the new participant, recorded with the facilitator's name, so a player who lost their cookie can return mid-session (section 5.4) |
| Making 2b-1 usable | 2b-1 includes a minimal `/console/[id]` readiness page (roster, codes once, model label, Start), so the control plane is usable and testable end to end on its own |

## 3. Slices and order

| Sub-slice | Stories | Usable result |
|---|---|---|
| 2b-1 Control plane and readiness | US-0057, US-0058, AC-0310 | Sign in, create a session, see who has joined and consented, get codes once, reissue, press Start. After Start the scene runs on its script and the Game Master; pause, inject, whisper and the rest arrive in 2b-2 (a terminal facilitator cannot attach to a control-service runtime, because its token is never shown) |
| 2b-2 Live console | US-0059 (AC-0311 to AC-0316) | Run the whole session from the browser: live view, interventions, remove a participant, end now |
| 2b-3 AI players | US-0060, US-0061 | Fill a role with an AI player, prompt it, choose whether AI lines count in group scores |

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
| Runtime (`services/runtime`) | Run one session | Managed mode with `NO_DOTENV`, the parent IPC channel, a server handle that can swap codes and kick a role, `end_now`, `remove_participant`, `prompt_ai`, AI-role state, `aiRoles` and the scoring option in `session.started`, a `by` label on facilitator commands, bot module extraction |
| BFF (`apps/web`) | Authenticate the browser, hold all tokens | Runtime lookup in dual mode, facilitator login and cookie, console API routes, a facilitator socket per console tab |
| Console pages (`/console/*`) | Presentation only | New, `noindex` |

Boundaries:

- The browser never talks to the control service or a runtime.
- Facilitator tokens exist only in memory, in the control service and the BFF. They are never written to disk and never sent to a browser.
- "The control service owns the data directory" means it creates and chooses the directory, owns the session list, and (in 2c) the review store and report-access files. Each runtime still writes its own event log, credentials, consent and codes files.

## 5. Control service and runtime protocol (2b-1)

### 5.1 Managed mode and the parent channel

The control service starts each runtime with `fork()`, giving one two-way IPC channel. This replaces the one-way dedicated file descriptor and the separate parent-pipe watch in the parent design. A runtime started without an IPC channel (the terminal) behaves exactly as today.

**Two messages, not one.** The codes and the port are not available at the same moment, and the codes hook is synchronous.

- `codes`: sent from the existing `showJoinCodes` hook in `bootstrap`, only when this start issued codes. `process.send` is asynchronous, so the hook uses a synchronous send path and counts a throw or a `false` return as failure, which aborts the start and withdraws the codes exactly as today. A parent crash after a successful send loses codes; the recovery is a reissue.
- `ready`: sent after `bootstrap` has the port: `{ port, logIdentity, status, modelLabel }`. `modelLabel` is the fixed provider label from `describeModelProvider` (never an endpoint or key).
- `ended`: sent when the session records `session.ended`. The control service persists `ended` in the session list at once (section 5.3).

**Managed mode** (set by the control service on the child; implies `NO_DOTENV=1`):

- `.env` is not read.
- On an empty log, the existing codes, seats and consent are kept. Today an empty-log start discards them (`engine/session-store.ts`, `settleCodes(false, false)`), which would wipe a lobby when the control service restarts.
- On an ended log, the start is refused with a clear error. It never rotates the log aside and starts a new session under the same id, because 2c needs the ended log.
- A parent `disconnect` stops the runtime and exits, so a control-service crash or restart leaves no orphan holding a session lock.

**Child environment.** The control service builds the child environment from an allowlist (`PATH`, `NODE_*`, and the provider keys and NPC and Game Master settings the control service itself holds, loaded from its own `.env`), because `fork()` otherwise inherits everything and `NO_DOTENV` removes the file. It sets `SESSION_ID`, `SESSION_START`, `SCENARIO_DIR`, `RUNTIME_HOST=127.0.0.1` (the default is `0.0.0.0`), `RUNTIME_PORT=0`, `TRUST_PROXY=1`, the connection caps, and `FACILITATOR_TOKEN`, and never `GM_TRACE_FILE`. The token is 32 random bytes encoded as hex (64 characters), which satisfies the runtime's printable 16 to 256 character rule.

**Server handle.** `startServer` today returns only `{ port, close }`. It returns a handle that also exposes `replaceCodes(joinCodes)` and `kickRole(roleId, closeCode)`, and re-broadcasts the roster.

### 5.2 Reissue

The parent sends `{ reissue, roleId }`; the runtime replies `{ reissued, roleId, code }`. A code opens only a role that has no credential, so the order is fixed:

1. Revoke the role's credential and persist the seats.
2. Kick the role's socket with a distinct close code.
3. Build a new `JoinCodes` with a new code for that role (a new `withRole(roleId)` method on the immutable class, reusing the salt) and write it with the existing atomic `writeJoinCodesFile`; the session lock check runs before commit.
4. Swap the instance in via `replaceCodes`.
5. Broadcast the roster and reply with the code.

Only the parent can call it, so no network surface is added. A whole-session reissue (control service only, before the start) stops the child, moves the codes file aside and starts it again; managed mode keeps codes only when the file is present, so this issues a full new set. It is a deliberate, confirmed console action that also clears every seat's credential and consent.

### 5.3 Control service API

Loopback only, service token header, callable only by the BFF. Bodies are validated; errors use the BFF's envelope.

| Route | Behaviour |
|---|---|
| `POST /sessions { scenarioId }` | `scenarioId` must be in an allowlist built from the scenarios folder and pass the existing loader. Capped by `MAX_SESSIONS` (default 10, live sessions only). Generates an unguessable session id that satisfies `isValidSessionId`. Returns `{ sessionId, status, port, modelLabel, codes }` once |
| `GET /scenarios` | `[{ id, title }]` from the allowlist, for the New session screen |
| `GET /sessions`, `GET /sessions/:id` | `{ sessionId, scenarioId, status, port, modelLabel }`; status is `running`, `stopped` or `ended` |
| `GET /sessions/:id/facilitator` | `{ port, token }` together, for the BFF only |
| `POST /sessions/:id/codes/reissue { roleId }` | Per role through the IPC call above; returns the new code once |
| `POST /sessions/:id/restart` | Resume a `stopped` session from its log, paused, with a fresh token. Refused for `ended` |

2b-3 adds the AI-role and prompt routes (sections 8.4 and 8.3a).

### 5.4 Reissue after the start

After the start the runtime refuses anyone whose participant id has no consent on record, and consent cannot be given after the start. The BFF mints a new participant id on every join, so a plain reissue would never readmit a lost-cookie player. Therefore a reissue after the start also **rebinds that seat's existing consent to the next participant who joins with the new code**. The rebind is recorded in the consent file with the facilitator's name and time and appears as a facilitator-only alert ("consent for <role> rebound after a code reissue by <name>"). The person is shown the consent notice read-only on joining. A reissue before the start clears the seat's consent instead, so the person consents again, as in 2a.

### 5.5 Lifecycle

- **Session list:** `sessions.json` holds `sessionId, scenarioId, status` only. It is written atomically, mode 0600, with the existing `secure-json-file` helper. The status becomes `ended` the moment the `ended` IPC message arrives.
- **Start up:** the service first checks each listed session's log tail with a lock-free read (so a crash that happened after `session.ended` still counts as ended), then resumes every non-ended session paused, with fresh tokens. It waits for any previous child of that session to exit before resuming, because an old child still draining holds the session lock.
- **Crash:** a child that exits unexpectedly becomes `stopped`. **Restart is manual only**; there is no auto-restart, so a bad scenario or a lost lock cannot loop.
- **Ended sessions:** after the `ended` message the child is stopped after a grace period. An ended session does not count against `MAX_SESSIONS`. The control service later serves released reports without a runtime (2c, AC-0329).
- **Logs:** each child's stdout and stderr go to a per-session log file in the control service's directory. Codes travel only over IPC, so these logs need no redaction.
- The session-id-to-port mapping lives in the control service and BFF, never in a cookie.

## 6. Facilitator login and BFF (2b-1)

- `POST /api/v1/console/login { secret, name }` checks `Origin` (login CSRF), compares the secret in constant time against `FACILITATOR_SECRET`, is throttled per address and fails closed when saturated, and sets a sealed cookie (`__Host-scenecoach-fac`). `name` is cleaned and limited like a display name.
- **Cookie separation is built, not assumed.** Today the player cookie has no audience: the seal's additional authenticated data is the key id only and the player check is by shape. The facilitator cookie binds its purpose into the authenticated data, and each route family accepts only its own purpose. Player cookie format is unchanged.
- **Rotating `FACILITATOR_SECRET` invalidates issued cookies:** the cookie carries a short epoch value derived from the secret, and a mismatch is treated as signed out.
- The console is disabled with a loud message when `FACILITATOR_SECRET` or `LAUNCHER_URL` is unset.
- All `/console` pages and `/api/v1/console/*` routes send `noindex, nofollow` and are disallowed in `robots.txt`. State-changing console requests check `Origin` and a custom header.
- **Facilitator sockets.** The BFF fetches `{ port, token }` together, never retries a refused token blindly (it fetches a fresh pair once), and does not forward `X-Forwarded-For` on facilitator sockets. Refused facilitator joins are charged to one shared scope in the runtime, so a stale token from a facilitator's address could otherwise block every upgrade from that address.
- New environment variables (in `.env.example`, `MEMORY.md` and the README): `FACILITATOR_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN`, `MAX_SESSIONS`, and the control service's own settings.

### 6.1 Readiness page (2b-1)

`/console` lists sessions with Create, Open and Restart for `stopped` sessions. `/console/new` picks an allowlisted scenario and shows the codes once with a warning. `/console/[id]` before the start shows the roster (joined, consented, connected), `modelLabel`, per-role reissue, and **Start**, disabled until the start gate is met. The runtime remains the authority on the gate; the console reads the roster only to explain why Start is disabled, and a stale tab cannot start a session early.

## 7. Live console (2b-2)

### 7.1 Channel

The BFF opens one `join_facilitator` WebSocket per console tab, using the token it fetched, and forwards frames as SSE with the seq as id and `Last-Event-ID` replay, as for players. Commands go through `POST /api/v1/console/command`. Several facilitators are allowed (`docs/THREAT_MODEL.md`); they share the runtime's connection cap (`WS_MAX_CONNECTIONS`, default 32) and per-address limit (8) with players and bots, so the control service sets the caps explicitly. The existing `expectSceneId` guards protect against conflicting clicks.

### 7.2 Facilitator name

`facilitator.command` events gain an optional `by` field (cleaned, at most 60 code points), attested by the BFF on the `command` message. Terminal facilitators send none. `by` is a label, not proof of identity; the threat model says so.

`viewFor` currently passes `pause` and `resume` commands to players whole, and `snapshotFor` copies session state by spread. Both change to **allowlisted player copies**: `by` is stripped from every command a player sees, and a new session-state field reaches players only if it is listed. The leak scan covers `by`.

### 7.3 Live view

Scene status and timers, the transcript with Game Master notices and alerts, talk time, and controls. Talk time has no live projection today (only the evaluator computes it), so 2b-2 adds one, derived from `utterance` events.

Controls: pause, resume, advance, inject, whisper, release hidden fact (including one click on a Game Master suggestion), NPC stance, end now. Irreversible or audience-affecting actions use one confirmation that names the subject and the audience (for example "Release fact 2 of Dana to everyone in the room").

### 7.4 New runtime messages

The current server runs `if (status === "idle") await host.start()` before every `command` (`host/ws-server.ts`). Any new FacilitatorCommand sent in the lobby would therefore start the session or fail with `seats_not_ready`. So **`remove_participant`, `end_now` and `prompt_ai` are new facilitator client messages, not FacilitatorCommands**, handled in the server and host, and they never trigger the auto-start.

- **`end_now { message? }`:** allowed only when the session has started. It appends the closing events for the open scene, then `session.ended` with reason `facilitator_end` and a new optional participant-visible `message` (capped, rendered as text), stops the scene clock and the Game Master, and appends a facilitator-only alert naming who ended it. The exact event sequence (including what `scene.exited` records for an interrupted scene) is fixed in the plan after reading the event schema, and the evaluator's transcript of such a log is tested.
- **`remove_participant { roleId }`:** before the start only. Revokes the credential, closes the socket with a distinct code, clears consent and frees the seat. The removed person sees "the facilitator removed you". The console's **Remove** calls this and then the reissue primitive in one step.
- **`prompt_ai`:** section 8.3a.

### 7.5 Rendering and accessibility

All transcript, name, alert and message text is untrusted and rendered as text under the nonce CSP. The layout works at laptop width. The transcript is a polite live region, and focus order and labels are checked with Axe in the Playwright run.

## 8. AI-filled player roles (2b-3)

### 8.1 Why this is more than moving a file

The existing `PlayerBotGenerator.speak()` rewrites a scripted line slot: the scripted text is used as a private intent and the run supplies the timing. A live AI player has no script. A new component decides when to speak and what to intend.

### 8.2 Shared bot module

`services/runtime/src/players/` (exported as a subpath so the demo and the control service both import it) holds the generator, prompt builder, line cleaning and the new `TurnPolicy`. Extraction removes the bot's dependency on `demo/showcase-script` (`MAX_LINE_CHARS` moves to the module). The demo keeps working through the same module. The bot has its own `PLAYER_MODEL` and `PLAYER_TEMPERATURE`, falling back to the NPC model.

### 8.3 Turn policy (reactive)

The bot speaks when an NPC or a human addresses its role or finishes speaking, or after a quiet-time nudge. It **does not react to another AI player's line**, so two AI roles cannot sustain a loop. It respects a minimum gap and a per-scene line cap. The intent comes from the role's brief and the scene goal. A model failure, timeout or empty reply **skips the turn and raises a facilitator alert**; it never speaks a canned line. Every call has a hard timeout and its own error handling, because bots run inside the control service for the local stage (moving them to child processes later is a small change behind the shared module).

**Spend.** Each bot line triggers an NPC round and a Game Master tick, so bot calls have a per-session budget (a setting, with a default), and prompts count against it. **A session cannot be started with no human player seated.**

### 8.3a Facilitator prompt

The live view offers **Prompt AI player** on each AI-filled role. It makes that bot respond now, without waiting for the policy.

- **Behaviour.** It skips the quiet-time nudge, the minimum gap and the per-scene cap (the facilitator asked for the line). The same model call, cleaning and timeout apply, and the result is an ordinary utterance labelled AI.
- **Optional hint.** A short steer, at most 300 characters, for example "push back on the deadline". It is added to that turn's private intent only. It is untrusted text: cleaned like other input, never shown to participants, and written only to the facilitator-only intent log.
- **Order, to avoid double audit entries.** (1) the BFF asks the control service to **reserve** the bot's turn (refused if a turn is in flight or inside a short debounce; the reservation expires after 10 seconds); (2) the BFF sends the runtime `prompt_ai { roleId, hint? }`, which is refused unless the role is AI-filled and the session is running (not paused, not ended, not before the start) and which is logged as a facilitator-only `facilitator.command` carrying `by`; (3) only on success the BFF asks the control service to **run** the reserved turn. If logging fails, nothing runs. If the run fails after logging, the facilitator sees an alert and may retry.

### 8.4 Mechanism, durability and marking

- **AI-role state lives in the runtime.** A new IPC message `set_ai_roles { roles, includeInGroup }`, valid before the start only, is persisted by the runtime with the seat files, so a resume keeps it. The runtime uses it for the start gate (AI roles skip consent and need a connected bot; humans need to be joined and consented), for post-start joins, and to write `aiRoles` and the scoring option into `session.started`.
- **Bots join like players.** The control service gets a code for each AI role and the bot joins with it. Bot credentials are held in the control service's memory. After a control-service restart, a running session's bots obtain fresh codes through the same private IPC reissue (AI roles need no consent, so reissue works after the start) and rejoin.
- **Bot alerts.** Only the engine can append `facilitator.alert`, so the control service sends an IPC `bot_alert { roleId, message }` that the runtime appends.
- **Intent log.** The control service keeps each bot's intent log (and prompt hints) in a facilitator-only file and serves it to the console through the BFF (`GET /sessions/:id/ai-roles/:roleId/intents`). It never reaches a participant stream.
- **Marking.** The label is derived from `aiRoles`: the display name becomes "AI player" plus the role title, and the prefix "AI player" is reserved so a human cannot choose it. The console, transcript, roster, reports and exports label the role AI; no frame shows an AI line unlabelled.
- **Toggle.** Available from creation until the start. Switching a joined human to AI asks for confirmation, revokes that person's credential and consent and tells them "the facilitator has filled this role". Switching back stops the bot, revokes its credential and issues a new code, shown once.
- **Consent notice.** The notice gains a sentence that some roles may be played by an AI, which is a new `CONSENT_NOTICE_VERSION`; consent held under the old version is dropped on read, so this applies to sessions created after the change.
- **Reports.** An AI-filled role gets no individual report, no report-access credential and no self-assessment; its report index row reads "AI player, not scored".

### 8.5 Group-score option and evaluator

- **Include AI players in group scores** defaults to on, can change until the start, and is recorded in `session.started`.
- On: the group rubric treats AI lines as team evidence, labelled AI in quoted evidence. Off: AI lines are context only, as AI character lines are today. Individual criteria never score an AI player (the evaluator currently scores every player role in the scenario, so it must exclude `aiRoles`).
- This changes the evaluator's evidence rule, so it has its own independent review and tests for both settings (AC-0326).
- US-0039 (the calibration stamp) is Complete and wired into the report model. A report that includes AI players carries its caveat through the existing stamp (`stampLine` and `StampState`), stating that the case is not covered by the calibration baseline. No standalone line is added.

## 9. Security and privacy

Threat-model additions (`docs/THREAT_MODEL.md`): the control service as a trust boundary and its loopback service token; the IPC channel (parent-only reissue); the facilitator cookie, its purpose-bound seal and the shared-secret login; the attested facilitator name; the BFF holding every live facilitator token (accepted at the local stage because the BFF already holds all participant credentials); consent rebound on a post-start reissue (a facilitator-attested admission); AI labelling and the reserved prefix; the bot's player-view-only access; prompt hint and display names as untrusted prompt input; the control service's log files and intent logs.

- A participant cookie is rejected on every `/console` route and a facilitator cookie on every player route.
- Participant streams use allowlisted player copies (section 7.2). The leak scan covers facilitator-only events, the bot intent log, prompt hints, `by`, codes and tokens.
- Console login: constant-time comparison, per-address throttle, neutral refusal message, `Origin` check.

## 10. Errors

- Control service unreachable: the console shows a reconnecting banner with backoff (injected clock in tests); player routes in single-runtime mode are unaffected.
- A child crash shows `stopped` with Restart. A failed create returns a neutral message and leaves no half-created session (the session list entry and files are rolled back).
- Bot failures are alerts, never canned speech. No stack traces, paths, ports or internal ids reach the browser.

## 11. Testing and rollout

- Unit and contract tests for each unit above, with the mock provider so everything runs offline and deterministically. Coverage stays at or above the repository thresholds.
- Runtime changes (managed mode, IPC, reissue, the server handle, the new messages) are written test first and run through the node:22 container recipe, as root and as `node`.
- The plan begins with a short spike confirming that `fork()` works under `tsx` in this repository.
- The Web E2E job gains a launcher-mode run covering login, create, join, consent, readiness, start, intervene, remove, end, and an AI seat. `pnpm demo --web` gains console checks.
- Explicit tests:
  - lobby commands never start the session;
  - a control-service restart keeps a lobby's codes, seats and consent, and never rotates an ended log;
  - IPC reissue revokes the old credential and swaps the code, before and after the start (consent rebound recorded);
  - the evaluator on a log that ended early with `facilitator_end`;
  - both group-score settings;
  - cookie separation in both directions;
  - the extended leak scan, including `by`, the hint and the intent log;
  - prompt action: logged before the bot runs, refused for a human role or a paused, ended or not-yet-started session, hint length and cleaning, one turn in flight, double click yields one line and one audit entry;
  - a stale facilitator token does not block player joins from the same address.
- **Log format.** Sessions that record `aiRoles` or the scoring option write log format 3, because an older runtime would otherwise resume such a log treating AI roles as human and demand consent for them. Other sessions keep format 2. `docs/ROLLBACK.md` says an older runtime refuses format 3.
- Each PR adds its user-visible change to `CHANGELOG.md` under `[Unreleased]`.

## 12. Differences from the parent design and story wording

To be applied when the plan files the acceptance criteria (new ids come from `docs/ID_REGISTRY.md` at that time):

| Item | Change |
|---|---|
| AC-0305 to AC-0307 | "dedicated file descriptor" and "parent pipe" become the `fork()` IPC channel, its `codes`, `ready` and `ended` messages, and `disconnect`; managed mode keeps lobby state and refuses an ended log |
| AC-0306 | `ready` carries `modelLabel`; codes arrive in a separate message |
| AC-0308 | Per-role reissue is an IPC call with a fixed order; after the start it rebinds consent (recorded); Remove always reissues |
| AC-0309 | Reworded as in the boundaries in section 4 |
| AC-0310 | Moves to 2b-1; the model status comes from `modelLabel` |
| AC-0312 | The name is the login-typed label carried as `by`, never shown to participants |
| AC-0313, AC-0314 | `end_now` and `remove_participant` are new client messages, not facilitator commands |
| AC-0319 | The bot module extraction plus the new `TurnPolicy` are separate criteria |
| AC-0325 | The caveat goes in the existing calibration stamp |
| New | Manual restart only; ended sessions stop and free their slot; per-session child logs; a bot failure skips the turn and alerts |
| New | Facilitator **Prompt AI player** with an optional hint (section 8.3a), including its tests |
| New | Bot call budget; no start without a human player; no AI-to-AI reaction; reserved "AI player" prefix |

## 13. Open items for the plan

1. Confirm `fork()` under `tsx` (spike, first task).
2. Fix the exact event sequence for `end_now`, including the scene event for an interrupted scene, after reading the event schemas.
3. Confirm how the lock-free log-tail check is exposed (a small helper beside the session store).
4. Choose the subpath-export mechanism for `players/` (package `exports` map).
5. Choose defaults for the bot call budget, the quiet-time nudge, the minimum gap and the per-scene line cap.
6. Decide the allowlisted player-copy shape for `snapshotFor` without changing what 2a players already see.

## 14. Review findings and where they landed

An independent review (Opus, read-only, against the code, 2026-10-30) found two blockers, eight majors and eleven minors. All are addressed here.

| Finding | Landed in |
|---|---|
| Blocker: new commands would trigger the lobby auto-start | 7.4 (new client messages) |
| Blocker: restart wipes lobbies and rotates ended logs | 5.1 (managed mode), 5.5 |
| Major: reissue wiring (server handle, order) | 5.1, 5.2 |
| Major: reissue after the start cannot readmit | 5.4 (owner decision: rebind consent) |
| Major: `ready` does not fit the codes hook | 5.1 (two messages) |
| Major: facilitator name and new state fields leak | 7.2 (allowlisted copies) |
| Major: AI seats not durable or recoverable | 8.4 |
| Major: bot alerts and intent log have no path | 8.4 |
| Major: 2b-1 result unreachable | 2, 3, 6.1 (owner decision) |
| Major: stale facilitator token locks the room out | 6 |
| Minor: US-0039 is Complete | 8.5 |
| Minor: audience tag does not exist; login CSRF; secret rotation | 6 |
| Minor: prompt audit order | 8.3a |
| Minor: model spend and AI loops; no-human room | 8.3 |
| Minor: AI label spoofing | 8.4 |
| Minor: child environment allowlist; token encoding | 5.1 |
| Minor: start-up lock race | 5.5 |
| Minor: `end_now` event sequence | 7.4, 13 |
| Minor: consent notice version | 8.4 |
| Minor: log format 3 | 11 |
| Minor: open items 2 and 3 closed | 7.1, 7.3 |
