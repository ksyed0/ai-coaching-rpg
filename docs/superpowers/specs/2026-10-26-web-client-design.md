# EPIC-0002 web client: design

Date: 2026-10-26. Status: draft for owner review. Epic: EPIC-0002 (Slice 2, web lobby, session view and reconnect). Related: `docs/ARCHITECTURE.md` section 6, `docs/THREAT_MODEL.md`, EPIC-0007 (brand, design system, landing page), EPIC-0008 (multi-client). Mockups: the SceneCoach.ai web client mockups published on 2026-10-26 (seven screens). This design was reviewed against the code by an independent Opus pass on 2026-10-26; its findings are folded in and listed in section 12.

## 1. Purpose and success criteria

The product is a text-only terminal MVP today. This epic lets a whole session run in a browser, with no terminal, for non-technical participants and a facilitator.

Success means:
- A facilitator creates a session from a browser, shares a link and per-role codes, and runs the session from a console.
- A participant opens the link, enters a code and a display name, consents, plays the scene as text, survives a dropped connection or a backend restart, and later reads their own released report and responds to it.
- The facilitator moderates and releases reports from the same console.
- No player ever receives facilitator-only data, another player's code, brief or report, or a secret, and a mistyped code from one player never locks out the others.

Out of scope for this epic: accounts, SSO and emails (a later slice with EPIC-0008), voice (EPIC-0003), the 3D scene (EPIC-0004), the landing page and visual identity (EPIC-0007), multiple client organisations (EPIC-0008).

## 2. Decisions already taken (owner, 2026-10-26)

| Topic | Decision |
| --- | --- |
| First release | Participants and facilitator both in the browser; participant's own report and facilitator moderation included |
| Joining | Shared link plus the existing per-role join code (US-0033); no accounts; no emails collected |
| Names | The participant types their own display name at join |
| Stack | Next.js app with a backend-for-frontend (BFF) in server routes, as in ARCHITECTURE.md section 6 |
| Consent | A versioned notice in the lobby; consent is recorded before play (SES-05) |
| Sessions | A small launcher starts one runtime process per session |
| Reconnect | A durable per-player credential issued by the runtime |
| Facilitator login | A shared facilitator secret held by the BFF (stub, local stage) |
| Name and brand | SceneCoach.ai, tagline "AI role-play and team skills coaching simulator"; trademark and domain not yet verified (US-0048) |

## 3. Slices

| Slice | Delivers | Needs from the runtime |
| --- | --- | --- |
| 2a Platform and participant | BFF, join with code and name, consent, lobby, session view, reconnect, noindex rules. A session is still started from the terminal. | Sections 5.1 to 5.5 |
| 2b Facilitator console | Facilitator login, launcher, new session, readiness, live control, monitoring, interventions, end session | Sections 5.6 and 5.7, launcher (section 7) |
| 2c Reports | The participant's own report, self-assessment and response; facilitator moderation, release and export in the browser | Section 5.8 |

Each slice has its own implementation plan and pull requests. 2a is usable on its own: the terminal facilitator sees consent state printed (section 5.4).

## 4. Architecture

Units, each with one job:
- **`apps/web`** (Next.js): pages `/join`, `/session/[id]`, `/report/[id]`, `/console/*`. No game logic. Presentational components use the EPIC-0007 design tokens when they exist; until then a minimal token file.
- **BFF** (Next.js server routes, forced Node runtime): authenticates the browser, holds one runtime WebSocket per connected participant, translates between the browser and the runtime protocol, and is the only component that sees join codes, credentials and runtime tokens.
- **Runtime** (`services/runtime`): unchanged apart from the additions in section 5. One process per session.
- **Launcher** (2b): a small Node service that creates and supervises runtimes.

The browser never talks to a runtime. Runtimes bind to `127.0.0.1` and are reachable only from the BFF and the launcher.

```
Browser <-HTTPS/SSE-> BFF (Next.js) <-WebSocket, loopback-> Runtime (one per session)
                            |                                   ^
                            +--HTTP, loopback--> Launcher ------+ (spawns, 2b)
```

## 5. Runtime additions

All are additive. Log format version is bumped once (section 5.3) and the resume code accepts the previous version.

### 5.1 Real client address behind the BFF

