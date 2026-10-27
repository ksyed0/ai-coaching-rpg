# Web Client Slice 2a (Platform and Participant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant joins a session from a link in a browser with a join code and a typed name, gives recorded consent, plays as text, survives a dropped connection or a backend restart, and the session cannot start until every human seat has consented. A session is still started from the terminal in this slice.

**Architecture:** The runtime gains a durable per-player credential, a consent store and start gate, display names, roster frames and per-(address, role) login throttles. A new `apps/web` Next.js app holds a stateless backend-for-frontend (BFF): a sealed cookie carries the credential, the BFF keeps one runtime WebSocket per participant and bridges it to the browser as server-sent events. Browser state is a gap-tolerant player projection that lives in `packages/events`. All BFF logic is plain `Request` to `Response` modules; Next route files only re-export them.

**Tech Stack:** TypeScript (NodeNext, strict), Node 22, `ws`, `zod` 4, Vitest, pnpm workspace; Next.js (App Router, Node runtime), `@playwright/test`, `@axe-core/playwright`.

**Spec:** `docs/superpowers/specs/2026-10-26-web-client-design.md` (sections 3, 4, 5.1 to 5.5, 6, 8, 9, 10). Stories: US-0052 to US-0056 and US-0065 in `docs/RELEASE_PLAN.md` (AC-0266 to AC-0299, TASK-0080 to TASK-0084 and TASK-0093 are the story tasks; the numbered tasks below are the work items).

## Global Constraints

- Credential: 128 bits from a CSPRNG, hex (32 characters), stored only as a salted SHA-256 beside the display name and log identity in `<id>.credentials.json`, mode `0600`, written by atomic rename under the session lock on every issue and revoke; never in the join-codes record, never copied into `review.opened`. Maximum accepted input: 64 characters.
- Consent file `<id>.consent.json`, mode `0600`, same writer. Notice version comes from `CONSENT_NOTICE_VERSION` (default `v1`) and the text from `consent/notice-<version>.md` (at most 4,000 characters); a mismatch with the server version is refused; a file written under another version is dropped on resume.
- `displayName`: 1 to 60 characters (code points), cleaned with `cleanText` from `services/runtime/src/review/text.ts`; never printed to stdout or logs, never in a model prompt.
- Close codes: `4001` `superseded` (a second join with the credential took the seat). The BFF must not reconnect on it.
- `LOG_FORMAT` becomes `2`; the reader accepts 0, 1 and 2; an older runtime refuses 2 (`session-engine.ts` restore) and `docs/ROLLBACK.md` says so.
- Throttle: failed logins are counted per (address, scope), scope `player:<roleId>` for a known player role, `player:*` otherwise, and `""` for the facilitator token (handshake-level, as today). Defaults: more than 5 failures in 60 s block 60 s. Set `WS_MAX_CONNECTIONS_PER_IP` and `WS_MAX_CONNECTIONS` for the deployment.
- Cookie: HttpOnly, Secure, SameSite=Lax, `Path=/`, sealed with AES-256-GCM, key id prefix for rotation (`COOKIE_KEYS=id:base64key,...`, newest first), expires at the session end.
- API: all routes under `/api/v1/`, response envelope `{ "success": boolean, "data": object | null, "error": { "code": string, "message": string } | null, "meta": { "version": "1.0", "timestamp": "<ISO8601>" } }` (`AGENTS.md` section 15). Identity only from the cookie, never the request body. State-changing requests check `Origin` equals `PUBLIC_ORIGIN` and header `X-Requested-With: scenecoach`. The stream route also checks `Sec-Fetch-Site` is `same-origin` or `none`.
- Private routes (`/join`, `/session`, `/report`, `/console`, `/admin`, `/api`) send `X-Robots-Tag: noindex, nofollow` and are disallowed in `robots.txt`. Strict CSP, no inline scripts. All server text is rendered as text.
- Dependencies pinned to exact versions (no `^`, `~`), each recorded in `findings.md` with name, version, purpose, licence and last-active date. Pick the current stable release at least two weeks old.
- Tests: at least 80 percent coverage on new code; no absolute-time assertions (`AGENTS.md` section 8, hygiene test fails on them); inject clocks; private `mkdtemp` directories for filesystem tests; generous explicit timeouts for socket and process tests; CI runs Ubuntu, so run new filesystem, lock and process tests once in the `node:22` container before pushing.
- Commit format `[TYPE] US-00XX: description` (max 72 characters), types `feat fix test docs refactor chore`. Branch per story, `feature/EPIC-0002-US-00XX-<slug>`. Squash-merge into `develop` by PR; merge only when the owner says so, with 14 checks green.
- User-visible changes go under `[Unreleased]` in `CHANGELOG.md` in the same PR.

## Review Focus

1. A player opens the link on a phone while the laptop tab is still open, or double-clicks Join: the second connection supersedes the first, the first shows "open in another tab" and does not fight back (Task 3, Task 12).
2. A display name with a right-to-left override, zero-width characters, HTML, Markdown link syntax, 61 characters or only spaces: stored cleaned or refused with a plain message, never rendered as markup (Task 3, Task 8, Task 13).
3. The runtime restarts between a player joining and the start: with a non-empty log everything is kept; with an empty log and new codes credentials and consent are discarded and the player sees "ask your facilitator for a new code" (Task 4).
4. A stream client that disconnects mid-replay, sends `Last-Event-ID` beyond the head, or one from before a fresh start (different log identity): the player view resets to a fresh snapshot, never shows a gap or a duplicate (Task 9, Task 12).
5. A tampered, expired or other-session cookie, a request without `Origin` or the custom header, a join code typed in lower case with spaces, and six wrong codes from an office address while a colleague joins (Task 1, Task 11, Task 12).

