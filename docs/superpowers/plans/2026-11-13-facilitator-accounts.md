# Facilitator Accounts and Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared `FACILITATOR_SECRET` console sign-in with per-person accounts (admin and facilitator) managed from an admin screen, with per-session ownership.

**Architecture:** The control service owns accounts in `<dataDir>/accounts.json` (salted scrypt hashes, atomic 0600 writes) behind an `AccountStore` interface, and an `AccountService` with the lifecycle rules. The web app (BFF) calls control over the existing service token; its console cookie carries `{accountId, epoch}` and every console request is re-checked against control, so revoke, reset and password change take effect at once (they bump the account's `epoch`). Sessions record an `owner`; the BFF enforces "owner or admin" in the shared `guard`.

**Tech Stack:** TypeScript, Node `crypto.scrypt`, vitest (jsdom for components), Next.js route handlers, Playwright for one e2e.

**Spec:** `docs/superpowers/specs/2026-11-13-facilitator-accounts-design.md` (approved 2026-11-13). Read it first.

## Global Constraints

- Ids: story US-0083; backlog US-0084 (email sending), US-0085 (database store), US-0086 (SSO/OIDC), US-0087 (separate auth service), US-0088 (password rules), US-0089 (per-client admins). Reserved: AC-0500..AC-0539, TASK-0130..TASK-0139, TC-0270..TC-0309. File them in `docs/RELEASE_PLAN.md` and `docs/ID_REGISTRY.md` in Task 10 only.
- Passwords are stored as salted scrypt hashes only; never in a log, URL, query string, response (except the one-time temporary password), error message or browser storage.
- Temporary passwords expire after **72 hours**; resend/reset/reinstate replace the old one. Minimum length of a user-chosen password: **10** characters.
- Default admin: login `admin`, password from `ADMIN_BOOTSTRAP_PASSWORD` or the documented default `ChangeMe-Admin-1` (owner's decision: a fixed default), `mustChange: true`. `ADMIN_RESET=1` at control start resets the admin to the default with `mustChange: true` and bumps its epoch.
- Revoke ends console sign-ins at once; the revoked person's running sessions keep running and become admin-only. The last active admin cannot be revoked. A login is unique forever (case-insensitive); revoked accounts are reinstated, never duplicated.
- The shared secret works only while the default admin still has `mustChange: true` (nobody has taken over). Existing messages and neutral refusals stay neutral.
- Deploy order: control before web; update `docs/ROLLBACK.md`. Follow `AGENTS.md` section 8 test rules (no absolute-time assertions, injected clocks, private temp dirs). Commit format `[feat] US-0083 | TASK-01xx: <imperative>`.

## Review Focus

- A revoked/reset account's old cookie must fail on the very next request on every console route (including the open event stream), not after expiry.
- A facilitator must get the same neutral 404 for another facilitator's session on every console route taking a session id (command, stream, readiness, reissue, remove, restart, start, facts, ai-roles, report*, report-links, owner).
- `accounts.json` that is missing, corrupt, group-writable or a symlink must refuse to start or sign in; it must never be replaced by an empty list (copy the `SessionList` safety checks).
- Login throttling must charge wrong passwords per address and per login, and a valid cookie must not be blocked by an address throttle.
- Temporary password shown on screen must not survive a reload or navigation (same rule as join codes: page memory only).

---

## File Structure

Control (`services/control/src/accounts/`): `types.ts` (types), `passwords.ts` (hash, verify, generate), `store.ts` (`AccountStore`, `FileAccountStore`), `service.ts` (`AccountService`). Modified: `api.ts` (routes), `config.ts` (`ADMIN_*`, `accountsFile`), `main.ts` (wiring), `session-list.ts` + `supervisor.ts` (owner).
Web server (`apps/web/src/server/`): modified `console-session.ts`, `console-handlers.ts`, `console-sessions.ts`, `console-stream.ts`, `launcher-client.ts`; new `console-accounts.ts` (account and admin routes), routes under `apps/web/src/app/api/v1/console/{password,admin/accounts,...}`.
Web UI: modified `ConsoleLogin.tsx`, `SessionList.tsx`; new `ChangePasswordForm.tsx`, `console/admin/FacilitatorsPanel.tsx`, `console/admin/CredentialsPanel.tsx`, page `app/console/admin/page.tsx`.

---

### Task 1: Password primitives and the account store (control)

**Files:** Create `services/control/src/accounts/{types,passwords,store}.ts`; Test `services/control/src/__tests__/accounts.passwords.test.ts`, `accounts.store.test.ts`.

**Interfaces:**
- Produces: `type Role = "admin" | "facilitator"`; `type Status = "invited" | "active" | "revoked"`; `type PasswordHash = { salt: string; hash: string }` (base64url); `type Account = { id: string; login: string; name: string; role: Role; status: Status; password: PasswordHash; mustChange: boolean; tempExpiresAt: number | null; epoch: number; createdAt: number; createdBy: string | null }`; `type PublicAccount = Omit<Account, "password">`.
- `hashPassword(plain: string): PasswordHash`; `verifyPassword(plain: string, h: PasswordHash): boolean` (timing-safe); `generateTemporaryPassword(): string` (16 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`).
- `interface AccountStore { read(): Account[]; write(list: Account[]): void }`; `class FileAccountStore implements AccountStore { constructor(file: string, hooks?: { beforeRename?: () => void; currentUid?: () => number }) }`.

- [ ] **Step 1: Write failing tests.** Names: `test_hash_password_never_contains_plain`, `test_verify_password_accepts_right_and_rejects_wrong`, `test_two_hashes_of_the_same_password_differ`, `test_generate_temporary_password_has_16_chars_from_the_alphabet`, `test_store_read_missing_file_is_empty_list`, `test_store_write_then_read_round_trips_with_mode_0600`, `test_store_refuses_symlink_group_writable_corrupt_and_wrong_shape_and_never_replaces_with_empty` (mirror `session-list.test.ts`), `test_store_failed_rename_leaves_old_file_intact`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/accounts.passwords.test.ts src/__tests__/accounts.store.test.ts`; expect FAIL (modules missing).
- [ ] **Step 3:** Implement `passwords.ts` with `crypto.scryptSync` (N=16384, r=8, p=1, keylen 64, 16-byte random salt) and `timingSafeEqual`; implement `FileAccountStore` by copying the open/fstat/atomic-rename safety of `services/control/src/session-list.ts` (O_NOFOLLOW, regular file, one link, owned by this user, 1 MiB cap, O_EXCL temp 0600, fsync, rename, directory fsync); validate the `Account` shape strictly, unique ids and logins.
- [ ] **Step 4:** Run the same command; expect PASS. Run `pnpm --filter @acr/control typecheck`.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0130: Add password primitives and the account file store`.

### Task 2: AccountService (control)

**Files:** Create `services/control/src/accounts/service.ts`; Test `services/control/src/__tests__/accounts.service.test.ts`.

**Interfaces:**
- Consumes: Task 1 types, `AccountStore`, `hashPassword`, `verifyPassword`, `generateTemporaryPassword`.
- Produces: `class AccountService { constructor(o: { store: AccountStore; now: () => number; bootstrapPassword: string; reset: boolean; newTemporary?: () => string; newId?: () => string }) }` with:
  `ensureDefaultAdmin(): void`; `login(login: string, password: string): { ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "expired" }`; `check(id: string, epoch: number): PublicAccount | null`; `changePassword(id: string, epoch: number, current: string, next: string): { ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "weak" }`; `list(): PublicAccount[]`; `create(i: { login: string; name: string; role: Role }, by: string | null): Issued`; `resend(id: string): Issued` (invited only); `resetPassword(id: string): Issued` (active only); `revoke(id: string): void`; `reinstate(id: string): Issued`; `legacySecretAllowed(): boolean`; with `type Issued = { account: PublicAccount; temporaryPassword: string }` and `class AccountError extends Error { code: "not_found" | "conflict" | "invalid" | "state" }`.
- Rules: `epoch` increments on revoke, reset, resend, reinstate, password change and admin reset; `check` returns null when epoch differs or status is revoked; `login` verifies the password first, then expiry (`expired` only for a correct password on an invited account past `tempExpiresAt`); a successful change sets `status: "active"`, `mustChange: false`, `tempExpiresAt: null`, requires `next.length >= 10` and `next !== current`; `login` is lower-cased and trimmed, unique; `revoke` of the last active admin throws `conflict`; `legacySecretAllowed()` is true only while the account with login `admin` has `mustChange: true`.

- [ ] **Step 1: Write failing tests** with an in-memory `AccountStore`, a fake clock and a fixed `newTemporary`: `test_ensure_default_admin_creates_admin_with_must_change_once`, `test_admin_reset_restores_default_password_and_bumps_epoch`, `test_login_right_password_ok_wrong_password_refused_unknown_login_refused_same_reason`, `test_login_after_72h_invited_is_expired_only_with_the_right_password`, `test_change_password_clears_must_change_and_bumps_epoch_so_old_check_fails`, `test_change_password_rejects_short_and_same_as_current`, `test_create_returns_temporary_password_once_and_stores_only_hash`, `test_create_duplicate_login_case_insensitive_is_conflict`, `test_resend_replaces_temporary_password_and_old_one_stops_working`, `test_reset_password_on_active_returns_to_must_change`, `test_revoke_bumps_epoch_check_returns_null_and_login_refused`, `test_revoke_last_active_admin_is_conflict`, `test_reinstate_issues_new_temporary_password`, `test_legacy_secret_allowed_only_until_admin_changes_default`, `test_service_never_returns_password_hash_in_public_account`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/accounts.service.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `AccountService` per the Interfaces rules; ids via `randomBytes(8).toString("hex")`; write through the store on every change; invalid state transitions throw `AccountError("state")`.
- [ ] **Step 4:** Re-run; expect PASS. Typecheck.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0130: Add the account service (lifecycle, epoch, default admin)`.

### Task 3: Account HTTP routes, config and wiring (control)

**Files:** Modify `services/control/src/config.ts`, `api.ts`, `main.ts`; Test `services/control/src/__tests__/api.accounts.test.ts`, `config.test.ts`.

**Interfaces:**
- Consumes: `AccountService`.
- Produces: `ControlConfig.accountsFile: string` (`<dataDir>/accounts.json`), `ControlConfig.adminBootstrapPassword: string` (`ADMIN_BOOTSTRAP_PASSWORD`, default `ChangeMe-Admin-1`, 10 to 200 chars), `ControlConfig.adminReset: boolean` (`ADMIN_RESET === "1"`). Routes (service token required; JSON bodies, envelope `{success,data,error}`): `POST /accounts/login {login,password}` -> `{account}` or 401 `login_refused`/`login_expired`; `POST /accounts/check {accountId,epoch}` -> `{account}` or 401; `POST /accounts/password {accountId,epoch,current,next}`; `GET /accounts` -> `{accounts}`; `POST /accounts {login,name,role,by}` -> `Issued`; `POST /accounts/:id/resend|reset|reinstate` -> `Issued`; `POST /accounts/:id/revoke`; `GET /accounts/legacy` -> `{allowed:boolean}`. The temporary password appears only in an `Issued` response body and is never logged.
- `createApi` options gain `accounts: AccountService`; `main.ts` builds `FileAccountStore`, calls `ensureDefaultAdmin()` at start and logs one line when the default password is still unchanged (never the password).

- [ ] **Step 1: Write failing tests** `test_login_route_returns_account_without_password_hash`, `test_check_route_401_after_revoke`, `test_routes_require_service_token`, `test_issued_response_has_temporary_password_but_list_never_does`, `test_account_error_codes_map_to_404_409_400`, `test_log_never_contains_a_password_or_hash` (capture logger output), and config tests for the three new settings (defaults, bad length refused, `ADMIN_RESET`).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/api.accounts.test.ts src/__tests__/config.test.ts`; expect FAIL.
- [ ] **Step 3:** Add the routes to the `route()` dispatcher in `api.ts` using the existing `parse`/`jsonBody`/`ok`/`HttpError` helpers; extend `config.ts` parsing; wire in `main.ts`.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/control test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0131: Expose account routes and settings on the control service`.

### Task 4: Session ownership (control)

**Files:** Modify `services/control/src/session-list.ts`, `supervisor.ts`, `api.ts`; Test `session-list.test.ts`, `supervisor.test.ts` (or the existing supervisor test files), `api.test.ts`.

**Interfaces:**
- Produces: `Entry` gains `owner?: string` (an account id; absent = admin-only); `Supervisor.create(scenarioId: string, owner?: string): Promise<CreateResult>`; `SessionInfo` gains `owner?: string`; `Supervisor.setOwner(sessionId: string, owner: string | null): void`; routes `POST /sessions {scenarioId, owner?}` and `PUT /sessions/:id/owner {owner: string | null}`; `GET /sessions` and `GET /sessions/:id` include `owner` when set.
- Backward compatibility: an entry without `owner` serializes byte-identically to today (the file for sessions without an owner must not change shape).

- [ ] **Step 1: Failing tests:** `test_entry_without_owner_round_trips_byte_identical`, `test_entry_with_owner_round_trips`, `test_entry_with_extra_unknown_key_still_refused`, `test_create_records_owner`, `test_set_owner_assigns_and_clears`, `test_set_owner_unknown_session_is_not_found`, `test_list_and_get_include_owner`.
- [ ] **Step 2:** Run those files; expect FAIL.
- [ ] **Step 3:** Relax `isEntry` (3 or 4 keys, `owner` a string of at most 64 safe characters when present); thread `owner` through `create`, `list`, `get` and the routes; `setOwner` writes the list under the existing per-session lock.
- [ ] **Step 4:** Run `pnpm --filter @acr/control test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0132: Record and assign session owners`.

### Task 5: BFF sign-in, cookie and the always-rechecked guard

**Files:** Modify `apps/web/src/server/{console-session,console-handlers,console-sessions,console-stream,launcher-client,config}.ts` and the other callers of `guard`/`requireConsole`; Create route files `app/api/v1/console/password/route.ts`; Test `apps/web/src/server/__tests__/console-accounts.login.test.ts` plus updates to existing console handler tests.

**Interfaces:**
- Consumes: control routes of Task 3 via `launcher-client.ts`.
- Produces in `launcher-client.ts`: `accountLogin(login, password): Promise<AccountInfo>`, `accountCheck(accountId, epoch): Promise<AccountInfo | null>`, `accountChangePassword(accountId, epoch, current, next)`, `legacyAllowed(): Promise<boolean>` with `type AccountInfo = { id: string; login: string; name: string; role: "admin" | "facilitator"; mustChange: boolean; epoch: number }`; new `LauncherReason` values `login_refused`, `login_expired`, `weak_password`.
- Cookie (`console-session.ts`): `ConsoleSession = { kind: "account"; accountId: string; epoch: number; name: string; expiresAt: number } | { kind: "legacy"; name: string; epoch: string; expiresAt: number }`.
- `requireConsole(req, deps): Promise<ConsoleSessionView | Response>` is now async and returns `{ name, role, accountId: string | null, mustChange }`, re-checking an account cookie with `accountCheck` on every call (a legacy cookie is accepted only while `legacyAllowed()`, acts as `role: "admin"`, `accountId: null`); `guard(...)` in `console-sessions.ts` becomes async and refuses with 403 `must_change_password` for every console route except logout and password change when `mustChange` is true. All callers await it.
- `POST /api/v1/console/login` accepts `{login, password}` (account) or `{secret, name}` (legacy, only while allowed); throttling charged per address and per lower-cased login on a wrong password; `POST /api/v1/console/password {current, next}` calls `accountChangePassword`, then re-seals the cookie with the new epoch.

- [ ] **Step 1: Failing tests:** `test_login_with_account_sets_sealed_cookie_and_returns_role`, `test_login_wrong_password_is_neutral_401_and_charges_throttle_per_address_and_login`, `test_legacy_login_works_only_while_default_admin_unchanged`, `test_guard_rechecks_account_on_every_request_revoked_cookie_gets_401_and_cleared`, `test_guard_returns_403_must_change_password_except_password_and_logout`, `test_change_password_reseals_cookie_with_new_epoch_old_cookie_fails`, `test_valid_cookie_bypasses_address_throttle` (mirror the report cookie rule), `test_no_secret_or_password_in_any_response_body_or_log`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-accounts.login.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement per Interfaces; update every `requireConsole`/`guard` caller with `await`; keep the existing console tests green by giving their fake deps an account-less legacy path or a fake `accountCheck`.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test` and `pnpm --filter @acr/web typecheck`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0133: Sign in with accounts and re-check every console request`.

### Task 6: Ownership enforcement in the BFF

**Files:** Modify `console-sessions.ts` (`guard`, `handleConsoleSessionsList`, `handleConsoleSessionsCreate`), `console-stream.ts`, `console-report-handlers.ts`, `console-ai.ts`; Create `app/api/v1/console/sessions/[id]/owner/route.ts` and handler `handleConsoleSetOwner` in `console-accounts.ts`; Test `console-ownership.test.ts`.

**Interfaces:**
- Produces: `guard` gains the rule "when the request names a session id: allow an admin; allow a facilitator only when the control service's session `owner === accountId`; otherwise the same neutral 404 the routes already use for an unknown session". `GET /api/v1/console/sessions` returns only the caller's sessions for a facilitator (admin: all, with `owner`); create passes `owner: accountId` (legacy: none); `POST /api/v1/console/sessions/:id/owner {owner: string | null}` is admin only.

- [ ] **Step 1: Failing tests (table-driven):** `test_facilitator_gets_404_for_another_facilitators_session_on_every_console_route` (iterate the route list in the File Structure: command, stream, readiness, reissue, reissue-all, remove, restart, start, facts, ai-roles, intents, prompt, report and every report subroute, report-links), `test_admin_can_use_any_session`, `test_session_without_owner_is_admin_only`, `test_list_is_filtered_for_facilitator_not_for_admin`, `test_create_records_the_caller_as_owner`, `test_set_owner_is_admin_only_and_rejects_unknown_account`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-ownership.test.ts`; expect FAIL.
- [ ] **Step 3:** Add the owner lookup to `guard` (one control `GET /sessions/:id` call, reuse the existing launcher-client session call) and apply it in `console-stream.ts` and the report/ai handlers that do not use `guard`.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0133: Enforce session ownership on every console route`.

### Task 7: Admin account routes in the BFF

**Files:** Create `apps/web/src/server/console-accounts.ts` handlers and routes `app/api/v1/console/admin/accounts/route.ts` (GET list, POST create) and `.../accounts/[id]/{resend,reset,revoke,reinstate}/route.ts`; Test `console-admin-accounts.test.ts`.

**Interfaces:**
- Produces: handlers `handleAdminAccountsList`, `handleAdminAccountCreate`, `handleAdminAccountAction(action: "resend" | "reset" | "revoke" | "reinstate")`: admin only (403 `forbidden` for a facilitator), Origin and `X-Requested-With` checked like every state change, `by` taken from the caller's account id (never from the body). The create/resend/reset/reinstate response carries `{ account, temporaryPassword }` once with `Cache-Control: no-store`.

- [ ] **Step 1: Failing tests:** `test_facilitator_gets_403_on_every_admin_route`, `test_create_returns_temporary_password_with_no_store_and_list_never_does`, `test_actions_require_origin_and_header`, `test_revoke_last_admin_returns_conflict_message`, `test_by_comes_from_the_cookie_not_the_body`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement as thin proxies to the Task 5 launcher-client calls (add `accountsList`, `accountCreate`, `accountAction`).
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0134: Add admin routes for facilitator accounts`.

### Task 8: Sign-in and forced change-password screens

**Files:** Modify `apps/web/src/components/console/ConsoleLogin.tsx`, the console shell/page redirect logic; Create `apps/web/src/components/console/ChangePasswordForm.tsx`, `apps/web/src/app/console/password/page.tsx`; Test `components/__tests__/ConsoleLogin.test.tsx`, `ChangePasswordForm.test.tsx`.

**Interfaces:**
- Produces: `ConsoleLogin` fields "Login" and "Password" (a small "Use the shared secret instead" disclosure shown only when the server says legacy is allowed); `ChangePasswordForm({ onDone })` with "New password" and "Repeat", minimum 10 characters shown as helper text; after login a `mustChange` account is sent to `/console/password` and every other console page redirects there until done; the new password and the current one are never put in storage or the URL.

- [ ] **Step 1: Failing tests:** `test_login_form_posts_login_and_password`, `test_login_refused_shows_the_neutral_message`, `test_must_change_redirects_to_password_page`, `test_change_form_rejects_mismatch_and_short_without_a_request`, `test_change_form_success_goes_to_console`, `test_passwords_are_never_written_to_storage_or_the_url`, `test_axe_has_no_violations_login_and_change` (follow the repo's existing Axe pattern).
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/ConsoleLogin.test.tsx src/components/__tests__/ChangePasswordForm.test.tsx`; expect FAIL.
- [ ] **Step 3:** Implement; reuse `api.ts` post helpers and existing form/banner CSS classes.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0135: Add account sign-in and the forced password change`.

### Task 9: Admin screen and owner column

**Files:** Create `apps/web/src/components/console/admin/{FacilitatorsPanel,CredentialsPanel}.tsx`, `apps/web/src/app/console/admin/page.tsx`; Modify `SessionList.tsx`, the console header (an "Admin" link for admins); Test `components/__tests__/FacilitatorsPanel.test.tsx`, `CredentialsPanel.test.tsx`, `SessionList.owner.test.tsx`.

**Interfaces:**
- Produces: `FacilitatorsPanel` lists name, login, role, status and actions per the spec's status machine (Resend for invited; Reset password for active; Revoke for invited or active; Reinstate for revoked), each with the existing `ConfirmDialog`; a "New facilitator" form (name, email as login, role Admin or Facilitator); `CredentialsPanel({ login, name, temporaryPassword, onDismiss })` shows "Share these with <name>. Shown once." with Copy buttons and keeps the password in component state only (same rule as `CodesPanel`); `SessionList` shows an Owner column and an Assign action for admins.

- [ ] **Step 1: Failing tests:** `test_panel_shows_only_the_actions_allowed_for_each_status`, `test_create_shows_credentials_once_then_clears_on_dismiss`, `test_credentials_never_in_storage_or_url_and_gone_after_remount`, `test_revoke_asks_for_confirmation`, `test_non_admin_never_sees_the_admin_link_or_page`, `test_session_list_shows_owner_and_assign_for_admin_only`, `test_axe_admin_panel_light_and_dark`.
- [ ] **Step 2:** Run the three test files; expect FAIL.
- [ ] **Step 3:** Implement with the existing `Person`, `ConfirmDialog` and card/table styles; fetch with the Task 7 routes.
- [ ] **Step 4:** Run `pnpm --filter @acr/web test` and `pnpm --filter @acr/web typecheck`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0083 | TASK-0135: Add the admin facilitators screen and session owners`.

### Task 10: End to end, docs, stories and the demo kit

**Files:** Create `apps/web/e2e/accounts.spec.ts`; Modify `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `README.md`, `.env.example`, `CHANGELOG.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `docs/TEST_CASES.md`, `docs/demo/CLIENT_DEMO.md`, `docs/demo/demo-up.sh`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1: Failing e2e** (`accounts.spec.ts`, real control + web via the existing stack helper): default admin signs in with the default password and is forced to change it; admin creates a facilitator and sees the temporary password once; the facilitator signs in, is forced to change it, creates a session; a second facilitator cannot open that session (neutral 404) but the admin can; the admin revokes the first facilitator and that person's open console page gets 401 on the next request; the legacy secret stops working after the admin's first change.
- [ ] **Step 2:** Run `pnpm --filter @acr/web e2e` (needs `PLAYWRIGHT_CHROMIUM_EXECUTABLE` if the pinned Chromium is missing); expect FAIL, then PASS after the earlier tasks.
- [ ] **Step 3:** Docs: THREAT_MODEL "Facilitator accounts" (default password risk and mitigations, temporary password on screen, epoch revoke, ownership, throttles, file safety); ROLLBACK (deploy control before web; `ADMIN_RESET=1` recovery; rolling back to the shared secret needs no data step because `accounts.json` is ignored by an older build, but owners recorded in `sessions.json` are ignored too); README and `.env.example` for `ADMIN_BOOTSTRAP_PASSWORD` and `ADMIN_RESET`; CHANGELOG under Unreleased; file US-0083 and the backlog stories US-0084..US-0089 in `docs/RELEASE_PLAN.md` with ACs AC-0500.. and the registry reserved block; TC-0270.. in `docs/TEST_CASES.md`; `npm run plan:generate`.
- [ ] **Step 4:** Demo kit: the cue card and `demo-up.sh` say to sign in as `admin` with the default password the first time, change it, then create facilitators; `demo-up.sh secret` still works until the first change.
- [ ] **Step 5:** Run the full gates: `pnpm typecheck`, `pnpm lint:sdk`, `pnpm --filter @acr/control test`, `pnpm --filter @acr/web test`, `pnpm --filter @acr/runtime test`, `npm run plan:test`, the mock demos `pnpm -s demo --fast` (29), `--showcase --fast` (14), `--fast --security --resume` (42). Commit `[docs] US-0083 | TASK-0136: Document accounts, file the stories and update the demo kit`.