The failed-login throttle and the per-address connection cap count by remote address (`ws-server.ts:182-188`, `security.ts:90`). Behind the BFF every player would share one address, so one player mistyping a code six times would block everyone for 60 seconds and a session of eight or more sockets would be refused.
- The runtime runs with `TRUST_PROXY=1` on loopback. The BFF sets the real client address as the last `X-Forwarded-For` entry for every runtime connection.
- The BFF also throttles `/api/join` per client address, so the browser-facing door is protected before the runtime sees anything.
- Test: six wrong codes from one client address do not affect a second client address.

### 5.2 Durable per-player credential

Today a reconnect token only takes over a role whose old socket is still open, and it changes on every join (`ws-server.ts:239-257`). After a drop or a BFF restart the player would need the join code again.
- At the first successful `join` the runtime issues a **player credential** for that role: 128 bits from a CSPRNG, stored only as a salted SHA-256 beside the join-code hashes (same file, same mode `0600`), surviving resume.
- `join` accepts `{ credential }` in place of `joinCode`, whether or not an older socket is still open. A second join for the same role terminates the older socket, as today.
- The credential is revoked when the role is released, the facilitator removes the participant, or the session ends. Refusals are the same byte-identical `unauthorized`, charged to the throttle.
- The reconnect token that exists today stays for the terminal client; the credential is the web mechanism. The two are separate and neither is the join code.

### 5.3 Consent

An event cannot be appended before `session.started` (`session-engine.ts:150, :352`), and an older runtime treats an unknown event as a corrupt log.
- Pre-start consent is held in host memory and mirrored to a side file under the session lock (`<id>.consent.json`, `0600`), like `.codes.json`.
- A client message `consent { noticeVersion }` from a joined role records `{ role, noticeVersion, at }`. The notice text is a versioned file the BFF serves; the runtime only stores the version string and checks it against the scenario's required version.
- At start, the consent records are written into `session.started` (new optional field `consents`), so consent is in the hash-chained log. `LOG_FORMAT` is bumped; the reader accepts the old format without the field.
- The gate is in `SessionHost.start`, which every route to a start goes through (the `start` message and the auto-start inside `command`, `ws-server.ts:286`). Starting with a human seat unconsented is refused with a code that lists the roles.
- Withdrawing consent before the start removes the role's consent record and frees the seat.

### 5.4 Display name and roster

- **Names.** The terminal client already sends a name as `participantId` (`cli/commands.ts:73`), logged for players assigned at start (`session-engine.ts:152`). The web keeps `participantId` as an opaque BFF-generated identifier and adds an optional `displayName` (1 to 60 characters, passed through the existing text sanitiser, hidden and bidirectional characters stripped) sent with `join`. Names are recorded in `session.started` next to `participantId`. A name cannot change after the start. Reports and the transcript use the display name; evidence is never altered.
- **Roster.** Joins and connections are not logged: assignments and holders exist only in memory (`session-host.ts:94-107`, `ws-server.ts:139`). The roster is therefore a host-memory frame, not an event: a **facilitator roster** (role, name, joined, consented, connected) and a **peer roster** (role, name, ready). Today peers do not see each other's participant names (`session-host.ts:304`, `redactRoles`); showing a name to peers is a deliberate change, recorded in the threat model, and limited to the display name the person typed.
- **Terminal facilitator in 2a.** The server prints a roster line on each join, consent and disconnect so a terminal facilitator can see readiness before they start.

### 5.5 Replay, projections and log identity

- The shared reducer throws on a seq gap (`state.ts:41`), and a player's stream has gaps by design (`session-host.ts:299-327`), the snapshot is redacted (`:247`), and an incomplete replay sends no events (`:263`). The browser therefore does **not** run the shared reducer. It runs a **player projection**: seeded from the `joined` snapshot, tolerant of gaps, appending visible events, and replaced wholesale on a `reset` frame.
- The BFF sends a `reset` SSE frame with a fresh snapshot whenever `joined.replay.complete` is false.
- The SSE event id is the runtime event seq. A **log identity** (a random id minted when a log is created and carried in `joined`) is added so a `Last-Event-ID` from before a `SESSION_START=fresh` cannot point into a new log (`THREAT_MODEL.md:60`); a mismatch triggers a `reset`.

### 5.6 End session now (2b)

`facilitator_end` exists only as a type (`events.ts:50`). A facilitator command `end_session { message }` appends the event, stops the scene clock and the Game Master, shows participants the message, and moves the session to ended. The engine, fold, view policy and docs all need the new case.