## File Structure

Runtime (`services/runtime/src`):
- `engine/secure-json-file.ts` (new): the one safe read/write/remove for small owner-only JSON files, extracted from `join-code-file.ts`.
- `engine/credentials.ts`, `engine/consent.ts`, `engine/seats.ts` (new): `PlayerCredentials`, `ConsentStore`, the `Seats` bundle.
- `engine/credentials-file.ts`, `engine/consent-file.ts` (new): file names, read, write, remove.
- `engine/consent-notice.ts` (new): `loadConsentNotice`.
- `engine/session-store.ts`, `main.ts` (modify): file lifecycle, wiring, `CONSENT_NOTICE_VERSION`.
- `host/seats` use in `host/session-host.ts`, `host/ws-server.ts`, `host/protocol.ts` (modify); `host/roster.ts`, `host/display-name.ts` (new).
- `host/security.ts` (modify): scoped `AuthThrottle`.
- `cli/commands.ts`, `cli/client.ts`, `cli/render.ts` (modify): `/consent`, roster line.
- `demo/ctx.ts` and the demo rooms (modify): consent step.
- `consent/notice-v1.md` at the repo root (new): the notice text.

Shared (`packages/events/src`): `events.ts` (modify), `player-view.ts` (new).

Web (`apps/web`, new): `src/server/*` (BFF modules), `src/app/**` (Next files), `src/lib/*` (browser helpers), `src/components/*`, `e2e/*`.

## Branches and pull requests

One branch and PR per story, stacked in this order, each rebased with `git rebase --onto origin/develop <old-base-head>` after its base squash-merges (`docs/memory/process.md`): US-0052 (Task 1), US-0053 (Tasks 2 to 4), US-0054 (Tasks 5 to 7), US-0055 (Tasks 8, 9), US-0056 (Tasks 10 to 13), US-0065 (Task 14); docs (Task 15) rides the last PR. Move each story to In Progress and file its test cases (TC ids from `docs/ID_REGISTRY.md`) when its branch starts.

---

### Task 1: Per-(address, role) failed-login throttle (US-0052)

**Files:**
- Modify: `services/runtime/src/host/security.ts` (`AuthThrottle`), `services/runtime/src/host/ws-server.ts` (`refuseLogin`, `dropAfterClose`, player join)
- Test: `services/runtime/src/host/__tests__/security.test.ts`, `ws-server.join-codes.test.ts`, `ws-server.security.test.ts`

**Interfaces:**
- Produces: `AuthThrottle.fail(ip: string, scope?: string): void`; `AuthThrottle.blockedForMs(ip: string, scope?: string): number`; in `ws-server.ts` `playerScope(h: SessionHost | undefined, roleId: string): string`. The default scope `""` behaves exactly as today.

- [ ] **Step 1: Write failing tests.** `security.test.ts`: "AuthThrottle: failures in one scope do not block another scope of the same address" (6 `fail(ip, "player:a")`, then `blockedForMs(ip, "player:a") > 0`, `blockedForMs(ip, "player:b") === 0`, `blockedForMs(ip) === 0`); "AuthThrottle: the default scope still blocks the address". `ws-server.join-codes.test.ts`: "six wrong codes for one role do not refuse another role from the same address"; "nine players join from one address when the per-address cap allows it" (`limits.maxConnectionsPerIp: 64`); "a blocked (address, role) is refused with the same unauthorized without checking the code" (use the injected clock). Update the existing test that expects player failures to block the whole address.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host` and confirm the new tests fail and only the intended old test needs changing.
- [ ] **Step 3: Implement** the scoped key in `AuthThrottle` (`${authKey(ip)}|${scope}`). In `ws-server.ts` give `refuseLogin(what: string, scope: string)` and a `failScope` variable used by `dropAfterClose`; player login failures use `playerScope`; at join, before verifying, refuse when `authThrottle.blockedForMs(ip, scope) > 0`; the handshake check keeps scope `""`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host` and `pnpm typecheck`; expect all pass.
- [ ] **Step 5: Commit** `[feat] US-0052: throttle failed player logins per address and role`.

### Task 2: Secure file helper, PlayerCredentials, ConsentStore (US-0053)

**Files:**
- Create: `engine/secure-json-file.ts`, `engine/credentials.ts`, `engine/credentials-file.ts`, `engine/consent.ts`, `engine/consent-file.ts`, `engine/seats.ts`
- Modify: `engine/join-code-file.ts` (use the helper; exports and error messages unchanged)
- Test: `engine/__tests__/credentials.test.ts`, `consent.test.ts`, `secure-json-file.test.ts`, existing `join-code-file` tests unchanged

