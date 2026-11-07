# Slice 2c-1: Report Access and the Read-Only Participant Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant opens a facilitator-issued link after the session has ended and reads their own released report and the peer-redacted group report in the browser; the facilitator can issue, reissue and revoke links from the console.

**Architecture:** A read-only runtime subpath `@acr/runtime/reports` finds a session's live review folder and returns the released view for one role. The control service owns one hashed credential store, verifies the credential on every read and is the only reader of reports. The BFF exchanges a link token (carried in the URL fragment) for a sealed cookie and proxies reads. Two PRs: PR 1 control side (no browser), PR 2 browser.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, Vitest, zod, Next.js route handlers, Playwright and Axe.

**Spec:** `docs/superpowers/specs/2026-11-05-slice-2c-reports-design.md`. Earlier: `docs/superpowers/specs/2026-10-26-web-client-design.md` section 5.8. An Opus review (2026-11-05) of the first draft of this plan found two Critical issues (credential file inside the review folder; links dying after an evaluate re-run) and nine Important ones; this version folds them in.

## Global Constraints

- Token format: `<id>.<secret>`; `id` = 8 random bytes and `secret` = 16 random bytes (128 bits), both base64url; shown once. Stored: `id`, and a salted SHA-256 of `secret` only. The id is the lookup key (so an exchange never scans), the secret is compared in constant time.
- Store: ONE file `<CONTROL_DATA_DIR>/report-access.json` (mode `0600`, atomic temp-file plus rename, one store instance and one in-process write queue for the whole control service). It lives OUTSIDE every review folder, because `loadDrafts` reads every `*.json` in a review folder and refuses unknown files (`review/draft.ts:334`, `review/store.ts:300`). Record: `{ id, sessionId, role, salt, hash, createdAt, expiresAt, revokedAt?, lastUsedAt? }`.
- `REPORT_ACCESS_DAYS`: integer 1 to 365, default 90, validated at startup with the other control settings (one message naming the variable, never a value).
- One live credential per (session, role). Issue on a live pair answers 409 `conflict`; `reissue` revokes the old and issues a new one in one write. Revoke works whenever a credential exists, whatever state the report is in.
- `lastUsedAt` is written on exchange and on reads, at most once per 10 minutes per credential, through the same write queue (a read can never undo a revoke).
- One neutral refusal (404, body `{ success:false, data:null, error:{ code:"not_found", message:"Not found." } }`, same headers) for an unknown, expired, revoked, wrong-session or malformed token or credential id. A holder of a LIVE credential whose report is withdrawn, still draft or unreadable is not an oracle case: `read` answers 200 `{ state:"not_released" }` or 503 `unavailable` ("try again").
- Reports: the reader resolves the session's single live review: directories `<CONTROL_DATA_DIR>/reports/<sessionId>` and `<sessionId>-2` … `-99` (evaluate re-runs write the suffixed ones, `report-write.ts:90`), choosing the one whose review is not superseded and whose recorded session id equals the credential's. "Released" counts states `released` and `amending` (as `canView` does).
- AI roles need no special code: an AI role can never be a report subject (`review/draft.ts:404`), so `listReleasedRoles` never returns one.
- The BFF never reads `data/reports` or credential records. The control service imports the runtime only through the `exports` map of `services/runtime/package.json` (today `./players`; this slice adds `./reports`).
- Cookie `__Host-scenecoach-report`: sealed with `seal`/`unseal` (purpose type widened to `"fac" | "rpt"`), payload `{ sessionId, credentialId, role, expiresAt }`, `HttpOnly; Secure; SameSite=Lax; Path=/`, `Max-Age` = seconds left to the credential's `expiresAt`.
- `/report` and `/report/enter` pages and every report API response carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Report text renders as escaped React text only.
- `POST /api/v1/report/enter` applies the same `checkOrigin` and `checkFetchSite` guards as join, then the per-address throttle (`JoinThrottle`, same limits as join).
- The "reports are not ready" message is one fixed sentence with no paths or ids: "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide)."
- Commit format `[TYPE] EPIC-0002: description`; each PR adds `[Unreleased]` CHANGELOG entries and passes the project checks. Reuse TASK-0091 for PR 1 and TASK-0092 for PR 2 if free in the plan, else TASK-0100; AC from AC-0365, TC from TC-0121 (check `docs/ID_REGISTRY.md` first). Coverage at least 80%.

