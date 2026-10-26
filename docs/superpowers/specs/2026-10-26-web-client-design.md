# EPIC-0002 web client: design

Date: 2026-10-26. Status: draft for owner review. Epic: EPIC-0002 (Slice 2, web lobby, session view and reconnect). Related: `docs/ARCHITECTURE.md` section 6, `docs/THREAT_MODEL.md`, EPIC-0007 (brand, design system, landing page), EPIC-0008 (multi-client). Mockups: the SceneCoach.ai web client mockups published on 2026-10-26 (seven screens). This design was reviewed against the code by two independent Opus passes on 2026-10-26; their findings are folded in and listed in section 12.

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
| Consent | A versioned notice; consent is recorded before play (SES-05). Always required, terminal sessions included |
| Sessions | A small launcher starts one runtime process per session |
| Reconnect | A durable per-player credential issued by the runtime |
| Reports after the session | A separate report-access credential, issued at release, checked without a live runtime |
| Facilitator login | A shared facilitator secret held by the BFF (stub, local stage) |
| Name and brand | SceneCoach.ai, tagline "AI role-play and team skills coaching simulator"; trademark and domain not yet verified (US-0048) |

## 3. Slices

| Slice | Delivers | Needs from the runtime |
| --- | --- | --- |
| 2a Platform and participant | BFF, join with code and name, consent (web and terminal), lobby, session view, reconnect, noindex rules. A session is still started from the terminal. | Sections 5.1 to 5.5 |
| 2b Facilitator console | Facilitator login, launcher and control service, new session, readiness, live control, monitoring, interventions, remove participant, end session | Sections 5.6 and 5.7, section 7 |
| 2c Reports | Report-access credential, the participant's own report, self-assessment and response; facilitator evaluate, moderation, release and export in the browser | Section 5.8 |

Each slice has its own implementation plan and pull requests. 2a is usable on its own: the terminal facilitator sees consent state in the roster line (section 5.4) and consents with `/consent`. Before the plans are written, stories and acceptance criteria for each slice are filed in `docs/RELEASE_PLAN.md` and their ids reserved in `docs/ID_REGISTRY.md`.

## 4. Architecture

Units, each with one job:
- **`apps/web`** (Next.js): pages `/join`, `/session/[id]`, `/report/[id]`, `/console/*`. No game logic. Presentational components use the EPIC-0007 design tokens when they exist; until then a minimal token file.
- **BFF** (Next.js server routes, forced Node runtime): authenticates the browser, holds one runtime WebSocket per connected participant, translates between the browser and the runtime protocol, and is the only component that sees join codes, credentials and runtime tokens.
- **Runtime** (`services/runtime`): unchanged apart from the additions in section 5. One process per session.
- **Launcher / control service** (2b): a small Node service that creates and supervises runtimes and is the only writer of the data directory for the web (session files, review store, report-access credentials). The BFF calls it over loopback with a service token.

The browser never talks to a runtime. Runtimes bind to `127.0.0.1` and are reachable only from the BFF and the launcher.

```
Browser <-HTTPS/SSE-> BFF (Next.js) <-WebSocket, loopback-> Runtime (one per session)
                            |                                   ^
                            +--HTTP, loopback--> Launcher ------+ (spawns, 2b)
```

## 5. Runtime additions

All are additive. The session log format version is bumped once (section 5.3) and the reader accepts the previous version. Side files are versioned separately.

### 5.1 Real client address and limits behind the BFF

The failed-login throttle and the per-address connection cap count by remote address (`ws-server.ts:182-188`, `ws-server.ts:101`, `security.ts:43`). Behind the BFF every player would share one address.
- The runtime runs with `TRUST_PROXY=1` on loopback. The BFF sets the real client address as the last `X-Forwarded-For` entry (the runtime reads the last entry, up to 64 characters, `security.ts:236-245`). The address comes only from the entry Caddy appends; Caddy is configured to replace any client-supplied header.
- `TRUST_PROXY=1` also turns off the runtime's raw-socket cap (`ws-server.ts:77`), so the BFF enforces its own global and per-address connection caps.
- Failed-login throttles are keyed by (address, role), in the BFF and in the runtime, so a mistyped code locks out only that role from that address, and six typos in an office behind one NAT do not lock out colleagues. `WS_MAX_CONNECTIONS_PER_IP` and `WS_MAX_CONNECTIONS` are set for the deployment (the default of 8 per address would refuse a ninth player behind one NAT).
- The BFF's reconnect loop stops on `unauthorized`; a refused credential is never retried and never charges the player's address.
- The BFF also throttles `/api/v1/join` per client address and role before the runtime sees anything.
- Tests: six wrong codes for one role from one address do not affect another role or address; nine players behind one address can join.