**Interfaces:**
- Produces:
  - `readSecureJson(dir: string, fileName: string, o: { maxBytes: number }): unknown | null` (null when absent; throws `SecureFileError` with `kind: "symlink" | "not_file" | "links" | "owner" | "size" | "json"`); `writeSecureJson(dir: string, fileName: string, value: unknown, beforeCommit?: SyncCheck): void`; `removeSecureFile(dir: string, fileName: string): void`.
  - `class PlayerCredentials`: `static create(bind: Bind): PlayerCredentials`; `static fromRecord(raw: unknown): PlayerCredentials` (throws `CredentialRecordError`, no values quoted); `toRecord(): CredentialRecord` (`{ v: 1, sessionId, scenarioSha256, logIdentity, salt, roles: Record<string, { hash: string; name: string }> }`); `get logIdentity(): string`; `issue(roleId: string, name: string): string` (returns the plain credential once); `verify(roleId: string, presented: string | undefined): boolean` (constant time; same digest work when the role has none); `has(roleId): boolean`; `revoke(roleId): boolean`; `nameOf(roleId): string | undefined`; `names(): Record<string, string>`; `matches(bind: Bind): boolean`. `Bind = { sessionId: string; scenarioSha256: string }`.
  - `class ConsentStore`: `constructor(notice: { version: string; text: string }, initial?: Record<string, { noticeVersion: string; at: number }>)`; `give(roleId, noticeVersion, at): void` (throws `ConsentError("version_mismatch")`); `withdraw(roleId): boolean`; `has(roleId): boolean`; `snapshot(): Record<string, { noticeVersion: string; at: number }>`; `get notice()`; `toRecord(bind): ConsentRecord`; `static fromRecord(raw, notice, bind)` (drops entries whose version differs from `notice.version`).
  - `type Seats = { credentials: PlayerCredentials; consent: ConsentStore; persist(): void }` in `engine/seats.ts`.
  - `credentialsFileName(sessionId)`, `readCredentialsFile`, `writeCredentialsFile`, `removeCredentialsFile`; the same four for consent.

