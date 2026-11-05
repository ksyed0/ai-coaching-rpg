# Slice 2c-1: Report Access and the Read-Only Participant Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A participant opens a facilitator-issued link after the session has ended and reads their own released report and the peer-redacted group report in the browser; the facilitator can issue, reissue and revoke links from the console.

**Architecture:** A read-only runtime subpath `@acr/runtime/reports` reads a review folder and returns the released view for one role. The control service owns a hashed credential store (`access.json`), verifies credentials on every read and is the only reader of reports. The BFF exchanges a link token (carried in the URL fragment) for a sealed cookie and proxies reads. Two PRs: PR 1 control side (no browser), PR 2 browser.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, Vitest, zod, Next.js route handlers, Playwright and Axe.

**Spec:** `docs/superpowers/specs/2026-11-05-slice-2c-reports-design.md` (decisions 1 to 10, sections 3 and 4). Earlier: `docs/superpowers/specs/2026-10-26-web-client-design.md` section 5.8.

## Global Constraints

- Credential: 128 bits from `crypto.randomBytes(16)`, base64url; stored only as a salted SHA-256; shown once.
- `REPORT_ACCESS_DAYS`: integer 1 to 365, default 90, validated at startup with the other control settings (one error naming the variable, never a value).
- `access.json`: mode `0600`, atomic write (temp file plus rename), at `<CONTROL_DATA_DIR>/reports/<sessionId>/access.json`, outside the review log. Record: `{ id, role, hash, salt, createdAt, expiresAt, revokedAt?, lastUsedAt? }`.
- One live credential per role. Issue on a role with a live credential answers 409 (`conflict`); `reissue` revokes the old and issues a new one.
- `lastUsedAt` is written on exchange and on reads, at most once per 10 minutes per credential.
- One neutral refusal (same status 404, same body `{ code: "not_found", message: "Not found." }`) for unknown, expired, revoked, wrong-role and wrong-session credentials. A holder of a LIVE credential whose report is later withdrawn or unreadable is not an oracle case: `read` answers 200 `{ state: "not_released" }` or 503 `unavailable` ("try again") for them.
- The BFF never reads `data/reports` or credential hashes. The control service imports the runtime only through the `exports` map of `services/runtime/package.json` (today `./players`; this slice adds `./reports`).
- Cookie `__Host-scenecoach-report`: sealed with the existing `seal`/`unseal` (new purpose `"rpt"`), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; `expiresAt` = the credential's `expiresAt`.
- Page and API responses carry `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. All report text is rendered escaped (React text nodes, never `dangerouslySetInnerHTML`).
- Commit format `[TYPE] EPIC-0002: description`; every PR adds `[Unreleased]` CHANGELOG entries and passes the project's checks. New ids: AC from AC-0365, TC from TC-0121, TASK from TASK-0100 (check `docs/ID_REGISTRY.md` first).
- Coverage gate stays at least 80%.

## Review Focus

1. A revoked credential whose cookie is still in a browser: the very next read must be refused (test through the BFF).
2. A token for session A or role X presented for session B or role Y: identical refusal to an unknown token (body and status byte-equal).
3. Expiry at the boundary: a credential is dead at exactly `expiresAt`, and the cookie never outlives it.
4. A report folder that is missing, empty, corrupt or still a draft: a clear page state, never a stack trace or file path.
5. The fragment token never reaches a server log, a `Referer` header or the address bar after load; with script disabled the page says so and sends nothing.

---

## PR 1: control side, no browser

### Task 1: `@acr/runtime/reports` reader

**Files:**
- Create: `services/runtime/src/reports/index.ts`
- Test: `services/runtime/src/reports/__tests__/reports.test.ts`
- Modify: `services/runtime/package.json` (`exports`: add `"./reports": "./src/reports/index.ts"`)

**Interfaces:**
- Produces:
  - `type ReleasedView = { kind: "released"; own: ParticipantReport; group: GroupReport | null; markdown: { own: string; group: string | null } }`
  - `type ReadResult = ReleasedView | { kind: "not_released" } | { kind: "missing" } | { kind: "unavailable" }`
  - `readReleasedView(dir: string, role: string, secrets: string[]): Promise<ReadResult>`
  - `listReleasedRoles(dir: string): Promise<string[] | null>` (null when `dir` holds no review)
- Consumes: `loadReview`, `canView`, `viewReport`, `participantGroupReport`, `renderSubjectMarkdown`, `scrubDeep` as `review/export.ts` uses them.

- [ ] **Step 1: Write failing tests** using a fixture review folder built the way `services/runtime/src/review/__tests__` builds one (reuse its helper). Cases: released role returns `own` and a `group` with every peer row removed (assert no peer role id appears anywhere in `JSON.stringify(result)`); a draft or withdrawn role returns `not_released`; a superseded review returns `not_released`; missing dir returns `missing`; a tampered `review.jsonl` returns `unavailable` and the result contains no path or message; an invalid role id returns `not_released`; `listReleasedRoles` lists only released participant roles.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime exec vitest run src/reports` and see the failures.
- [ ] **Step 3: Implement** both functions. Read only (`loadReview`, never `applyCommand`; no audit event is written, a deliberate difference from `export`). Authorise each read with `canView({ principal: \`participant:${role}\`, view: "report", ... })` for the role and for `group`; produce the group with `participantGroupReport`. Catch `ReviewCorruptError` and `ReviewRefusedError` and map them to `unavailable`/`missing` without echoing messages.
- [ ] **Step 4: Run** the tests; they pass. Run `pnpm --filter @acr/runtime typecheck`.
- [ ] **Step 5: Commit** `[feat] EPIC-0002: read-only released-report reader (@acr/runtime/reports)`.