### 5.7 Launcher hooks (2b)

See section 7.

### 5.8 Authenticated participant actions on reports (2c)

Self-assessment, response and dispute are facilitator-attested today: the review store's `Actor` requires `attestedBy` (`review/types.ts:22`), the fold rejects any other shape (`store.ts:80-87`), and the threat model states the attested assumption (`THREAT_MODEL.md:166`).
- Add a versioned actor kind `participant_session`, carrying the role, the credential's session id and the log identity, accepted only for `self-assess`, `respond` (including marking a dispute) and reading the participant's own released report. `resolve` stays a facilitator action. The attested kind stays for the CLI.
- The BFF ties the report directory to the session in the credential, because `canView` knows roles, not sessions (`policy.ts:115`).
- A held `review.lock` is refused, not waited on (`review-log.ts:179-190`); the BFF retries with backoff and surfaces "try again" rather than failing.
- The threat model is updated: a web participant is authenticated by the credential, not by the facilitator's attestation, and what that does and does not protect.

## 6. BFF design

- **Participant cookie.** HttpOnly, Secure, SameSite=Lax (Strict would drop the cookie when a player follows the link from a mail or chat client), `Path=/`. The value is sealed (authenticated encryption) with a key identified by a key id, so keys can rotate; it holds `{ sessionId, role, participantId, credential, expiresAt }`. The expiry is the session end or 12 hours, whichever is sooner. The credential is the runtime's, never the join code. A server-side revoke list (in memory, seeded from the runtime's revocations) handles removal.
- **Join.** `POST /api/join { sessionId, role, joinCode, displayName }`: BFF throttle, then runtime `join` with the code, which returns the credential; the join code is discarded. Every refusal is one neutral message.
- **Stream.** `GET /api/stream` opens the runtime WebSocket (one per participant; a second tab terminates the first, shown to the user as "this session is open in another tab"), forwards events as SSE with the seq as id, sends heartbeat comments, disables compression and runs on the Node runtime. A BFF restart or a browser drop reconnects with `Last-Event-ID` and the credential.
- **Commands.** `POST /api/say`, `/api/consent`, `/api/report/*`. State-changing requests check `Origin` and a custom header.
- **Facilitator.** `POST /api/console/login { secret }` compared in constant time against `FACILITATOR_SECRET`, throttled; sets a separate sealed cookie. The BFF, never the browser, holds each runtime's facilitator token, fetched from the launcher over loopback. The secret is required: the console is disabled with a loud message when it is unset.
- **Rendering.** All transcript, brief, fact and report text is untrusted and rendered as text. Strict CSP, no inline scripts.
- **Errors.** Wrong code or credential: one neutral message. Runtime unreachable: a "Reconnecting" banner with exponential backoff (injected clock in tests). Ended session, missing consent, stale scene: plain messages and a safe retry. No stack traces, internal ids or paths reach the browser.

## 7. Launcher (2b)

A separate small Node service, not part of Next.js.
- `POST /sessions { scenarioId }` (authenticated: only the BFF, over loopback, with a service token) validates the scenario with the existing loader, starts a runtime with `RUNTIME_PORT=0` (the runtime reports its port, avoiding a find-then-bind race), `RUNTIME_HOST=127.0.0.1` set explicitly (the default is `0.0.0.0`, `security.ts:147`), `SESSION_ID`, the scenario, a fresh facilitator token passed in the environment (an `.env` token would win over an empty one, `main.ts:62`, so the launcher runs the runtime with a clean environment), and `TRUST_PROXY=1`.
- **Machine channel for codes.** Join codes are printed as text mixed with normal logs (`main.ts:190-198`) and are not shown again after a resume (`:165-175`). The runtime gains a machine channel (a JSON line on a dedicated file descriptor, via `showJoinCodes`, `main.ts:44`) that carries the port, the log identity and the issued codes once. A failure to deliver them aborts the start, as today.
- **Reissue.** An explicit operation stops the runtime, moves `<id>.codes.json` aside, and starts it again, returning new codes; the previous credentials are revoked.
- **Lifecycle.** The launcher never relaunches an ended session (an ended session is rotated aside and starts fresh with new codes, `main.ts:117`). It records `sessionId -> pid, port, status` in a file readable only by its user; **facilitator tokens are not written to disk**, so after a launcher restart it adopts live children whose pid is recorded or stops them, and a runtime it cannot adopt is stopped and resumed (always paused) with a fresh token. Orphaned children are killed on a clean shutdown; a crashed launcher's orphans hold the lock for up to the 30-second stale timeout (`log-files.ts:162`) before a resume can take it.
- The mapping session id to port lives in the launcher and BFF, never in a cookie.