- [ ] **Step 1: Write failing tests.** `credentials.test.ts`: "issue returns a 32-hex credential and verify accepts only that one"; "verify is false for an unissued role, an AI role, empty and over-long input"; "revoke makes verify false and keeps other roles"; "toRecord holds no plain credential"; "fromRecord refuses an extra key, a bad salt, a bad hash and a wrong version"; "logIdentity is stable across toRecord and fromRecord"; "names returns the cleaned name per issued role". `consent.test.ts`: "give records version and time"; "give with another version throws version_mismatch"; "fromRecord drops entries under another notice version". `secure-json-file.test.ts` (private `mkdtemp`): "write is 0600 and atomic and leaves no temp file on a failing beforeCommit"; "read refuses a symlink, a hard-linked file, a non-regular file and an oversized file"; "read returns null when absent".
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/engine/__tests__/credentials.test.ts src/engine/__tests__/consent.test.ts src/engine/__tests__/secure-json-file.test.ts`; expect FAIL (modules missing).
- [ ] **Step 3: Implement** `secure-json-file.ts` by moving the open/fstat/read and temp-write/fsync/rename/fsync-dir logic out of `join-code-file.ts` (same flags: `O_NOFOLLOW`, `O_EXCL`, mode `0600`); make `join-code-file.ts` call it and map `SecureFileError.kind` to its existing messages. Implement the two classes with salted SHA-256 over `salt \0 roleId \0 value` as `JoinCodes` does (`engine/join-codes.ts`), and the dummy digest for absent roles.
- [ ] **Step 4: Run** the new tests plus `src/engine` and `src/host` suites; expect PASS with the join-code file tests untouched.
- [ ] **Step 5: Commit** `[feat] US-0053: credential and consent stores with a shared secure file helper`.

### Task 3: Join by credential, supersede, leave (US-0053)

**Files:**
- Modify: `host/protocol.ts`, `host/ws-server.ts`, `host/session-host.ts` (option `seats?: Seats`, methods `leave`), create `host/display-name.ts`
- Test: `host/__tests__/ws-server.credentials.test.ts` (new), `display-name.test.ts` (new), update `ws-server.join-codes.test.ts` where a join response now carries new fields

**Interfaces:**
- Consumes: `Seats`, `PlayerCredentials` (Task 2); `playerScope` (Task 1).
- Produces:
  - `protocol.ts`: `join` gains `issueCredential?: boolean`, `credential?: string` (1 to 64), `displayName?: string` (max 200 raw); client message `{ type: "leave" }`; `ServerMessage` `joined` gains `credential?: string` (only on the issuing join) and `logIdentity?: string`.
  - `CLOSE_SUPERSEDED = 4001` exported from `ws-server.ts`.
  - `host/display-name.ts`: `normalizeDisplayName(raw: string): string | null` (wraps `cleanText(raw, 60, "displayName", [])`, returns null on a `ReviewUsageError`; a name that is only hidden characters is null).
  - `SessionHost.leave(roleId: string, participantId: string): void` (revokes the credential, withdraws consent, releases the seat, persists).

- [ ] **Step 1: Write failing tests** in `ws-server.credentials.test.ts` using the existing join-code test harness: "first web join by code with issueCredential returns a credential and persists it"; "a dropped connection frees the seat and the credential rejoins without the code"; "the join code is refused once a credential exists for the role"; "a second join with the credential closes the first socket with code 4001"; "leave revokes the credential and frees the seat"; "a terminal join without issueCredential keeps working by code after a drop"; "a wrong credential counts only against its (address, role)"; "a name with a right-to-left override or only zero-width characters is refused as bad_message". `display-name.test.ts`: 60 code points accepted, 61 refused, trimmed, emoji kept, control characters refused.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/ws-server.credentials.test.ts src/host/__tests__/display-name.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Join algorithm in `ws-server.ts`: `byCredential = seats && m.credential && seats.credentials.verify(role, m.credential)`; `byCode` additionally requires `!seats?.credentials.has(role)`; refuse unless `byCode || byCredential || byReconnect`; when a live socket holds the role and the join is by credential or reconnect token, close it with `CLOSE_SUPERSEDED` then terminate after 250 ms (the old close handler already skips release because `holders` points at the new socket); when `m.issueCredential && byCode`, clean the name (`normalizeDisplayName`, default the role id when absent), `seats.credentials.issue`, `seats.persist()` BEFORE sending `joined`, and put the plain credential in `joined.credential`; always put `seats.credentials.logIdentity` in `joined`. A disconnect never revokes. `leave` calls `host.leave`, closes with code 1000.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host` and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0053: join by durable credential, supersede and leave`.

### Task 4: Credential and consent file lifecycle in the session store (US-0053)

**Files:**
- Modify: `engine/session-store.ts` (`OpenedSession.seats`, `settleCodes` neighbours, `rotate`, `discardIssuedCodes`), `main.ts` (pass `consentNotice`, `seats`), create `engine/consent-notice.ts` and `consent/notice-v1.md`
- Test: `engine/__tests__/session-store.seats.test.ts` (new), `__tests__/main.test.ts`, `__tests__/main.resume.test.ts`

**Interfaces:**
- Consumes: `Seats`, files from Task 2.
- Produces: `openSession` option `consentNotice: { version: string; text: string }`; `OpenedSession.seats: Seats`; `loadConsentNotice(root: string, version: string): { version: string; text: string }` (throws `Error` with a message that never quotes file content when the file is missing, over 4,000 characters or has control characters); `consent/notice-v1.md` states what is recorded, who can see results (this version: the participant and the facilitator only), that some roles may be played by an AI, and how to leave.

- [ ] **Step 1: Write failing tests** `session-store.seats.test.ts` (private `mkdtemp`, fake clock): "a new session creates credentials and consent files with a log identity"; "resume keeps credentials and consent that match the scenario and notice version"; "a start that finds an empty log and issues new codes discards credentials and consent"; "a fresh start and an ended-session rotation remove both files before the new session opens"; "consent under another notice version is dropped on resume"; "a credentials file with an extra key makes openSession fail with SessionStoreError and changes nothing"; "persist refuses when the lock was lost". `main.test.ts`: "bootstrap fails with a clear message when the consent notice file is missing"; "CONSENT_NOTICE_VERSION with a bad value is refused".
- [ ] **Step 2: Run** the store and main tests; expect FAIL.
- [ ] **Step 3: Implement** `settleSeats(keepCodes: boolean)` called next to every `settleCodes`: keep the files only when codes were kept and both match the bind and the notice version, else create new ones; `rotate` removes both files before the log moves; `persist()` writes both with `holdLockNow` as `beforeCommit`; `discardIssuedCodes` also removes the seat files it created. `main.ts` reads `CONSENT_NOTICE_VERSION` (1 to 32 characters of `[A-Za-z0-9._-]`, default `v1`), loads the notice from `<root>/consent/`, passes `seats: store.seats` to `SessionHost`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/engine src/__tests__/main.test.ts src/__tests__/main.resume.test.ts`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0053: keep credentials and consent files across resume and rotation`.

### Task 5: Log format 2 and the session.started fields (US-0054)

**Files:**
- Modify: `packages/events/src/events.ts` (`LOG_FORMAT = 2`, `session.started` gains optional `consents`, `names`, `logIdentity`), `engine/session-engine.ts` (`start(assignments, extra?)`, restore accepts formats 0 to 2), `host/session-host.ts` (`viewFor` redaction)
- Test: `engine/__tests__/session-engine.test.ts`, `host/__tests__/session-host.test.ts`, `packages/events` tests

**Interfaces:**
- Produces: `SessionStartExtra = { consents?: Record<string, { noticeVersion: string; at: number }>; names?: Record<string, string>; logIdentity?: string }`; `SessionEngine.start(assignments: Record<string, string>, extra?: SessionStartExtra): Promise<void>`.

- [ ] **Step 1: Write failing tests:** "a format 2 log restores"; "a format 1 log without the new fields restores"; "a format 3 log is refused with a log_format RestoreError"; "start with extra writes consents, names and logIdentity into session.started"; in `session-host.test.ts` "viewFor gives a player only their own consent and no names or log identity" and "the facilitator sees all of them".
- [ ] **Step 2: Run** `pnpm --filter @acr/events exec vitest run` and the engine and host tests; expect FAIL.
- [ ] **Step 3: Implement.** In `viewFor` for `session.started`: `const { consents, names, logIdentity, ...rest } = e` and return `{ ...rest, roles: redactRoles(e.roles), ...(consents?.[who] ? { consents: { [who]: consents[who] } } : {}) }`. The reducer keeps ignoring the new fields.
- [ ] **Step 4: Run** the three suites and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0054: log format 2 with consents, names and log identity`.

### Task 6: Consent messages and the start gate (US-0054)

**Files:**
- Modify: `host/protocol.ts`, `host/session-host.ts` (`start`, `giveConsent`, `withdrawConsent`, `HostError`), `host/ws-server.ts`
- Test: `host/__tests__/ws-server.consent.test.ts` (new), `session-host.test.ts`