### Task 2: Control may import only the two subpaths

**Files:**
- Modify: `docs/superpowers/specs/2026-11-05-slice-2c-reports-design.md` (decision 1 and threat-model "Boundary": the boundary is the runtime `exports` map, not the SDK Import Guard script, which only checks provider SDKs)
- Test: `services/control/src/__tests__/runtime-imports.test.ts`

- [ ] **Step 1: Write a failing test** that scans every `*.ts` under `services/control/src` (and `apps/web/src`) for `@acr/runtime` specifiers: control may use only `@acr/runtime/players` and `@acr/runtime/reports`; web must use none.
- [ ] **Step 2: Run** it. Because Task 1 already added the export it passes; prove the test can fail by running it once against a temporary `import "@acr/runtime/review/store"` line added to a control file, then remove that line.
- [ ] **Step 3: Fix the spec wording** named above.
- [ ] **Step 4: Run, commit** `[test] EPIC-0002: pin the runtime subpaths the control service may import`.

### Task 3: Credential store

**Files:**
- Create: `services/control/src/report-access.ts`
- Test: `services/control/src/__tests__/report-access.test.ts`

**Interfaces:**
- Produces:
  - `type ReportCredential = { id: string; role: string; createdAt: number; expiresAt: number; revokedAt?: number; lastUsedAt?: number }` (never exposes `hash` or `salt`)
  - `class ReportAccessStore { constructor(o: { dir: string; days: number; now: () => number }) }`
  - `issue(role: string): Promise<{ credential: ReportCredential; token: string }>` throws `ControlError("conflict")` when a live credential exists
  - `reissue(role: string)` same return; revokes the old one first, in one atomic write
  - `revoke(role: string): Promise<boolean>`
  - `list(): Promise<ReportCredential[]>`
  - `verify(token: string): Promise<ReportCredential | null>` (constant-time hash compare; null for unknown, expired, revoked)
  - `check(id: string): Promise<ReportCredential | null>` (live by id; used on every read; updates `lastUsedAt` at most every 10 minutes)

- [ ] **Step 1: Write failing tests**: issue returns a 22-character base64url token and `access.json` never contains it; file mode is `0600`; second `issue` for a live role throws `conflict`; `reissue` kills the old token and `verify(old)` is null; `verify` is null at exactly `expiresAt`; `revoke` then `check(id)` is null; `lastUsedAt` changes at most once per 10 minutes (fake `now`); a corrupt `access.json` makes every call fail closed (verify null, issue throws) without leaking content; two concurrent `issue` calls for different roles both persist.
- [ ] **Step 2: Run** and see failures.
- [ ] **Step 3: Implement** with a per-store promise chain so writes are serialised, write to a temp file in the same directory then `rename`, `fs.chmod 0600`, salted SHA-256 compared with `timingSafeEqual`.
- [ ] **Step 4: Run** tests and `pnpm --filter @acr/control typecheck`; **Step 5: Commit** `[feat] EPIC-0002: hashed report-access credential store`.

### Task 4: Config, report service and control API