### 5.2 Durable per-player credential

Today a reconnect token only takes over a role whose old socket is still open, and it changes on every join (`ws-server.ts:239-257`). After a drop or a BFF restart a player would need the join code again.
- **Storage.** A separate versioned file `<id>.credentials.json` (`0600`), holding salted SHA-256 hashes, the display name given at join, and the log identity (section 5.5). It is written by atomic rename under the session lock on every issue and revoke. It is not part of the join-codes record (the loader rejects any extra key, `join-codes.ts:88`) and it is never copied into `review.opened` (the review log copies the join-code record, `review/store.ts:255-285`).
- **Issue.** At the first successful join by code the runtime issues a 128-bit credential from a CSPRNG for that role. `join` accepts `{ credential }` whether or not an older socket is open.
- **Revoke.** Only on an explicit leave, consent withdrawal, facilitator removal, code reissue or the end of the session. **Never on a disconnect.** The close handler frees the seat (`ws-server.ts:318`, `session-host.ts:105-107`) but leaves the credential, which reclaims it.
- **The join code after a credential exists.** It stops working for that role until the facilitator reissues it. A leaked code therefore cannot take over a role during a drop. A player who loses their cookie asks the facilitator to reissue their code (a per-role reissue in the console; the old credential is revoked).
- **Takeover.** A second join with the credential for a role with a live socket supersedes the old socket, which is closed with a distinct close code (`superseded`). The BFF does not reconnect on it and tells the user "this session is open in another tab".
- **Resume and restart.** The file survives resume. A start that finds an empty log and issues new codes discards credentials and consent with the old codes (nothing has happened yet, `session-store.ts:176-177`); the BFF shows "ask your facilitator for a new code" for the invalid cookie. This is the one case where the cookie outlives the credential.
- The terminal client's reconnect token is unchanged. The credential, the reconnect token and the join code are three separate things.

### 5.3 Consent (always required)

An event cannot be appended before `session.started` (`session-engine.ts:150`, `:352`), and an older runtime treats an unknown event as a corrupt log, so pre-start consent lives outside the log until the start.
- Consent records `{ role, noticeVersion, at }` are held in host memory and mirrored to `<id>.consent.json` (`0600`, atomic, under the lock).
- **Who must consent.** Every role of type player in the scenario. A start is refused until each has joined and consented. (Starting with fewer people than roles is not supported today and stays out of scope.)
- **The notice version** is configured on the server (`CONSENT_NOTICE_VERSION` and a notice file the BFF serves), not in the scenario, so `scenarioHash` is unchanged and sessions in progress still resume (`session-engine.ts:358`). The runtime requires equality with the server's current version. The notice text states who can see results (ASM-09).
- **Gate** in `SessionHost.start`, which every route to a start uses, including the auto-start inside `command` (`ws-server.ts:286`). A refusal names the roles still missing.
- **At start** the consents and the display names are written into `session.started` (new optional fields `consents` and `names`). The session log is append-only with seq-order checks (`event-log.ts:108`) but is not hash-chained; only `review.jsonl` is. `viewFor` spreads `session.started` to players (`session-host.ts:305`), so it redacts `consents` and `names` for players: a player sees only their own consent.
- `LOG_FORMAT` is bumped; the reader accepts the old format without the fields. An older runtime refuses format 2 (`session-engine.ts:356`); `docs/ROLLBACK.md` says so.
- **Terminal and demos.** Terminal players use a new `/consent` command. `pnpm demo` and generated players consent through the harness. Existing tests get a helper that consents all roles; this is part of 2a.
- **Withdrawing** before the start removes the role's consent, revokes its credential and frees the seat.

### 5.4 Display name and roster

- **Names.** The terminal client already sends a name as `participantId` (`cli/commands.ts:73`). The web keeps `participantId` as an opaque BFF-generated identifier and adds an optional `displayName` (1 to 60 characters) sent with `join`, cleaned with the review module's `cleanText`, hidden and bidirectional characters stripped. The name is stored in the credentials file when issued, so a player who is briefly disconnected at the start keeps it (assignments are read from live holders at start, `session-engine.ts:153`, which would lose them). A name cannot change after the start. Display names never enter model prompts (`ARCHITECTURE.md` section 8). Exports strip Markdown link and image syntax from names (`review/export.ts:151`).
- **Roster.** Joins and connections are not logged (`session-host.ts:94-107`, `ws-server.ts:139`), so the roster is a host-memory frame, not an event: a **facilitator roster** (role, name, joined, consented, connected) and a **peer roster** (role, name, ready). Peers do not see each other's names today (`session-host.ts:304`); showing the typed display name to peers is a deliberate change recorded in the threat model.
- **Terminal facilitator in 2a.** The server prints a roster line on each join, consent and disconnect with the role and state only. Display names are never printed to stdout or logs (`AGENTS.md` sections 12 and 18); they appear in the browser frames.

