# EPIC-0002 Slice 2b-2b1: Facilitator Channel and Read-only Live View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in facilitator follows a running session live in the browser (scene and timer, transcript with Game Master notices and alerts, words spoken per role) over one facilitator socket per console tab, forwarded as SSE, within a fixed connection budget that players and later bots cannot exhaust.

**Architecture:** Every BFF facilitator socket (live tab, readiness poll, Start) carries one reserved forwarded key, `scenecoach-console`, and takes a slot from a per-session budget (4 live, 3 short-lived) that stays under the runtime's per-key cap of 8. A new `FacilitatorHub` (its own key: a random channel id per stream; its own cap; its own reset rule; no `logIdentity`) bridges a tab's socket to SSE on a separate route, `GET /api/v1/console/sessions/:id/stream`, sharing only the SSE framing, backpressure, heartbeat and replay-reset helpers with the player `StreamHub`. The browser folds events with the shared `reduce` into a console view plus a notice timeline, resyncing on a seq gap, and the `/console/[id]` page switches from readiness polling to the live channel once the session runs.

**Tech Stack:** TypeScript, Node 22, Next.js 16.4.1, React 19.3.0, ws, vitest 5.0.3, Playwright with `@axe-core/playwright`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-31-slice-2b-remaining-design.md` section 4 "B1", section 6 item 1 and the stack table (binding; it wins over the parent), and `docs/superpowers/specs/2026-10-30-web-client-slice-2b-design.md` sections 6 (facilitator sockets), 7.1, 7.3, 7.5, 9 and 11. Stories: US-0059 (AC-0311 read-only part, AC-0316 for the live view; new criteria for the budget and the channel). Security posture: `docs/THREAT_MODEL.md`.

## Global Constraints

- Out of scope: every control, command route, confirmation, `end_now`/remove buttons, Prompt AI player, hidden-fact text in the browser (2b-2b2 and later). The channel sends nothing to the runtime after `join_facilitator`.
- Forwarded keys (decision, recorded in Task 2): BFF facilitator sockets send `X-Forwarded-For: scenecoach-console` (never none, never the browser's address); 2b-3b bots send `X-Forwarded-For: scenecoach-bot` from the control service. A player key is always an IP literal or `unknown` (`requestAddress` in `guards.ts` already answers null, so a neutral 400 in `handleJoin` and `handleStream`, for any value `normalizeAddress` rejects, the reserved words included; no guard code changes). The runtime (`clientIp` in `services/runtime/src/host/security.ts`, `TRUST_PROXY=1`) keys on the last `X-Forwarded-For` entry as sent (at most 64 characters), so the console key is exactly `scenecoach-console`; its upgrade-level block (`authThrottle.blockedForMs(ip)`, scope `""`) counts only refused facilitator tokens, never player or credential refusals (scoped `player:*`/`cred:*`). This holds only while the runtime is reachable by the BFF and the control service alone (launcher children bind `127.0.0.1`), the same precondition `TRUST_PROXY=1` already has.
- Budget per session (one runtime per session): `LIVE_TABS_PER_SESSION = 4`, `SHORT_SOCKETS_PER_SESSION = 3`; 4 + 3 < `CHILD_WS_MAX_CONNECTIONS_PER_IP` (8), the spare slot covers close lag. A slot is released when its socket reports close, never on `close()` alone. B2 commands go over the tab's live socket (addressed by the stream's channel id), so B2 adds no socket. Bots get their own key and the runtime's own cap of 8.
- Route: `GET /api/v1/console/sessions/:id/stream`, cookie (`__Host-scenecoach-fac`, purpose `fac`, epoch) checked by `requireConsole` on every request, so on every EventSource reconnect. A player cookie never opens it; the player route `/api/v1/stream` is unchanged.
- SSE: seq as `id`, `retry: 3000`, heartbeat 15 s, stall cap 256 KiB, `Last-Event-ID` absent or malformed means `lastSeq: 0`. A reset is sent exactly when the runtime's replay is missing or `complete: false`; the facilitator `joined` has no `logIdentity` and it is never compared. A `lastSeq` past the head is retried once without it (then a reset).
- Final console stream events and their page copy: `ended` (keeps the view), `stopped` (back to the lobby: "The session stopped. Restart it from this page."), `expired` ("Your console sign-in has expired. Sign in again."), `busy` ("This session is open in too many console tabs. Close one, then reload this page."); non-final `reconnecting`. Browser-side finals: `closed` ("The live view was refused. Reload the page; if it happens again, sign in again."), `lost` ("The live view fell out of step. Reload the page.").
- Copies to the browser: the reset state and `session.started` lose every `participantId`, `logIdentity` and `scenarioHash`; roster entries are cleaned by the existing `entryOf`; no hidden-fact text: `hiddenFacts` is not forwarded, the reset state's `npcs` is `{}` and `npc.updated` keeps its envelope and `roleId` with empty `goals`, `knowledge` and `released` (its `released` carries released fact text; the frame must still be sent so seqs stay gap-free). B2 decides what to widen.
- Live view copy: section headings "Live session", "Transcript and notices", "Words spoken" (never "time" anywhere in that section); words spoken caption "Words and lines typed per role. A count, not a measure of quality."; AI characters listed apart as context. Browser caps: `MAX_CONSOLE_LINES = 1_000` timeline entries and transcript lines (talk counts are never cut), `MAX_GAP_RESYNCS = 3`.
- Rendering: all untrusted text (lines, names, `by`, alerts, Game Master condition and reasoning, inject content, closing message) as React text children; names inside `<bdi>`; no inline style, no `dangerouslySetInnerHTML` (`source-rules.test.ts`); the timeline is `aria-live="polite" aria-relevant="additions"`; alerts carry the word "Alert" or "Warning", never colour alone.
- Commit format `[TYPE] US-0059: description` (max 72 chars), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Squash merges into `develop`. Before every commit: `pnpm -r --if-present typecheck` and the touched packages' vitest (`pnpm --filter <pkg> exec vitest run <files>`). Every new socket or real-runtime test passes the node:22 container recipe (`AGENTS.md` section 8, root and `--user node`). Injected timers only, `vi.waitFor`/`until` on effects, no elapsed-time assertions. Playwright runs locally and in CI (job "Web E2E": `playwright install --with-deps chromium` in `apps/web`, then `pnpm --filter @acr/web e2e`). Locally: `pnpm --filter @acr/web e2e console-live.spec.ts` (the script is `next build --webpack && playwright test`, and pnpm appends the file to `playwright test`; each test starts its own launcher stack on free ports, no env needed), and the whole `pnpm --filter @acr/web e2e` once before each PR that touches the web. The pinned `@playwright/test` 1.64.0 wants chromium revision 1248 while the laptop cache holds 1223: run `pnpm --filter @acr/web exec playwright install chromium` once, or prefix the run with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell` (read by `playwright.config.ts`).
- Ids are assigned by each PR's docs task when it files them (next free at that time; the expected values are noted); this plan reserves nothing. Each PR adds its user-visible change under `[Unreleased]` in `CHANGELOG.md`.