**Files:**
- Modify: `services/control/src/config.ts` (add `reportsDir: string` = `<dataDir>/reports`, `reportAccessDays: number`; `whole("REPORT_ACCESS_DAYS", 90, 1, 365)`)
- Create: `services/control/src/reports.ts`
- Modify: `services/control/src/api.ts`, `services/control/src/main.ts` (construct the service)
- Test: `services/control/src/__tests__/reports.test.ts`, `services/control/src/__tests__/api.reports.test.ts`, extend `config.test.ts`

**Interfaces:**
- Produces (`reports.ts`): `createReportService(d: { config: ControlConfig; aiRolesOf: (sessionId: string) => string[]; now: () => number; secrets: string[] }): ReportService` with
  - `links(sessionId): Promise<{ missing: boolean; roles: { role: string; released: boolean; ai: boolean; credential: ReportCredential | null }[] }>`
  - `issue(sessionId, role)`, `reissue(sessionId, role)`, `revoke(sessionId, role)`: refuse AI and unreleased roles with `conflict` ("no report to link")
  - `exchange(token): Promise<{ credentialId: string; sessionId: string; role: string; expiresAt: number } | null>`
  - `read(sessionId, credentialId): Promise<ReadResult>` re-checks `check(credentialId)` and that the credential's session matches, then calls `readReleasedView`
- Produces (HTTP, all behind the existing service-token check): `GET /sessions/:id/report-links`, `POST /sessions/:id/report-links` body `{ role }`, `POST /sessions/:id/report-links/:role/reissue`, `DELETE /sessions/:id/report-links/:role`, `POST /report-access/exchange` body `{ token }` (token max 64 chars), `GET /sessions/:id/reports/:credentialId`.

- [ ] **Step 1: Write failing tests**: config rejects `REPORT_ACCESS_DAYS=0`, `400`, `abc` with one message that names the variable and no value; issue for an AI role, an unreleased role and a missing folder each give 409 with fixed messages (the missing-folder message includes the exact `pnpm evaluate --out` command with the session id and nothing else from the request); `exchange` for unknown, revoked, expired tokens returns the same 404 body; a `read` after `revoke` is 404 identical to unknown; `read` with another session's id is 404; `read` returns no peer roles. API tests check body size cap, unknown role id 404 before any file is touched, and that no response or log line contains a token or hash.
- [ ] **Step 2: Run** and see failures.
- [ ] **Step 3: Implement.** Map `read` results: a failed `check` or session mismatch to the neutral 404; `released` to 200 with the view; `not_released` and `missing` to 200 `{ state: "not_released" }`; `unavailable` to 503 `unavailable`. The sealed cookie payload (Task 6) is `{ sessionId, credentialId, role, expiresAt }`.
- [ ] **Step 4: Run** `pnpm --filter @acr/control test` and typecheck; **Step 5: Commit** `[feat] EPIC-0002: control-service report links and released-report read API`.

### Task 5: PR 1 documentation and gate

- [ ] Add `[Unreleased]` CHANGELOG entry; file AC/TC ids in `docs/ID_REGISTRY.md` and `docs/RELEASE_PLAN.md`/`TEST_CASES.md`; amend AC-0327 wording (spec section 3); update `progress.md`; run `npm run plan:generate`; run the full local gate (`pnpm -r typecheck`, `pnpm -r test`, `npm test`); open the PR to develop with auto-merge.

---

## PR 2: browser

### Task 6: BFF exchange, cookie and read proxy

**Files:**
- Modify: `apps/web/src/server/launcher-client.ts` (add `reportLinks`, `issueReportLink`, `reissueReportLink`, `revokeReportLink`, `exchangeReportToken`, `readReport`), `apps/web/src/server/seal.ts` (purpose type `"fac" | "rpt"`), `apps/web/src/server/routes.ts` (export new routes; add `reportThrottle: JoinThrottle` to `Deps`), `apps/web/src/server/handlers.ts` types
- Create: `apps/web/src/server/report-handlers.ts`, `apps/web/src/app/api/v1/report/enter/route.ts`, `apps/web/src/app/api/v1/report/route.ts`, `apps/web/src/app/api/v1/console/sessions/[id]/report-links/route.ts` (and `[role]` variants)
- Test: `apps/web/src/server/__tests__/report-handlers.test.ts`

**Interfaces:**
- Produces: `handleReportEnter(req, deps)` (POST `{ token }`, throttled per client address like join; sets cookie; returns `{ success: true, data: {} }`), `handleReportGet(req, deps)` (GET; unseals cookie, calls `readReport(sessionId, credentialId)`), console handlers `handleReportLinks*` guarded by the facilitator session like the other console handlers.