**Interfaces:**
- Consumes: `Seats` (Task 2), `SessionStartExtra` (Task 5).
- Produces: client messages `{ type: "consent", noticeVersion: string }` (1 to 32) and `{ type: "withdraw_consent" }`; `joined` gains `consent?: { noticeVersion: string; notice: string; given: boolean }` for players; `HostError` codes `seats_not_ready` (message `seats_not_ready: role1,role2`), `consent_version`, `already_started`; `SessionHost.giveConsent(roleId, participantId, noticeVersion): void`; `SessionHost.withdrawConsent(roleId, participantId): void` (revokes the credential, frees the seat, persists).

- [ ] **Step 1: Write failing tests:** "start is refused with seats_not_ready naming the roles that are missing a join or a consent"; "the auto-start inside a facilitator command is refused the same way"; "start succeeds once every player role has joined and consented and writes the consents and names into session.started"; "consent with another version is refused as consent_version"; "consent after the start is refused as already_started"; "withdrawing consent removes it, revokes the credential and frees the seat"; "a player sees only their own consent in joined"; "a session host built without seats starts as before" (embedder path).
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host`; expect FAIL.
- [ ] **Step 3: Implement.** Gate inside `SessionHost.start` before `engine.start` (so every route is covered); missing = player roles where `!assignments[r] || !seats.consent.has(r)`; pass `{ consents: seats.consent.snapshot(), names: seats.credentials.names(), logIdentity: seats.credentials.logIdentity }` to `engine.start`. Persist after every consent change.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host src/engine`; expect PASS (other suites are fixed in Task 7).
- [ ] **Step 5: Commit** `[feat] US-0054: recorded consent and the start gate`.

### Task 7: Terminal /consent, demos and existing tests (US-0054)

**Files:**
- Modify: `cli/commands.ts` (`/consent`, `/withdraw`), `cli/client.ts`, `cli/render.ts` (print the notice from `joined.consent`), `demo/ctx.ts` (`playerConsent`), the demo rooms that send `start` (`demo/lab.ts`, `resume.ts`, `security.ts`, `audit.ts`, `showcase.ts`, `story.ts`), generated-player setup, and every test that joins players and then starts a session
- Create: `services/runtime/src/__tests__/consent-helper.ts`
- Test: `cli/__tests__/commands.test.ts`, `client.test.ts`, the suites below

**Interfaces:**
- Produces: `consentAll(clients: { send(m: unknown): void }[], noticeVersion?: string): void` test helper (default `"v1"`); `playerConsent(ctx: Ctx, role: string): Record<string, unknown>` in `demo/ctx.ts` returning `{ type: "consent", noticeVersion: ctx.noticeVersion ?? "v1" }`.

- [ ] **Step 1: Write failing tests:** `commands.test.ts` "/consent sends the notice version the server announced" and "/consent before joining is refused locally"; `client.test.ts` "the notice is printed once after joined"; `checks.test.ts` count lists updated for the new demo steps only if a check is added.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/cli`; expect FAIL; then run the whole runtime suite and list the failing files (they fail because starts are now gated); that list is the work list for Step 3.
- [ ] **Step 3: Implement** `/consent` and `/withdraw` and notice rendering; add `playerConsent` and send it after each player `join` in the demo rooms and the generated-player harness; add `consentAll` to every failing test file's setup before `start`. Do not change any assertion other than adding the consent step; if a count or transcript changes, stop and explain it in the commit body.
- [ ] **Step 4: Run** `pnpm test:coverage`, then `pnpm demo --fast`, `pnpm demo --fast --security`, `pnpm demo --fast --resume`, `pnpm demo --showcase --fast` and `pnpm demo --showcase --fast --evaluate`; expect the same check counts as before (29, 42, 39, 14, 16, see `docs/memory/demo-and-testing.md`).
- [ ] **Step 5: Commit** `[feat] US-0054: terminal /consent and consent in demos and tests`.

### Task 8: Display name and roster frames (US-0055)

**Files:**
- Create: `host/roster.ts`; modify `host/protocol.ts`, `host/ws-server.ts`, `cli/render.ts`
- Test: `host/__tests__/roster.test.ts` (new), `ws-server.roster.test.ts` (new), `cli/__tests__/render.test.ts`

**Interfaces:**
- Produces: `type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean }`; `type PeerRosterEntry = { roleId: string; name?: string; ready: boolean }`; `buildRoster(input: { playerRoles: string[]; assignments: Record<string, string>; connected: ReadonlySet<string>; seats?: Seats }): { facilitator: FacilitatorRosterEntry[]; peers: PeerRosterEntry[] }`; `ServerMessage` `{ type: "roster"; audience: "facilitator"; entries: FacilitatorRosterEntry[] } | { type: "roster"; audience: "peers"; entries: PeerRosterEntry[] }`.

- [ ] **Step 1: Write failing tests:** `roster.test.ts` "ready means joined and consented"; "AI characters are not listed"; "a terminal player has no name"; `ws-server.roster.test.ts` "a roster frame goes to every connection on join, consent, withdraw, leave and disconnect"; "a player never receives the facilitator roster"; "names are never written to the server log" (capture `log`); `render.test.ts` "the roster renders as role and state only, never a name".
- [ ] **Step 2: Run** the three files; expect FAIL.
- [ ] **Step 3: Implement.** Names come only from `seats.credentials.nameOf`. The server broadcasts after each change and logs `roster: <role> <state>` lines (role ids and states only). Peers see names; the facilitator frame carries the same names. Recorded in the threat model in Task 15.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host src/cli`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0055: roster frames and typed display names`.

### Task 9: Player projection and scene info (US-0055)

**Files:**
- Create: `packages/events/src/player-view.ts`; modify `packages/events/src/index.ts`, `host/protocol.ts` and `host/ws-server.ts` (`joined.scenes`)
- Test: `packages/events/src/__tests__/player-view.test.ts`, `host/__tests__/ws-server.test.ts`

**Interfaces:**
- Produces: `type PlayerScene = { id: string; title: string; goal: string; timeBoxMinutes: number }` (only scenes the player takes part in) carried in `joined.scenes`; `type PlayerView = { lastSeq: number; status: SessionState["status"]; paused: boolean; scene: { id: string; enteredAt: number; pausedMs: number } | null; transcript: PlayerLine[]; injects: { seq: number; content: string; sceneId: string }[]; ended: { reason: string } | null }` with `PlayerLine = { seq: number; ts: number; roleId: string; text: string; sceneId: string | null }`; `initPlayerView(snapshot: SessionState): PlayerView`; `applyPlayerEvent(view: PlayerView, e: SessionEvent): PlayerView` (pure; never throws on a seq gap; ignores `e.seq <= view.lastSeq`).

- [ ] **Step 1: Write failing tests:** "initPlayerView takes the redacted snapshot as is"; "applyPlayerEvent skips a gap and keeps going"; "a duplicate seq is ignored"; "a pause and resume toggle paused and pausedMs follows the engine rule"; "session.ended sets ended"; "an event type the view does not know is ignored, not thrown"; runtime: "joined lists only the scenes the player takes part in".
- [ ] **Step 2: Run** `pnpm --filter @acr/events exec vitest run` and the host test; expect FAIL.
- [ ] **Step 3: Implement** mirroring the relevant cases of `reduce` in `packages/events/src/state.ts` without its seq check.
- [ ] **Step 4: Run** both suites and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0055: gap-tolerant player view and scene info in joined`.

