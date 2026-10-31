# EPIC-0002 Slice 2b-1: Control Plane and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator signs in to a browser console, creates a session through a new control service, sees who has joined and consented, gets codes once, reissues codes, and presses Start.

**Architecture:** A new `services/control` package forks one runtime per session and talks to it over `fork()` IPC. The runtime gains a managed mode, three IPC messages (`codes`, `ready`, `ended`), a parent-only code reissue and a server handle that can swap codes and kick a role. The BFF (`apps/web`) gains a purpose-bound facilitator cookie, console API routes, a launcher client and dual-mode runtime lookup (`LAUNCHER_URL` set, else today's `RUNTIME_URL`).

**Tech Stack:** TypeScript, Node 22 (`node:http`, `node:child_process`), vitest 5.0.3, Next.js 16.4.1, React 19.3.0, Playwright 1.64.0, ws. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-30-web-client-slice-2b-design.md` (sections 5, 6, 6.1, 9, 10, 11). Stories US-0057, US-0058 and AC-0310 of US-0059. Outline: `docs/superpowers/specs/2026-10-26-web-client-design.md`. Slices 2b-2 and 2b-3 get their own plans.

## Global Constraints

- Runtime child environment is an allowlist; `RUNTIME_HOST=127.0.0.1`, `RUNTIME_PORT=0`, `TRUST_PROXY=1`, `NO_DOTENV=1`, `GM_TRACE_FILE` never set. The child's data directory is set explicitly with `SESSION_DATA_DIR` (absolute, `<CONTROL_DATA_DIR>/sessions`); the runtime must honour `SESSION_DATA_DIR`, `NO_DOTENV=1` and `CONTROL_MANAGED=1` (the last implies `NO_DOTENV`), none of which exist in it today. `FACILITATOR_TOKEN` is 32 random bytes as hex (64 characters), fresh per start, in memory only.
- `MAX_SESSIONS` default 10, counting live sessions only; ended sessions do not count.
- `sessions.json` holds `sessionId, scenarioId, status` only, mode 0600, atomic (`secure-json-file`).
- Facilitator cookie name `__Host-scenecoach-fac`; purpose bound into the seal's authenticated data; the player cookie format is unchanged. Facilitator name: cleaned, at most 60 code points. Login checks `Origin`, compares the secret in constant time, is throttled per address and fails closed when saturated.
- Restart is manual only. A crashed child is `stopped`. No stack traces, paths, ports or internal ids reach a browser.
- Commit format `[TYPE] SHORT-ID: description (max 72 chars)`; end commits with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Branches `feature/EPIC-0002-US-0057-facilitator-login`, `feature/EPIC-0002-US-0058-launcher-control-service`, `feature/EPIC-0002-US-0059-readiness` (each from the previous when stacked; PRs into `develop`). Each PR adds `CHANGELOG.md` `[Unreleased]` lines.
- Every runtime and control-service change is test first and passes the node:22 container recipe (`AGENTS.md` section 8, as root and `--user node`). Coverage stays at or above repository thresholds. Dependencies stay pinned (none added).

## Review Focus

1. A control-service restart with a lobby in progress keeps its codes, seats and consent (Tasks 6, 11b, 16).
2. A stale or refused facilitator token must not block player joins from the same address (Tasks 13, 16).
3. Two quick Create clicks or two tabs must not exceed `MAX_SESSIONS` (Task 11a).
4. A `scenarioId` outside the allowlist, a path-like id or an oversize body is refused before any file is touched (Tasks 10, 12).
5. A child killed with SIGKILL (stale lock) and then restarted by hand either resumes or reports a plain reason; no token or code appears in any status text or log (Tasks 11b, 12).

## File Structure

| File | Responsibility |
|---|---|
| `services/runtime/src/host/parent-channel.ts` (new) | Typed IPC channel to the parent; absent when not forked |
| `services/runtime/src/host/reissue.ts` (new) | `reissueRole`: the ordered reissue steps |
| `services/runtime/src/engine/session-store.ts`, `join-codes.ts`, `consent.ts`, `host/session-host.ts`, `host/ws-server.ts`, `main.ts` (modify) | Managed mode, `withRole`, consent rebind, server handle, wiring |
| `services/control/src/{config,scenarios,session-list,log-tail,child-env,supervisor,api,main}.ts` (new) | The control service, one job per file |
| `apps/web/src/server/{config,seal,console-session,console-handlers,launcher-client,runtime-lookup,routes}.ts` | Cookie, login, console API, launcher client, dual-mode lookup |
| `apps/web/src/app/console/**`, `apps/web/src/app/api/v1/console/**`, `apps/web/src/components/console/*` | Pages, route files, components |

---

## PR 1: US-0057 facilitator login (`feature/EPIC-0002-US-0057-facilitator-login`)

### Task 1: File the 2b-1 artefacts

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `docs/TEST_CASES.md`.

- [ ] **Step 1:** Per `AGENTS.md` ID rules, reserve in `docs/ID_REGISTRY.md` first: AC-0341 to AC-0350, TC-0077 to TC-0086, TASK-0094. Then in `docs/RELEASE_PLAN.md` file: AC-0341 managed mode keeps lobby state and refuses an ended log; AC-0342 `codes`/`ready`/`ended` messages, a failed codes send aborts the start and withdraws the codes; AC-0343 parent disconnect stops the runtime; AC-0344 per-role reissue order (revoke, kick, new code, swap, roster); AC-0345 post-start reissue rebinds consent (recorded), pre-start clears it; AC-0346 control service: manual restart only, crash is `stopped`, `ended` persisted and frees the slot, per-session child logs; AC-0347 child environment allowlist and 64-character hex token; AC-0348 purpose-bound cookie, secret epoch, login `Origin` check; AC-0349 dual-mode lookup, `{port, token}` fetched together, no blind retry, no `X-Forwarded-For` on facilitator sockets; AC-0350 launcher-mode Web E2E through Start. Apply the section 12 rewordings of AC-0302 to AC-0310 from the spec; move AC-0310 to a `US-0059` readiness note; TASK-0086, TASK-0087 and TASK-0088 already exist: update the notes of TASK-0086 and TASK-0087 to the new spec and leave TASK-0088 for 2b-2. Add only TASK-0094 for the US-0059 readiness work (branch `feature/EPIC-0002-US-0059-readiness`; US-0059's own branch stays `feature/EPIC-0002-US-0059-live-console`). Add TC-0077 to TC-0086, one per new AC, `Not Run`, in `docs/TEST_CASES.md`.
- [ ] **Step 2:** Run `npm run plan:generate`; expect "Done" and no parse errors.
- [ ] **Step 3:** Commit `[docs] US-0057: file slice 2b-1 acceptance criteria and ids`.

### Task 2: Purpose-bound seal and the console login handler

**Files:** Modify `apps/web/src/server/seal.ts`, `config.ts`, `handlers.ts` (Deps), `routes.ts`, and the two existing tests that build a `Deps` (`__tests__/handlers.test.ts`, `__tests__/handlers.runtime.test.ts`); Create `apps/web/src/server/console-session.ts`, `console-handlers.ts`; Test `apps/web/src/server/__tests__/{seal.purpose,console-handlers}.test.ts`.

**Interfaces:**
- Produces: `seal(payload, keys, now, purpose?: "fac")` and `unseal<T>(token, keys, now, purpose?: "fac")` (no purpose = today's behaviour; `"fac"` binds `${keyId}|fac` as AAD). `Config` gains `facilitatorSecret?: string; launcherUrl?: string; launcherToken?: string`. `Deps` gains `consoleThrottle: JoinThrottle`. `console-session.ts`: `type ConsoleSession = { name: string; epoch: string; expiresAt: number }`, `secretEpoch(secret: string): string` (first 16 hex of HMAC-SHA256(secret, "scenecoach-fac-epoch")), `readConsoleSession(req, config, now): ConsoleSession | null`, `consoleSessionFromToken(token: string | undefined, config: Config, now: number): ConsoleSession | null` (for server pages, which have cookies but no `Request`, like `seatedIn`), `CONSOLE_COOKIE = "__Host-scenecoach-fac"`. `console-handlers.ts`: `handleConsoleLogin(req, deps)`, `handleConsoleLogout(req, deps)`, `requireConsole(req, deps): ConsoleSession | Response`.

- [ ] **Step 1: Write failing tests** (names and key assertions):
  - `seal.purpose`: a `"fac"`-sealed token returns null from `unseal` without purpose and a player-sealed token returns null with `"fac"`; both still round-trip with their own purpose.
  - `console-handlers`: `login with the right secret sets __Host-scenecoach-fac (HttpOnly, Secure, SameSite=Strict, Path=/) and returns the cleaned name`; `login with a wrong secret returns the neutral refusal and no cookie`; `login with a foreign Origin is refused before the secret is compared`; `the sixth wrong secret from one address is throttled and a saturated throttle fails closed`; `a 61-code-point name is cut to 60 and control characters are removed`; `a cookie sealed under an old secret's epoch is treated as signed out after FACILITATOR_SECRET changes`; `login is disabled with the loud message when FACILITATOR_SECRET or LAUNCHER_URL is unset`; `a player cookie is rejected by requireConsole`; `a player-only deployment with only RUNTIME_URL set still loads its configuration`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/seal.purpose.test.ts src/server/__tests__/console-handlers.test.ts`; expect FAIL (missing exports).
- [ ] **Step 3:** Implement to the interfaces. `loadConfig` reads `FACILITATOR_SECRET` (at least 16 characters), `LAUNCHER_URL` (an `http://127.0.0.1:<port>` or `localhost` URL only) and `LAUNCHER_TOKEN` (at least 32 characters); `RUNTIME_URL` stays required only when `LAUNCHER_URL` is unset. The console is enabled only when all three are set; when none or only some are set it is disabled and a loud log line names each missing variable. Only an invalid value is a configuration error (naming the variable, never the value). Reuse `JoinThrottle` (5 failures per 60 s, 60 s block) as `consoleThrottle`, keyed by `requestAddress`. Compare the secret with `secretsMatch`-style `timingSafeEqual` on equal-length digests.
- [ ] **Step 4:** Re-run the command from step 2; expect PASS. Run `pnpm --filter @acr/web typecheck`.
- [ ] **Step 5:** Commit `[feat] US-0057: facilitator login and purpose-bound cookie`.

### Task 3: Console routes, shell page and noindex

**Files:** Create `apps/web/src/app/api/v1/console/{login,logout}/route.ts`, `apps/web/src/app/console/page.tsx`, `apps/web/src/components/console/{ConsoleLogin,ConsoleShell}.tsx`; Modify `routes.ts` (`consoleLoginPOST`, `consoleLogoutPOST`), `apps/web/e2e/helpers/start-stack.ts` (`StackOptions.webEnv?: Record<string, string>` merged into the `next start` environment; `console-login.spec.ts` passes `FACILITATOR_SECRET`, `LAUNCHER_TOKEN` and `LAUNCHER_URL=http://127.0.0.1:<an unused port>`, and moves to `startLauncherStack` in Task 16); Test `apps/web/src/components/__tests__/ConsoleLogin.test.tsx`, `apps/web/e2e/console-login.spec.ts`.

**Interfaces:** Consumes Task 2 handlers; the page reads its cookie with `consoleSessionFromToken`. Produces `/console` (login form when signed out; "Signed in as <name>" shell with a sign-out button and an empty "No sessions yet" state when signed in) and the two API routes, same re-export pattern as `app/api/v1/say/route.ts`.

- [ ] **Step 1: Write failing tests:** `ConsoleLogin shows labelled secret and name fields, an error region (aria-live polite) and never echoes the secret`; `the disabled configuration renders the loud message and no form`; e2e `console-login.spec.ts`: `wrong secret shows the neutral message`, `right secret reaches the shell and /console sends noindex`, `robots.txt disallows /console`, Axe passes on both states at 400 px and laptop width.
- [ ] **Step 2:** Run component test (expect FAIL) then implement pages and route files; text rendered as text; secret input `autocomplete="off"`.
- [ ] **Step 3:** Run `pnpm --filter @acr/web exec vitest run` and `pnpm --filter @acr/web e2e -- console-login`; expect PASS.
- [ ] **Step 4:** Update `.env.example` (`FACILITATOR_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN`), `CHANGELOG.md`; commit `[feat] US-0057: console login page and routes`; open PR 1 into `develop`.

---

## PR 2: US-0058 runtime and control service (`feature/EPIC-0002-US-0058-launcher-control-service`, from PR 1's branch)

### Task 4: Control package skeleton and the `fork()` under `tsx` spike

**Files:** Create `services/control/{package.json,tsconfig.json,vitest.config.ts}`, `services/control/src/runtime-command.ts`, `services/control/src/__tests__/fork-spike.test.ts`, `services/control/src/__tests__/fixtures/echo-child.ts`; Modify root `package.json` (script `"control": "pnpm --filter @acr/control start"`), `pnpm-lock.yaml`.

**Interfaces:** Produces `runtimeCommand(): { execPath: string; execArgv: string[]; entry: string }`, the single place that says how to start `services/runtime/src/main.ts` (mirror `services/runtime/package.json` scripts and tsconfig; `@acr/*` workspace deps only; every other version **exactly pinned**, no `^` (`AGENTS.md` section 19), for example `tsx` at the version `apps/web` pins).

- [ ] **Step 1: Write the spike test** `a forked tsx child exchanges one IPC message with the parent and the child exits when the parent disconnects`: fork `echo-child.ts` using `runtimeCommand()`'s `execArgv`, send `{type:"ping"}`, expect `{type:"pong"}`, then `child.disconnect()` and expect the child to exit with code 0 within 5 s (poll with an injected short interval, no fixed sleeps).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run`; expect FAIL, implement `runtimeCommand`, run again; expect PASS. Use `execArgv: ["--import", "tsx"]` and fork with `cwd` set to a package directory that has `tsx` installed (`--import` resolves from the cwd). If that fails, find the working form, record it in `MEMORY.md`, and do not continue until this test passes locally and in the node:22 container.
- [ ] **Step 3:** Run `pnpm install` (lockfile), `pnpm -r typecheck`; commit `[chore] US-0058: control service package and fork spike`.

### Task 5: Runtime parent channel

**Files:** Create `services/runtime/src/host/parent-channel.ts`; Test `services/runtime/src/host/__tests__/parent-channel.test.ts`.

**Interfaces:** Produces
`type ParentMessage = { type: "reissue"; requestId: string; roleId: string; by?: string }` (also exported as the zod `ParentMessageSchema`, with a `ChildMessageSchema` for the other direction);
`type ChildMessage = { type: "codes"; codes: { roleId: string; code: string }[] } | { type: "ready"; port: number; logIdentity?: string; status: "new" | "resumed"; modelLabel: string } | { type: "ended" } | { type: "reissued"; requestId: string; code: string } | { type: "reissue_failed"; requestId: string; reason: string }`;
`interface ParentChannel { send(msg: ChildMessage): boolean; onMessage(fn: (m: ParentMessage) => void): void; onDisconnect(fn: () => void): void }`;
`openParentChannel(proc?: Pick<NodeJS.Process, "send" | "on" | "connected">): ParentChannel | null` (null when `proc.send` is undefined).

- [ ] **Step 1: Write failing tests** with a fake process: `returns null without an IPC channel`; `send returns false when process.send throws, returns false, or the channel is disconnected`; `onMessage ignores anything that is not a valid ParentMessage (wrong type, extra shapes, non-object)`; `onDisconnect fires once on "disconnect"`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/parent-channel.test.ts`; expect FAIL. Implement with zod 4.6.6 (already a dependency) for inbound validation; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: runtime parent IPC channel`.

### Task 6: Managed mode in the session store

**Files:** Modify `services/runtime/src/engine/session-store.ts` (`openSession` option `managed?: boolean`), `services/runtime/src/main.ts` (env `CONTROL_MANAGED=1` implies `NO_DOTENV`); Test `engine/__tests__/session-store.managed.test.ts`, `__tests__/main.managed.test.ts`.

**Interfaces:** `openSession({ ..., managed })`. In managed mode an empty log runs `const found = readSeats(); const joinCodes = settleCodes(true, false); const seats = settleSeats(!joinCodes?.issued, found);` (so codes bound to another scenario are replaced **and** the stale seats are dropped; passing `found` blindly would keep credentials that `settleCodes` just removed from disk, and nobody could join with the new codes). An ended log throws `SessionStoreError("resume_refused", "the session has ended")` and never rotates. `bootstrap` reads `SESSION_DATA_DIR` (absolute path required, refused otherwise with the value never echoed): `dataDir = opts.logDir ?? env.SESSION_DATA_DIR ?? <root>/data/sessions`; `CONTROL_MANAGED=1` or `NO_DOTENV=1` skips the `<root>/.env` merge entirely.

- [ ] **Step 1: Write failing tests:** `managed: a restart on an empty log keeps the issued codes, the credentials and the consent`; `managed: files bound to a different scenario hash are replaced, not kept`; `managed: an ended log is refused and the log file is not renamed`; `unmanaged behaviour is unchanged (empty log still discards, ended still rotates)`; `managed: codes bound to another scenario give new codes and empty seats, and a new code can join`; `bootstrap with CONTROL_MANAGED=1 ignores a <root>/.env that sets SESSION_START=fresh and FACILITATOR_TOKEN`; `NO_DOTENV=1 alone skips the .env merge`; `bootstrap with SESSION_DATA_DIR writes the log, lock and codes there and nothing under <root>/data`; `a relative SESSION_DATA_DIR is refused and the value is not echoed`.
- [ ] **Step 2:** Run both files; expect FAIL. Implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: runtime managed mode keeps lobbies, refuses ended logs`.

### Task 7: Wire `codes`, `ready`, `ended` and disconnect

**Files:** Modify `services/runtime/src/main.ts`; Test `services/runtime/src/__tests__/main.parent.test.ts`.

**Interfaces:** Consumes Tasks 5 and 6. `bootstrap` gains `opts.parent?: ParentChannel | null` (default none). With a parent: `showJoinCodes` sends `codes` and throws when `send` returns false (existing abort-and-withdraw path); after `startServer` it sends `ready` with `modelLabel` from `describeModelProvider(env)` and `status: store.resume ? "resumed" : "new"`; on the host's `session.ended` event it sends `ended`; `parent.onDisconnect` calls `runtime.stop()` then `process.exit(0)` (in `run()`, not in `bootstrap`). `run()` builds the channel with `openParentChannel()` only when `CONTROL_MANAGED=1`. `process.send` returning false means backpressure, not loss; the hook still treats it as failure, which aborts the start safely.

- [ ] **Step 1: Write failing tests** with a fake `ParentChannel`: `a new start sends codes then ready, in that order, codes only when issued`; `a resumed start sends ready with status resumed and no codes`; `a failed codes send aborts the start and the issued codes are withdrawn (the .codes.json is removed)`; `session.ended sends ended once`; `the codes never appear in log or warn output`; `ready never contains a token or an endpoint`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: runtime reports codes, ready and ended to its parent`.

### Task 8: Server handle

**Files:** Modify `services/runtime/src/host/ws-server.ts`; Test `host/__tests__/ws-server.handle.test.ts`.

**Interfaces:** `startServer` returns `ServerHandle = { port: number; close(): Promise<void>; replaceCodes(sessionId: string, codes: JoinCodes): void; kickRole(sessionId: string, roleId: string, closeCode: number): void }` (`replaceCodes` swaps the instance in the `joinCodes` map; `kickRole` removes the role's holder entry, calls `host.release(roleId, assignments[roleId])` **synchronously** so the seat is free before the socket finishes closing, closes the socket with the given code (the holder record gains `kickWith(code)`; the existing `kick` closure hard-codes `CLOSE_SUPERSEDED`), and rebroadcasts the roster). Export `CLOSE_REISSUED = 4002`.

- [ ] **Step 1: Write failing tests:** `replaceCodes: the old code is refused and the new code joins a role that has no credential`; `kickRole closes only that role's socket with 4002 and frees the seat`; `a join with the new code immediately after kickRole succeeds (no role_taken)`; `kickRole broadcasts the roster to the facilitator and peers`; `existing startServer callers are unaffected`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS; run the whole runtime suite for regressions.
- [ ] **Step 3:** Commit `[feat] US-0058: server handle can swap codes and kick a role`.

### Task 9: Reissue

**Files:** Modify `services/runtime/src/engine/join-codes.ts`, `engine/consent.ts`, `engine/session-store.ts`, `host/session-host.ts`, `main.ts`; Create `services/runtime/src/host/reissue.ts`; Test `engine/__tests__/join-codes.withrole.test.ts`, `engine/__tests__/consent.rebind.test.ts`, `host/__tests__/reissue.test.ts`.

**Interfaces:**
- `JoinCodes#withRole(roleId: string, pick?: (n: number) => number): { codes: JoinCodes; plain: string }` (same salt, same other hashes, one new code; throws for a role not in the record).
- `ConsentStore#releaseForRebind(roleId: string): boolean` (sets the entry's participant to the constant `REBIND_PENDING = "rebind-pending"`, so the existing record shape persists it), `isRebindPending(roleId): boolean`, `claimRebind(roleId, participantId, at): boolean`.
- `SessionHost#join` calls `claimRebind` for a seat whose consent is `REBIND_PENDING` before the consent check, and appends a facilitator-only info alert through the engine's alert method ("consent for <role> rebound after a code reissue") when it does.
- `reissueRole(d: { host: SessionHost; seats: Seats; codes: () => JoinCodes; setCodes(c: JoinCodes): void; writeCodes(c: JoinCodes): void; server: Pick<ServerHandle, "kickRole">; sessionId: string }, roleId: string): Promise<string>` runs the fixed order: revoke credential and `seats.persist()`; before the start `consent.withdraw(roleId)`, after the start `consent.releaseForRebind(roleId)` and persist; `kickRole(…, CLOSE_REISSUED)`; `withRole` and `writeCodes` (the existing atomic write with the lock check); `setCodes` (which calls `replaceCodes`); return the plain code. `main.ts` answers `reissue` messages with `reissued` or `reissue_failed` (a plain reason, never a path). `OpenedSession` gains `writeJoinCodes(c: JoinCodes): void` (calls `writeJoinCodesFile(dataDir, sessionId, c, holdLockNow)`, throws `SessionStoreError`), which `reissueRole` uses as `writeCodes`. `reissueRole` and the IPC message carry `by?: string` (cleaned, at most 60 code points); at reissue time the runtime appends a facilitator-only alert ("consent for <role> will be rebound after a code reissue by <name>"). `SessionHost#join` is synchronous while the engine's alert returns a promise: call it as `void alert(...).catch(report)`. If the credential write fails after a join that claimed a rebind, restore `REBIND_PENDING` (the path in `ws-server.ts` that already undoes the seat).

- [ ] **Step 1: Write failing tests:** `withRole replaces one hash and keeps the others verifying`; `withRole for an unknown role throws`; `releaseForRebind then claimRebind binds the new participant and keeps the notice version`; `a rebind is persisted and survives a restart`; `host.join after a post-start reissue admits the new participant with no consent step and appends the alert`; `reissue before the start clears consent so the person must consent again`; `reissue order: credential revoked and persisted before the socket is kicked, before the new code opens`; `a failed codes write leaves the old code working and replies reissue_failed`; `the reissued code is never written to log, warn or the event log`; `a failed credential write after claimRebind leaves the rebind pending`; `the facilitator name appears in a facilitator-only alert and in no player view`.
- [ ] **Step 2:** Run the three files; expect FAIL. Implement; expect PASS.
- [ ] **Step 3:** Run the full runtime suite and `pnpm --filter @acr/runtime typecheck`; commit `[feat] US-0058: parent-only code reissue with consent rebind`.

### Task 10: Control config, scenario allowlist, session list, log tail

**Files:** Create `services/control/src/{config,scenarios,session-list,log-tail}.ts`; Test `services/control/src/__tests__/{config,scenarios,session-list,log-tail}.test.ts`.

**Interfaces:**
- `loadControlConfig(env): ControlConfig` = `{ port: number; serviceToken: string; maxSessions: number; dataDir: string; scenariosDir: string; logDir: string; graceMs: number; readyTimeoutMs: number }`. Reads `CONTROL_PORT` (default 8787, loopback bind only), `LAUNCHER_TOKEN` (at least 32 characters), `MAX_SESSIONS` (1 to 100, default 10), `CONTROL_DATA_DIR` (absolute; the session list is `<dir>/sessions.json` and children use `<dir>/sessions` as `SESSION_DATA_DIR`), `SCENARIOS_DIR` (default `<repo>/scenarios`), `CONTROL_LOG_DIR` (default `<dir>/child-logs`), `CONTROL_GRACE_MS` (default 30000), `CONTROL_READY_TIMEOUT_MS` (default 30000); messages name the variable and rule, never a value. Loads its own `<root>/.env` (provider keys are forwarded to children by the allowlist in Task 11a).
- `listScenarios(dir): Promise<{ id: string; title: string }[]>` using `loadScenario` and `validateScenario` from `@acr/script`; `isAllowedScenario(list, id): boolean` is exact-match only.
- `SessionList`: `type Entry = { sessionId: string; scenarioId: string; status: "running" | "stopped" | "ended" }`; `read(): Entry[]`, `upsert(e: Entry): void`, `remove(id): void`; mode 0600, atomic, `secure-json-file`; a corrupt file is refused with a plain error, not silently emptied.
- `readLogStatus(file: string): "empty" | "running" | "ended"`: lock-free; reads the last complete JSON line, ignores a cut-off tail.

- [ ] **Step 1: Write failing tests:** config problems (short token, bad port, `MAX_SESSIONS=0`) name the variable only; `an id with ../ or a path separator is not allowed even if a folder exists`; `session-list file is 0600 and replaced atomically`; `a corrupt session list is refused`; `readLogStatus: ended after a session.ended last line; running after a cut-off tail following a normal line; empty for a missing or empty file`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: control service config, allowlist, session list, log tail`.

### Task 11a: Child environment, protocol copy and create

**Files:** Create `services/control/src/{child-env,protocol,supervisor}.ts`; Test `services/control/src/__tests__/{child-env,protocol.drift,supervisor.create}.test.ts`.

**Interfaces:**
- `buildChildEnv(o: { config: ControlConfig; parentEnv: NodeJS.ProcessEnv; sessionId: string; scenarioDir: string; token: string; start: "resume" | "fresh" }): NodeJS.ProcessEnv`: allowlist only (`PATH`, `NODE_*`, and the `MODEL_PROVIDER`, `NPC_*`, `GM_*` (not `GM_TRACE_FILE`), `*_BASE_URL`, `LOCAL_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` values the control service itself holds) plus the fixed variables in Global Constraints, `CONTROL_MANAGED=1`, `SESSION_ID`, `SCENARIO_DIR`, `SESSION_START`, `SESSION_DATA_DIR`, `FACILITATOR_TOKEN` and the connection caps.
- `protocol.ts`: the control side's copy of `ParentMessage` and `ChildMessage`. `protocol.drift.test.ts` fails if the copy drifts: a type-level `Equal<A, B>` against the runtime's exported types (imported in the test file only; checked by `pnpm -r typecheck`) and every sample message parsed by the runtime's exported zod schemas.
- `type SpawnFn = (o: { env: NodeJS.ProcessEnv; logFile: string }) => ChildHandle`; `ChildHandle = { send(m: ParentMessage): boolean; onMessage(fn): void; onExit(fn: (code: number | null) => void): void; kill(): void; disconnect(): void }`.
- `class Supervisor { constructor(o: { config: ControlConfig; list: SessionList; scenarios: () => Promise<{ id: string; title: string }[]>; spawn: SpawnFn; setTimer?: SetTimer; log?: (m: string) => void }); create(scenarioId): Promise<{ sessionId: string; status: "running"; port: number; modelLabel: string; codes: { roleId: string; code: string }[] }>; get(id); list(); facilitator(id): { port: number; token: string } | undefined; reissue(id, roleId, by?): Promise<string>; reissueAll(id, by?): Promise<{ roleId: string; code: string }[]>; restart(id); resumeAll(): Promise<void>; shutdown(): Promise<void> }` (11b implements the last six). Session ids are `randomBytes(16).toString("hex")`, checked with `isValidSessionId`. Child log files are mode 0600.
- **Slots.** A service-wide create lock (or a synchronous slot reservation before the first `await`) counts `starting`, `running` and `stopped` sessions against `MAX_SESSIONS`; `ended` never counts. Per-session mutexes serialise restart and reissue.
- **Ready timeout.** `create` waits for `ready` at most `readyTimeoutMs` (injected timer); on timeout it kills the child and rolls back.

- [ ] **Step 1: Write failing tests:**
  - env: `contains no variable outside the allowlist`; `has no GM_TRACE_FILE even if the parent does`; `token is 64 hex characters and differs per start`; `SESSION_DATA_DIR is absolute and under CONTROL_DATA_DIR`.
  - create: `a scenarioId outside the allowlist is refused before any spawn`; `two concurrent creates at MAX_SESSIONS - 1 produce one session, not two`; `ended sessions do not count against MAX_SESSIONS`; `a child that exits before ready leaves no session-list entry, no codes file and no seat files`; `a child that never sends ready is killed after readyTimeoutMs and the create is rolled back`; `codes are returned once and never stored`; `child log files are mode 0600 and never contain the token`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run`; expect FAIL; implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: control service child environment and create`.

### Task 11b: Lifecycle, restart and reissue

**Files:** Modify `services/control/src/supervisor.ts`; Test `services/control/src/__tests__/supervisor.lifecycle.test.ts`.

**Interfaces:** Implements `get`, `list`, `facilitator`, `reissue`, `reissueAll`, `restart`, `resumeAll`, `shutdown` from Task 11a. `reissueAll` is refused unless `readLogStatus` is `empty`; it stops the child, moves `<id>.codes.json` aside, restarts and returns the full new set once. `resumeAll` starts every non-ended session concurrently, each bounded by `readyTimeoutMs`, so one hung child cannot keep the service from listening.

- [ ] **Step 1: Write failing tests** with a fake `SpawnFn`:
  - `an unexpected exit marks the session stopped and is not restarted automatically`;
  - `the ended message persists ended and the child is stopped after graceMs (injected timers)`;
  - `restart is refused for ended and resumes a stopped session paused with a new token`;
  - `resumeAll checks the log tail first: a session whose log ends with session.ended is marked ended and not spawned`;
  - `resumeAll waits for a previous child to exit before spawning`;
  - `a hung child does not stop resumeAll from settling and the service from listening`;
  - `codes that are not followed by ready are discarded`;
  - `reissue sends the IPC request with the console name and returns the code; a reissue_failed reply rejects with a plain reason`;
  - `reissueAll before the start returns a full new set and the old codes stop working; after the start it is refused with a plain message`;
  - `child stdout and stderr go to the per-session log file`;
  - `shutdown disconnects every child`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0058: control service lifecycle, restart and reissue`.

### Task 12: Control HTTP API and entry point

**Files:** Create `services/control/src/{api,main}.ts`; Test `services/control/src/__tests__/api.test.ts`, `services/control/src/__tests__/supervisor.real.test.ts`; Modify root `package.json`/`services/control/package.json` scripts (`start`: `tsx src/main.ts`).

**Interfaces:** `createApi(deps: { config: ControlConfig; supervisor: Supervisor; scenarios: () => Promise<{id:string;title:string}[]> }): http.RequestListener`. Routes exactly as spec section 5.3 (`GET /scenarios`, `POST /sessions`, `GET /sessions`, `GET /sessions/:id`, `GET /sessions/:id/facilitator`, `POST /sessions/:id/codes/reissue` (a body with `roleId` reissues that role, an empty body reissues the whole session; both accept `by`), `POST /sessions/:id/restart`). Every route requires header `x-service-token` (constant-time); bodies are at most 4 KB JSON; responses use `{ success, data, error }`; unknown ids, bad bodies and wrong tokens each return a neutral error. `main.ts` binds `127.0.0.1` only, calls `resumeAll()` before listening and `shutdown()` on SIGINT and SIGTERM.

- [ ] **Step 1: Write failing tests:** `missing or wrong token returns 401 with no detail`; `a body over 4 KB is refused before parsing`; `scenarioId "../x" returns 400`; `GET /sessions/:id/facilitator returns port and token together and is never logged`; `status text never contains a token or code`. Real-process test `supervisor.real.test.ts` (uses `runtimeCommand()`, the mock provider and a temp `CONTROL_DATA_DIR`, so nothing is written under the repository): `create returns six-role codes, ready arrives, the child exits when the service disconnects, and a SIGKILLed child is stopped and restarts by hand` (poll with deadlines, no fixed sleeps).
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS (including under the node:22 container recipe).
- [ ] **Step 3:** Update `.env.example`, `CHANGELOG.md`; commit `[feat] US-0058: control service API and entry point`.

### Task 13: Launcher client and dual-mode lookup in the BFF

**Files:** Create `apps/web/src/server/{launcher-client,runtime-lookup}.ts`; Modify `handlers.ts` (join and stream resolve the URL through `resolveRuntimeUrl`), `routes.ts`, `runtime-connection.ts` (add `joinFacilitator`); Test `__tests__/{launcher-client,runtime-lookup,facilitator-socket}.test.ts`.

**Interfaces:**
- `class LauncherClient { constructor(o: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }); scenarios(); createSession(scenarioId); sessions(); session(id); facilitator(id): Promise<{ port: number; token: string }>; reissue(id, roleId, by): Promise<string>; reissueAll(id, by): Promise<{ roleId: string; code: string }[]>; restart(id) }` (5 s timeout; every failure becomes a `LauncherError` with a plain `reason`).
- `resolveRuntimeUrl(deps: Deps, sessionId: string): Promise<string | null>`: launcher mode returns `ws://127.0.0.1:<port>` for a `running` session and null otherwise; single mode returns `config.runtimeUrl`.
- `RuntimeConnection.connect(url, clientAddress: string | null, o)`: `null` sends no `X-Forwarded-For` (used for facilitator sockets). `wire.ts` gains `join_facilitator { sessionId, token }` and `start` client messages and its contract test. `RuntimeConnection#joinFacilitator(sessionId: string, token: string): Promise<{ roster: FacilitatorRosterEntry[]; status: SessionState["status"] }>` reads `joined` and the first facilitator roster frame and closes on failure.
- `Deps` gains `launcher?: LauncherClient`, built by `createDeps` when `LAUNCHER_URL` is set.

- [ ] **Step 1: Write failing tests:** `single mode returns RUNTIME_URL for any session id`; `launcher mode returns null for stopped and ended sessions`; `a launcher failure maps to "unavailable" and never leaks the launcher URL`; `facilitator socket sends no X-Forwarded-For`; `a refused facilitator token is not retried with the same token; one fresh {port, token} is fetched once`; with TRUST_PROXY=1 and a real runtime, `maxAuthFailures stale facilitator tokens over a socket without X-Forwarded-For do not block a player upgrade carrying X-Forwarded-For 203.0.113.5`; `join and stream in single mode behave exactly as before (existing suite unchanged)`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS; run the whole web suite.
- [ ] **Step 3:** Commit `[feat] US-0058: launcher client and dual-mode runtime lookup`; open PR 2 into the PR 1 branch (retarget to `develop` after PR 1 merges).

---

## PR 3: AC-0310 readiness and E2E (`feature/EPIC-0002-US-0059-readiness`, from PR 2's branch)

### Task 14: Console session API

**Files:** Modify `apps/web/src/server/console-handlers.ts`, `routes.ts`; Create route files under `apps/web/src/app/api/v1/console/{scenarios,sessions,sessions/[id],sessions/[id]/readiness,sessions/[id]/start,sessions/[id]/reissue,sessions/[id]/reissue-all,sessions/[id]/restart}/route.ts`; Test `__tests__/console-sessions.test.ts`.

**Interfaces:** All routes call `requireConsole` first, then check `Origin` and the custom header for state changes. `GET readiness` returns `{ status, modelLabel, roster: FacilitatorRosterEntry[], canStart: boolean, missing: string[] }` where `canStart` is `status === "idle"` and every roster entry is joined and consented (the runtime stays the authority); it opens one short-lived facilitator socket per call. `POST start` sends the runtime `start` message on a short-lived facilitator socket and waits (bounded by a timeout) for the `session.started` event frame or an `error` frame; `seats_not_ready` maps to a plain message listing roles. `route()` drops the Next context, so each handler parses `[id]` from `req.url` and checks it with `isValidSessionId`. Both reissue routes pass the console name as `by`; `POST sessions/[id]/reissue-all` reissues the whole session, before the start only. `POST sessions` returns the codes once; no route stores or logs a code.

- [ ] **Step 1: Write failing tests** (fake launcher and fake runtime connection): `every route returns 401 without a console cookie and with a player cookie`; `create returns codes once and a repeat GET never contains them`; `readiness canStart is false until every seat is joined and consented`; `start while the gate is unmet returns the runtime's refusal as a plain message and the session is not started`; `reissue returns the new code once`; `reissue-all is refused after the start`; `a LauncherError becomes a neutral 502 with a banner message`.
- [ ] **Step 2:** Run; expect FAIL; implement; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0059: console session API and readiness`.

### Task 15: Console UI: session list, New session, readiness

**Files:** Create `apps/web/src/app/console/new/page.tsx`, `apps/web/src/app/console/[id]/page.tsx`, `apps/web/src/components/console/{SessionList,NewSessionForm,CodesPanel,Readiness,ConfirmDialog}.tsx`, `apps/web/src/lib/use-readiness.ts`; Modify `ConsoleShell.tsx` and `SessionScreen.tsx` (a collapsed read-only consent notice for a seat that was already consented when the person joined); Test `apps/web/src/components/__tests__/{SessionList,NewSessionForm,CodesPanel,Readiness}.test.tsx`.

**Interfaces:** `useReadiness(sessionId, { intervalMs = 2000, setTimer })` polls the readiness route with an injected timer and shows a "Reconnecting" banner with exponential backoff on failure. `CodesPanel` holds codes in component state only (never storage, never URL), with copy buttons and a warning that they cannot be shown again. `Readiness` shows the roster (joined, consented, connected as text plus icon, not colour alone), `modelLabel`, per-role Reissue (opens `ConfirmDialog` naming the seat and its audience), and Start, disabled with the reason until `canStart`.

- [ ] **Step 1: Write failing tests:** `CodesPanel never writes codes to localStorage, sessionStorage or the URL`; `Start is disabled and names the missing roles`; `Reissue confirmation names the role and says the old code stops working`; `roster state is announced as text (not colour alone)`; `polling backs off after failures and recovers`; `all text from names is rendered as text (an <img onerror> display name stays inert)`; `Restart appears only for stopped sessions and calls restart`; `Reissue all asks for confirmation that says every code, credential and consent is cleared`; `a player whose consent was rebound sees the consent notice read-only on the session screen`.
- [ ] **Step 2:** Run; expect FAIL; implement with the existing tokens in `src/lib/tokens.css`; expect PASS.
- [ ] **Step 3:** Commit `[feat] US-0059: console session list, New session and readiness screens`.

### Task 16: Launcher-mode Web E2E

**Files:** Create `apps/web/e2e/helpers/start-launcher-stack.ts`, `apps/web/e2e/console-flow.spec.ts`; Modify `apps/web/e2e/helpers/start-stack.ts` only to share helpers; no CI file change is needed because `pnpm --filter @acr/web e2e` already runs every spec (confirm in `.github/workflows/ci.yml` job `web-e2e`).

**Interfaces:** `startLauncherStack(): Promise<{ baseUrl: string; control: ChildProcess; restartControl(): Promise<void>; stop(): Promise<void> }>` starts the control service (mock provider, temp data dir, random token and secret) and `next start` with `LAUNCHER_URL`, `LAUNCHER_TOKEN`, `FACILITATOR_SECRET`.

- [ ] **Step 1: Write the specs** (they fail until the stack exists): `facilitator logs in, creates a session, three players join with the shown codes and consent, readiness shows all joined and consented, Start becomes enabled and pressing it starts the session (a player sees the scene)`; `reissue issues a new code and the old code is refused`; `a control-service restart in the lobby keeps the codes, joined seats and consent`; `one stale-token refusal after a manual child restart leads to exactly one fresh {port, token} fetch and a player still joins`; `console-login.spec.ts` now runs on `startLauncherStack`; `a player cookie on /api/v1/console/sessions returns 401 and a facilitator cookie on /api/v1/say returns 401`; `Axe passes on /console, /console/new and /console/[id] at 400 px and laptop width, light and dark`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web e2e -- console-flow`; implement the helper until it passes; run the full `pnpm --filter @acr/web e2e` and `pnpm demo --web` to confirm single-mode flows are unchanged.
- [ ] **Step 3:** Commit `[test] US-0059: launcher-mode Web E2E through Start`.

### Task 17: Container run, coverage, documentation and close-out

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md` (section 6), `docs/ROLLBACK.md` (no log-format change in 2b-1; the new env and service), `README.md`, `.env.example`, `MIGRATION_LOG.md`, `CHANGELOG.md`, `MEMORY.md` and `docs/memory/*.md`, `progress.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/LESSONS.md` (anything learned); Create nothing else.

- [ ] **Step 1:** Run the node:22 recipe (as root and `--user node`) on the new runtime and control test files (`parent-channel`, `session-store.managed`, `main.managed`, `main.parent`, `ws-server.handle`, `reissue`, `join-codes.withrole`, `consent.rebind`, and all of `services/control`). Expect all pass; record counts in `progress.md` (TC-0086 is the launcher-mode E2E case).
- [ ] **Step 2:** Run `pnpm test:coverage` (twice, once under load: `yes > /dev/null` x8) and `npx eslint .`, `pnpm -r typecheck`, `npm run plan:test`; expect green and thresholds held.
- [ ] **Step 3:** Threat-model additions from spec section 9 that 2b-1 introduces (control service boundary and token, IPC reissue, facilitator cookie and secret epoch, BFF-held tokens, rebind admission, launcher loopback). Tick the new ACs, set US-0057 and US-0058 `Complete` only when every AC is ticked, leave US-0059 `In Progress` (live view is 2b-2), update TC statuses, run `npm run plan:generate`.
- [ ] **Step 4:** Commit `[docs] US-0059: slice 2b-1 documentation and close-out`; open PR 3 and report CI results.