- [ ] **Step 1: Write failing tests**: enter with a valid token sets `__Host-scenecoach-report` with `HttpOnly; Secure; SameSite=Lax; Path=/` and `Expires` equal to the credential's `expiresAt`; refused tokens return the exact neutral body; sixth failed attempt from one address in 60 s is throttled; GET without or with a tampered cookie is the neutral 404; GET after the launcher answers 404 (revoked) is the neutral 404 and clears the cookie; every response has `no-store` and `no-referrer`; console routes need the facilitator cookie; the token never appears in any log call (spy on `console`).
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/report-handlers.test.ts`, see failures. **Step 3: Implement.** **Step 4: Run** passes. **Step 5: Commit** `[feat] EPIC-0002: BFF report exchange, sealed cookie and read proxy`.

### Task 7: Participant pages

**Files:**
- Create: `apps/web/src/app/report/enter/page.tsx`, `apps/web/src/app/report/page.tsx`, `apps/web/src/components/ReportEnter.tsx`, `apps/web/src/components/ReportView.tsx`, print rules in the page's CSS module
- Test: `apps/web/src/components/__tests__/ReportEnter.test.tsx`, `ReportView.test.tsx`

**Interfaces:**
- `ReportEnter`: client component; on mount reads `location.hash`, calls `history.replaceState(null, "", location.pathname)`, posts `{ token }`, then `location.assign("/report")`; shows states `opening`, `refused` ("This link no longer works. Ask your facilitator for a new one."), `retry`. `<noscript>` shows "This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help."
- `ReportView`: states `loading`, `report` (own report, group report section, "Available until <date>", Print button), `not_released`, `refused`, `retry`. Uses design tokens only (`apps/web/src/lib/tokens.css`), no new colours.

- [ ] **Step 1: Write failing tests**: the fragment is removed from the address bar before the POST is awaited; the POST body holds the token and nothing else; the three states render their fixed copy; report text containing `<img onerror>` renders as text; "Available until" shows the formatted date; `@media print` hides the header and the Print button (assert the CSS rule text).
- [ ] **Step 2 to 4: run, implement, run.** **Step 5: Commit** `[feat] EPIC-0002: participant report pages`.

### Task 8: Console link panel

**Files:**
- Create: `apps/web/src/components/console/ReportLinksPanel.tsx`; modify `SessionConsole.tsx` to show it when the session has ended
- Test: `apps/web/src/components/__tests__/ReportLinksPanel.test.tsx`

**Interfaces:** consumes the console report-link routes of Task 6. Shows per released human role: Issue link, Reissue (uses the existing `ConfirmDialog`; text states the old link stops working at once), Revoke, expiry date, last-used time; the token appears once, as `<origin>/report/enter#<token>`, with a Copy button. When the folder is missing it shows the exact `pnpm evaluate --out` command from the API message. AI roles and unreleased roles are listed as "no link" with the reason.

- [ ] **Step 1: Write failing tests** (reissue needs confirmation; the shown link disappears on re-render after dismissal; copy uses the clipboard API; missing-folder state; AI and unreleased roles have no Issue button). **Steps 2 to 4**, **Step 5: Commit** `[feat] EPIC-0002: console panel to issue, reissue and revoke report links`.

### Task 9: End-to-end, accessibility, documents

**Files:**
- Create: `apps/web/e2e/report-access.spec.ts` (follow the existing Playwright specs for fixtures and the control-service start-up)
- Modify: `docs/THREAT_MODEL.md` (new section "Report access (slice 2c-1, US-0062)": spec section 4, one paragraph per bullet), `CHANGELOG.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `progress.md`, `MEMORY.md`, `docs/ROLLBACK.md` (a rollback note: `access.json` is ignored by older builds)

- [ ] **Step 1: Write the e2e**: seed a released review folder, end the runtime, issue a link in the console, open `/report/enter#<token>` in a fresh context, assert the report shows and the address bar has no fragment; revoke in the console, reload `/report`, assert the refused state; reissue, assert old link refused and new link works; JavaScript disabled shows the fallback and sends no request to `/api/v1/report/enter`. Axe at 400 and 1280 px, light and dark, on `/report` and the console panel.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec playwright test report-access`, fix, repeat until green.
- [ ] **Step 3: Documents** as listed; run `npm run plan:generate`.
- [ ] **Step 4: Full local gate** then open the PR to develop with auto-merge; do not merge with failing or pending checks.