### Task 10: apps/web scaffold, workspace and CI (US-0056)

**Files:**
- Create: `apps/web/package.json` (`@acr/web`), `tsconfig.json`, `next.config.ts` (security headers, `serverExternalPackages: ["ws"]`), `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx` (redirects to `/join`), `eslint` config entry
- Modify: `pnpm-workspace.yaml` (add `"apps/*"`), root `package.json` scripts (`web:dev`, `web:test`), `.github/workflows/ci.yml` (typecheck, test and a `web-e2e` job with `pnpm exec playwright install --with-deps chromium`), `.env.example`, `findings.md`
- Test: `apps/web/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: workspace package `@acr/web` with scripts `dev`, `build`, `typecheck`, `test`, `e2e`; dependencies `@acr/events: workspace:*` and pinned `next`, `react`, `react-dom`, `ws`, `@types/ws`, `@playwright/test`, `@axe-core/playwright`, `vitest`.

- [ ] **Step 1: Write the failing smoke test:** "the web package imports the shared player view" (`import { initPlayerView } from "@acr/events"`).
- [ ] **Step 2: Run** `pnpm install` then `pnpm --filter @acr/web test`; expect FAIL before the scaffold exists.
- [ ] **Step 3: Implement** the scaffold; record each dependency in `findings.md`; `pnpm install --frozen-lockfile` must succeed after committing the lockfile.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm --filter @acr/web build`, `pnpm lint:sdk`, `npx eslint .`; expect PASS.
- [ ] **Step 5: Commit** `[chore] US-0056: scaffold the Next.js web app and its CI jobs`.

### Task 11: BFF core modules (US-0056)

**Files:**
- Create: `apps/web/src/server/config.ts`, `seal.ts`, `envelope.ts`, `throttle.ts`, `guards.ts`
- Test: `apps/web/src/server/__tests__/*.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): Config` with `{ runtimeUrl: string; publicOrigin: string; cookieKeys: { id: string; key: Buffer }[]; maxStreams: number; maxStreamsPerSession: number }`, throwing a message that never quotes a value.
  - `seal(payload: unknown, keys: Config["cookieKeys"], now: number): string` and `unseal<T>(token: string, keys: Config["cookieKeys"], now: number): T | null` (AES-256-GCM, `keyId.nonce.ciphertext.tag` base64url, payload carries `expiresAt`; null when tampered, expired or the key id is unknown).
  - `ok<T>(data: T): Response`, `fail(status: number, code: string, message: string): Response` (the envelope from Global Constraints).
  - `class JoinThrottle` (`constructor(o: { max: number; windowMs: number; blockMs: number; now: () => number })`, `fail(ip: string, role: string): void`, `blockedForMs(ip: string, role: string): number`).
  - `checkOrigin(req: Request, publicOrigin: string): boolean` (Origin equals and `X-Requested-With: scenecoach` present); `checkFetchSite(req: Request): boolean`; `clientAddress(req: Request): string` (the last `X-Forwarded-For` entry, up to 64 characters, else `"unknown"`).

