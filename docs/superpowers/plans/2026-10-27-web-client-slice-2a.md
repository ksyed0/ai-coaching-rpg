# Web Client Slice 2a (Platform and Participant) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant joins a session from a link in a browser with a join code and a typed name, gives recorded consent, plays as text, survives a dropped connection or a backend restart, and the session cannot start until every human seat has consented. A session is still started from the terminal in this slice.

**Architecture:** The runtime gains a durable per-player credential, a consent store and start gate, display names, roster frames and per-(address, role) login throttles. A new `apps/web` Next.js app holds a stateless backend-for-frontend (BFF): a sealed cookie carries the credential, the BFF keeps one runtime WebSocket per participant and bridges it to the browser as server-sent events. Browser state is a gap-tolerant player projection that lives in `packages/events`. All BFF logic is plain `Request` to `Response` modules; Next route files only re-export them.

**Tech Stack:** TypeScript (NodeNext, strict), Node 22, `ws`, `zod` 4, Vitest, pnpm workspace; Next.js (App Router, Node runtime), `@playwright/test`, `@axe-core/playwright`.

**Spec:** `docs/superpowers/specs/2026-10-26-web-client-design.md` (sections 3, 4, 5.1 to 5.5, 6, 8, 9, 10). Stories: US-0052 to US-0056 and US-0065 in `docs/RELEASE_PLAN.md` (AC-0266 to AC-0299; story tasks TASK-0080 to TASK-0084 and TASK-0085; the numbered tasks below are work items). Reviewed by two independent Opus passes on 2026-10-27; findings are folded in.

## Global Constraints