### 5.5 Replay, projections and log identity

- The shared reducer throws on a seq gap (`state.ts:38`), and a player's stream has gaps by design (`session-host.ts:299-327`), the snapshot is redacted (`:247`), and an incomplete replay sends no events (`:263`). The browser does **not** run the shared reducer. It runs a **player projection**: seeded from the `joined` snapshot, tolerant of gaps, replaced wholesale on a `reset` frame. This deviates from `ARCHITECTURE.md` section 6, which is updated to say so.
- The BFF sends `reset` whenever `joined.replay.complete` is false.
- The SSE event id is the runtime seq. A **log identity** (a random id minted when the session files are first created, stored in `<id>.credentials.json` and copied into `session.started`) is carried in `joined`, so a `Last-Event-ID` from before a `SESSION_START=fresh` cannot point into a new log (`THREAT_MODEL.md:60`); a mismatch triggers `reset`.

### 5.6 End the session now (2b)

`session.ended` already has the reason `facilitator_end` (`events.ts:50`) but nothing emits it. A facilitator command `end_now { message }` (named to avoid the repair kind `end_session`, `session-engine.ts:47`) appends `session.ended` with that reason and a new optional participant-visible `message` field, stops the scene clock and the Game Master, and moves the session to ended. The engine, fold, view policy and docs all need the new case.

### 5.7 Remove a participant (2b)

A facilitator command `remove_participant { roleId }`, allowed before the start only: it revokes the credential, closes the socket with a distinct code, clears the consent and frees the seat. After the start, the facilitator can pause or end.

### 5.8 Reports after the session (2c)

**Report-access credential.** When a report is released to a participant, the control service issues a report-access credential for that participant: 128 bits from a CSPRNG, stored hashed with an expiry (default 90 days, `REPORT_ACCESS_DAYS`) in an `access.json` beside the review directory (`0600`, atomic), outside the review log. The facilitator console shows the report link with the credential once, like join codes. The control service verifies it without a live runtime (the runtime may have exited; an ended log is rotated and its codes removed on the next start, `session-store.ts:141-146`, `:178-183`). The facilitator can revoke or reissue it.

**Who runs what.** The control service owns the data directory and the model access. It runs `evaluate` and the review operations on behalf of the facilitator console and serves the released views to the BFF, so the BFF never touches `data/reports`.