## Review Focus

1. A revoked credential whose cookie is still in a browser: the next read through the BFF is refused.
2. Wrong-session, wrong-role, malformed, expired and revoked tokens: byte-equal status, body and headers; unknown ids take the same code path as wrong secrets.
3. Expiry at the boundary: dead at exactly `expiresAt`; the cookie never outlives it.
4. A report folder that is missing, draft, withdrawn, corrupt, re-run (`-2`) or deleted mid-read: a clear page state, never a stack trace or file path.
5. The fragment token never reaches a log, a `Referer`, the address bar after load or a second effect run (React StrictMode); with script off the page says so and sends nothing.
6. A forged cross-site POST to `/api/v1/report/enter` cannot sign a victim into the attacker's report.

---

## PR 1: control side, no browser

### Task 1: `@acr/runtime/reports` reader and resolver

**Files:**
- Create: `services/runtime/src/reports/index.ts`
- Test: `services/runtime/src/reports/__tests__/reports.test.ts`
- Modify: `services/runtime/package.json` (`exports`: add `"./reports": "./src/reports/index.ts"`); export `secretValues` (or its equivalent used by `review/cli.ts`) so control can build the `secrets` list the same way the CLI does

**Interfaces:**
- Produces:
  - `type ReleasedView = { kind: "released"; own: ParticipantReport; group: GroupReport | null; markdown: { own: string; group: string | null } }`
  - `type ReadResult = ReleasedView | { kind: "not_released" } | { kind: "missing" } | { kind: "unavailable" }`
  - `resolveReviewDir(reportsDir: string, sessionId: string): Promise<string | null>` (the live, unsuperseded review of that session among `<id>`, `<id>-2`…; null when none)
  - `readReleasedView(reportsDir: string, sessionId: string, role: string, secrets: string[]): Promise<ReadResult>`
  - `listReleasedRoles(reportsDir: string, sessionId: string): Promise<string[] | null>` (null when nothing resolves)
- Consumes: `loadReview`, `canView`, `viewReport`, `participantGroupReport`, `renderSubjectMarkdown`, `scrubDeep` (from `demo/report.ts`), exactly as `review/export.ts:37-160` combines them for `--for participant:<role>`.