- [ ] **Step 1: Write failing tests:** "seal and unseal round-trip"; "unseal returns null for a flipped byte, an expired payload and an unknown key id"; "a rotated key still opens a cookie sealed with the older key while newest seals"; "loadConfig refuses a short key and a missing PUBLIC_ORIGIN without quoting them"; "fail uses the envelope with a timestamp and version 1.0"; "JoinThrottle blocks one (address, role) and not another"; "checkOrigin is false without the custom header"; "clientAddress takes the last entry".
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement** with `node:crypto`; keys are 32 bytes base64.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test` and `typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: BFF config, sealed cookie, envelope, guards and throttle`.

### Task 12: Runtime connection, stream hub and routes (US-0056)

**Files:**
- Create: `apps/web/src/server/runtime-connection.ts`, `stream-hub.ts`, `handlers.ts`, `headers.ts`; route files `src/app/api/v1/join/route.ts`, `stream/route.ts`, `say/route.ts`, `consent/route.ts`, `leave/route.ts`; `src/app/robots.ts`; `src/middleware.ts`
- Test: `apps/web/src/server/__tests__/handlers.test.ts` (fake runtime), `handlers.runtime.test.ts` (real runtime in mock mode, started in-process on port 0)

**Interfaces:**
- Consumes: Task 11 modules; runtime protocol (Tasks 3, 6, 8).
- Produces:
  - `class RuntimeConnection`: `static connect(url: string, clientAddress: string): Promise<RuntimeConnection>` (sets `X-Forwarded-For`); `joinWithCode(a: { sessionId; roleId; participantId; joinCode; displayName }): Promise<JoinedFrame>` (sends `issueCredential: true`); `joinWithCredential(a: { sessionId; roleId; participantId; credential; lastSeq? }): Promise<JoinedFrame>`; `send(m: ClientMessage): void`; `onFrame(fn): () => void`; `onClose(fn: (code: number) => void): () => void`; `close(): void`.
  - `type SessionCookie = { sessionId: string; roleId: string; participantId: string; credential: string; logIdentity: string; expiresAt: number }`.
  - Handlers (each `(req: Request, deps: Deps) => Promise<Response>`): `handleJoin`, `handleStream`, `handleSay`, `handleConsent`, `handleLeave`; `Deps = { config: Config; now: () => number; connect: typeof RuntimeConnection.connect; joinThrottle: JoinThrottle; hub: StreamHub }`.
  - `StreamHub`: `open(cookie: SessionCookie, conn: RuntimeConnection, send: (chunk: string) => void, close: () => void): { close(): void }`; one stream per participant (a second one closes the first with an SSE frame `event: superseded`); caps `maxStreams` and `maxStreamsPerSession` (else 503 envelope); heartbeat comment every 15 s via an injected timer; SSE `id:` is the event seq; a `reset` frame carries a fresh `PlayerView` whenever `joined.replay.complete` is false or the log identity differs; no reconnect on close code 4001 (sends `event: superseded` and ends).

- [ ] **Step 1: Write failing tests** against both a scripted fake runtime and the real one: "join with a right code sets a sealed HttpOnly SameSite=Lax cookie and never returns the code or credential in the body"; "every join refusal returns the same envelope and status"; "join is throttled per address and role before the runtime is contacted"; "stream without a cookie, with a tampered cookie, with an expired cookie and with another session's cookie is 401 with the neutral envelope"; "stream rejects Sec-Fetch-Site cross-site"; "say, consent and leave reject a missing Origin or custom header"; "stream resumes from Last-Event-ID without a gap or duplicate after a socket drop"; "a Last-Event-ID beyond the head or from another log identity yields a reset frame"; "a second stream for the same participant ends the first with a superseded event and the first does not reconnect"; "the stream forwards nothing a player may not see (scan every frame for facilitator-only event types, hidden facts, codes and credentials)"; "the stream cap returns 503"; "robots.txt disallows the private prefixes and every private route sends X-Robots-Tag".
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement.** Route files only re-export (`export { handleJoin as POST } ...` with `runtime = "nodejs"`, `dynamic = "force-dynamic"`); the cookie is re-sealed with the same expiry; `participantId` is `crypto.randomUUID()` minted at join; the stream handler rejoins with the credential and `lastSeq = Number(Last-Event-ID)`; on `unauthorized` it deletes the cookie and sends an `event: signed_out`; reconnect backoff uses an injected timer.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test` and `typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: runtime bridge, SSE stream and v1 routes`.

### Task 13: Pages and components (US-0056)

**Files:**
- Create: `apps/web/src/app/join/page.tsx`, `session/[id]/page.tsx`, `src/components/*` (`AppHeader`, `TitleBlock`, `StatusChip`, `JoinForm`, `ConsentPanel`, `Roster`, `Transcript`, `SayBox`, `BriefPanel`, `SceneStatus`), `src/lib/use-session.ts` (EventSource, reset handling, reconnect banner), `src/lib/tokens.css` (minimal tokens until EPIC-0007)
- Test: `apps/web/src/lib/__tests__/use-session.test.ts`, component tests with Testing Library

**Interfaces:**
- Consumes: Task 12 routes; `applyPlayerEvent`, `initPlayerView` (Task 9).
- Produces: pages as in the mockups: `/join?session=<id>&role=<role>` (code, name, consent), lobby wait with the peer roster, session view with transcript, say box, brief and facts, scene title, goal and timer (`timeBoxMinutes` from `joined.scenes`, `enteredAt` and `pausedMs` from the view), Reconnecting banner, "open in another tab" and "ask your facilitator for a new code" messages.

