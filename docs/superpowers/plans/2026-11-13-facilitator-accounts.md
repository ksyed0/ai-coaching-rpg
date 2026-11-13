# Facilitator Accounts and Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared `FACILITATOR_SECRET` console sign-in with per-person accounts (admin and facilitator) managed from an admin screen, with per-session ownership.

**Architecture:** The control service owns accounts in `<dataDir>/accounts.json` (salted scrypt hashes, atomic 0600 writes through one shared safe-file helper) behind an `AccountStore` interface, an `AccountService` with the lifecycle rules, and session owners in a separate `<dataDir>/session-owners.json` (so `sessions.json` is unchanged and rollback stays safe). The web app (BFF) calls control over the existing service token; its console cookie carries `{accountId, epoch}` and every console request, server page and open event stream is re-checked against control, so revoke, reset and password change take effect at once (each bumps the account's `epoch`). The BFF enforces "owner or admin" in the shared `guard`.

**Tech Stack:** TypeScript, Node `crypto.scrypt` (async), vitest (jsdom for components), Next.js route handlers, Playwright for one e2e.

**Spec:** `docs/superpowers/specs/2026-11-13-facilitator-accounts-design.md` (approved 2026-11-13). Read it first. This plan was reviewed by Opus against the code on 2026-11-13; its changes are folded in.

## Global Constraints

- Ids: story US-0083; backlog US-0084 (email sending), US-0085 (database store), US-0086 (SSO/OIDC), US-0087 (separate auth service), US-0088 (password rules), US-0089 (per-client admins). Reserved: AC-0500..AC-0539, TASK-0130..TASK-0141, TC-0270..TC-0309. File them in `docs/RELEASE_PLAN.md` and `docs/ID_REGISTRY.md` in Task 11 only.
- Passwords are stored as salted scrypt hashes only; never in a log, URL, query string, response (except the one-time temporary password in an `Issued` body), error message or browser storage. Responses carrying one are not cached (the web envelope and control `http-util` already send `Cache-Control: no-store`).
- Temporary passwords expire after **72 hours**; resend, reset and reinstate replace the old one. Minimum length of a user-chosen password: **10** characters.
- Default admin: login `admin`, status **`active`** with `mustChange: true` and **no expiry**, password from `ADMIN_BOOTSTRAP_PASSWORD` or the documented default `ChangeMe-Admin-1` (owner's decision: a fixed default). A **missing** `accounts.json` means first start: create it with the default admin (documented in the threat model as equivalent to `ADMIN_RESET`: host access is the authority). A corrupt, wrong-shape, symlinked, hard-linked, foreign-owner or group/other-accessible file is **refused**, never replaced. `ADMIN_RESET=1` at control start resets the admin to the default with `mustChange: true` and bumps its epoch; it logs a loud line each start ("ADMIN_RESET is set: unset it after use") and never reopens the shared secret.
- The shared secret (legacy sign-in) works only until the persisted one-way latch `legacyClosed` is set (by the first password change by any account, or the first account created by an admin); the latch is never cleared, not even by `ADMIN_RESET`. A legacy session acts as admin for sessions but gets 403 on the admin account routes and is refused at once when the latch closes.
- Revoke ends console sign-ins, server pages and open streams at once; the person's running sessions keep running and stay reachable by the admin only. The last active admin cannot be revoked. A login is unique forever (case-insensitive); revoked accounts are reinstated, never duplicated. Display names follow `cleanConsoleName` (hidden characters removed, at most 60 code points).
- Deploy order: control before web; update `docs/ROLLBACK.md`. Follow `AGENTS.md` section 8 test rules (no absolute-time assertions, injected clocks, private temp dirs) and prefix each test name with its module (`test_<module>_<behaviour>_<expected>`; the names below are the behaviour part). Commit format `[feat] US-0083: <imperative>` (CLAUDE.md), docs `[docs] US-0083: ...`.

## Review Focus

- A revoked, reset or password-changed account's old cookie fails on the very next request on every console route, every server page and the **open event stream** (within one heartbeat), not at cookie expiry.
- A facilitator gets the same neutral 404 for another facilitator's session on every console route that takes a session id (command, stream, readiness, reissue, reissue-all, remove, restart, start, facts, ai-roles, intents, prompt, report and every report subroute, report-links); the owner-assign route is admin-only (403).
- A corrupt, group-writable or symlinked `accounts.json` or `session-owners.json` refuses to start or sign in and is never replaced by an empty list; a missing file is first start.
- Wrong logins cost the same time as wrong passwords (dummy hash for unknown and revoked logins); throttling charges wrong passwords per address and per login; a valid cookie is never blocked by an address throttle.
- The legacy secret can never create or manage accounts, and stays dead after the latch closes, also after `ADMIN_RESET`.
- A temporary password shown on screen does not survive a reload or navigation (page memory only, like join codes).
- Sessions keep their owner through stop, restart, resume and end.

---

## File Structure

Control (`services/control/src/accounts/`): `types.ts`, `passwords.ts`, `safe-json-file.ts` (shared safe atomic JSON file), `store.ts` (`AccountStore`, `FileAccountStore`), `owners.ts` (`OwnerStore`), `service.ts` (`AccountService`). Modified: `api.ts`, `config.ts`, `main.ts`, `supervisor.ts` (owners), `packages/events` (move `cleanConsoleName` and its hidden-character table here, re-exported by the web app).
Web server (`apps/web/src/server/`): modified `config.ts` (console-enabled rule), `routes.ts` (`consoleView` async), `console-session.ts`, `console-handlers.ts`, `console-sessions.ts`, `console-stream.ts`, `facilitator-hub.ts`, `console-ai.ts`, `console-command.ts`, `console-report-handlers.ts`, `report-handlers.ts`, `launcher-client.ts`; new `console-accounts.ts`, `test-support/console-fixtures.ts`; new routes under `apps/web/src/app/api/v1/console/{password,admin/accounts,sessions/[id]/owner}`.
Web UI: modified `ConsoleLogin.tsx`, `SessionList.tsx`, console pages under `app/console`; new `ChangePasswordForm.tsx`, `console/admin/FacilitatorsPanel.tsx`, `console/admin/CredentialsPanel.tsx`, page `app/console/admin/page.tsx`.

---

### Task 1: Safe JSON file, password primitives, account store (control)

**Files:** Create `services/control/src/accounts/{types,passwords,safe-json-file,store}.ts`; Test `services/control/src/__tests__/accounts.passwords.test.ts`, `accounts.safe-json-file.test.ts`, `accounts.store.test.ts`.

**Interfaces:**
- Produces: `Role = "admin" | "facilitator"`; `Status = "invited" | "active" | "revoked"`; `PasswordHash = { salt: string; hash: string }` (base64url); `Account = { id: string; login: string; name: string; role: Role; status: Status; password: PasswordHash; mustChange: boolean; tempExpiresAt: number | null; epoch: number; createdAt: number; createdBy: string | null }`; `PublicAccount = Omit<Account, "password">`; `AccountsFile = { legacyClosed: boolean; accounts: Account[] }`.
- `hashPassword(plain: string): Promise<PasswordHash>`; `verifyPassword(plain: string, h: PasswordHash): Promise<boolean>` (async scrypt N=16384 r=8 p=1 keylen 64, 16-byte salt, `timingSafeEqual`); `generateTemporaryPassword(): string` (16 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`).
- `class SafeJsonFile { constructor(file: string, hooks?: { beforeRename?: () => void; currentUid?: () => number }); read(): unknown | null /* null = file missing */; write(value: unknown): void }`: the open/fstat/atomic-rename safety of `session-list.ts` (O_NOFOLLOW, regular file, one link, owned by this user, 1 MiB cap, O_EXCL temp 0600, fsync, rename, directory fsync) **plus** an explicit refusal when `mode & 0o077 !== 0`; any failure throws a plain error, never an empty result.
- `interface AccountStore { read(): AccountsFile | null; write(f: AccountsFile): void }`; `class FileAccountStore implements AccountStore` over `SafeJsonFile` with strict shape validation (unique ids and logins).

- [ ] **Step 1: Failing tests.** `hash_never_contains_plain`, `verify_accepts_right_rejects_wrong`, `same_password_hashes_differ`, `temporary_password_has_16_chars_from_alphabet`, `safe_file_missing_is_null`, `safe_file_round_trips_with_mode_0600`, `safe_file_refuses_symlink_hardlink_foreign_owner_group_writable_corrupt_and_oversize`, `safe_file_failed_rename_leaves_old_file`, `store_refuses_wrong_shape_duplicate_ids_and_duplicate_logins`, `store_missing_file_reads_null`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/accounts.passwords.test.ts src/__tests__/accounts.safe-json-file.test.ts src/__tests__/accounts.store.test.ts`; expect FAIL (modules missing).
- [ ] **Step 3:** Implement the three modules as specified.
- [ ] **Step 4:** Re-run; expect PASS; `pnpm --filter @acr/control typecheck`.
- [ ] **Step 5:** Commit `[feat] US-0083: add the safe JSON file, password primitives and account store`.

### Task 2: AccountService (control)

**Files:** Create `services/control/src/accounts/service.ts`; move `cleanConsoleName` and the hidden-character table to `packages/events/src/display-name.ts` (export from the package index; `apps/web/src/server/console-session.ts` re-exports it so its tests stay green); Test `services/control/src/__tests__/accounts.service.test.ts`, `packages/events/src/__tests__/display-name.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces: `class AccountService { constructor(o: { store: AccountStore; now: () => number; bootstrapPassword: string; reset: boolean; newTemporary?: () => string; newId?: () => string; log?: (line: string) => void }) }` with (all async because hashing is async):
  `ensureDefaultAdmin(): Promise<void>`; `login(login: string, password: string): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "expired" }>`; `check(id: string, epoch: number): PublicAccount | null` (sync, no hashing); `changePassword(id: string, epoch: number, current: string, next: string): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "weak" }>`; `list(): PublicAccount[]`; `create(i: { login: string; name: string; role: Role }, by: string | null): Promise<Issued>`; `resend(id: string): Promise<Issued>` (invited only); `resetPassword(id: string): Promise<Issued>` (active only); `revoke(id: string): void`; `reinstate(id: string): Promise<Issued>` (revoked only); `legacySecretAllowed(): boolean`; `type Issued = { account: PublicAccount; temporaryPassword: string }`; `class AccountError extends Error { code: "not_found" | "conflict" | "invalid" | "state" }`.
- Rules: `epoch` increments on revoke, reset, resend, reinstate, password change and admin reset; `check` is null when the epoch differs or the status is revoked; `login` always spends one hash verification (a dummy hash for an unknown or revoked login) so timing does not reveal accounts, verifies the password first and reports `expired` only for a correct password on an invited account past `tempExpiresAt`; a successful change sets `status: "active"`, `mustChange: false`, `tempExpiresAt: null`, requires `next.length >= 10` and `next !== current`, and sets `legacyClosed`; creating the first non-default account also sets `legacyClosed`; `legacySecretAllowed()` is `!legacyClosed`; logins are trimmed and lower-cased; names pass `cleanConsoleName` (null result is `invalid`); `revoke` of the last active admin is `conflict`; `ADMIN_RESET` never touches `legacyClosed`; a missing store file triggers `ensureDefaultAdmin` to create it, a present file never gets a second default admin.

- [ ] **Step 1: Failing tests** (in-memory store, fake clock, fixed `newTemporary`): `ensure_default_admin_creates_active_must_change_admin_once`, `missing_file_is_first_start_but_corrupt_file_is_refused`, `admin_reset_restores_default_and_bumps_epoch_but_keeps_legacy_closed`, `login_unknown_wrong_and_revoked_all_refused_with_one_verify_each`, `login_after_72h_is_expired_only_with_the_right_password`, `default_admin_does_not_expire`, `change_password_clears_must_change_closes_legacy_and_old_check_fails`, `change_password_rejects_short_and_same_as_current`, `create_returns_temporary_once_stores_only_hash`, `create_closes_legacy`, `create_duplicate_login_case_insensitive_is_conflict`, `create_rejects_name_that_cleans_to_empty`, `resend_replaces_temporary_and_old_stops_working`, `reset_password_on_active_returns_to_must_change`, `revoke_bumps_epoch_check_null_login_refused`, `revoke_last_active_admin_is_conflict`, `reinstate_issues_new_temporary`, `public_account_never_has_password`, plus `display_name` tests moved with the function.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/accounts.service.test.ts` and the events test; expect FAIL.
- [ ] **Step 3:** Implement per the rules; ids `randomBytes(8).toString("hex")`; write through the store on every change; invalid transitions throw `AccountError("state")`.
- [ ] **Step 4:** Re-run; expect PASS; typecheck all packages (`pnpm typecheck`).
- [ ] **Step 5:** Commit `[feat] US-0083: add the account service`.

### Task 3: Account routes, config and wiring (control)

**Files:** Modify `services/control/src/config.ts`, `api.ts`, `main.ts`; Test `services/control/src/__tests__/api.accounts.test.ts`, `config.test.ts`.

**Interfaces:**
- Produces: `ControlConfig.accountsFile` (`<dataDir>/accounts.json`), `adminBootstrapPassword` (`ADMIN_BOOTSTRAP_PASSWORD`, default `ChangeMe-Admin-1`, 10 to 200 chars), `adminReset` (`ADMIN_RESET === "1"`). Routes (service token required; envelope `{success,data,error}`): `POST /accounts/login {login,password}` -> `{account}` or 401 `login_refused` / `login_expired`; `POST /accounts/check {accountId,epoch}` -> `{account}` or 401 **`account_refused`** (distinct from the token's 401 `unauthorized`); `POST /accounts/password {accountId,epoch,current,next}` -> `{account}` or 401 `account_refused` / 400 `weak_password`; `GET /accounts` -> `{accounts: PublicAccount[]}` (includes `status`); `POST /accounts {login,name,role,by}` -> `Issued`; `POST /accounts/:id/{resend,reset,reinstate}` -> `Issued`; `POST /accounts/:id/revoke`; `GET /accounts/legacy` -> `{allowed:boolean}`. `AccountError` maps `not_found` 404, `conflict` 409, `state` 409, `invalid` 400 (add the catch branch in `api.ts`'s error handler). Logs never contain a password, hash or temporary password; main logs one line while the default admin still has `mustChange`.
- `createApi` options gain `accounts: AccountService`; `main.ts` builds `FileAccountStore` + service, awaits `ensureDefaultAdmin()` before listening.

- [ ] **Step 1: Failing tests:** `login_route_returns_account_without_hash`, `check_route_account_refused_after_revoke_is_distinct_from_bad_token`, `routes_require_service_token`, `issued_has_temporary_password_but_list_never_does`, `account_error_codes_map_to_404_409_409_400`, `logs_never_contain_a_password_or_hash` (capture logger output), `legacy_route_reports_the_latch`, and config tests (defaults, bad length refused, `ADMIN_RESET`).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/api.accounts.test.ts src/__tests__/config.test.ts`; expect FAIL.
- [ ] **Step 3:** Add the routes to the `route()` dispatcher using the existing `parse`/`jsonBody`/`ok`/`HttpError` helpers; extend config parsing; wire `main.ts`.
- [ ] **Step 4:** Run `pnpm --filter @acr/control test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: expose account routes and settings on the control service`.

### Task 4: Session owners (control)

**Files:** Create `services/control/src/accounts/owners.ts`; Modify `supervisor.ts`, `api.ts`; Test `services/control/src/__tests__/accounts.owners.test.ts`, `supervisor.owner.test.ts`, `api.test.ts`. `session-list.ts` is **not** changed.

**Interfaces:**
- Produces: `class OwnerStore { constructor(file: string); get(sessionId: string): string | null; set(sessionId: string, owner: string | null): void; all(): Record<string, string> }` over `SafeJsonFile` (`{ owners: { [sessionId]: accountId } }`, a missing file is empty); `SessionInfo` gains `owner?: string`; `Supervisor.create(scenarioId: string, owner?: string)`; `Supervisor.setOwner(sessionId: string, owner: string | null): void`; routes `POST /sessions {scenarioId, owner?}`, `PUT /sessions/:id/owner {owner: string | null}`; `GET /sessions` and `GET /sessions/:id` include `owner` when set (`info()` and `list()` read the owner store, so stop, restart, resume and end never lose it).

- [ ] **Step 1: Failing tests:** `owner_store_round_trips_and_missing_file_is_empty`, `owner_store_refuses_corrupt_and_group_writable`, `create_records_owner`, `status_change_stop_restart_resume_and_end_preserve_owner`, `set_owner_assigns_and_clears`, `set_owner_unknown_session_is_not_found`, `get_and_list_include_owner`, `sessions_json_is_byte_identical_with_and_without_an_owner`.
- [ ] **Step 2:** Run those files; expect FAIL.
- [ ] **Step 3:** Implement; `supervisor` takes an `owners: OwnerStore` option wired in `main.ts` (`<dataDir>/session-owners.json`).
- [ ] **Step 4:** Run `pnpm --filter @acr/control test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: record and assign session owners`.

### Task 5a: Console cookie, always-rechecked guard, server pages, test support (web server)

**Files:** Modify `apps/web/src/server/{config,routes,console-session,console-handlers,console-sessions,console-stream,facilitator-hub,launcher-client}.ts`, the three console pages under `apps/web/src/app/console`; Create `apps/web/src/server/test-support/console-fixtures.ts`; Test `apps/web/src/server/__tests__/console-recheck.test.ts` plus updates to the existing console tests (about 16 files seal `{name, epoch: secretEpoch(...)}` cookies).

**Interfaces:**
- Produces in `launcher-client.ts`: `type AccountInfo = { id: string; login: string; name: string; role: "admin" | "facilitator"; status: "invited" | "active" | "revoked"; mustChange: boolean; epoch: number }`; `accountLogin(login, password): Promise<AccountInfo>`, `accountCheck(accountId, epoch): Promise<AccountInfo | null>` (control unreachable throws `unavailable`, which answers 502 and **does not clear the cookie**), `accountChangePassword(accountId, epoch, current, next): Promise<AccountInfo>`, `legacyAllowed(): Promise<boolean>`; new `LauncherReason`s `login_refused`, `login_expired`, `account_refused`, `weak_password` added to `BY_CODE`; `SessionInfo` and `toInfo` carry `owner?: string`.
- Cookie (`console-session.ts`): `{ kind: "account"; accountId; epoch: number; name; expiresAt }` or legacy `{ name; epoch: string; expiresAt }` (a cookie **without `kind` is legacy**, so cookies live at deploy keep working until the latch closes). `requireConsole(req, deps): Promise<ConsoleCaller | Response>` with `ConsoleCaller = { name: string; role: "admin" | "facilitator"; accountId: string | null; legacy: boolean; mustChange: boolean }`: re-checks an account cookie with `accountCheck` on every call; accepts a legacy cookie only while `legacyAllowed()` (acts as admin); returns 403 `must_change_password` when `mustChange` unless the route is password change or logout (applied here so the stream and every guard user inherit it). `consoleView` in `routes.ts` becomes async with the same re-check and returns role and mustChange (the three server pages await it).
- Console-enabled rule (`config.ts`): `missingConsoleVars` requires `LAUNCHER_URL` and `LAUNCHER_TOKEN` only; `FACILITATOR_SECRET` becomes optional (legacy sign-in only); update the "not set up" copy, the `routes.ts` startup warning and `config.test.ts`.
- `facilitator-hub.ts`: `hub.open(...)` takes `{ accountId, epoch }`; the 15 s heartbeat re-checks via `accountCheck` and closes the stream when it is refused; `closeAccount(accountId)` closes that account's streams and is called by the BFF revoke, reset and password routes.
- `test-support/console-fixtures.ts`: `fakeDeps(over?)`, `accountCookie(info)`, `legacyCookie(name)` used by all console tests.

- [ ] **Step 1: Write the fixtures first and port one existing console test to them; then failing tests:** `guard_rechecks_account_on_every_request_and_clears_a_refused_cookie`, `control_unreachable_answers_502_and_keeps_the_cookie`, `legacy_cookie_without_kind_works_only_while_the_latch_is_open`, `must_change_blocks_every_route_including_the_stream_except_password_and_logout`, `consoleView_is_async_and_a_revoked_cookie_is_signed_out`, `open_stream_ends_within_one_heartbeat_after_revoke`, `close_account_closes_that_accounts_streams`, `console_enabled_without_facilitator_secret`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-recheck.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement; every caller of `requireConsole`/`guard` awaits; pages await `consoleView`.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test` and `typecheck`; expect PASS (all ported console tests green).
- [ ] **Step 5:** Commit `[feat] US-0083: re-check the account on every console request, page and stream`.

### Task 5b: Sign-in and password-change routes (web server)

**Files:** Modify `console-handlers.ts`; Create `apps/web/src/app/api/v1/console/password/route.ts`; Test `apps/web/src/server/__tests__/console-accounts.login.test.ts`.

**Interfaces:**
- Consumes: Task 5a. Produces: `POST /api/v1/console/login` accepts `{login, password}` or `{secret, name}` (legacy only while allowed); the existing Origin, Fetch-Metadata, address throttle and global throttle apply; a wrong password is charged per address **and** per lower-cased login (a separate `consoleLoginThrottle` keyed by login); `login_expired` answers a distinct message only after the right password; `POST /api/v1/console/password {current, next}` calls `accountChangePassword`, calls `closeAccount` for other tabs' streams, then re-seals the cookie with the new epoch.

- [ ] **Step 1: Failing tests:** `login_with_account_sets_sealed_cookie_and_returns_role`, `wrong_password_is_neutral_401_and_charges_address_and_login`, `expired_temporary_password_message_only_after_right_password`, `legacy_login_refused_after_the_latch_closes`, `change_password_reseals_cookie_old_cookie_fails_two_tabs_second_gets_401`, `valid_cookie_bypasses_address_throttle`, `no_secret_or_password_in_any_response_or_log`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement per Interfaces (reuse `throttle.ts` classes with new instances in `createDeps`).
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: add account sign-in and password change routes`.

### Task 6: Ownership and the account's audit name in the BFF

**Files:** Modify `console-sessions.ts` (`guard`, list, create), `console-stream.ts`, `console-ai.ts`, `console-command.ts`, `console-report-handlers.ts`, `report-handlers.ts`, `launcher-client.ts`; Create `apps/web/src/app/api/v1/console/sessions/[id]/owner/route.ts` and `handleConsoleSetOwner` in `console-accounts.ts`; Test `console-ownership.test.ts`.

**Interfaces:**
- Produces: `guard` rule "when the request names a session id: allow an admin; allow a facilitator only when `session.owner === accountId`; otherwise the same neutral 404 as an unknown session"; the stream (the one handler that does not use `guard`) applies it too. `GET /api/v1/console/sessions` returns only the caller's sessions for a facilitator (admin: all, with `owner`; legacy acts as admin); create passes `owner: accountId` (legacy: none); `POST /api/v1/console/sessions/:id/owner {owner: string | null}` is admin only (403 otherwise; legacy is admin for sessions but this route is admin-account only? no: legacy may assign, it is a session action; unknown account id is `invalid`). The review writes' `by` becomes `accountSlug(name, id)` (lower-case, non-alphanumerics to `-`, at most 40 characters, `-`, first 6 hex of the account id; it satisfies `/^[A-Za-z0-9_-]{1,56}$/`) and is **set server-side, ignoring any body `by`**; the report write throttle is keyed by account id (legacy: by cookie hash as today).

- [ ] **Step 1: Failing tests (table-driven over the route list in Review Focus):** `facilitator_gets_404_for_another_facilitators_session_on_every_route`, `admin_can_use_any_session`, `session_without_owner_is_admin_only`, `list_is_filtered_for_a_facilitator_not_for_an_admin`, `create_records_the_caller_as_owner`, `set_owner_is_admin_only_and_unknown_account_is_invalid`, `review_by_is_the_account_slug_and_body_by_is_ignored`, `report_write_throttle_survives_a_cookie_reseal`, `launcher_client_carries_owner_through_to_info`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-ownership.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement; the extra `launcher.session` call is cached per request so tests that count launcher calls are updated deliberately.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: enforce session ownership on every console route`.

### Task 7: Admin account routes (web server)

**Files:** Create handlers in `apps/web/src/server/console-accounts.ts` and routes `app/api/v1/console/admin/accounts/route.ts` (GET list, POST create) and `.../accounts/[id]/{resend,reset,revoke,reinstate}/route.ts`; add `accountsList`, `accountCreate`, `accountAction` to `launcher-client.ts`; Test `console-admin-accounts.test.ts`.

**Interfaces:**
- Produces: `handleAdminAccountsList`, `handleAdminAccountCreate`, `handleAdminAccountAction(action: "resend" | "reset" | "revoke" | "reinstate")`: admin accounts only (403 `forbidden` for a facilitator **and for a legacy session**), `must_change_password` enforced (inherited from `requireConsole`), Origin and `X-Requested-With` checked, `by` taken from the caller's account id and never from the body; revoke, reset and reinstate call `closeAccount` for that account.

- [ ] **Step 1: Failing tests:** `facilitator_and_legacy_get_403_on_every_admin_route`, `create_returns_temporary_password_and_list_never_does`, `actions_require_origin_and_header`, `revoke_last_admin_returns_the_conflict_message`, `by_comes_from_the_cookie_not_the_body`, `revoke_closes_that_accounts_streams`, `admin_route_blocked_while_must_change`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement as thin proxies to the control calls.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: add admin routes for facilitator accounts`.

### Task 8: Sign-in and forced change-password screens

**Files:** Modify `apps/web/src/components/console/ConsoleLogin.tsx`, the console shell and pages' redirect logic; Create `ChangePasswordForm.tsx`, `apps/web/src/app/console/password/page.tsx`; Test `components/__tests__/ConsoleLogin.test.tsx`, `ChangePasswordForm.test.tsx`.

**Interfaces:**
- Produces: `ConsoleLogin` fields "Login" and "Password" (a small "Use the shared secret instead" disclosure only while `legacyAllowed`); `ChangePasswordForm({ onDone })` with **"Current (temporary) password"**, "New password" and "Repeat" and the minimum length as helper text; a `mustChange` account is redirected to `/console/password` from every console page until done; no password in storage or the URL.

- [ ] **Step 1: Failing tests:** `login_form_posts_login_and_password`, `refused_login_shows_the_neutral_message`, `expired_temporary_password_shows_ask_the_admin_to_resend`, `must_change_redirects_to_password_page`, `change_form_rejects_mismatch_and_short_without_a_request`, `change_form_sends_current_and_new`, `change_success_goes_to_console`, `passwords_never_in_storage_or_url`, `axe_login_and_change_light_and_dark`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/ConsoleLogin.test.tsx src/components/__tests__/ChangePasswordForm.test.tsx`; expect FAIL.
- [ ] **Step 3:** Implement with the existing form, banner and `api.ts` post helpers.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: add account sign-in and the forced password change screens`.

### Task 9: Admin screen and owner column

**Files:** Create `components/console/admin/{FacilitatorsPanel,CredentialsPanel}.tsx`, `apps/web/src/app/console/admin/page.tsx`; Modify `SessionList.tsx` and the console header (an "Admin" link for admin accounts only); Test `FacilitatorsPanel.test.tsx`, `CredentialsPanel.test.tsx`, `SessionList.owner.test.tsx`.

**Interfaces:**
- Produces: `FacilitatorsPanel` lists name, login, role, status and the actions the status machine allows (Resend for invited; Reset password for active; Revoke for invited or active; Reinstate for revoked), each behind the existing `ConfirmDialog`, plus a "New facilitator" form (name, email as login, role Admin or Facilitator); `CredentialsPanel({ login, name, temporaryPassword, onDismiss })` shows "Share these with <name>. Shown once." with Copy buttons, password in component state only; `SessionList` shows Owner and an Assign action for admins.

- [ ] **Step 1: Failing tests:** `panel_shows_only_the_actions_allowed_for_each_status`, `create_shows_credentials_once_then_clears_on_dismiss`, `credentials_never_in_storage_or_url_and_gone_after_remount`, `revoke_asks_for_confirmation`, `non_admin_never_sees_the_admin_link_or_page`, `session_list_shows_owner_and_assign_for_admin_only`, `axe_admin_panel_light_and_dark`.
- [ ] **Step 2:** Run the three files; expect FAIL.
- [ ] **Step 3:** Implement with `Person`, `ConfirmDialog` and card/table styles; call the Task 7 routes.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test` and `typecheck`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083: add the admin facilitators screen and session owners`.

### Task 10: End to end

**Files:** Create `apps/web/e2e/accounts.spec.ts`.

- [ ] **Step 1: Failing e2e** (real control + web via the existing stack helper): default admin signs in with the default password and is forced to change it; the shared secret then stops working; admin creates a facilitator and sees the temporary password once; the facilitator signs in, is forced to change it and creates a session; a second facilitator gets a neutral 404 for it and the admin can open it; the admin revokes the first facilitator and that person's open console page and stream are refused at once; the session keeps running and the admin assigns it to the second facilitator.
- [ ] **Step 2:** Run `pnpm --filter @acr/web e2e` (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the pinned Chromium is missing); expect FAIL first, then PASS.
- [ ] **Step 3:** Commit `[test] US-0083: add the accounts end-to-end spec`.

### Task 11: Docs, stories and the demo kit

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `README.md`, `.env.example`, `CHANGELOG.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `docs/TEST_CASES.md`, `docs/demo/CLIENT_DEMO.md`, `docs/demo/demo-up.sh`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1: Docs.** THREAT_MODEL "Facilitator accounts" (the default password and its mitigations, temporary password on screen, epoch revoke and the stream heartbeat, ownership, throttles, file safety, deleting `accounts.json` equals a reset, the legacy latch); ROLLBACK (deploy control before web; recover a locked-out admin with `ADMIN_RESET=1` and unset it after; rolling back needs no data step because `accounts.json` and `session-owners.json` are ignored by an older build and `sessions.json` is unchanged; an older web app signs in with the shared secret only while it is still set); README and `.env.example` for `ADMIN_BOOTSTRAP_PASSWORD`, `ADMIN_RESET` and `FACILITATOR_SECRET` now optional; CHANGELOG under Unreleased.
- [ ] **Step 2: Stories.** File US-0083 and the backlog stories US-0084..US-0089 in `docs/RELEASE_PLAN.md` with ACs from AC-0500, tests TC-0270.. in `docs/TEST_CASES.md`, the reserved block in `docs/ID_REGISTRY.md`; run `npm run plan:generate`.
- [ ] **Step 3: Demo kit.** The cue card and `demo-up.sh` say to sign in as `admin` with the default password the first time, change it, then create facilitators; `demo-up.sh secret` is for the legacy sign-in only and stops working after the first change.
- [ ] **Step 4: Full gates:** `pnpm typecheck`, `pnpm lint:sdk`, `pnpm --filter @acr/control test`, `pnpm --filter @acr/web test`, `pnpm --filter @acr/runtime test`, `npm run plan:test`, mock demos `pnpm -s demo --fast` (29), `--showcase --fast` (14), `--fast --security --resume` (42); expect all green.
- [ ] **Step 5:** Commit `[docs] US-0083: document accounts, file the stories and update the demo kit`.