## 8. Security and privacy

- Threat-model additions: the BFF as a new trust boundary; the sealed cookie and key rotation; the per-player credential; the shared-secret facilitator login; peers seeing display names; the new actor kind; the launcher and its loopback-only service token; SSE and proxy behaviour; log identity.
- Participant streams reuse the runtime's default-deny `viewFor`; the BFF adds no field. A test scans every frame a player receives for facilitator-only events, other roles' briefs and facts, codes and tokens.
- Private routes (`/join`, `/session`, `/report`, `/console`, `/admin`) send `noindex, nofollow` and are disallowed in `robots.txt`; join links carry no personal data in the URL.
- Data minimisation: no emails; the display name is the only personal data added; it is recorded in the session log and shown only as described.
- TLS terminates at Caddy. Codes, credentials, cookies and tokens are never logged.

## 9. Testing

- **Unit:** cookie sealing and rotation, the player projection (gaps, resets), roster and talk-time projections, launcher validation, credential issue and revoke, consent gating (including the auto-start path), display-name sanitising.
- **BFF contract tests** against a fake runtime replaying scripted frames **and** against the real runtime in mock mode, so the fake cannot drift. A readiness probe uses the runtime's 426 reply (`ws-server.ts:69`).
- **Security:** an XSS payload in a transcript line and in a display name; a tampered and an expired cookie; a replayed credential after revoke; six wrong codes from one client address while a second client joins; a stream scan for facilitator-only data; a cross-role report request; a cross-session report request.
- **Playwright end to end**, mock mode, offline and deterministic: facilitator creates a session, three players join with names and consent, the facilitator starts, everyone speaks, one drop and recovery, a BFF restart and recovery, the facilitator ends the session, releases a report, its owner reads it. Axe accessibility checks on every screen. Reconnect backoff uses an injected clock; real-process tests set the generous timeouts from `AGENTS.md` section 8 and assert no elapsed time.
- **Repo plumbing:** add `apps/*` to `pnpm-workspace.yaml`; add a Playwright browser install step to CI (the Playwright in this environment is pre-installed, CI's is not); run new filesystem, lock and process tests once in the `node:22` Linux container before pushing; `pnpm test:coverage` at least 80 percent, run more than once and once under load.
- **Demo:** `pnpm demo --web` drives the flow with generated players and adds checks to the demo count list.

## 10. Operations

New environment variables (documented in `MEMORY.md` and `.env.example`): `FACILITATOR_SECRET`, `COOKIE_KEYS` (id:key pairs), `LAUNCHER_URL`, `LAUNCHER_TOKEN`, `PUBLIC_ORIGIN`, `TRUST_PROXY`. A rollback plan (`docs/ROLLBACK.md`) is written before any deployment. Dependencies are pinned and recorded in `findings.md`.

## 11. Open questions (do not block 2a)

- Subdomain or path addressing for clients (EPIC-0008, US-0049); the cookie and origin rules here assume one origin.
- Scenario list source and ordering for the New session screen (the scenarios folder for now).
- Retention and deletion of display names with the session log (needs a policy before any hosted deployment).

## 12. Review findings and where they landed

| Finding (Opus review, 2026-10-26) | Resolved in |
| --- | --- |
| Per-address throttle and caps would lock out every player behind the BFF | 5.1 |
| Reconnect token cannot reconnect after a drop; stateless cookie impossible | 5.2, 6 |
| Consent event cannot precede `session.started`; gate must be in `SessionHost.start` | 5.3 |
| Facilitator authentication in the browser undesigned | 2, 6 |
| Shared reducer throws on player gaps; incomplete replay sends no events | 5.5 |
| Roster cannot come from the log; reverses peer name redaction | 5.4 |
| `displayName` duplicated `participantId` | 5.4 |
| Launcher cannot capture codes cleanly; restart behaviour undefined; `0.0.0.0` default | 7 |
| Self-assess and respond need a new actor kind, not a channel swap | 5.8 |
| No end-session command exists | 5.6 |
| SameSite, key rotation, SSE settings, log identity, workspace and CI | 6, 5.5, 9 |