## Rulings (settled in review, 2026-11-01)

- **Ended session.** On `ended` IPC the control service marks the session ended at once and `supervisor.facilitator(id)` returns nothing from then on (the BFF's `launcher.facilitator` is `not_found`); the child keeps running for `CONTROL_GRACE_MS` (default 30 s; 2 s in the e2e stack) and is then stopped. So no console socket reaches a runtime after the end: a tab open at the end keeps its view (`ended` final); a reload or a new tab gets `sseFinal("ended")` from the route's `launcher.session` check and shows the lobby's ended status with no transcript (review after the end is 2c's released report). No test may rely on the grace window.
- **No log identity on the console stream.** A crashed or stopped child ends every console stream with `stopped` (back to the lobby, the hook's state is dropped), a Restart resumes the same log, and a fresh log only starts from an empty one (reissue-all before the start), which never had a live view. So `Last-Event-ID` can never be applied to another log.
- **Total cap (open item for 2b-3b, recommendation recorded).** Peak runtime sockets per session are `2H + B + 7 <= 32` (`CHILD_WS_MAX_CONNECTIONS`), with H human-filled and B bot-filled player roles (disjoint: a role is one or the other; a human peaks at 2 while a reload's new stream overlaps the superseded one; the console at 7). The worst case is all human, so at most 12 player roles; the bot key's own cap of 8 also bounds B. No scenario today comes near it (friday-escalation has 3) and the schema has no player-role limit. Recommendation: 2b-3b makes the control service refuse at create a scenario with more than 12 player roles, and sizes bot reconnects so a bot never holds two sockets at once. 2b-2b1 records the arithmetic only (Task 2).

## Review Focus

1. **Reconnect and seq gaps.** A reload, a dropped socket, a runtime restart (`session.resumed`) and a `Last-Event-ID` past the head each end in a view equal to the fold of the runtime's facilitator snapshot, with no duplicate or missing line; a gap never throws in `reduce`, it resyncs (Tasks 3, 7, 9, 10).
2. **Facilitator data reaching players.** With a facilitator stream open on the same runtime, no player frame carries `by`, `"talk":`, an alert or a Game Master event, and a player cookie (or its value under the console cookie name) gets a 401 and no runtime contact from the console route (Tasks 6, 7).
3. **Connection-cap exhaustion.** Five tabs, readiness polls and Start in the lobby, eight player sockets claiming `X-Forwarded-For: 127.0.0.1`, and five stale tokens on the console key: the extra tab gets `busy` with its message, players and bots are never refused because of the console, and nothing hangs on a hidden runtime 503 (Tasks 1, 6).
4. **Proxy and `X-Forwarded-For`.** A console request with a forged, listed or absent `X-Forwarded-For` still reaches the runtime as `scenecoach-console`; a player request claiming `scenecoach-console` is a neutral 400 (Tasks 1, 6).
5. **Markup and bidi injection.** `<img src=x onerror=alert(1)>`, `<b>`, U+202E and control characters in a line, a name, `by`, an alert and Game Master reasoning render as literal text, create no element, and a right-to-left override in one name does not reorder the next item (Task 11).

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/server/facilitator-budget.ts` (new) | Reserved forwarded key, per-session live and short slots |
| `apps/web/src/server/facilitator-socket.ts` | `openFacilitatorSocket` (budget, key, fresh-pair retry, `lastSeq`); `withFacilitatorSocket` on top |
| `apps/web/src/server/runtime-connection.ts`, `wire.ts` | `joinFacilitator` with `lastSeq` and the whole joined frame |
| `apps/web/src/server/sse.ts` (exists: `sseBody`) | Gains the shared SSE framing, headers, finals, backpressure writer, heartbeat, replay-reset rule and `SseOut` |
| `apps/web/src/server/facilitator-copies.ts` (new) | Allowlisted console copies of state, `session.started` and roster |
| `apps/web/src/server/facilitator-hub.ts` (new) | Console streams: channel ids, cap, reset, forwarding, finals |
| `apps/web/src/server/console-stream.ts` (new), `routes.ts`, `app/api/v1/console/sessions/[id]/stream/route.ts` (new) | The console stream route |
| `services/runtime/src/host/{session-host,ws-server}.ts` | `scenes` on the facilitator `joined` |
| `apps/web/src/lib/console-view.ts` (new) | Pure console fold, timeline text, words-spoken rows |
| `apps/web/src/lib/use-console-stream.ts` (new), `use-readiness.ts` | EventSource hook with gap resync; polling switch |
| `apps/web/src/components/console/{LiveView,ConsoleTimeline,WordsSpoken,SessionConsole}.tsx` (new), `Readiness.tsx`, `app/console/[id]/page.tsx` | Live view and the lobby-to-live switch |
| `apps/web/e2e/console-live.spec.ts` (new) | Launcher-stack flow and Axe |

---

## PR 1: connection budget (`feature/EPIC-0002-US-0059-console-budget`, from `develop`)

### Task 1: Reserved console key and per-session facilitator budget

**Files:** Create `apps/web/src/server/facilitator-budget.ts`; Modify `apps/web/src/server/facilitator-socket.ts` (and its header comment, which says facilitator sockets send no `X-Forwarded-For`), `handlers.ts` (`Deps`), `routes.ts` (`createDeps`), `console-sessions.ts` (`failure`, Start); Test `apps/web/src/server/__tests__/facilitator-budget.test.ts` (new), `facilitator-socket.test.ts`, `facilitator-throttle.runtime.test.ts`, `console-sessions.test.ts`, `guards.test.ts`, `handlers.test.ts`. `Deps` fixtures gain `facilitatorBudget: new FacilitatorBudget()`: the typed ones in `handlers.test.ts`, `handlers.launcher.test.ts`, `handlers.runtime.test.ts` (else typecheck fails) and the cast ones that reach a facilitator socket, `facilitator-socket.test.ts` and `console-sessions.test.ts` (else they throw at run time).

**Interfaces:**
- Produces in `facilitator-budget.ts`: `FACILITATOR_FORWARD_KEY = "scenecoach-console"`, `LIVE_TABS_PER_SESSION = 4`, `SHORT_SOCKETS_PER_SESSION = 3`, `type SocketKind = "live" | "short"`, `class FacilitatorBudget { tryAcquire(sessionId: string, kind: SocketKind): (() => void) | null; inUse(sessionId: string, kind: SocketKind): number }` (release is idempotent; an entry at zero is deleted).
- `Deps.facilitatorBudget: FacilitatorBudget`. `FacilitatorSocketError.reason: "unavailable" | "unauthorized" | "busy"`. `withFacilitatorSocket` takes one `short` slot before the first launcher call (none: `busy`, the launcher is not called), connects with `FACILITATOR_FORWARD_KEY`, and releases the slot once, when its last connection has reported close (or at once when no connection was made). Readiness treats `busy` like `unavailable` (status null); Start answers `503 busy` "Too many console connections to this session are open. Close a console tab and try again."

- [ ] **Step 1: Write the failing tests:**
  - budget: `four live slots then null; three short slots then null; kinds and sessions are independent`; `release twice frees one slot`; `LIVE_TABS_PER_SESSION + SHORT_SOCKETS_PER_SESSION is below CHILD_WS_MAX_CONNECTIONS_PER_IP` (import `services/control/src/child-env.ts` by computed path, as `hub.runtime.test.ts` does for the runtime).
  - facilitator-socket: `the runtime handshake carries X-Forwarded-For scenecoach-console` (fakeRuntime `headers`; it replaces the existing assertion that `x-forwarded-for` is absent, around line 110); `a fourth concurrent call is busy and never calls the launcher`; `the slot is held across the fresh-pair retry and freed only after the socket reports close`.
  - console-sessions: `Start with no short slot is 503 busy`; `readiness with no short slot is status null, not an error`.
  - Pins (they pass before the change; they guard the decision): guards `requestAddress of X-Forwarded-For scenecoach-console or scenecoach-bot is null`; handlers `join and stream with X-Forwarded-For scenecoach-console are a 400 and never call connect`.
  - facilitator-throttle.runtime (bootstrap env adds `WS_MAX_CONNECTIONS_PER_IP: "8"`, the runtime default made explicit; its two existing tests connect with `null` and argue "why facilitator sockets send none": rewrite them onto the console key): `MAX_AUTH_FAILURES + 1 stale tokens on the console key do not block a player upgrade with X-Forwarded-For 203.0.113.5 nor one with 127.0.0.1`; `eight player sockets claiming 127.0.0.1 do not stop a facilitator join on the console key`; `stale tokens on the console key do not block an upgrade on scenecoach-bot`; `a ninth socket on one key is refused 503 while another key still connects`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/facilitator-budget.test.ts src/server/__tests__/facilitator-socket.test.ts src/server/__tests__/facilitator-throttle.runtime.test.ts src/server/__tests__/console-sessions.test.ts src/server/__tests__/guards.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run step 2 and the whole web suite; run `facilitator-throttle.runtime.test.ts` in the node:22 container; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console sockets share a reserved key and budget`.

### Task 2: PR 1 docs and pull request

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** `docs/THREAT_MODEL.md` new section "Live console channel (EPIC-0002 slice 2b-2b1, US-0059)", first bullet the budget decision record: the reserved keys and why (a player cannot claim them; a stale-token block, scope `""`, lands on the console key only and costs at most the console for `authBlockMs`, never players or bots); 4 live + 3 short of 8; B2 commands reuse the tab socket; bots send `scenecoach-bot` (2b-3b); the precondition (runtime reachable only by the BFF and the control service); the total-cap arithmetic and its open item exactly as in Rulings (`2H + B + 7 <= 32`, at most 12 player roles). Amend the 2b-1 paragraph (around line 299, "A facilitator socket sends no `X-Forwarded-For`") and the "runtime trusts the BFF's header" bullet's `WS_MAX_CONNECTIONS` advice. `docs/ARCHITECTURE.md`: the same in the console section. `CHANGELOG.md` "Changed".
- [ ] **Step 2:** Assign the next free ids (expected AC-0352, TC-0092, TASK-0096) with an "Assigned 2026-11-01 (slice 2b-2b1, PR 1)" line in `ID_REGISTRY.md`. `RELEASE_PLAN.md` under US-0059: `AC-0352: every BFF facilitator socket carries the reserved forwarded key scenecoach-console and takes a per-session slot (4 live tabs, 3 short-lived), so players and bots cannot exhaust or block the console's connections nor the console theirs` (checked, TC-0092) and `TASK-0096 (US-0059): Facilitator channel and read-only live view (slice 2b-2b1)`, In Progress, Branch `feature/EPIC-0002-US-0059-console-budget` (PR 2 `feature/EPIC-0002-US-0059-console-stream`, PR 3 `feature/EPIC-0002-US-0059-console-live-view`), Notes naming this plan. TC-0092 in `TEST_CASES.md` with the Task 1 files as Actual Result.
- [ ] **Step 3:** `npm run plan:generate` (no parse errors); commit `[docs] US-0059: record the console connection budget`.
- [ ] **Step 4:** Push, open PR 1 into `develop` (body: US-0059, AC-0352, TASK-0096). Wait for the squash merge before PR 2.

---

## PR 2: facilitator SSE channel (`feature/EPIC-0002-US-0059-console-stream`, from `develop` after PR 1)

### Task 3: Facilitator join with replay and scenes

Already in the runtime (no change): `join_facilitator` accepts `lastSeq` (`protocol.ts` `LastSeq`), refuses one past the head with `bad_message` "lastSeq: after the last event ..." before anything is sent, and `sendJoined` replays to the facilitator exactly as to a player (`replay.complete`, bounded by `MAX_REPLAY_EVENTS`/`MAX_REPLAY_BYTES` and send-buffer room; pinned by `ws-server.replay.test.ts` "test_facilitator_rejoin_with_last_seq_replays_everything_after_it"). The facilitator `joined` today carries `roleId`, `state` (full `SessionState`, `lastSeq` inside), `hiddenFacts`, `notice` (open server only) and `replay`; no `scenes`, no `logIdentity`; the roster comes as the next frame after the replayed events. The only runtime change is `scenes`.

**Files:** Modify `services/runtime/src/host/session-host.ts` (beside `scenesFor`), `host/ws-server.ts:377`, `host/protocol.ts` (the `scenes` doc says "Never sent to the facilitator"), `apps/web/src/server/wire.ts`, `runtime-connection.ts` (`joinFacilitator`), `facilitator-socket.ts`; Test `services/runtime/src/host/__tests__/ws-server.scenes.test.ts`, `apps/web/src/server/__tests__/runtime-connection.test.ts`, `facilitator-socket.test.ts`, `hub.runtime.test.ts`.

**Interfaces:**
- Runtime: `SessionHost.allScenes(): PlayerScene[]` (every scene in script order, same mapping as `scenesFor`); the facilitator `joined` gains `scenes` via `(h as Partial<SessionHost>).allScenes?.() ?? []` (omitted when empty, as for players). Players' `joined.scenes` unchanged.
- Web: `ClientMessage` `join_facilitator` gains `lastSeq?: number`. `RuntimeConnection.joinFacilitator(sessionId: string, token: string, o?: { lastSeq?: number }): Promise<{ frame: JoinedFrame; roster: FacilitatorRosterEntry[]; status: SessionStatus }>`; a `lastSeq` refusal is retried once without it (the `join(msg, fallback)` path; the fallback is the same message with the token, minus `lastSeq`). Replay frames stay queued for `onFrame`; only the roster frame after them is taken.
- `type FacilitatorJoin = { frame: JoinedFrame; roster: FacilitatorRosterEntry[]; status: SessionStatus }`. `openFacilitatorSocket(deps: Deps, sessionId: string, o: { kind: SocketKind; lastSeq?: number }): Promise<{ conn: RuntimeConnection; joined: FacilitatorJoin }>` (budget, key and fresh-pair rules of Task 1; the slot frees when `conn` reports close; the caller owns `conn`). `withFacilitatorSocket` becomes `openFacilitatorSocket(kind "short")` plus `fn` plus `close`, behaviour unchanged.

- [ ] **Step 1: Write the failing tests:** ws-server.scenes: replace `the facilitator joined has no scenes` (line 77) with `the facilitator's joined lists every scene with id, title, goal and time box; a player's lists only its own`. runtime-connection (fakeRuntime): `joinFacilitator with lastSeq sends it, resolves with the joined frame, keeps the replayed events queued in order and takes the roster that follows them`; `a lastSeq past the head is retried once without lastSeq and resolves without replay`. facilitator-socket: `openFacilitatorSocket returns an open connection whose slot frees on close`. hub.runtime ("wire contract: facilitator"): `scenes` moves into the facilitator joined's required keys (it is already an allowed key) and `SENT.join_facilitator` gains `lastSeq: 0`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/ws-server.scenes.test.ts` and the three web files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run step 2, both suites and typecheck; run the ws-server.scenes file in the node:22 container; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: facilitator join with replay and the scene list`.

### Task 4: Shared SSE mechanics

Refactor only: the player stream's bytes and tests do not change.

**Files:** Modify `apps/web/src/server/sse.ts` (today only `sseBody`; one SSE module, not a second one beside it), `stream-hub.ts` (its private `RETRY_MS`, `HEARTBEAT_MS`, `DEFAULT_MAX_PENDING_BYTES`, `sse`, the pending-bytes logic of `write` and the reset test in `open`), `handlers.ts` (move its private `RETRY_MS`, `SSE_HEADERS`, `sseHeaders`, `sseFinal`, `lastSeqOf`); Test `apps/web/src/server/__tests__/sse.test.ts` (new cases beside the `sseBody` ones), `stream-hub.test.ts`, `handlers.test.ts` (unchanged, must pass).

**Interfaces:**
- Produces in `sse.ts`: `type SseOut` (moved from `stream-hub.ts`, which re-exports it so `handlers.ts` imports keep working), `RETRY_MS = 3_000`, `HEARTBEAT_MS = 15_000`, `DEFAULT_MAX_PENDING_BYTES = 256 * 1024`; `sseFrame(event: string, data: unknown, id?: number): string`; `sseHeaders(setCookie?: string): Headers`; `sseFinal(event: string, data?: unknown, setCookie?: string): Response`; `lastSeqOf(v: string | null): number`; `replayIncomplete(replay: ReplaySummary | undefined): boolean`; `class SseWriter { constructor(out: SseOut, maxPendingBytes: number); write(chunk: string): "ok" | "stalled" | "gone" }`; `heartbeat(setTimer: SetTimer, beat: () => boolean): () => void` (re-arms every `HEARTBEAT_MS` while `beat` returns true; returns cancel).

- [ ] **Step 1: Write the failing tests** (`sse.test.ts`): `sseFrame escapes CR and LF inside data and puts id first`; `SseWriter is stalled past the cap, ok again after a taken write, gone when out throws`; `heartbeat stops re-arming when beat returns false and on cancel` (manualTimers); `replayIncomplete is true for undefined and complete false`; `lastSeqOf gives 0 for null, "", "-1", "1e3" and 17 digits`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/sse.test.ts`; expect FAIL (the new cases).
- [ ] **Step 3:** Implement and switch `stream-hub.ts` and `handlers.ts` to it.
- [ ] **Step 4:** Run the whole web suite; expect PASS with `stream-hub.test.ts`, `handlers.test.ts` and `hub.runtime.test.ts` untouched.
- [ ] **Step 5:** Commit `[refactor] US-0059: share SSE framing, heartbeat and reset rule`.

### Task 5: Console copies and the facilitator hub

**Files:** Create `apps/web/src/server/facilitator-copies.ts`, `facilitator-hub.ts`; Modify `console-sessions.ts` (export `entryOf`), `handlers.ts` (`Deps`), `routes.ts` (`createDeps`); Test `apps/web/src/server/__tests__/facilitator-copies.test.ts`, `facilitator-hub.test.ts` (new; `FakeConn`/`asConn`, `sseRecorder` and `manualTimers` from `__tests__/fakes.ts`), and the typed `Deps` fixtures of Task 1 gain `facilitatorHub`.

**Interfaces:**
- Consumes: Task 3's `FacilitatorJoin`, Task 4's helpers.
- `facilitator-copies.ts`: `consoleState(s: SessionState): SessionState` built from `CONSOLE_STATE: { [K in keyof SessionState]: (s: SessionState) => SessionState[K] }` (every key listed, so a new field is a compile error; `roles` copied as `{ kind }` only; `npcs` is `{}`); `consoleEvent(e: SessionEvent): SessionEvent` (`session.started` keeps `type, seq, ts, sessionId, scenarioId, version, roles` as `{ kind }`, `consents`, `names`; `npc.updated` keeps `type, seq, ts, sessionId, roleId` with `goals: [], knowledge: [], released: []`; every other event whole); `consoleRoster(entries: FacilitatorRosterEntry[]): FacilitatorRosterEntry[]` (`entryOf`).
- `facilitator-hub.ts`: `MAX_FACILITATOR_STREAMS = 64`; `type ConsoleStreamFinal = "reconnecting" | "ended" | "expired"` (the route writes `stopped` and `busy` itself); `class FacilitatorHub { constructor(o: { setTimer: SetTimer; now: () => number; maxStreams?: number; maxPendingBytes?: number; newChannelId?: () => string }); open(a: { sessionId: string; expiresAt: number; conn: RuntimeConnection; joined: FacilitatorJoin; out: SseOut }): { channel: string; close(): void } | "capacity"; size(): number }`. Channel ids are `randomUUID()` by default. Writes, in order: `retry`, `joined { channel, scenes }`, `reset { state: consoleState }` with id `state.lastSeq` only when `replayIncomplete(frame.replay)` (then the replayed frames are skipped), `roster { entries }`, then `event` (`consoleEvent`, id seq), `roster`, and `error { code, message: "the server reported an error" }`; anything else is dropped. `session.ended` is forwarded, then `ended`. Any runtime close: `reconnecting`. Heartbeat past `expiresAt`: `expired`. Stall: `reconnecting`. Every exit closes `conn`. `Deps.facilitatorHub: FacilitatorHub` in `createDeps`.

- [ ] **Step 1: Write the failing tests:**
  - copies: `the console state has no participantId, npcs is empty and every other key equals the input`; `session.started loses logIdentity, scenarioHash and participantIds; npc.updated keeps its seq and roleId with no goal, knowledge or released text; other events pass whole`.
  - hub: `writes retry, joined with channel and scenes, roster, then events with seq ids; a complete replay with no logIdentity gives no reset`; `a missing or incomplete replay writes reset at lastSeq and skips the replayed frames`; `two tabs of one session get distinct channels and both receive every event`; `session.ended is forwarded then ended; a runtime close writes reconnecting; the first heartbeat after expiresAt writes expired`; `error frames carry the fixed message; joined and unknown frames are not forwarded`; `past maxStreams open is capacity, closes the connection and writes nothing`; `a stalled consumer past maxPendingBytes ends with reconnecting`; `closing the output closes the runtime connection`.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, then the web suite and typecheck; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: facilitator hub with its own key, caps and reset`.

### Task 6: The console stream route

**Files:** Create `apps/web/src/server/console-stream.ts`, `apps/web/src/app/api/v1/console/sessions/[id]/stream/route.ts`; Modify `routes.ts`, `console-sessions.ts` (export `sessionIdOf`); Test `apps/web/src/server/__tests__/console-stream.test.ts` (new), `routes.test.ts`, `handlers.test.ts`.

**Interfaces:**
- `handleConsoleStream(req: Request, deps: Deps): Promise<Response>`, in order: `checkFetchSite`, and an `Origin` that is present must equal `publicOrigin` (else 403; absent is allowed, as in `handleStream`: a same-origin EventSource GET sends no `Origin`); `Accept` includes `text/event-stream` (else 406); `requireConsole` (503 disabled, 401 with a clearing cookie); `sessionIdOf` valid (else 404); no `deps.launcher`: the 502 `launcher_unavailable` envelope of the other console routes; `launcher.session(id)`: `ended` gives `sseFinal("ended")`, `stopped` gives `sseFinal("stopped")`, `not_found` the 404 envelope, any other launcher failure `sseFinal("reconnecting")`; `openFacilitatorSocket(deps, id, { kind: "live", lastSeq: lastSeqOf(Last-Event-ID) })`: `busy` gives `sseFinal("busy", { message })` with the Global Constraints copy, other failures `reconnecting`; an aborted request or a cookie that expired meanwhile closes the socket; then `facilitatorHub.open` (capacity: close and `busy`). `X-Forwarded-For` of the request is never read. Route file re-exports `consoleStreamGET` with `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

- [ ] **Step 1: Write the failing tests** (`console-stream.test.ts`, spies on `deps.connect` and the launcher):
  - `a player cookie alone is 401 and neither the launcher nor the runtime is contacted`; `a player cookie value under the console cookie name is 401 and cleared`; `a cookie from before a FACILITATOR_SECRET change is 401`; `a reconnect with an expired console cookie is 401` (every request checks).
  - `Last-Event-ID 41 joins with lastSeq 41; absent or "abc" joins with lastSeq 0`.
  - `Sec-Fetch-Site cross-site and a foreign Origin are 403; no Origin is accepted; no text/event-stream Accept is 406`.
  - `ended, stopped, unknown and unreachable launcher answers give ended, stopped, 404 and reconnecting`.
  - `a fifth live tab of one session gets busy with its message and opens no socket`.
  - `the runtime sees X-Forwarded-For scenecoach-console whatever the request sent (a forged single value, a list, none)`.
  - `responses carry X-Robots-Tag noindex, nofollow and Cache-Control no-store, no-transform`.
  - handlers: `a console cookie on /api/v1/stream is 401` (add if not already pinned). routes: `consoleStreamGET` exists.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interface.
- [ ] **Step 4:** Re-run and the web suite; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console stream route, cookie checked on every connect`.

### Task 7: Real-runtime contract for the channel

**Files:** Create `apps/web/src/server/__tests__/console-stream.runtime.test.ts` (in-process runtime by computed path as in `hub.runtime.test.ts`, `TRUST_PROXY=1`, `FACILITATOR_TOKEN`, mock models, private `mkdtemp`, `vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })`, a stub launcher returning the port and token).

- [ ] **Step 1: Write the failing tests:**
  - `no hidden-fact text reaches the console stream`: release a fact (`release_hidden` over the test facilitator socket) and check the client_sponsor hidden fact text of `hub.runtime.test.ts` ("Would accept a phased delivery after go-live") appears in the raw facilitator frames and in no console `npc.updated` event, `reset` state or `joined` frame (an AI character's line may legitimately say it once released).
  - `a console stream resumes from Last-Event-ID after the runtime socket drops: folding the reset or replayed events with reduce gives the runtime's facilitator snapshot, with no duplicate or missing seq`.
  - `a Last-Event-ID past the head gives a reset at the head, not an error`.
  - `with a console stream and three player streams open, the facilitator's command with by "LEAK-BY-2b2b1", talk and the `end_now` alert (sent over a test facilitator socket) reach the console stream and no player stream` (positive control first; the same kind of markers as the `FACILITATOR_ONLY` list inside the leak test of `hub.runtime.test.ts`, a local constant to copy, not an export). The test facilitator socket is raw `ws` with `FACILITATOR_TOKEN` (`wire.ts` has no `command` or `end_now`).
  - `after the session ends the console stream forwards session.ended and then ended`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-stream.runtime.test.ts`; these are contract tests over Tasks 3 to 6, so they may pass at once; before relying on a pass, break one thing on purpose (e.g. skip the reset) and see the matching test fail. A real failure is fixed in code, never in the assertion.
- [ ] **Step 3:** Run it in the node:22 container (root and `--user node`); expect PASS.
- [ ] **Step 4:** Commit `[test] US-0059: console stream against the real runtime`.

### Task 8: PR 2 docs and pull request

**Files:** Modify `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, `README.md` (API list), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Threat model section (Task 2's): separate route and hub; cookie on every connect; what the console copies drop and why `hiddenFacts` is not sent; a console tab shows facilitator-only data to whoever sits at it (shoulder-surfing, as for codes). Architecture: the channel, its frames and finals. README: the route.
- [ ] **Step 2:** Assign the next free ids (expected AC-0353, TC-0093). `AC-0353: one facilitator socket per console tab is forwarded as SSE on GET /api/v1/console/sessions/:id/stream with seq ids and Last-Event-ID replay; the console cookie is checked on every connect and reconnect, a player cookie gets a 401 and nothing from it, and a reset is sent only for a missing or incomplete replay` (checked, TC-0093). CHANGELOG "Added".
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage`; commit `[docs] US-0059: document the facilitator channel`.
- [ ] **Step 4:** Push, open PR 2 into `develop` (body: US-0059, AC-0353, TASK-0096). Wait for the squash merge before PR 3.

---

## PR 3: read-only live view (`feature/EPIC-0002-US-0059-console-live-view`, from `develop` after PR 2)

### Task 9: The console view fold

**Files:** Create `apps/web/src/lib/console-view.ts`, `apps/web/src/lib/__tests__/console-view.test.ts`.

**Interfaces:**
- `type TimelineEntry = { seq: number; ts: number; kind: "line" | "notice" | "alert"; text: string; roleId?: string; level?: "info" | "warning" }`; `type ConsoleView = { state: SessionState; timeline: TimelineEntry[]; gap: boolean }`; `MAX_CONSOLE_LINES = 1_000`.
- `viewFromReset(state: SessionState): ConsoleView` (timeline = transcript lines, plus the notice "Earlier Game Master notices and alerts are not shown after a reconnect." when `lastSeq > 0`).
- `applyConsoleEvent(v: ConsoleView | null, e: SessionEvent, ctx: { scenes: PlayerScene[]; label: (roleId: string) => string }): ConsoleView | null` never throws: `v` null takes only seq 1 (from `initialState()`), else stays null with nothing folded; seq at or below `lastSeq` returns `v` unchanged; seq above `lastSeq + 1` returns `{ ...v, gap: true }`; otherwise `reduce`, cap transcript and timeline at `MAX_CONSOLE_LINES`, append the entry from `timelineText(e, before, ctx)` and set `gap: false` (after a resync the replay's next in-order event clears the flag; older ones are no-ops).
- `timelineText(e, before: SessionState, ctx): Omit<TimelineEntry, "seq" | "ts"> | null`, exact text (`<by>` is `e.by ?? "the facilitator"`, `<scene>` the scene title or id, roles through `ctx.label`): `utterance` line with the text; `facilitator.alert` alert "<message>"; `gm.decision` only when it changes `before.gmVerdicts[condition]`: "Game Master: “<condition>” is met" or "is not met"; `gm.no_verdict` "Game Master gave no verdict on “<condition>”"; `gm.fact_earned` "Game Master suggests releasing fact <n> of <role>" plus " (released automatically)" with `autoRelease`; `facilitator.command`: "Paused by <by>", "Resumed by <by>", "Advance requested by <by>", "Inject <injectId> fired by <by>", "Whisper to <role> by <by>: <text>", "Fact <n> of <role> released by <by>", "Stance of <role> changed by <by>"; `inject.fired` "Inject to <roles>: <content>" (`<roles>` is `e.to` through `ctx.label`, joined with ", "); `scene.entered` "Scene “<scene>” begins"; `scene.exited` "Scene “<scene>” ends"; `session.started` "Session started"; `session.resumed` "The session server restarted; the session is paused"; `session.ended` "Session ended" plus ". Message to participants: <message>" when present; `npc.updated` null.
- `type TalkRow = { roleId: string; kind: RoleKind; words: number; lines: number }`; `talkRows(state: SessionState): TalkRow[]`: every role in `state.roles` (players first, then AI characters, each in `roles` order), 0 for the silent, read with `Object.hasOwn`.

- [ ] **Step 1: Write the failing tests:** `folding a recorded sequence from seq 1 gives reduce's state and a timeline in seq order`; `null takes only seq 1`; `a duplicate changes nothing (same object); a gap sets gap and folds nothing; the next in-order event clears gap; an unknown event type does not throw`; `transcript and timeline are capped at 1000 while talk keeps the full count`; `gm.decision appears only when the verdict changes`; one case per timeline text above (exact strings, with and without `by`); `talkRows lists silent players with 0, AI characters after the players, and a "__proto__" role as an ordinary row`; `viewFromReset adds the not-shown notice only after seq 0`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/lib/__tests__/console-view.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console view fold with notices and words spoken`.

### Task 10: The console stream hook

**Files:** Create `apps/web/src/lib/use-console-stream.ts`, `apps/web/src/lib/__tests__/use-console-stream.test.ts` (`FakeEventSource` from `lib/__tests__/fakes.ts`, as `use-session.test.ts` uses it).

**Interfaces:**
- Consumes: Task 9's fold, the frames of Task 5.
- `consoleStreamUrl(sessionId: string): string` (the Task 6 route); `MAX_GAP_RESYNCS = 3`; `type ConsoleFinal = "ended" | "stopped" | "expired" | "busy" | "closed" | "lost"`; `type ConsoleStreamUi = { conn: "connecting" | "live" | "reconnecting"; final: { kind: ConsoleFinal; message: string } | null; channel: string | null; scenes: PlayerScene[]; view: ConsoleView | null; roster: FacilitatorRosterEntry[]; notice: string | null }`; `consoleStreamReducer`; `useConsoleStream(sessionId: string, deps: SessionDeps, o?: { enabled?: boolean }): ConsoleStreamUi`. On `view.gap` the hook closes the source and opens a fresh one (no Last-Event-ID, so the BFF joins with `lastSeq: 0` and sends a reset or a full replay); it keeps its view meanwhile and replaces it only on `reset` (never on `joined`, which also follows every ordinary reconnect); the fourth gap is final `lost`. A new hook instance (after `stopped` and a Restart) starts from `view: null`. `ended` keeps the view. Messages from Global Constraints.

- [ ] **Step 1: Write the failing tests:** `opens the console route; joined, reset, roster and events build the view`; `a joined after a reconnect keeps the view and the next events continue it`; `a gap closes the source and opens a new one; the fourth gap is final lost`; `ended keeps the view and closes; stopped, expired and busy are final with their messages; reconnecting keeps the view`; `readyState CLOSED on error is final closed`; `a server error event shows a notice and a malformed frame is ignored`; `enabled false opens nothing; switching it on opens the stream`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console stream hook with gap resync`.

### Task 11: Live view components

**Files:** Create `apps/web/src/components/console/LiveView.tsx`, `ConsoleTimeline.tsx`, `WordsSpoken.tsx`; Modify `apps/web/src/lib/app.css` (classes only); Test `apps/web/src/components/__tests__/LiveView.test.tsx` (new), `src/__tests__/source-rules.test.ts` (unchanged, must pass).

**Interfaces:**
- `LiveView({ ui, clock }: { ui: ConsoleStreamUi; clock: Clock })`: section "Live session" with a status word (Not started, Running, Paused, Ended), `SceneStatus` (`components/SceneStatus.tsx`, unchanged) fed from `ui.scenes` (the scene whose id is `currentScene.id`, its index and the count) and `view: { paused, pausedSince, scene: currentScene && { id, enteredAt, pausedMs } }` taken from `view.state`, the reconnecting banner and notices; then `ConsoleTimeline`, then `WordsSpoken`. Names come from `ui.roster`.
- `ConsoleTimeline({ entries, names, playerRoles }: { entries: TimelineEntry[]; names: Record<string, string>; playerRoles: ReadonlySet<string> })`: `<ol aria-label="Transcript and notices" aria-live="polite" aria-relevant="additions" tabIndex={0}>`, the follow-the-bottom rule of `Transcript.tsx`; lines show the name in `<bdi>`, the role label and an "AI" pill for non-player roles; notices are prefixed "Game Master" or "Facilitator" in text; alerts "Alert:" or "Warning:".
- `WordsSpoken({ rows, names }: { rows: TalkRow[]; names: Record<string, string> })`: `<section aria-labelledby>` with h2 "Words spoken", the caption from Global Constraints, a table (`th scope="col"`: Role, Words, Lines) for players and a second one, "AI characters (context)", for AI characters.

- [ ] **Step 1: Write the failing tests** (Testing Library, injected `Clock`): `renders <img src=x onerror=alert(1)>, <b>, U+202E and a tab in a line, a name, by, an alert, Game Master reasoning and a closing message as literal text, with no img, b or script element`; `a name with U+202E sits in its own bdi`; `the Words spoken section has its heading and caption and its text never contains "time"`; `the timeline is a polite live region with additions only; an alert is labelled in text`; `scene title, goal and timer from scenes and currentScene; Paused shows the pill; no scene shows Between scenes`; `an AI character's line has the AI pill and is listed under AI characters (context)`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/LiveView.test.tsx`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `src/__tests__/source-rules.test.ts`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: read-only live view components`.

### Task 12: From readiness to the live view on `/console/[id]`

**Files:** Create `apps/web/src/components/console/SessionConsole.tsx`; Modify `apps/web/src/lib/use-readiness.ts`, `apps/web/src/components/console/Readiness.tsx`, `apps/web/src/app/console/[id]/page.tsx`; Test `apps/web/src/lib/__tests__/use-readiness.test.tsx`, `apps/web/src/components/__tests__/Readiness.test.tsx`, `SessionConsole.test.tsx` (new).

**Interfaces:**
- `UseReadinessOptions.enabled?: boolean` (default true; false cancels the timer and fetches nothing; true again polls at once).
- `ReadinessProps` gain `live?: { status: SessionStatus; roster: FacilitatorRosterEntry[] } | null` (when set: polling off, status and roster come from it, the last polled `launcherStatus` and `modelLabel` stay) and `onState?: (s: { launcherStatus: string; status: SessionStatus | null }) => void`, `onStarted?: () => void`.
- `SessionConsole({ sessionId, deps }: { sessionId: string; deps?: Partial<SessionDeps & { setTimer: SetTimer; clock: Clock }> })`: mode `lobby` until a readiness answer says `status === "running"` or Start succeeds, then `live` (opens `useConsoleStream`, passes `live` to `Readiness`, renders `LiveView` below it); a final `stopped` returns to `lobby` (polling, Restart shown). The page renders it; title "Session", signed-in lede "Get the room ready, start, then follow the session live."

- [ ] **Step 1: Write the failing tests:** use-readiness: `enabled false stops polling; true again polls at once`. Readiness: `with live set it makes no readiness request and shows the live roster and status`. SessionConsole: `a running readiness answer opens the console stream and stops polling`; `a successful Start opens the stream`; `a stopped final returns to polling and shows Restart`; `an idle session never opens the stream`.
- [ ] **Step 2:** Run the three files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run and the web suite; expect PASS (the existing Readiness tests unchanged).
- [ ] **Step 5:** Commit `[feat] US-0059: the console switches from readiness to the live view`.

### Task 13: End-to-end and accessibility

**Files:** Create `apps/web/e2e/console-live.spec.ts` (`startLauncherStack`; `facilitator`, `createSession`, `startButton`, `checkBothSchemes`, `noHorizontalScroll` from `e2e/helpers/console.ts`; `seatLauncher`, `say` from `players.ts`).

- [ ] **Step 1: Write the specs:**
  - `after Start the console shows the first scene and its timer, a player's line, Words spoken for that player, and the reissue alert after a reissue after the start` (deterministic: the runtime appends a facilitator-only info alert naming who reissued, `reissue.ts` step 4; reissue a role after the start as in `console-flow.spec.ts` "reissue after the start rebinds consent").
  - `the live view raises no securitypolicyviolation` (a listener added with `page.addInitScript` collects them; the nonce CSP of `proxy.ts` stays intact with untrusted text on screen).
  - `a reload keeps the line and a second console tab follows the same events`.
  - `a player cookie on the console stream URL is 401` (request with the player's context).
  - `no serious or critical Axe violations on the live view at 1280 px and 400 px, light and dark, with no horizontal scroll at 1280` (`checkBothSchemes` and `noHorizontalScroll` of `e2e/helpers/console.ts`, as `console-flow.spec.ts` uses them).
- [ ] **Step 2:** Run `pnpm --filter @acr/web e2e console-live.spec.ts` locally (chromium per Global Constraints), then the whole `pnpm --filter @acr/web e2e`; expect PASS; the CI Web E2E job must pass too.
- [ ] **Step 3:** Commit `[test] US-0059: live view flow and Axe at laptop width`.

### Task 14: PR 3 docs, pull request and close-out

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** Assign the next free TC (expected TC-0094) for the live view. AC-0311 stays unchecked with a note: "scene status, timers, transcript with Game Master notices and alerts and Words spoken are built in slice 2b-2b1 (TC-0094); pause, resume, advance and end now follow in 2b-2b2". AC-0316 stays unchecked with a note that the live view passes Axe at 400 px and 1280 px (console-live.spec.ts) and the controls are audited in 2b-2b2. TASK-0096 Done with the three PRs.
- [ ] **Step 2:** Threat model: text-only rendering and `bdi` for untrusted text in the console; the polite live region. Architecture: the browser runs the shared reducer for the facilitator (2a's "the web does not run the shared reducer" now holds for players only). CHANGELOG "Added": the live view.
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage` twice (once under load); record coverage and the Axe result in `progress.md`; update `MEMORY.md` (reserved keys and budget, channel finals, gap resync). Commit `[docs] US-0059: document the live view and close 2b-2b1`.
- [ ] **Step 4:** Push, open PR 3 into `develop` (body: US-0059, AC-0311 and AC-0316 progress, TASK-0096). After the merge the 2b-2b2 plan is written next.