**Authenticated participant actions.** Self-assessment, response and dispute are facilitator-attested today: the review `Actor` requires `attestedBy` (`review/types.ts:22`), and the fold and write checks reject any other shape (`review/store.ts:80-87`, `review/fold.ts:137`, `:334`, `:432`). Changes:
- A versioned actor kind `participant_session` (role plus the report-access credential's id), accepted only for `self-assess`, `respond` (including marking a dispute) and reading the participant's own released report. `resolve` stays a facilitator action. The attested kind stays for the CLI. `REVIEW_SCHEMA` is bumped (`review/types.ts:1`).
- The chain is unkeyed (`THREAT_MODEL.md:160-161`), so a `participant_session` label could be forged by anyone who can write the reports directory. The control service is the only web writer; the file modes and this limit are documented in the threat model.
- `canView` knows roles, not sessions (`review/policy.ts:115`); the control service ties the report directory to the session in the credential.
- A held `review.lock` is refused, not waited on (`review/review-log.ts:179-190`); the control service retries with backoff and returns "try again".

## 6. BFF design

- **API shape.** Routes live under `/api/v1/` and return the project's response envelope (`AGENTS.md` section 15). Every route derives the session and role from the sealed cookie only, never from the request body, so one participant cannot make the BFF act for another.
- **Participant cookie.** HttpOnly, Secure, SameSite=Lax (Strict would drop the cookie when a player follows the link from a mail or chat client), `Path=/`. The value is sealed (authenticated encryption) with a key identified by a key id, so keys can rotate; it holds `{ sessionId, role, participantId, credential, expiresAt }`. It expires at the session end. The credential is the runtime's, never the join code. Revocation is enforced by the runtime at the next join, so the BFF keeps no revoke list to lose on a restart.
- **Join.** `POST /api/v1/join { sessionId, role, joinCode, displayName }`: BFF throttle, then runtime `join` with the code, which returns the credential; the join code is discarded. Every refusal is the same neutral message.
- **Stream.** `GET /api/v1/stream` rejects a cross-site top-level navigation (it checks `Sec-Fetch-Site` and `Origin`), opens the runtime WebSocket (one per participant), and forwards events as SSE with the seq as id. It sends heartbeat comments, disables compression and runs on the Node runtime. Streams are capped per session and globally and closed after idle. A BFF restart or a browser drop reconnects with `Last-Event-ID` and the credential. On `superseded` it stops and shows the "open in another tab" message.
- **Commands.** `POST /api/v1/say`, `/consent`, `/report/*`. State-changing requests check `Origin` and a custom header.
- **Reports.** The report page uses the report-access credential (a separate cookie) and calls the control service; it works after the runtime is gone.
- **Facilitator.** `POST /api/v1/console/login { secret }` compares in constant time against `FACILITATOR_SECRET` and is throttled; it sets a separate sealed cookie. The BFF, never the browser, holds each runtime's facilitator token, which it gets from the control service over loopback. The console is disabled with a loud message when the secret is unset.
- **Rendering.** All transcript, brief, fact, name and report text is untrusted and rendered as text. Strict CSP, no inline scripts.
- **Errors.** Wrong code or credential: one neutral message. Runtime unreachable: a "Reconnecting" banner with exponential backoff (injected clock in tests). Ended session, missing consent, stale scene: plain messages and a safe retry. No stack traces, internal ids or paths reach the browser.

## 7. Launcher and control service (2b)

A separate small Node service, not part of Next.js.
- **Create.** `POST /sessions { scenarioId }` is callable only by the BFF over loopback with a service token. `scenarioId` must be in an allowlist built from the scenarios folder, and the number of live sessions is capped (`MAX_SESSIONS`, default 10). The scenario is validated with the existing loader.
- **Environment.** The runtime reads `<root>/.env` even when the parent passes a clean environment (`main.ts:53-59`), so stray values such as `SESSION_START=fresh`, `GM_TRACE_FILE`, `ALLOWED_ORIGINS` and `WS_*` could leak in. The launcher sets every lifecycle and security variable explicitly (`SESSION_START`, `RUNTIME_HOST=127.0.0.1` because the default is `0.0.0.0` at `security.ts:100` and `ws-server.ts:60`, `RUNTIME_PORT=0`, `TRUST_PROXY=1`, the connection caps, `FACILITATOR_TOKEN`, `GM_TRACE_FILE` unset). A new runtime flag, `NO_DOTENV=1`, skips the `.env` merge for launcher-started runtimes. A non-empty `FACILITATOR_TOKEN` already wins over `.env` (`main.ts:59`, `:62`).
- **Machine channel.** The runtime emits one JSON line on a dedicated file descriptor on **every** start, resumed or new: the port (the runtime accepts port 0, `main.ts:71`, but today only logs it), the log identity, and the status. Codes are included only when issued. Today codes are printed as text mixed with logs (`main.ts:190-198`) and not shown after a resume (`main.ts:165-176`); a failure to deliver them aborts a start, as today.
- **Reissue.** Per role: revokes that role's credential and issues a new code. For the whole session: stops the runtime, moves `<id>.codes.json` aside and starts again. Both return the new codes once.
- **Lifecycle.** The runtime exits when its parent pipe closes, so a launcher crash or restart stops all its children; they cannot become orphans that keep their locks current. On start the launcher resumes the sessions in its list (always paused) with fresh facilitator tokens. It never relaunches an ended session (an ended session is rotated aside and starts fresh with new codes, `main.ts:117`). The list holds only `sessionId, scenarioId, status`; facilitator tokens are kept in memory and never written to disk.
- The mapping session id to port lives in the launcher and BFF, never in a cookie.

## 8. Security and privacy

- Threat-model additions: the BFF and the control service as new trust boundaries; the sealed cookie and key rotation; the player credential and its file; the report-access credential; the shared-secret facilitator login; peers seeing display names; the new actor kind and the unkeyed chain; the launcher's loopback service token; SSE connections as a denial-of-service surface; log identity; the confused-deputy rule (identity only from the cookie).
- Participant streams reuse the runtime's default-deny `viewFor`; the BFF adds no field. A test scans every frame a player receives for facilitator-only events, other roles' briefs and facts, other players' consent, codes and tokens.
- Private routes (`/join`, `/session`, `/report`, `/console`, `/admin`) send `noindex, nofollow` and are disallowed in `robots.txt`; join links carry no personal data in the URL.
- Data minimisation: no emails. The display name is the only personal data added; it is stored in the credentials file and `session.started`, shown only as described, never logged and never sent to a model.
- TLS terminates at Caddy. Codes, credentials, cookies and tokens are never logged.

## 9. Testing

- **Unit:** cookie sealing and rotation, the player projection (gaps, resets), roster and talk-time projections, launcher validation and environment, credential issue, revoke and file atomicity, consent gating (including the auto-start path and the terminal `/consent`), display-name sanitising, report-access expiry.
- **BFF contract tests** against a fake runtime replaying scripted frames **and** against the real runtime in mock mode, so the fake cannot drift. A readiness probe uses the runtime's 426 reply (`ws-server.ts:69`).
- **Runtime tests:** a drop does not revoke; a second tab supersedes and the first stops; the join code stops working once a credential exists; an empty-log restart discards credentials and consent; an older runtime refuses format 2; the throttle is keyed by (address, role); nine players behind one address join.
- **Security:** XSS payload in a transcript line, a display name and a report; tampered and expired cookies; a replayed credential after revoke; a stream scan for facilitator-only data; a cross-role and a cross-session report request; a forged cross-site request to the stream route.
- **Playwright end to end**, mock mode, offline and deterministic: the facilitator creates a session, three players join with names and consent, start, everyone speaks, one drop and recovery, a BFF restart and recovery, end, the facilitator evaluates and releases a report through the control service, its owner reads it after the runtime has exited. Axe accessibility checks on every screen. Reconnect backoff uses an injected clock; real-process tests use the generous timeouts from `AGENTS.md` section 8 and assert no elapsed time.
- **Repo plumbing:** add `apps/*` to `pnpm-workspace.yaml`; add a Playwright browser install step to CI (the Playwright in this environment is pre-installed, CI's is not); run new filesystem, lock and process tests once in the `node:22` Linux container before pushing; `pnpm test:coverage` at least 80 percent, run more than once and once under load.
- **Demo:** `pnpm demo --web` drives the flow with generated players and adds checks to the demo count list. Existing demos gain the consent step.

## 10. Operations

New environment variables (documented in `MEMORY.md` and `.env.example`): `FACILITATOR_SECRET`, `COOKIE_KEYS` (id:key pairs), `RUNTIME_URL` (2a, to find the terminal-started runtime), `LAUNCHER_URL`, `LAUNCHER_TOKEN`, `PUBLIC_ORIGIN`, `TRUST_PROXY`, `CONSENT_NOTICE_VERSION`, `REPORT_ACCESS_DAYS`, `MAX_SESSIONS`, `NO_DOTENV`. A rollback plan (`docs/ROLLBACK.md`) is written before any deployment and records that an older runtime refuses format 2 logs. Dependencies are pinned and recorded in `findings.md`.

## 11. Open questions (do not block 2a)

- Subdomain or path addressing for clients (EPIC-0008, US-0049); the cookie and origin rules here assume one origin.
- The scenario list source and ordering for the New session screen (the scenarios folder for now).
- Retention and deletion of display names with the session log (needs a policy before any hosted deployment).
- Fewer people than roles (not supported by the consent rule or the scenario format today).

## 12. Review findings and where they landed

First pass (2026-10-26):

| Finding | Resolved in |
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

Second pass (2026-10-26):

| Finding | Resolved in |
| --- | --- |
| Revoking on role release breaks reconnect | 5.2 |
| Credential and cookie end with the session but reports are needed later | 5.8, 6 |
| Credentials cannot share the join-code file; a lobby restart wipes them | 5.2 |
| The join code stays valid after a credential is issued | 5.2 |
| A takeover has no distinguishing close code; two tabs fight | 5.2, 6 |
| NAT: limits keyed by address only; `TRUST_PROXY` disables the raw cap | 5.1 |
| Session log is not hash-chained; `viewFor` would leak `consents` | 5.3 |
| Consent gate breaks terminal, demos and tests; scenario hash; undefined "human seat"; names lost on disconnect | 5.3, 5.4 |
| Launcher environment leakage through `.env` | 7 |
| Machine channel fires only when codes are issued | 7 |
| Orphan and lock reasoning wrong; adoption contradicts "no tokens on disk" | 7 |
| 2c actor kind under-designed; who runs evaluate and open | 5.8 |
| Undefined remove-participant, end-session shape, log identity location, runtime URL for 2a | 5.7, 5.6, 5.5, 10 |
| Conflicts with `AGENTS.md` (API envelope, PII in logs), `ARCHITECTURE.md`, ASM-09; ids not reserved | 3, 5.3, 5.4, 5.5, 6 |
| Minor: `Sec-Fetch-Site`, Markdown in exports, sanitiser name, prompts, launcher caps, rollback note, throttle charging | 5.1, 5.4, 6, 7, 10 |
