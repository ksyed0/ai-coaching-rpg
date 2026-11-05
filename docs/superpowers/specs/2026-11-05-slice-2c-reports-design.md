# Slice 2c: reports in the browser (2c-1 designed in full, 2c-2 and 2c-3 outlined)

Addendum to `2026-10-26-web-client-design.md` section 5.8 (and the 2c row of its slice table). Where they differ, this one wins. Slice 2c has three stories (US-0062, US-0063, US-0064). Each gets its own spec, plan and PRs; this document designs the first in full and fixes the order and shared decisions for the other two. Owner decisions of 2026-11-05 are marked **[owner]**.

## 1. Understanding

A participant who finished a session can read their own released report, and the group report with peers removed, in the browser, from a link, without a join code and after the runtime has exited. The facilitator issues that link from the console. In 2c-1 the page is read-only.

- Slice 2c ships in this order: 2c-1 report access and the read-only participant page (US-0062), 2c-2 self-assess and respond (US-0063), 2c-3 facilitator evaluate, moderate, release and export in the console (US-0064) **[owner]**.
- The console issues report links for any role whose report is released, on an ended session. That covers reports released from the terminal as well **[owner]**.
- Until 2c-3, the console shows the exact `pnpm evaluate --out` command, and the control service gives a clear refusal when the reports folder or the released reports are missing **[owner]**.
- A participant gets their own report plus the group report **[owner]**. AI roles and roles with no released report get no link.
- Success: a participant opens the link on a phone, sees only what the review policy releases to them, and loses access the moment the facilitator revokes the link or it expires.

## 2. Decisions for 2c-1

1. **Read path.** A new read-only runtime subpath export `@acr/runtime/reports` returns the released view of one role's report and the group report with peers removed, driven by the review policy (`canView`). The control service is its only consumer; the BFF never touches `data/reports`. The SDK Import Guard rule that today lets the control service import only `@acr/runtime/players` is extended to allow this second subpath and nothing else.
2. **Where reports live.** `CONTROL_DATA_DIR/reports/<sessionId>/`, the folder `pnpm evaluate --out` writes. The control service ties the folder to the session named in the credential, because `canView` knows roles, not sessions.
3. **The link does not carry the credential in a path or query.** The console issues `/report/enter#<token>`. The page reads the fragment in script, removes it from the address bar with `history.replaceState`, and posts it to `POST /api/v1/report/enter`. The BFF exchanges it with the control service and sets a sealed, `HttpOnly` `__Host-` cookie, then redirects to a clean `/report`. The cookie's lifetime is the credential's remaining life (never longer), not the session's.
4. **JavaScript fallback.** The fragment needs script. When script is blocked or fails, `/report/enter` shows "This link needs JavaScript to open. Turn it on for this site, or ask your facilitator for help." A test pins that message.
5. **Credential store** `services/control/src/report-access.ts`, file `access.json` beside the reports (`0600`, atomic write, outside the review log).
   - Record: `{ id, role, hash, createdAt, expiresAt, revokedAt?, lastUsedAt? }`. `hash` is a salted SHA-256 of a 128-bit CSPRNG token; the token is high-entropy, so a slow hash adds nothing.
   - `REPORT_ACCESS_DAYS` defaults to 90 and is validated at startup (integer, 1 to 365).
   - One live credential per role. Issuing for a role that already has a live credential is refused (409). **Reissue** is a separate, explicit action that revokes the old credential and issues a new one.
   - `lastUsedAt` is written on exchange and on report reads, at most once per 10 minutes per credential, so the console can show whether a link looks used or shared.
6. **Control API.**
   - `POST /sessions/:id/report-links` issues links for the released human roles and returns each token once.
   - `POST /sessions/:id/report-links/:role/reissue` and `DELETE /sessions/:id/report-links/:role`.
   - `POST /report-access/exchange { token }` returns `{ credentialId, role, sessionId, expiresAt }` or the neutral refusal.
   - `GET /sessions/:id/reports/:role` returns the released view. The control service re-verifies the credential id (live, unexpired, unrevoked) on every call, so revoking takes effect at once even while a cookie exists.