- [ ] **Step 1: Write failing tests** with a fixture review built like the existing ones in `services/runtime/src/review/__tests__`:
  - parity: for a released role, `markdown.own` and `markdown.group` equal what `moderate export --for participant:<role>` writes (same bytes), and `own`/`group` equal the scrubbed JSON of that export; no assertion that a peer id is absent everywhere (policy keeps notable-moment role and quote, `policy.ts:133`); instead assert peers' `lo_coverage` rows and facilitator-only fields (notes, talking points, internal comments) are absent.
  - states: draft or withdrawn role gives `not_released`; `amending` with a snapshot gives `released`; a role that is not a subject gives `not_released`; invalid role id gives `not_released`; no directory gives `missing`; tampered `review.jsonl`, a stray unreadable file, or a directory removed mid-read gives `unavailable` with no path or message in the result.
  - re-run: with `<id>` superseded and `<id>-2` live and released, `resolveReviewDir` returns `<id>-2` and the read succeeds; with two live siblings it returns null.
  - `listReleasedRoles` returns only released participant roles.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/reports`; see failures.
- [ ] **Step 3: Implement** read-only (`loadReview` takes no `review.lock`; no `applyCommand`, no audit event, a deliberate difference from `export`). Wrap every call, including the directory scan and `frozenView`, in a catch-all mapping to `unavailable` or `missing` without echoing the error. Check the role is a participant subject in the view before authorising, as `export.ts:61` does.
- [ ] **Step 4: Run** tests and `pnpm --filter @acr/runtime typecheck`. **Step 5: Commit** `[feat] EPIC-0002: read-only released-report reader (@acr/runtime/reports)`.

### Task 2: Allow the second control import and keep the guard honest

**Files:**
- Modify: `services/control/src/__tests__/bots/imports.test.ts` (allow exactly `@acr/runtime/players` and `@acr/runtime/reports`; keep the checker-sees-every-import-form test)
- Modify: `docs/superpowers/specs/2026-11-05-slice-2c-reports-design.md` (see Task 4b)
- Test: add to `apps/web/src/server/__tests__` (or reuse an existing source-rules test) a check that no `apps/web/src` file imports `@acr/runtime`

- [ ] **Step 1: Change the allow-list**; the test must then FAIL for a temporary `import "@acr/runtime/review/store"` line added to a control file (run it, then remove the line) and pass without it.
- [ ] **Step 2: Commit** `[test] EPIC-0002: allow the reports subpath, pin the rest`.

### Task 3: Credential store

**Files:**
- Create: `services/control/src/report-access.ts`
- Test: `services/control/src/__tests__/report-access.test.ts`

**Interfaces:**
- Produces:
  - `type ReportCredential = { id: string; sessionId: string; role: string; createdAt: number; expiresAt: number; revokedAt?: number; lastUsedAt?: number }` (never carries `salt`, `hash` or the secret)
  - `class ReportAccessStore { constructor(o: { file: string; days: number; now: () => number }) }`
  - `issue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }>` (throws `ControlError("conflict")` when a live pair exists)
  - `reissue(sessionId: string, role: string)` (same return; revoke plus issue in one write)
  - `revoke(sessionId: string, role: string): Promise<boolean>`
  - `list(sessionId: string): Promise<ReportCredential[]>`
  - `verify(token: string): Promise<ReportCredential | null>` (parses `<id>.<secret>`, looks up by id, constant-time hash compare, null for unknown, malformed, expired or revoked)
  - `check(credentialId: string): Promise<ReportCredential | null>` (live by id; the per-read re-check; writes `lastUsedAt` at most every 10 minutes through the queue)

- [ ] **Step 1: Write failing tests**: the file never contains the token or secret; mode `0600`; second `issue` for a live pair throws `conflict`; `reissue` kills the old token; `verify` is null at exactly `expiresAt`; `revoke` then `check(id)` is null; a `check` write racing a `revoke` can never resurrect the credential (run both concurrently 100 times with a fake slow write); `lastUsedAt` changes at most once per 10 minutes; malformed tokens (empty, no dot, 10 000 characters, non-base64url) return null quickly; a corrupt file makes every call fail closed without echoing content; concurrent `issue` calls for different roles both persist.
- [ ] **Step 2: Run**, see failures. **Step 3: Implement** with a single promise-chain write queue and read-modify-write inside it. **Step 4: Run** tests and typecheck. **Step 5: Commit** `[feat] EPIC-0002: hashed report-access credential store`.

### Task 4: Config, report service and control API

**Files:**
- Modify: `services/control/src/config.ts` (add `reportsDir` = `<dataDir>/reports`, `reportAccessFile` = `<dataDir>/report-access.json`, `reportAccessDays` via `whole("REPORT_ACCESS_DAYS", 90, 1, 365)`)
- Create: `services/control/src/reports.ts`
- Modify: `services/control/src/api.ts`, `services/control/src/main.ts`
- Test: `services/control/src/__tests__/reports.test.ts`, `services/control/src/__tests__/api.reports.test.ts`, extend `config.test.ts`

**Interfaces:**
- Produces (`reports.ts`): `createReportService(d: { config: ControlConfig; store: ReportAccessStore; secrets: string[]; now: () => number }): ReportService`
  - `links(sessionId): Promise<{ ready: boolean; roles: { role: string; credential: ReportCredential | null }[] }>` (`ready` false when `resolveReviewDir` finds nothing)
  - `issue(sessionId, role)`, `reissue(sessionId, role)`: refuse with `conflict` and the fixed "not ready" sentence when nothing resolves, and with `conflict` "no report to link" when the role is not in `listReleasedRoles`
  - `revoke(sessionId, role)`: always allowed when a credential exists
  - `exchange(token): Promise<{ credentialId: string; sessionId: string; role: string; expiresAt: number } | null>`
  - `read(sessionId, credentialId): Promise<{ status: 200; body: { state: "released"; view: ReleasedView } | { state: "not_released" } } | { status: 503 } | { status: 404 }>`; a failed `check` or a session mismatch is 404
- HTTP (all after the existing service-token check): `GET /sessions/:id/report-links`, `POST /sessions/:id/report-links` body `{ role }`, `POST /sessions/:id/report-links/:role/reissue`, `DELETE /sessions/:id/report-links/:role`, `POST /report-access/exchange` body `{ token }` (token max 64 chars), `GET /sessions/:id/reports/:credentialId` (credential id matched against `^[A-Za-z0-9_-]{11}$` before any lookup). Role ids validated with `RoleIdSchema` before anything else runs.

- [ ] **Step 1: Write failing tests**: config rejects `REPORT_ACCESS_DAYS` of `0`, `400`, `abc` with a message that names the variable and no value; issue for a role not released, or when nothing resolves, gives 409 with the fixed sentences (no path, no id echoed); `exchange` for unknown, revoked, expired, wrong-secret and malformed tokens returns identical 404 bytes; `read` after `revoke` and `read` with another session's id are that same 404; `read` on a re-run folder works; no response body, header or log line contains a token, hash or salt; body size cap; `reissue` returns the new token once and the old one stops working.
- [ ] **Step 2: Run**, see failures. **Step 3: Implement.** **Step 4: Run** `pnpm --filter @acr/control test` and typecheck. **Step 5: Commit** `[feat] EPIC-0002: control-service report links and released-report read API`.

### Task 4b: PR 1 documents and gate

- [ ] Fix the spec: decision 1 and "Boundary" say the boundary is the runtime `exports` map plus `bots/imports.test.ts`, not the SDK Import Guard script; decision 5 and the Global Constraints above (one global store file, token format, re-run resolver); decision 6 route paths; decision 9 `/report` is read through the cookie with no `:role` in the URL.
- [ ] `[Unreleased]` CHANGELOG entry; file AC/TC ids in `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`; amend AC-0327 (spec section 3); `progress.md`; `npm run plan:generate`; run the full local gate (`pnpm -r typecheck`, `pnpm -r test`, `npm test`); open the PR to develop with auto-merge.

---

## PR 2: browser

### Task 5: BFF exchange, cookie and read proxy

**Files:**
- Modify: `apps/web/src/server/launcher-client.ts` (add `reportLinks`, `issueReportLink`, `reissueReportLink`, `revokeReportLink`, `exchangeReportToken`, `readReport`; check the 1 MiB response cap against the largest fixture report), `apps/web/src/server/seal.ts` (purpose `"fac" | "rpt"`), `apps/web/src/server/handlers.ts` (add `reportThrottle: JoinThrottle` to `Deps`), `apps/web/src/server/routes.ts` (create it, export the routes)
- Create: `apps/web/src/server/report-handlers.ts`, `apps/web/src/app/api/v1/report/enter/route.ts`, `apps/web/src/app/api/v1/report/route.ts`, `apps/web/src/app/api/v1/console/sessions/[id]/report-links/route.ts` and `[role]/…` variants
- Test: `apps/web/src/server/__tests__/report-handlers.test.ts`

**Interfaces:**
- `handleReportEnter(req, deps)`: POST `{ token }`; runs `checkOrigin`, `checkFetchSite`, then the throttle; on success sets the cookie and returns `{ success:true, data:{} }`.
- `handleReportGet(req, deps)`: GET; unseals the cookie, calls `readReport(sessionId, credentialId)`; on control 404 clears the cookie and answers the neutral 404.
- Console handlers: guarded like the other console handlers.

- [ ] **Step 1: Write failing tests**: cookie attributes exactly as the Global Constraints (assert `Max-Age`); neutral bodies are byte-equal across refusals; a cross-site `Origin` or `Sec-Fetch-Site: cross-site` POST is refused before the throttle or any control call; the sixth failed attempt from one address inside 60 s is throttled (match `JoinThrottle` semantics exactly); GET without, with a tampered, or with a `"fac"`-purpose cookie gives the neutral 404; GET after a control 404 clears the cookie; every response has `no-store` and `no-referrer`; console routes need the facilitator cookie; no `console.*` call receives the token (spy).
- [ ] **Step 2 to 4: run, implement, run.** **Step 5: Commit** `[feat] EPIC-0002: BFF report exchange, sealed cookie and read proxy`.

### Task 6: Participant pages

**Files:**
- Create: `apps/web/src/app/report/enter/page.tsx`, `apps/web/src/app/report/page.tsx`, `apps/web/src/components/ReportEnter.tsx`, `apps/web/src/components/ReportView.tsx`, print rules in the components' CSS
- Modify: `apps/web/src/proxy.ts` or the pages' `headers`/route config so the HTML pages themselves carry `no-store` and `no-referrer` (the API already does; the pages do not), checking `proxy.ts` does not strip them
- Test: `apps/web/src/components/__tests__/ReportEnter.test.tsx`, `ReportView.test.tsx`

**Interfaces:**
- `ReportEnter`: client component; reads `location.hash` into a module-level variable on first run only (so React StrictMode's second effect run, which sees an empty hash, reuses it), calls `history.replaceState(null, "", location.pathname)`, posts `{ token }`, then `location.assign("/report")`. States `opening`, `refused` ("This link no longer works. Ask your facilitator for a new one."), `retry`. `<noscript>`: "This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help."
- `ReportView`: states `loading`, `report` (own report, group report, "Available until <date>", Print button), `not_released`, `refused`, `retry`. Tokens only from `apps/web/src/lib/tokens.css`.

- [ ] **Step 1: Write failing tests**: the fragment is gone from the address bar before the POST resolves; the POST body holds the token and nothing else; mounting twice (StrictMode) posts once; state copy is exact; report text containing `<img onerror>` renders as text; "Available until" shows the formatted date; the print rule hides the header and Print button (assert the rule text).
- [ ] **Step 2 to 4**, **Step 5: Commit** `[feat] EPIC-0002: participant report pages`.

### Task 7: Console link panel

**Files:**
- Create: `apps/web/src/components/console/ReportLinksPanel.tsx`; modify `SessionConsole.tsx` to show it for an ended session
- Test: `apps/web/src/components/__tests__/ReportLinksPanel.test.tsx`

Shows per role from `links()`: Issue link, Reissue (existing `ConfirmDialog`; text says the old link stops working at once), Revoke (available whenever a credential exists), expiry date, last-used time; the token shown once as `<origin>/report/enter#<token>` with a Copy button. When `ready` is false it shows the fixed "not ready" sentence.