- Credential: 128 bits from a CSPRNG, hex (32 characters), stored only as a salted SHA-256 beside the display name and log identity in `<id>.credentials.json`, mode `0600`, written by atomic rename under the session lock on every issue and revoke; never in the join-codes record and never copied into `review.opened`. Maximum accepted input: 64 characters.
- Consent file `<id>.consent.json`, mode `0600`, same writer. Each entry stores the `participantId` that gave it; a consent counts only for that participant. Notice version from `CONSENT_NOTICE_VERSION` (default `v1`), text from `consent/notice-<version>.md` (at most 4,000 characters, no control characters); a version mismatch is refused; entries under another version are dropped on resume.
- `displayName`: 1 to 60 code points, cleaned with `cleanText(raw, 60, "displayName", [])` (`review/text.ts`: it strips hidden, bidirectional and control characters and keeps `\n` and `\t`); a name that is empty after cleaning, or that contains `\n` or `\t`, is refused as `bad_message`. The check runs before authentication and is not charged to any throttle. Never printed to stdout or logs and never in a model prompt.
- Close code `4001` `superseded`: a second join with the credential took the seat. The BFF must not reconnect on it.
- `LOG_FORMAT` becomes `2`; the reader accepts 0, 1 and 2; an older runtime refuses 2 (`session-engine.ts` restore) and `docs/ROLLBACK.md` says so.
- Throttle: failed logins are counted per (address, scope): `player:<roleId>` for a wrong join code for a known player role, `player:*` for any other role id, `cred:<roleId>` for a refused credential, `""` for the facilitator token (handshake-level, as today). More than 5 failures in 60 s block 60 s. Set `WS_MAX_CONNECTIONS_PER_IP` and `WS_MAX_CONNECTIONS` for the deployment.
- Cookie: HttpOnly, Secure, SameSite=Lax, `Path=/`, sealed with AES-256-GCM, key id prefix for rotation (`COOKIE_KEYS=id:base64key,...`, newest first). Lifetime `COOKIE_MAX_AGE_HOURS` (default 12); cleared when `session.ended` arrives.
- API: all routes under `/api/v1/`, response envelope `{ "success": boolean, "data": object | null, "error": { "code": string, "message": string } | null, "meta": { "version": "1.0", "timestamp": "<ISO8601>" } }` (`AGENTS.md` section 15). Identity only from the cookie, never the request body. State-changing requests check `Origin` equals `PUBLIC_ORIGIN` and header `X-Requested-With: scenecoach`. The stream route also checks `Sec-Fetch-Site` is `same-origin` or `none`.
- Private routes (`/join`, `/session`, `/report`, `/console`, `/admin`, `/api`) send `X-Robots-Tag: noindex, nofollow` and are disallowed in `robots.txt`. Content-Security-Policy is built per request in `src/middleware.ts` with a nonce (a static policy would block the App Router's inline bootstrap scripts), and pages render dynamically. All server text is rendered as text.
- Dependencies pinned to exact versions (no `^`, `~`), each recorded in `findings.md` (created in Task 10) with name, version, purpose, licence and last-active date. Pick the current stable release at least two weeks old.
- Tests: at least 80 percent coverage on new code; no absolute-time assertions (`test-hygiene.test.ts` fails on them); inject clocks; private `mkdtemp` directories; generous explicit timeouts for socket and process tests; CI runs Ubuntu, so run new filesystem, lock and process tests once in the `node:22` container before pushing. A test marked "regression guard" passes before and after its change; every other new test must be seen failing first.
- Commit format `[TYPE] US-00XX: description` (max 72 characters); branch per story, `feature/EPIC-0002-US-00XX-<slug>`. Merge into `develop` by PR and only when the owner says so, with every required check green (CI lists 14 today; the new `web-e2e` job is added in Task 10).
- Each task that changes user-visible behaviour adds its line under `[Unreleased]` in `CHANGELOG.md` in the same PR.
- Demo check counts: before changing anything, run each demo on `develop` and record the counts (`docs/memory/demo-and-testing.md` and `MEMORY.md` disagree on some); after the plan every demo must report the same counts.

## Review Focus

1. A player opens a second tab or double-clicks Join: exactly one connection holds the seat, the older one shows "open in another tab" and does not fight back (Task 3 simultaneous-join test, Task 12, Task 14).
2. A display name with a right-to-left override, zero-width characters, HTML, Markdown link syntax, 61 code points, only spaces, or a newline: stored cleaned or refused with a plain message, never rendered as markup, never in a model prompt (Tasks 3, 8, 14).
3. The runtime restarts: after the start everything is kept and the session resumes paused; before the start, with an empty log and new codes, credentials and consent are discarded and the player sees "ask your facilitator for a new code" (Tasks 4, 12, 14).
4. A stream client that disconnects mid-replay, sends `Last-Event-ID` beyond the head, or one from before a fresh start (different log identity): the player view resets to a fresh snapshot, never shows a gap or a duplicate, and an aborted request closes its runtime socket (Tasks 9, 12, 13).
5. A tampered, expired or other-session cookie, a request without `Origin` or the custom header, a join code typed in lower case with spaces and hyphens (passed to the runtime unchanged), and six wrong codes from an office address while a colleague joins (Tasks 1, 11, 13).

## File Structure

Runtime (`services/runtime/src`):
- `engine/secure-json-file.ts` (new): the one safe read, write and remove for small owner-only JSON files, extracted from `join-code-file.ts`.
- `engine/credentials.ts`, `engine/consent.ts`, `engine/seats.ts` (new): `PlayerCredentials`, `ConsentStore`, the `Seats` bundle.
- `engine/credentials-file.ts`, `engine/consent-file.ts` (new): file names, read, write, remove, temp sweep.
- `engine/consent-notice.ts` (new): `loadConsentNotice`.
- `engine/session-store.ts`, `main.ts` (modify): file lifecycle, wiring, `CONSENT_NOTICE_VERSION`, `bootstrap({ consentDir })`.
- `host/session-host.ts`, `host/ws-server.ts`, `host/protocol.ts` (modify); `host/roster.ts`, `host/display-name.ts` (new).
- `host/security.ts` (modify): scoped `AuthThrottle`.
- `cli/commands.ts`, `cli/client.ts`, `cli/render.ts` (modify): `/consent`, notice, roster line.
- `demo/ctx.ts`, `demo/harness.ts`, `demo/audit.ts`, `demo/lab.ts` and the other rooms (modify); `demo/args.ts`, `demo/runner.ts` (the `--web` flag).
- `consent/notice-v1.md` at the repo root (new); `deploy/compose/Dockerfile.runtime` (copy `consent/`).

Shared (`packages/events/src`): `events.ts` (modify), `player-view.ts` (new).

Web (`apps/web`, new): `src/server/*` (BFF modules), `src/app/**` (Next files), `src/lib/*` (browser helpers), `src/components/*`, `e2e/*`.

## Branches and pull requests

One branch and PR per story, stacked in this order: US-0052 (Task 1), US-0053 (Tasks 2 to 4), US-0054 (Tasks 5 to 7), US-0055 (Tasks 8, 9), US-0056 (Tasks 10 to 14), US-0065 (Task 15); Task 16 rides the last PR. Per `docs/memory/process.md`: merge the base first, then bring `develop` into the next branch with `git merge origin/develop` (registry max-merge runbook); never rewrite pushed history. Move each story to In Progress and file its test cases (TC ids from `docs/ID_REGISTRY.md`) when its branch starts.

---

### Task 1: Per-(address, role) failed-login throttle (US-0052)

**Files:**
- Modify: `services/runtime/src/host/security.ts` (`AuthThrottle`), `services/runtime/src/host/ws-server.ts` (`refuseLogin`, `dropAfterClose` including its parse path, player join)
- Test: `host/__tests__/security.test.ts`, `ws-server.join-codes.test.ts`, `ws-server.security.test.ts`; the `CountingThrottle` subclasses in `ws-server.join-codes.test.ts` and `ws-server.replay.test.ts` must pass the scope on to `super`

**Interfaces:**
- Produces: `AuthThrottle.fail(ip: string, scope?: string): void`; `AuthThrottle.blockedForMs(ip: string, scope?: string): number`; in `ws-server.ts` `playerScope(known: boolean, roleId: string): string` (`player:<roleId>` or `player:*`); `SessionHost.hasPlayerRole(roleId: string): boolean` (public accessor; `scenario` is private). The default scope `""` behaves exactly as today.

- [ ] **Step 1: Write failing tests.** `security.test.ts`: "AuthThrottle: failures in one scope do not block another scope of the same address" (6 `fail(ip, "player:a")`; then `blockedForMs(ip, "player:a") > 0`, `blockedForMs(ip, "player:b") === 0`, `blockedForMs(ip) === 0`); "AuthThrottle: the default scope still blocks the address" (regression guard). `ws-server.join-codes.test.ts`: "six wrong codes for one role do not refuse another role from the same address"; "nine players join from one address when the per-address cap allows it" (build a scenario fixture with nine player roles and `limits.maxConnectionsPerIp: 64`; the `minimal` fixture has one); "a blocked (address, role) is refused with the same unauthorized without checking the code" (injected clock); "an unknown role id is counted under player:* and cannot fill the map" (bounded by the existing entry cap). Update the existing test that expects player failures to block the whole address.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host`; confirm the new tests fail and only the intended old test needs changing.
- [ ] **Step 3: Implement** the scoped key in `AuthThrottle` (`${authKey(ip)}|${scope}`). In `ws-server.ts` give `refuseLogin(what: string, scope: string)` and a `failScope` variable used by both `dropAfterClose` paths (`:170` and `:178`); player login failures use `playerScope`; at join, before verifying, refuse when `authThrottle.blockedForMs(ip, scope) > 0`; the handshake check keeps scope `""`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host` and `pnpm typecheck`; expect all pass.
- [ ] **Step 5: Commit** `[feat] US-0052: throttle failed player logins per address and role`.

### Task 2: Secure file helper, PlayerCredentials, ConsentStore (US-0053)

**Files:**
- Create: `engine/secure-json-file.ts`, `engine/credentials.ts`, `engine/credentials-file.ts`, `engine/consent.ts`, `engine/consent-file.ts`, `engine/seats.ts`
- Modify: `engine/join-code-file.ts` (use the helper; exports and error messages unchanged)
- Test: `engine/__tests__/credentials.test.ts`, `consent.test.ts`, `secure-json-file.test.ts`; existing `join-code-file` tests unchanged

**Interfaces:**
- Produces:
  - `readSecureJson(dir: string, fileName: string, o: { maxBytes: number }): unknown | null` (null when absent; throws `SecureFileError` with `kind: "symlink" | "not_file" | "links" | "owner" | "size" | "json"`); `writeSecureJson(dir: string, fileName: string, value: unknown, beforeCommit?: SyncCheck): void`; `removeSecureFile(dir: string, fileName: string): void`; `sweepSecureTemps(dir: string, fileName: string): void` (removes leftover `<fileName>.*.tmp`, like `sweepJoinCodesTemps`).
  - `class PlayerCredentials`: `static create(bind: Bind): PlayerCredentials`; `static fromRecord(raw: unknown): PlayerCredentials` (throws `CredentialRecordError`, no values quoted); `toRecord(): CredentialRecord` (`{ v: 1, sessionId, scenarioSha256, logIdentity, salt, roles: Record<string, { hash: string; name: string }> }`); `get logIdentity(): string`; `issue(roleId: string, name: string): string` (returns the plain credential once); `verify(roleId: string, presented: string | undefined): boolean` (constant time; the same digest work when the role has none); `has(roleId): boolean`; `revoke(roleId): boolean`; `revokeAll(): string[]` (returns the roles revoked); `nameOf(roleId): string | undefined`; `names(): Record<string, string>`; `matches(bind: Bind): boolean`. `Bind = { sessionId: string; scenarioSha256: string }`.
  - `class ConsentStore`: `constructor(notice: { version: string; text: string }, initial?: Record<string, ConsentEntry>)` with `ConsentEntry = { participantId: string; noticeVersion: string; at: number }`; `give(roleId: string, participantId: string, noticeVersion: string, at: number): void` (throws `ConsentError("version_mismatch")`); `withdraw(roleId): boolean`; `has(roleId: string, participantId: string): boolean`; `snapshot(): Record<string, { noticeVersion: string; at: number }>` (no participant ids); `get notice()`; `toRecord(bind): ConsentRecord`; `static fromRecord(raw, notice, bind)` (drops entries whose version differs from `notice.version`).
  - `type Seats = { credentials: PlayerCredentials; consent: ConsentStore; persist(): void }` in `engine/seats.ts`.
  - `credentialsFileName(sessionId)`, `readCredentialsFile`, `writeCredentialsFile`, `removeCredentialsFile`; the same four for consent.

- [ ] **Step 1: Write failing tests.** `credentials.test.ts`: "issue returns a 32-hex credential and verify accepts only that one"; "verify is false for an unissued role, an AI role, empty and over-long input"; "revoke makes verify false and keeps other roles"; "revokeAll empties every role"; "toRecord holds no plain credential"; "fromRecord refuses an extra key, a bad salt, a bad hash and a wrong version"; "logIdentity is stable across toRecord and fromRecord"; "names returns the cleaned name per issued role". `consent.test.ts`: "give records participant, version and time"; "give with another version throws version_mismatch"; "has is false for a different participant than the one who consented"; "fromRecord drops entries under another notice version"; "snapshot carries no participant id". `secure-json-file.test.ts` (private `mkdtemp`): "write is 0600 and atomic and leaves no temp file after a failing beforeCommit"; "read refuses a symlink, a hard-linked file, a non-regular file and an oversized file"; "read returns null when absent"; "sweepSecureTemps removes only matching temp files".
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/engine/__tests__/credentials.test.ts src/engine/__tests__/consent.test.ts src/engine/__tests__/secure-json-file.test.ts`; expect FAIL (modules missing).
- [ ] **Step 3: Implement** `secure-json-file.ts` by moving the open, fstat and read and the temp-write, fsync, rename and fsync-directory logic out of `join-code-file.ts` (same flags: `O_NOFOLLOW`, `O_EXCL`, mode `0600`); make `join-code-file.ts` call it and map `SecureFileError.kind` to its existing messages. Implement the two classes with salted SHA-256 over `salt \0 roleId \0 value` as `JoinCodes` does (`engine/join-codes.ts`), including the dummy digest for absent roles. `engine/` must not import from `host/`.
- [ ] **Step 4: Run** the new tests plus `src/engine` and `src/host`; expect PASS with the join-code file tests untouched.
- [ ] **Step 5: Commit** `[feat] US-0053: credential and consent stores with a shared secure file helper`.

### Task 3: Join by credential, supersede, leave, end of session (US-0053)

**Files:**
- Modify: `host/protocol.ts`, `host/ws-server.ts`, `host/session-host.ts` (option `seats?: Seats`, `leave`, `endSeats`, `HostError` constructor), create `host/display-name.ts`
- Test: `host/__tests__/ws-server.credentials.test.ts` (new), `display-name.test.ts` (new); update `ws-server.join-codes.test.ts` where a join response now carries new fields

**Interfaces:**
- Consumes: `Seats`, `PlayerCredentials` (Task 2); scopes and `hasPlayerRole` (Task 1).
- Produces:
  - `protocol.ts`: `join` gains `issueCredential?: boolean`, `credential?: string` (1 to 64), `displayName?: string` (max 200 raw); client message `{ type: "leave" }`; `joined` gains `credential?: string` (only on the issuing join) and `logIdentity?: string`.
  - `CLOSE_SUPERSEDED = 4001` exported from `ws-server.ts`.
  - `normalizeDisplayName(raw: string): string | null` in `host/display-name.ts` (rules in Global Constraints).
  - `HostError` gains `constructor(code, roles?: string[])` so `message` is `code` or `code: role1,role2`.
  - `SessionHost.leave(roleId: string, participantId: string): void` (revokes the credential, withdraws consent, releases the seat, persists). `SessionHost.endSeats(): void` (revokes every credential and persists), called when the host sees `session.ended`.
  - `seats` is optional; with `joinCodes` off (embedders and tests) the credential paths are inactive.

- [ ] **Step 1: Write failing tests** in `ws-server.credentials.test.ts` using the existing join-code test harness: "first web join by code with issueCredential returns a credential and persists it before joined is sent"; "a dropped connection frees the seat and the credential rejoins without the code"; "the join code is refused once a credential exists for the role"; "a second join with the credential closes the first socket with code 4001"; "two simultaneous joins by code for one role: exactly one succeeds"; "leave revokes the credential and frees the seat"; "a wrong credential is counted under cred:<role> only and does not block the code path of another role"; "a persist failure releases the seat and answers internal"; "session.ended revokes every credential" ; "a name with a right-to-left override is stored stripped; a name that is only spaces, only zero-width characters or contains a newline is refused as bad_message and is not charged to any throttle". Regression guard: "a terminal join without issueCredential keeps working by code after a drop". `display-name.test.ts`: 60 code points accepted, 61 refused, trimmed, emoji kept, `\n` and `\t` refused.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/ws-server.credentials.test.ts src/host/__tests__/display-name.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.** Join algorithm in `ws-server.ts` (name validated first): `byCredential = seats && m.credential && seats.credentials.verify(role, m.credential)` (a refusal counts under scope `cred:<role>`); `byCode` additionally requires `!seats?.credentials.has(role)`; refuse unless `byCode || byCredential || byReconnect`; the live-seat check becomes `prevLive && !(byReconnect || byCredential)` (`ws-server.ts:253`); keep everything from `beyondHead` through `subscribe` synchronous; after `h.join`, when `m.issueCredential && byCode`, issue the credential, call `seats.persist()` in a try (on a throw: `h.release`, remove the holder, answer `internal`), then send `joined`; supersede a live holder by closing it with `CLOSE_SUPERSEDED` and terminating after 250 ms; a disconnect never revokes. `leave` calls `host.leave` and closes with 1000. `SessionHost` subscribes to its engine and calls `endSeats` on `session.ended`.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host` and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0053: join by durable credential, supersede, leave and end-of-session revoke`.

### Task 4: Credential and consent file lifecycle, notice, Docker image (US-0053)

**Files:**
- Modify: `engine/session-store.ts` (`OpenedSession.seats`, next to every `settleCodes`, `rotate`, `discardIssuedCodes`), `main.ts` (`bootstrap({ consentDir?: string })`, `CONSENT_NOTICE_VERSION`, pass `seats`), `deploy/compose/Dockerfile.runtime` (`COPY consent ./consent`), `.gitignore` and `.dockerignore` as needed
- Create: `engine/consent-notice.ts`, `consent/notice-v1.md`
- Test: `engine/__tests__/session-store.seats.test.ts` (new), `__tests__/main.test.ts`, `__tests__/main.resume.test.ts`, `review/__tests__` (moderate open)

**Interfaces:**
- Consumes: `Seats` and files from Task 2.
- Produces: `openSession` option `consentNotice: { version: string; text: string }`; `OpenedSession.seats: Seats`; `loadConsentNotice(dir: string, version: string): { version: string; text: string }` (throws an `Error` whose message never quotes file content when the file is missing, over 4,000 characters or has control characters); `bootstrap` option `consentDir?: string`, default `path.join(REPO_ROOT, "consent")` regardless of `root`, so the many tests that pass `root: tmp` keep working; `consent/notice-v1.md` states what is recorded, that in this version only the participant and the facilitator see results, that some roles may be played by an AI, and how to leave.

- [ ] **Step 1: Write failing tests** `session-store.seats.test.ts` (private `mkdtemp`, fake clock): "a new session creates credentials and consent files with a log identity"; "resume keeps credentials and consent that match the scenario and notice version"; "a start that finds an empty log and issues new codes discards credentials and consent"; "a fresh start and an ended-session rotation remove both files before the new session opens"; "consent under another notice version is dropped on resume"; "a missing credentials file on a resume takes the log identity from session.started and creates a new file"; "a credentials file with an extra key makes openSession fail with SessionStoreError and changes nothing"; "persist refuses when the lock was lost"; "leftover temp files of both files are swept at open". `main.test.ts`: "bootstrap fails with a clear message when the notice file is missing"; "CONSENT_NOTICE_VERSION with a bad value (not 1 to 32 characters of [A-Za-z0-9._-]) is refused"; "bootstrap with root set to a temp directory still finds the notice". Review: "moderate open copies no credential data into review.opened".
- [ ] **Step 2: Run** the store, main and review tests; expect FAIL.
- [ ] **Step 3: Implement** `settleSeats(keepCodes: boolean)` called next to every `settleCodes`: keep the files only when codes were kept and both match the bind and the notice version, else create new ones; `rotate` removes both files before the log moves; `persist()` writes both with `holdLockNow` as `beforeCommit`; `discardIssuedCodes` also removes the seat files it created. Load the notice in `bootstrap` before `openSession` and fail the start with a clear error.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/engine src/review src/__tests__/main.test.ts src/__tests__/main.resume.test.ts`; expect PASS. Build the Docker image locally if Docker is available (CI builds it).
- [ ] **Step 5: Commit** `[feat] US-0053: keep credentials and consent files across resume and rotation`.

### Task 5: Log format 2 and the session.started fields (US-0054)

**Files:**
- Modify: `packages/events/src/events.ts` (`LOG_FORMAT = 2`, `session.started` gains optional `consents`, `names`, `logIdentity`), `engine/session-engine.ts` (`start(assignments, extra?)`), `host/session-host.ts` (`viewFor`)
- Test: `engine/__tests__/session-engine.test.ts`, `host/__tests__/session-host.test.ts`, `packages/events` tests

**Interfaces:**
- Produces: `SessionStartExtra = { consents?: Record<string, { noticeVersion: string; at: number }>; names?: Record<string, string>; logIdentity?: string }`; `SessionEngine.start(assignments: Record<string, string>, extra?: SessionStartExtra): Promise<void>`.

- [ ] **Step 1: Write failing tests:** "a format 2 log restores"; "start with extra writes consents, names and logIdentity into session.started"; "viewFor gives a player only their own consent and no names or log identity"; "the facilitator sees all of them". Regression guards: "a format 1 log without the new fields restores"; "a format 3 log is refused with a log_format RestoreError".
- [ ] **Step 2: Run** `pnpm --filter @acr/events exec vitest run` and the engine and host tests; expect the new tests FAIL.
- [ ] **Step 3: Implement.** In `viewFor` for `session.started`: `const { consents, names, logIdentity, ...rest } = e` and return `{ ...rest, roles: redactRoles(e.roles), ...(consents?.[who] ? { consents: { [who]: consents[who] } } : {}) }`. The reducer keeps ignoring the new fields.
- [ ] **Step 4: Run** the three suites and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0054: log format 2 with consents, names and log identity`.

### Task 6: Consent messages and the start gate (US-0054)

**Files:**
- Modify: `host/protocol.ts`, `host/session-host.ts` (`start`, `giveConsent`, `withdrawConsent`), `host/ws-server.ts`
- Test: `host/__tests__/ws-server.consent.test.ts` (new), `session-host.test.ts`

**Interfaces:**
- Consumes: `Seats`, `ConsentStore` (Task 2), `SessionStartExtra` (Task 5), `HostError(code, roles)` (Task 3).
- Produces: client messages `{ type: "consent", noticeVersion: string }` (1 to 32) and `{ type: "withdraw_consent" }`; `joined` gains `consent?: { noticeVersion: string; notice: string; given: boolean }` for players; `HostError` codes `seats_not_ready`, `consent_version`, `already_started`; `SessionHost.giveConsent(roleId: string, participantId: string, noticeVersion: string): void`; `SessionHost.withdrawConsent(roleId: string, participantId: string): void` (revokes the credential, frees the seat, persists).

- [ ] **Step 1: Write failing tests:** "start is refused with seats_not_ready naming the roles that are missing a join or a consent"; "the auto-start inside a facilitator command is refused the same way"; "start succeeds once every player role has joined and consented and writes the consents and names into session.started"; "consent from another participant who later holds the role does not count"; "consent with another version is refused as consent_version"; "consent, withdraw and leave are refused while the start is in progress and after it (already_started)"; "withdrawing consent removes it, revokes the credential and frees the seat"; "a player sees only their own consent in joined"; regression guard "a session host built without seats starts as before".
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/host`; expect FAIL.
- [ ] **Step 3: Implement.** Gate inside `SessionHost.start` before `engine.start`, so every route is covered: missing = player roles where `!assignments[r] || !seats.consent.has(r, assignments[r])`; refuse the three consent-changing calls while `this.starting !== null` or `this.started`; pass `{ consents: seats.consent.snapshot(), names: seats.credentials.names(), logIdentity: seats.credentials.logIdentity }` to `engine.start`. Persist after every consent change. `resumeFrom` stays outside the gate.
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host src/engine`; expect PASS (other suites are fixed in Task 7).
- [ ] **Step 5: Commit** `[feat] US-0054: recorded consent and the start gate`.

### Task 7: Terminal /consent, demos, harness and existing tests (US-0054)

**Files:**
- Modify: `cli/commands.ts` (`/consent`, `/withdraw`), `cli/client.ts`, `cli/render.ts` (print the notice from `joined.consent`), `demo/ctx.ts` (`playerConsent`), `demo/harness.ts` (`buildSystem` builds in-memory `Seats` with a no-op `persist` and the default notice), the demo rooms that send `start` (`lab.ts`, `resume.ts`, `security.ts`, `audit.ts`, `showcase.ts`, `story.ts`), generated-player setup, and every test that joins players and then starts a session
- Create: `services/runtime/src/__tests__/consent-helper.ts`
- Test: `cli/__tests__/commands.test.ts`, `client.test.ts`, the suites below

**Interfaces:**
- Produces: `consentAll(clients: { send(m: unknown): void }[], noticeVersion?: string): void` test helper (default `"v1"`); `playerConsent(ctx: Ctx, role: string, noticeVersion: string): Record<string, unknown>` returning `{ type: "consent", noticeVersion }`, where the version comes from the player's `joined.consent.noticeVersion` (there is no `ctx.noticeVersion`).

- [ ] **Step 1: Record the baseline.** On `develop`, run `pnpm demo --fast`, `--fast --security`, `--fast --resume`, `--fast --security --resume`, `--showcase --fast`, `--showcase --fast --evaluate` and note each check count in the commit body.
- [ ] **Step 2: Write failing tests:** `commands.test.ts` "/consent sends the notice version the server announced" and "/consent before joining is refused locally"; `client.test.ts` "the notice is printed once after joined". Then run the whole runtime suite and list the failing files (they fail because starts are now gated); that list is the work list for Step 3.
- [ ] **Step 3: Implement.** Add `/consent` and `/withdraw` and notice rendering. Give `buildSystem` in `harness.ts` in-memory `Seats` so demo servers reach the gate, and send `playerConsent` after each player `join`. Two rooms need more than a consent line: audit F-24 (`audit.ts`, restarts through `bootstrap` and starts with no players) and the lab room (`lab.ts`, starts after tech_lead was freed) must have all three players join with the codes shown and then consent before `start`. Add `consentAll` to every failing test file's setup. Do not change any assertion other than adding consent; if a count or transcript changes, stop and explain it in the commit body.
- [ ] **Step 4: Run** `pnpm test:coverage` and every demo from Step 1; expect the same check counts as the baseline.
- [ ] **Step 5: Commit** `[feat] US-0054: terminal /consent and consent in demos, harness and tests`.

### Task 8: Display name and roster frames (US-0055)

**Files:**
- Create: `host/roster.ts`; modify `host/protocol.ts`, `host/ws-server.ts`, `cli/render.ts`
- Test: `host/__tests__/roster.test.ts` (new), `ws-server.roster.test.ts` (new), `cli/__tests__/render.test.ts`, a prompt-leak test beside the existing mock-provider tests

**Interfaces:**
- Produces: `type FacilitatorRosterEntry = { roleId: string; name?: string; joined: boolean; consented: boolean; connected: boolean }`; `type PeerRosterEntry = { roleId: string; name?: string; ready: boolean }`; `buildRoster(input: { playerRoles: string[]; assignments: Record<string, string>; connected: ReadonlySet<string>; seats?: Seats }): { facilitator: FacilitatorRosterEntry[]; peers: PeerRosterEntry[] }`; `ServerMessage` `{ type: "roster"; audience: "facilitator"; entries: FacilitatorRosterEntry[] } | { type: "roster"; audience: "peers"; entries: PeerRosterEntry[] }`.

- [ ] **Step 1: Write failing tests:** `roster.test.ts` "ready means joined and consented for the same participant"; "AI characters are not listed"; "a terminal player has no name"; `ws-server.roster.test.ts` "a roster frame goes to every connection on join, consent, withdraw, leave and disconnect"; "a roster frame is never sent between joined and its replay events (it follows the subscription)"; "a player never receives the facilitator roster"; "names are never written to the server log" (capture `log`); `render.test.ts` "the roster renders as role and state only, never a name"; "no prompt sent to an NPC or Game Master model contains a display name" (use the recording mock provider the demo harness already has).
- [ ] **Step 2: Run** the files; expect FAIL.
- [ ] **Step 3: Implement.** Names come only from `seats.credentials.nameOf`. Broadcast after each change, only after `sendJoined` and `subscribe` have run for the joining connection; log `roster: <role> <state>` lines (role ids and states only).
- [ ] **Step 4: Run** `pnpm --filter @acr/runtime exec vitest run src/host src/cli src/agents`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0055: roster frames and typed display names`.

### Task 9: Player projection and scene info (US-0055)

**Files:**
- Create: `packages/events/src/player-view.ts`; modify `packages/events/src/index.ts`, `host/protocol.ts` and `host/ws-server.ts` (`joined.scenes`)
- Test: `packages/events/src/__tests__/player-view.test.ts`, `host/__tests__/ws-server.test.ts`

**Interfaces:**
- Produces: `type PlayerScene = { id: string; title: string; goal: string; timeBoxMinutes: number }` (only scenes the player takes part in) carried in `joined.scenes`; `type PlayerView = { lastSeq: number; status: SessionState["status"]; paused: boolean; pausedSince: number | null; scene: { id: string; enteredAt: number; pausedMs: number } | null; transcript: PlayerLine[]; injects: { seq: number; content: string; sceneId: string }[]; ended: { reason: string } | null }` with `PlayerLine = { seq: number; ts: number; roleId: string; text: string; sceneId: string | null }`; `initPlayerView(snapshot: SessionState): PlayerView`; `applyPlayerEvent(view: PlayerView, e: SessionEvent): PlayerView` (pure; never throws on a seq gap; ignores `e.seq <= view.lastSeq`). The player snapshot carries no inject content, so the BFF's first join sends `lastSeq: 0` to receive the replay, and a `reset` after an incomplete replay shows injects from the snapshot's `injectsFired` ids only as "message received".

- [ ] **Step 1: Write failing tests:** "initPlayerView takes the redacted snapshot as is"; "applyPlayerEvent skips a gap and keeps going"; "a duplicate seq is ignored"; "pause and resume set paused, pausedSince and pausedMs by the engine's rule (state.ts)"; "session.ended sets ended"; "an event type the view does not know is ignored, not thrown"; runtime: "joined lists only the scenes the player takes part in".
- [ ] **Step 2: Run** `pnpm --filter @acr/events exec vitest run` and the host test; expect FAIL.
- [ ] **Step 3: Implement** mirroring the relevant cases of `reduce` in `packages/events/src/state.ts` without its seq check.
- [ ] **Step 4: Run** both suites and `pnpm typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0055: gap-tolerant player view and scene info in joined`.

### Task 10: apps/web scaffold, workspace and CI (US-0056)

**Files:**
- Create: `apps/web/package.json` (`@acr/web`), `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx` (redirects to `/join`), `findings.md` (repo root; none exists yet)
- Modify: `pnpm-workspace.yaml` (add `"apps/*"`), root `package.json` scripts (`web:dev`, `web:test`), `.github/workflows/ci.yml` (typecheck and test already run through `pnpm -r`; add a `web-e2e` job with `pnpm exec playwright install --with-deps chromium`), `.env.example`, `.gitignore` and `.dockerignore` (`.next/`, `test-results/`, `playwright-report/`), eslint config
- Test: `apps/web/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: workspace package `@acr/web` with scripts `dev`, `build`, `typecheck`, `test`, `e2e`. `next.config.ts` sets `transpilePackages: ["@acr/events"]` and a webpack `resolve.extensionAlias` mapping `.js` to `.ts`/`.tsx` (the events package exports TypeScript source with `.js` import paths) and `serverExternalPackages: ["ws"]`. `vitest.config.ts` excludes `e2e/**` (otherwise `pnpm test:coverage` runs the Playwright specs). Dependencies, pinned: `@acr/events: workspace:*`, `next`, `react`, `react-dom`, `ws`; dev: `@types/ws`, `@types/react`, `@playwright/test`, `@axe-core/playwright`, `vitest`, `jsdom`, `@testing-library/react`, `@vitejs/plugin-react`, `@acr/runtime: workspace:*` (the real-runtime contract test starts it in-process).

- [ ] **Step 1: Write the failing smoke test:** "the web package imports the shared player view" (`import { initPlayerView } from "@acr/events"`).
- [ ] **Step 2: Run** `pnpm install` then `pnpm --filter @acr/web test`; expect FAIL before the scaffold exists.
- [ ] **Step 3: Implement** the scaffold; record each dependency in `findings.md`; `pnpm install --frozen-lockfile` must succeed after committing the lockfile.
- [ ] **Step 4: Run** `pnpm typecheck`, `pnpm --filter @acr/web build`, `pnpm lint:sdk`, `npx eslint .`, `pnpm test:coverage`; expect PASS.
- [ ] **Step 5: Commit** `[chore] US-0056: scaffold the Next.js web app and its CI jobs`.

### Task 11: BFF core modules (US-0056)

**Files:**
- Create: `apps/web/src/server/config.ts`, `seal.ts`, `envelope.ts`, `throttle.ts`, `guards.ts`, `wire.ts`
- Test: `apps/web/src/server/__tests__/*.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: Record<string, string | undefined>): Config` with `{ runtimeUrl: string; publicOrigin: string; cookieKeys: { id: string; key: Buffer }[]; cookieMaxAgeHours: number; maxStreams: number; maxStreamsPerSession: number; maxStreamsPerAddress: number }`, throwing a message that never quotes a value.
  - `seal(payload: unknown, keys: Config["cookieKeys"], now: number): string` and `unseal<T>(token: string, keys: Config["cookieKeys"], now: number): T | null` (AES-256-GCM, `keyId.nonce.ciphertext.tag` base64url, payload carries `expiresAt`; null when tampered, expired or the key id is unknown).
  - `ok<T>(data: T): Response`, `fail(status: number, code: string, message: string): Response` (the envelope from Global Constraints).
  - `class JoinThrottle` (`constructor(o: { max: number; windowMs: number; blockMs: number; now: () => number })`, `fail(ip: string, role: string): void`, `blockedForMs(ip: string, role: string): number`).
  - `checkOrigin(req: Request, publicOrigin: string): boolean` (Origin equals and `X-Requested-With: scenecoach` present); `checkFetchSite(req: Request): boolean`; `clientAddress(req: Request): string` (the last `X-Forwarded-For` entry, up to 64 characters, else `"unknown"`).
  - `wire.ts`: hand-written TypeScript types `ClientMessage`, `JoinedFrame`, `ServerMessage` for the messages the BFF sends and reads (the runtime's `protocol.ts` is not importable from a Next app); Task 12's real-runtime contract test pins them against drift.

- [ ] **Step 1: Write failing tests:** "seal and unseal round-trip"; "unseal returns null for a flipped byte, an expired payload and an unknown key id"; "a rotated key still opens a cookie sealed with the older key while newest seals"; "loadConfig refuses a short key and a missing PUBLIC_ORIGIN without quoting them"; "fail uses the envelope with a timestamp and version 1.0"; "JoinThrottle blocks one (address, role) and not another"; "checkOrigin is false without the custom header"; "clientAddress takes the last entry".
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement** with `node:crypto`; keys are 32 bytes base64.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test` and `typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: BFF config, sealed cookie, envelope, guards and throttle`.

### Task 12: Runtime connection and stream hub (US-0056)

**Files:**
- Create: `apps/web/src/server/runtime-connection.ts`, `stream-hub.ts`
- Test: `apps/web/src/server/__tests__/runtime-connection.test.ts`, `stream-hub.test.ts` (fake runtime), `hub.runtime.test.ts` (real runtime in mock mode on port 0, in-process)

**Interfaces:**
- Consumes: Task 11 modules; runtime protocol (Tasks 3, 6, 8, 9).
- Produces:
  - `class RuntimeConnection`: `static connect(url: string, clientAddress: string): Promise<RuntimeConnection>` (sets `X-Forwarded-For`); `joinWithCode(a: { sessionId: string; roleId: string; participantId: string; joinCode: string; displayName: string }): Promise<JoinedFrame>` (sends `issueCredential: true`, `lastSeq: 0`, passes the code through unchanged); `joinWithCredential(a: { sessionId: string; roleId: string; participantId: string; credential: string; lastSeq?: number }): Promise<JoinedFrame>`; `send(m: ClientMessage): void`; `onFrame(fn: (m: ServerMessage) => void): () => void`; `onClose(fn: (code: number) => void): () => void`; `close(): void`.
  - `type SessionCookie = { sessionId: string; roleId: string; participantId: string; credential: string; logIdentity: string; expiresAt: number }`.
  - `class StreamHub`: `constructor(o: { maxStreams: number; maxStreamsPerSession: number; maxStreamsPerAddress: number; setTimer: (fn: () => void, ms: number) => () => void; now: () => number })`; `open(cookie: SessionCookie, address: string, conn: RuntimeConnection, joined: JoinedFrame, out: { write(chunk: string): void; end(): void }): { close(): void } | "capacity"`; `send(cookie: SessionCookie, m: ClientMessage): Promise<ServerMessage | null>` (uses the participant's open stream connection; with no stream open it throws `NoStreamError`, mapped to 409 `no_stream` by the routes). One stream per participant: a second `open` writes `event: superseded` to the first and ends it. SSE `id:` is the event seq; `retry: 3000` is sent first so the browser's native reconnect carries `Last-Event-ID`; heartbeat comment every 15 s through the injected timer; a `reset` frame carries a fresh `PlayerView` whenever `joined.replay.complete` is false or the log identity differs from the cookie's; on runtime close code 4001 it writes `event: superseded` and ends without reconnecting; on `session.ended` it writes `event: ended` and ends.

- [ ] **Step 1: Write failing tests** against the fake and the real runtime: "joinWithCode returns the credential and passes a lower-case code with spaces and hyphens through unchanged"; "stream resumes from lastSeq without a gap or duplicate after a socket drop"; "a lastSeq beyond the head or from another log identity yields a reset frame"; "a second open for the same participant ends the first with a superseded event and the first does not reconnect"; "send reaches the runtime over the stream's own connection and does not supersede it"; "send with no stream open throws NoStreamError"; "the stream forwards nothing a player may not see (scan every frame for facilitator-only event types, hidden facts, codes and credentials)"; "capacity is returned past the global, per-session and per-address caps"; "closing the output (request abort) closes the runtime socket"; "the pinned wire types match the real runtime's frames" (contract).
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement.** Reconnect timing uses the injected timer. Do not hold anything else in the hub: the cookie carries identity.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test` and `typecheck`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: runtime connection and SSE stream hub`.

### Task 13: Routes, headers and robots (US-0056)

**Files:**
- Create: `apps/web/src/server/handlers.ts`; route files `src/app/api/v1/join/route.ts`, `stream/route.ts`, `say/route.ts`, `consent/route.ts`, `leave/route.ts`; `src/app/robots.ts`; `src/middleware.ts`
- Test: `apps/web/src/server/__tests__/handlers.test.ts` (fake runtime), `handlers.runtime.test.ts` (real runtime)

**Interfaces:**
- Consumes: Tasks 11 and 12.
- Produces: `type Deps = { config: Config; now: () => number; connect: typeof RuntimeConnection.connect; joinThrottle: JoinThrottle; hub: StreamHub }`; handlers `handleJoin`, `handleStream`, `handleSay`, `handleConsent`, `handleLeave`, each `(req: Request, deps: Deps) => Promise<Response>`. `handleJoin` mints `participantId` with `crypto.randomUUID()`, joins by code, **closes its connection once the credential is issued** (the stream opens its own by credential), and sets the sealed cookie with `Max-Age` from `cookieMaxAgeHours`. `handleStream` unseals the cookie, rejoins by credential with `lastSeq = Number(Last-Event-ID)` (or 0), opens the hub stream, closes the runtime socket on `req.signal` abort, and on `unauthorized` clears the cookie and sends `event: signed_out`. `handleSay`, `handleConsent`, `handleLeave` call `hub.send` and map `NoStreamError` to 409. `src/middleware.ts` sets the per-request nonce CSP, `X-Robots-Tag` on private routes and the other security headers. Route files only re-export (`runtime = "nodejs"`, `dynamic = "force-dynamic"`).

- [ ] **Step 1: Write failing tests:** "join with a right code sets a sealed HttpOnly Secure SameSite=Lax cookie and never returns the code or credential in the body"; "every join refusal returns the same envelope and status"; "join is throttled per address and role before the runtime is contacted"; "stream without a cookie, with a tampered cookie, with an expired cookie and with another session's cookie is 401 with the neutral envelope"; "a cookie for a session whose log identity changed gets a reset, and a revoked credential gets signed_out and a cleared cookie, with the message 'ask your facilitator for a new code'"; "stream rejects Sec-Fetch-Site cross-site"; "say, consent and leave reject a missing Origin or custom header"; "session.ended clears the cookie"; "the stream cap returns 503"; "every private route sends X-Robots-Tag and robots.txt disallows the private prefixes"; "the CSP header carries a fresh nonce per request and no unsafe-inline for scripts".
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm --filter @acr/web test`, `typecheck` and `build`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: v1 routes, headers and robots`.

### Task 14: Pages and components (US-0056)

**Files:**
- Create: `apps/web/src/app/join/page.tsx`, `session/[id]/page.tsx`, `src/components/*` (`AppHeader`, `TitleBlock`, `StatusChip`, `JoinForm`, `ConsentPanel`, `Roster`, `Transcript`, `SayBox`, `BriefPanel`, `SceneStatus`), `src/lib/use-session.ts`, `src/lib/tokens.css` (minimal tokens until EPIC-0007)
- Test: `apps/web/src/lib/__tests__/use-session.test.ts`, component tests with Testing Library

**Interfaces:**
- Consumes: Task 13 routes; `applyPlayerEvent`, `initPlayerView` (Task 9).
- Produces: pages as in the mockups: `/join?session=<id>&role=<role>` (code, name, consent), lobby wait with the peer roster, session view with transcript, say box, brief and facts, scene title, goal and timer (`timeBoxMinutes` from `joined.scenes`; `enteredAt`, `pausedMs` and `pausedSince` from the view), a Reconnecting banner, "open in another tab" and "ask your facilitator for a new code" messages. `use-session.ts` relies on the browser's native `EventSource` reconnect (the server sends `retry:`), so `Last-Event-ID` is kept; on `superseded`, `signed_out` or `ended` it calls `es.close()` so the browser does not reconnect. The page opens the stream before it posts consent (consent goes through the stream's connection).

- [ ] **Step 1: Write failing tests:** "a transcript line containing HTML renders as text"; "a display name with markup renders as text in the roster"; "the reconnect banner appears after a dropped stream and clears after reset"; "superseded and signed_out call es.close and show their messages"; "the say box is disabled while paused and after the end"; "the timer shows the remaining time from enteredAt, pausedMs, pausedSince and timeBoxMinutes using an injected clock and freezes while paused"; "a double-click on Join sends one request" (disabled while pending); "no source file uses dangerouslySetInnerHTML" (a test greps `src`).
- [ ] **Step 2: Run** `pnpm --filter @acr/web test`; expect FAIL.
- [ ] **Step 3: Implement** with semantic HTML, visible focus, labelled controls, a 16 px gutter, no horizontal scroll at 400 px, light and dark tokens.
- [ ] **Step 4: Run** `pnpm --filter @acr/web test`, `typecheck` and `build`; expect PASS.
- [ ] **Step 5: Commit** `[feat] US-0056: join, consent, lobby and session view pages`.

### Task 15: End-to-end tests and web demo (US-0065)

**Files:**
- Create: `apps/web/e2e/participant-flow.spec.ts`, `e2e/axe.spec.ts`, `e2e/helpers/start-stack.ts`, `apps/web/src/demo/web-demo.ts`; modify `services/runtime/src/demo/args.ts` and `runner.ts` (the `--web` flag; `run.ts` stays a thin entry and spawns `pnpm --filter @acr/web demo`), `README.md`, `docs/memory/demo-and-testing.md`
- Test: the specs above; `hub.runtime.test.ts` and `handlers.runtime.test.ts` already cover the real-runtime contract

**Interfaces:**
- Produces: `startStack(): Promise<{ baseUrl: string; runtimeUrl: string; codes: Record<string, string>; terminalFacilitator: { start(): Promise<void>; command(c: unknown): Promise<void> }; restartBff(): Promise<void>; dropSocket(role: string): void; stop(): Promise<void> }` (runtime in mock mode on port 0 with `TRUST_PROXY=1`, `next start` on a free port, injected `COOKIE_KEYS`, `PUBLIC_ORIGIN`); `pnpm demo --web` prints checks `W-01` to `W-08` and exits 0.

- [ ] **Step 1: Write failing specs:** `participant-flow.spec.ts` "three players join with names and consent, the terminal facilitator starts, everyone speaks, one drop recovers, a BFF restart recovers, and a second tab supersedes the first"; "start is refused while one player has not consented and the page shows the roster state"; "after a runtime restart with an empty log the player sees 'ask your facilitator for a new code'"; `axe.spec.ts` "no serious or critical Axe violations on /join, the lobby and the session view, in light and dark" and "no horizontal scroll at 400 px". Demo checks: W-01 join sets a cookie, W-02 stream delivers the opening scene, W-03 say reaches the transcript, W-04 drop and replay without gap, W-05 BFF restart keeps the seat, W-06 superseded, W-07 no facilitator-only data on the stream, W-08 robots and noindex.
- [ ] **Step 2: Run** `pnpm --filter @acr/web e2e`; expect FAIL (stack helper missing). Use the pre-installed browser; when the project pins a different Playwright, launch with `executablePath: "/opt/pw-browsers/chromium"`.
- [ ] **Step 3: Implement** the helper and demo; reconnect waits use `expect.poll`, never fixed sleeps; no assertion on elapsed time; explicit generous timeouts (`test.setTimeout(90_000)`).
- [ ] **Step 4: Run** `pnpm --filter @acr/web e2e`, `pnpm demo --web`, `pnpm test:coverage` twice (once under `yes > /dev/null` x8) and the new filesystem and process tests in the `node:22` container recipe from `docs/memory/demo-and-testing.md`; expect PASS and coverage at least 80 percent.
- [ ] **Step 5: Commit** `[test] US-0065: Playwright flow, Axe checks and pnpm demo --web`.

### Task 16: Documentation, threat model and bookkeeping

**Files:**
- Modify: `docs/THREAT_MODEL.md` (new web section: BFF boundary, sealed cookie, credential file, peers seeing typed names, `TRUST_PROXY` and per-role throttles, SSE denial of service, confused-deputy rule, the 2a limitation that a player who loses their cookie cannot rejoin until per-role reissue ships in US-0058), `docs/ARCHITECTURE.md` section 6 (player projection instead of the shared reducer), `docs/ROLLBACK.md` (older runtime refuses format 2), `README.md` and `.env.example` (new variables), `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md` (tick ACs, statuses; AC-0273's per-role reissue clause moves to US-0058), `docs/ID_REGISTRY.md` (TC ids), `progress.md`, `MEMORY.md` and `docs/memory/*`, `docs/LESSONS.md`

- [ ] **Step 1: File the test cases** (two or more per story, ids from `docs/ID_REGISTRY.md`, registry updated first) covering the Review Focus items and every AC.
- [ ] **Step 2: Write the docs** listed above; the threat-model section states what the cookie and credential do and do not protect.
- [ ] **Step 3: Run** `node tools/generate-plan.js` (after `npm ci`), `npx eslint .`, `pnpm lint:sdk`, `npm run plan:test`; expect PASS.
- [ ] **Step 4: Session close** per `AGENTS.md` section 14: coverage summary and results to `progress.md`, `MEMORY.md`, lessons.
- [ ] **Step 5: Commit** `[docs] US-0056: web client documentation and bookkeeping`.

---

## Clarifications to the spec found while planning and reviewing

1. A join issues a credential only when the client asks (`issueCredential: true`, sent by the BFF). Terminal clients keep joining by code after a drop, as today, so "the code stops working once a credential exists" applies to web seats only.
2. Per-role code reissue (AC-0273's second clause) needs the control service and moves to US-0058 in slice 2b. Until then a web player who loses their cookie cannot rejoin; the workaround is a whole-session fresh start.
3. `pnpm demo --web` is a flag on the existing demo runner that spawns the web package's demo script, so the runtime package does not import from `apps/web`.
4. The consent notice text is read by the runtime from `consent/notice-<version>.md` and sent to clients in `joined.consent`; consent is stored with the participant who gave it.
5. `joined.scenes` is added so the browser can show scene title, goal and timer; the BFF's first join sends `lastSeq: 0` so injects arrive through the replay.
6. The CSP is per-request with a nonce; the cookie lifetime is `COOKIE_MAX_AGE_HOURS` because the BFF does not know the session end in 2a, and `session.ended` clears it.