- [ ] **Step 1: Write failing tests:** "a transcript line containing HTML renders as text"; "a display name with markup renders as text in the roster"; "the reconnect banner appears after a dropped stream and clears after reset"; "the superseded message stops reconnecting"; "the say box is disabled while paused and after the end"; "the timer shows the remaining time from enteredAt, pausedMs and timeBoxMinutes using an injected clock".
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement** with semantic HTML, visible focus, labelled controls, a 16 px gutter, no horizontal scroll at 400 px, light and dark tokens; no `dangerouslySetInnerHTML` anywhere (a lint rule or a test greps for it).
- [ ] **Step 4: Run** `pnpm --filter @acr/web test`, `typecheck` and `build`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: join, consent, lobby and session view pages`.

### Task 14: End-to-end tests and web demo (US-0065)

**Files:**
- Create: `apps/web/e2e/participant-flow.spec.ts`, `e2e/axe.spec.ts`, `e2e/helpers/start-stack.ts`, `apps/web/src/demo/web-demo.ts`; modify `services/runtime/src/demo/run.ts` (`--web` spawns `pnpm --filter @acr/web demo`), `README.md`, `docs/memory/demo-and-testing.md`
- Test: the specs above; `apps/web/src/server/__tests__/handlers.runtime.test.ts` already covers the real-runtime contract

**Interfaces:**
- Produces: `startStack(): Promise<{ baseUrl: string; runtimeUrl: string; codes: Record<string, string>; terminalFacilitator: { start(): Promise<void>; command(c: unknown): Promise<void> }; restartBff(): Promise<void>; dropSocket(role: string): void; stop(): Promise<void> }` (runtime in mock mode on port 0 with `TRUST_PROXY=1`, `next start` on a free port, injected `COOKIE_KEYS`, `PUBLIC_ORIGIN`); `pnpm demo --web` prints checks `W-01` to `W-08` and exits 0.

- [ ] **Step 1: Write failing specs:** `participant-flow.spec.ts` "three players join with names and consent, the terminal facilitator starts, everyone speaks, one drop recovers, a BFF restart recovers, and a fourth tab supersedes the first"; "start is refused while one player has not consented and the page shows the roster state"; `axe.spec.ts` "no serious or critical Axe violations on /join, the lobby and the session view, in light and dark" and "no horizontal scroll at 400 px". Demo checks: W-01 join sets a cookie, W-02 stream delivers the opening scene, W-03 say reaches the transcript, W-04 drop and replay without gap, W-05 BFF restart keeps the seat, W-06 superseded, W-07 no facilitator-only data on the stream, W-08 robots and noindex.
- [ ] **Step 2: Run** `pnpm --filter @acr/web e2e`; expect FAIL (stack helper missing). Use the pre-installed browser: when the project pins a different Playwright, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- [ ] **Step 3: Implement** the helper and demo; reconnect waits use `expect.poll`, never fixed sleeps; no assertion on elapsed time; explicit generous timeouts (`test.setTimeout(90_000)`).
- [ ] **Step 4: Run** `pnpm --filter @acr/web e2e`, `pnpm demo --web`, `pnpm test:coverage` twice (once under `yes > /dev/null` x8) and the new filesystem and process tests in the `node:22` container recipe from `docs/memory/demo-and-testing.md`; expect PASS and coverage at least 80 percent.
- [ ] **Step 5: Commit** `[test] US-0065: Playwright flow, Axe checks and pnpm demo --web`.

### Task 15: Documentation, threat model and bookkeeping

**Files:**
- Modify: `docs/THREAT_MODEL.md` (new web section: BFF boundary, sealed cookie, credential file, peers seeing typed names, `TRUST_PROXY` and per-role throttles, SSE denial of service, confused-deputy rule), `docs/ARCHITECTURE.md` section 6 (player projection instead of the shared reducer), `docs/ROLLBACK.md` (older runtime refuses format 2), `README.md` and `.env.example` (new variables), `CHANGELOG.md` `[Unreleased]`, `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md` (tick ACs, statuses), `docs/ID_REGISTRY.md` (TC ids), `progress.md`, `MEMORY.md` and `docs/memory/*`, `docs/LESSONS.md`

- [ ] **Step 1: File the test cases** (two or more per story, ids from `docs/ID_REGISTRY.md`, updated first) covering the Review Focus items and every AC.
- [ ] **Step 2: Write the docs** listed above; the threat-model section states what the cookie and credential do and do not protect.
- [ ] **Step 3: Run** `node tools/generate-plan.js` (after `npm ci`), `npx eslint .`, `pnpm lint:sdk`, `npm run plan:test`; expect PASS.
- [ ] **Step 4: Session close** per `AGENTS.md` section 14: coverage summary and results to `progress.md`, `MEMORY.md`, lessons.
- [ ] **Step 5: Commit** `[docs] US-0056: web client documentation and bookkeeping`.

---

## Clarifications to the spec found while planning

1. A join issues a credential only when the client asks (`issueCredential: true`, sent by the BFF). Terminal clients keep joining by code after a drop, as today, so the rule "the code stops working once a credential exists" applies to web seats only.
2. `pnpm demo --web` is implemented as a flag on the existing demo runner that spawns the web package's demo script, so the runtime package does not import from `apps/web`.
3. The consent notice text is read by the runtime from `consent/notice-<version>.md` and sent to clients in `joined.consent`, so the terminal and the BFF share one source.
4. `joined.scenes` is added so the browser can show scene title, goal and timer for scenes the player takes part in.