7. **One neutral refusal** for a wrong role, wrong session, expired, revoked or unknown token: the same status and body, so the exchange is not an oracle for which sessions or roles exist. The exchange is throttled per client address, like the other credentials.
8. **Console.** On an ended session the console lists each released human role with: Issue link, Reissue, Revoke, the expiry date and last-used time. Reissue asks for confirmation and says the old link stops working at once. The token is shown once, like join codes.
9. **Participant page `/report`.**
   - States: loading, report, not released yet, expired or revoked, try again.
   - Shows "Available until <date>" and has a print stylesheet, so a participant can save a copy before the link ends. PDF and file export arrive with 2c-3.
   - `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on the page and its API; all report text is escaped (2c-2 adds participant-written text).
10. **Tests.** Store (issue, one live per role, reissue, revoke, expiry, mode `0600`, atomic write, startup validation). Neutral refusal is identical across every refusal cause. No link for AI or unreleased roles. The reader never returns a peer's private data. The fragment is removed from the address bar and absent from server logs. The no-JavaScript message. Playwright end to end after the runtime has exited, including revoke while a cookie exists. Axe at 400 and 1280 px, light and dark.

## 3. Rollout

### 2c-1 (US-0062), two PRs

- **PR 1, no browser.** `@acr/runtime/reports` and its tests, the import-guard extension, `report-access.ts`, the control API, the startup validation. Works from curl and the control tests only.
- **PR 2, browser.** BFF routes (`/api/v1/report/enter`, the report read), the sealed cookie, `/report/enter` and `/report`, the console panel, the Playwright and Axe tests, threat-model section (see 4), CHANGELOG, plan documents. PR 1 amends the RELEASE_PLAN wording of AC-0327 ("releasing a report issues a credential") to "the facilitator issues a link for a released report from the console", because reports can be released from the terminal (decision in section 1). PR 2 amends AC-0328 for the fragment link (decision 3) and the explicit reissue (decision 5).

US-0062's acceptance criteria are AC-0327 to AC-0330 (credential store, console link with revoke and reissue, verification without a live runtime, one neutral refusal). The plan maps each to tests. Anything new takes AC-0365 and TC-0121 onward.

### 2c-2 (US-0063), outlined

Self-assess and respond from the page. New versioned actor kind `participant_session` (role plus credential id), accepted only for `self-assess` and `respond` (including marking a dispute); `resolve` stays a facilitator action and the attested kind stays for the terminal. `REVIEW_SCHEMA` is bumped. A held `review.lock` is retried with backoff and answers "try again". Needs its own spec for the form, drafts and the lock behaviour.

### 2c-3 (US-0064), outlined

Facilitator evaluate, moderation, release and export in the console, run by the control service. Replaces the printed `pnpm evaluate --out` command. Needs its own spec.

## 4. Threat-model changes (new section "Report access" in `docs/THREAT_MODEL.md`, written in 2c-1 PR 2)

- **Bearer link.** Anyone holding the link sees that participant's report and the group report. Mitigations: 128-bit token, hashed at rest, fragment not sent to servers or logs and removed from the address bar, one live credential per role, expiry shown to the participant, revoke and reissue, `lastUsedAt` in the console. A link forwarded by its owner cannot be told apart from the owner; that is a known limit.
- **No `Referer` or cache leak.** `no-referrer` and `no-store` on the page and API; the token never appears in a path or query.
- **Revocation is immediate.** The control service re-checks the credential on every read; the cookie alone grants nothing.
- **No existence oracle.** One neutral refusal; exchange throttled per address.
- **Boundary.** The BFF holds no report data and no credential hashes; the control service reads reports only through `@acr/runtime/reports`; the import guard enforces this.
- **Policy drives the view.** Peers are removed from the group report by the review policy in the runtime, not in the page.
- **Inherited limits, restated.** The review chain is unkeyed (`THREAT_MODEL.md`, review log section), so anyone who can write the reports directory can alter reports; `access.json` has the same file-mode protection. A shared computer keeps the cookie until it expires or is revoked.
- **Not in 2c-1.** No participant-written content (2c-2 reopens the section for that), no export file (2c-3).

## 5. Risks carried into the plan

- A participant who comes back after 90 days meets a dead link. The expiry date on the page and the printable view are the mitigation; a longer default is the owner's call.
- A reissue by mistake locks out the old link's holder. The confirmation text and `lastUsedAt` are the mitigation.
- The fragment flow depends on script; the fallback message is the mitigation and is tested.
- Next release notes must be shorter than the v0.1.0 notes (GitHub limit about 125 KB).