- [ ] **Step 1: Write failing tests** (reissue needs confirmation; the shown link is gone after dismissal; copy uses the clipboard API; not-ready state; revoke offered for a role whose report was withdrawn). **Steps 2 to 4**, **Step 5: Commit** `[feat] EPIC-0002: console panel to issue, reissue and revoke report links`.

### Task 8: End-to-end, accessibility, documents

**Files:**
- Create: `apps/web/e2e/report-access.spec.ts` (follow the existing Playwright specs for fixtures and control start-up)
- Modify: `docs/THREAT_MODEL.md` (new section "Report access (slice 2c-1, US-0062)": spec section 4, plus browser history/bfcache of the clean `/report` page, the record caps, the single store file and its write queue, and the login-CSRF guard), `CHANGELOG.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `progress.md`, `MEMORY.md`, `docs/ROLLBACK.md` (older builds ignore `report-access.json`)

- [ ] **Step 1: Write the e2e**: seed a released review folder and a `-2` re-run, end the runtime, issue a link in the console, open `/report/enter#<token>` in a fresh context, assert the report shows and the address bar has no fragment; revoke, reload `/report`, assert refused; reissue, assert the old link refused and the new one works; JavaScript disabled shows the fallback and sends no request to the enter route. Axe at 400 and 1280 px, light and dark, on `/report` and the console panel.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-access`; fix until green.
- [ ] **Step 3: Documents** as listed; `npm run plan:generate`.
- [ ] **Step 4: Full local gate**, then open the PR to develop with auto-merge; do not merge with failing or pending checks.
