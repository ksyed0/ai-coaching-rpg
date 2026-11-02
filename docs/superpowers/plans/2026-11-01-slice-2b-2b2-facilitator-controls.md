# EPIC-0002 Slice 2b-2b2: Facilitator Command Route, Controls and Confirmations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in facilitator runs the session from the live console: pause, resume, move on, fire an inject, whisper, release a hidden fact (one click on a Game Master suggestion), change an AI character's stance, end now with an optional closing message, and remove a participant before the start, each logged with the login name and each irreversible or audience-affecting action behind one confirmation that names its subject and audience.

**Architecture:** Commands go through `POST /api/v1/console/sessions/:id/command` and travel over the console tab's own live facilitator socket (the stream's `channel` id names it; no new socket, as 2b-2b1 recorded). The runtime acknowledges nothing today, so it gains an optional client `ref` on `command` and `end_now`, answered by `{ type: "ack", ref }` or an `error` carrying the `ref`; a command that carries a `ref` never auto-starts the session. The `FacilitatorHub` correlates the answer and the route turns it into fixed copy. The console stream gains each scene's injects and a facilitator-only `characters` frame (AI characters' goals and numbered hidden facts) so the controls can name what they act on. Remove is the existing launcher reissue with reason `removed` on its own route, because it has no runtime socket and lives in the lobby, where no live channel exists.

**Tech Stack:** TypeScript, Node 22, Next.js 16.4.1, React 19.3.0, ws, zod (runtime only), vitest 5.0.3, Playwright with `@axe-core/playwright`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-31-slice-2b-remaining-design.md` section 4 "B2" and the stack table (binding; it wins over the parent), and `docs/superpowers/specs/2026-10-30-web-client-slice-2b-design.md` sections 7.1 to 7.5, 9, 10 and 11. Stories: US-0059 (AC-0311 controls part, AC-0312, AC-0315, AC-0316 for the controls; AC-0314 console button). Security posture: `docs/THREAT_MODEL.md`. Predecessor: `docs/superpowers/plans/2026-11-01-slice-2b-2b1-facilitator-live-view.md` and its ledger rulings R1 to R5.

## What exists today (verified against the code at 19aaba1)

- **Runtime.** `command` (`FacilitatorCommandSchema`: pause, resume, advance, fire_inject, whisper, release_hidden, set_npc_stance) and `end_now { message?, by? }` exist (`services/runtime/src/host/protocol.ts`). Success sends nothing but the resulting events; a refusal is an uncorrelated `error { code, message }` to the sender only (`ws-server.ts` `handle`, `fail`). `command` runs `if (!host.hasStarted) await host.start()` first (`ws-server.ts:428`), so a lobby command starts the session when the seats are ready. Engine refusals (`session-engine.ts` `doCommand`): `ended`, `stale_scene` (from `expectSceneId`), `unknown_inject`, `unknown_role`, `npc_role`, `unknown_fact`, `already_released`, `log_failed`; `end_now` adds `not_started`, `starting` (`session-host.ts:399`). Pause while paused and a repeated inject are accepted. Ref-less `rate_limited` comes from the per-connection bucket before parsing.
- **Facilitator scenes** are `PlayerScene` (`id, title, goal, timeBoxMinutes`) from `SessionHost.allScenes()` (`session-host.ts:467`): no injects.
- **Remove** is `reissueRole(..., reason: "removed")`, before the start only (`host/reissue.ts:58`), reached by the control API `POST /sessions/:id/codes/reissue { roleId, by, reason: "removed" }` (`services/control/src/api.ts:23`); a refusal comes back as `ControlError("conflict")` (`supervisor.ts` `onReissueReply`). The BFF's `LauncherClient.reissue(id, roleId, by)` (`launcher-client.ts:202`) cannot send a reason.
- **BFF.** No command route and no remove route. Console routes are `/api/v1/console/sessions/:id/*` with `guard` (requireConsole, then Origin + `X-Requested-With: scenecoach` + Fetch-Metadata for changes) and a strict 1 KiB `readBody` (`console-sessions.ts`). `FacilitatorHub.open` mints a `channel` (randomUUID) per stream but stores neither it nor `sessionId`, forwards `error` frames to the page with fixed text, drops unknown frame types, and copies scenes field by field (`facilitator-hub.ts:57`). Console copies strip NPC goals, knowledge, released text and hidden facts and replace alert text (`facilitator-copies.ts`, R1, R2). The player relay's "no error within 300 ms means success" (`stream-hub.ts` `send`) is not used here: it cannot tell a late `stale_scene` from success.
- **Console UI.** `SessionConsole` (lobby, then live; sole owner of `ui.final`, R5), `LiveView` (read-only), `Readiness` (per-role Reissue with `ConfirmDialog`, Reissue all, Start, Restart), `useConsoleStream` (`joined { channel, scenes }`, `reset`, `event`, `roster`, finals), `console-view.ts` timeline texts for every command already ("Paused by <by>", "Fact <n> of <role> released by <by>", ...). `ConfirmDialog` has title, description and one confirm button; no body slot.

## Global Constraints

- Scope: the controls of B2 only. Out of scope: Prompt AI player, AI toggles, the bot (2b-3a/b), mid-session removal (end the session instead), a runtime-side sanitised alert field (R1 open item stays), released reports (2c).
- Route: `POST /api/v1/console/sessions/:id/command`, body `{ channel, kind, ...fields }`, strict keys per kind, `Content-Type: application/json`, at most `COMMAND_MAX_BODY_BYTES = 16 * 1024`. Checks in order: `guard(req, deps, true)` (503 disabled, 401 with a clearing cookie, 403 Origin/custom header/Fetch-Metadata), `sessionIdOf` (404), body (400). `by` is `who.name` from the sealed cookie, never from the body (a body `by` is 400). The request's `X-Forwarded-For` is never read.
- Kinds and limits: `pause`, `resume` (no fields, no `expectSceneId`); `advance { expectSceneId? }`; `fire_inject { injectId, expectSceneId? }`; `whisper { roleId, text, expectSceneId? }` (text 1..2000 UTF-16 units, not whitespace only); `release_hidden { roleId, fact, expectSceneId? }` (integer 1..50); `set_npc_stance { roleId, goals, expectSceneId? }` (1..10 goals, each 1..500 units after trim); `end_now { message? }` (at most 300 code points; the runtime cleans it). Ids: `CLIENT_ID_MAX_CHARS` and `isScenarioId`; `channel`: lowercase UUID.
- Runtime `ref`: optional on `command` and `end_now`, `/^[A-Za-z0-9-]{1,64}$/` (else `bad_message`). Success: `{ type: "ack", ref }` to the sender only, after the host call resolved (so after its events). Refusal: the `error` frame carries `ref`. A `command` with `ref` before the start is refused `not_started` (`starting` while a start is in flight) and never auto-starts; without `ref` the terminal behaviour is unchanged.
- Hub correlation: one pending command per channel (`COMMAND_TIMEOUT_MS = 10_000`, ref `randomUUID()`); answered by an `ack` or `error` with its ref, or by a ref-less `error` whose code is `rate_limited`, `bad_json` or `bad_message` while it is pending; an `ack` or ref'd `error` is never forwarded to the page; `log_failed` without ref is forwarded as today and answers nothing. A late answer is dropped. A command is never retried by the BFF or the browser.
- Answers (`COMMAND_ANSWERS`, BFF-written; the browser shows the BFF's `error.message` as text, as the player action answers do):

  | Outcome | Status, code | Message |
  |---|---|---|
  | ack | 200, `{ done: true }` | |
  | `stale_scene` | 409 `stale_scene` | The scene changed. Review the live view and try again. |
  | `not_started` | 409 `not_started` | The session has not started yet. |
  | `starting` | 409 `starting` | The session is still starting. Try again in a moment. |
  | `ended` | 409 `ended` | The session has ended. |
  | `already_released` | 409 `already_released` | That fact is already released. |
  | `unknown_inject`, `unknown_role`, `npc_role`, `unknown_fact` | 409 `conflict` | That action is not possible in the session's current state. |
  | `rate_limited` | 429 `rate_limited` | Too many actions at once. Wait a moment and try again. |
  | any other code | 502 `command_failed` | The session could not take that action. Check the live view, then try again. |
  | timeout, socket or stream closed while waiting | 504 `command_unconfirmed` | The session did not confirm the action. Check the live view before you try again. |
  | no such channel in this session | 409 `no_channel` | The live view is not connected. Wait until it is live again, then try again. |
  | a command already pending on the channel | 409 `command_pending` | Another action is still being confirmed. Wait a moment, then try again. |

- Remove: `POST /api/v1/console/sessions/:id/remove { roleId }` → `launcher.reissue(id, roleId, who.name, "removed")` → `{ roleId, code }` once; a launcher `conflict` is 409 `conflict` "A participant can only be removed before the start."; other failures as `failure()` today.
- Widening (rulings W1, W2 below): the console `joined.scenes` carry `injects: { id, to, content, atMinute? }[]`; a new SSE event `characters { roles: { roleId, goals: string[], facts: { n, text, released }[] }[] }` is the ONLY frame that carries goal or hidden-fact text (never knowledge). `consoleState` and `consoleEvent` are unchanged.
- Confirmations (exact copy, `lib/console-confirm.ts`; names and labels pass through `isolate` from `console-view.ts`): advance: title "Move on from “<scene>”?", "The scene ends for everyone in the room and the next scene begins. This cannot be undone.", button "Move on". end_now: "End the session now?", "The session ends for everyone in the room. Nobody can speak after this and the session cannot be restarted.", "End session", with the optional field "Closing message to participants (optional)" and hint "Shown to participants who are connected at the end. At most 300 characters." fire_inject: "Fire inject “<id>”?" (again: "Fire inject “<id>” again?"), "It is shown to <audience>. It cannot be taken back.", "Fire inject", the content shown in the body. whisper: "Whisper to <recipient>?", "Only <recipient> sees this message. It cannot be taken back.", "Send whisper", the text shown in the body. release_hidden: "Release fact <n> of <character>?", "<character> may now share this fact with everyone in the room. It cannot be taken back.", "Release fact". remove: "Remove <name> from <role>?" (no name: "Remove the participant from <role>?"), "They are signed out of the <role> seat and their code stops working. A new code for the seat is shown once. This affects the <role> role only.", "Remove". Pause, resume and stance have no confirmation (reversible, no audience). Audience: "Name (Role label)" for a seated player, "Role label" for an empty seat, "Role label (AI character)" for an AI character, joined with ", " and a final " and ".
- `expectSceneId` is the current scene id the console showed when the confirmation OPENED (for stance: at submit), omitted when no scene was current, never sent for pause and resume.
- Success announcements (polite `role="status"`): "Paused.", "Resumed.", "Moving on to the next scene.", "Inject fired.", "Whisper sent.", "Fact released.", "Stance changed.", "The session has ended."; failures in `role="alert"`. While a command is pending every control is disabled; controls are disabled unless `ui.conn === "live"` and the session is running.
- Rendering: inject content, fact text, goals, names, whisper and closing text are React text children only; names in `<bdi>`; no inline style or `dangerouslySetInnerHTML` (`src/__tests__/source-rules.test.ts`); the fact list is a closed `<details>` by default ("Hidden facts (<count>)").
- Commit format `[TYPE] US-0059: description` (max 72 chars), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Squash merges into `develop`. Before every commit: `pnpm -r --if-present typecheck` and the touched packages' `pnpm --filter <pkg> exec vitest run <files>` (no `timeout` wrapper). Every new socket or real-runtime test passes the node:22 container recipe (`AGENTS.md` section 8, "Linux" bullet; root and `--user node`). Injected timers only, `vi.waitFor` on effects, no elapsed-time assertions. Playwright locally: `pnpm --filter @acr/web e2e console-controls.spec.ts`, prefixed with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell` (or `pnpm --filter @acr/web exec playwright install chromium` once), and the whole `pnpm --filter @acr/web e2e` once before the PR; CI job "Web E2E" must pass.
- Ids are assigned by each PR's docs task (next free at that time; expected values noted); this plan reserves nothing. Each PR adds its user-visible change under `[Unreleased]` in `CHANGELOG.md`.

## Rulings

- **C1 Correlation needs the runtime.** The spec puts 2b-2b2 in the BFF and console, but its "stale scene: review and retry" criterion cannot be met on an ack-less protocol (a refusal after any wait is indistinguishable from success, and another tab's identical event can arrive first). So PR 1 adds `ref`/`ack` to the runtime: optional, backward compatible, the terminal sends none. Cost if wrong: one small protocol field.
- **C2 No auto-start from the console.** A `command` with `ref` is refused `not_started` before the start. The browser's only way to start is Start (with its gate explanation); a stale tab's Pause can never start a room. No BFF status tracking is needed.
- **C3 Route shape.** `/api/v1/console/sessions/:id/command` instead of the spec's `/api/v1/console/command`: every console route is per session (`sessionIdOf`), and the channel must belong to that session. Remove is its own route (`/remove`), not a command kind: it is a launcher reissue that returns a code and is used in the lobby, where there is no live channel.
- **C4 One pending command per channel**, refused `command_pending` rather than queued: the UI disables controls while pending, so a second one is a double click or a script, and a queue would apply actions the facilitator can no longer see confirmed.
- **W1 Injects reach the console** as part of the facilitator's `joined.scenes` (runtime `FacilitatorScene`), needed to name an inject and its audience. Players' `scenesFor` is unchanged and a test pins that no player frame carries an unfired inject's content.
- **W2 Goals and hidden facts reach the console** (B2 "decides what to widen") in one frame, `characters`, built in the hub from `joined.hiddenFacts`, `joined.state.npcs` and each `npc.updated` (released matched to fact numbers by exact text; `role.hidden[n-1]` is what the engine releases). Needed to choose a fact, to show a Game Master suggestion's text, and to edit a stance from the current goals. Knowledge never leaves the BFF. The 2b-2b1 runtime test "no hidden-fact text reaches the console stream" becomes "only in `characters` frames". The facts list is closed by default (projected screens). Owner confirmation requested (Open questions).
- **E1 E2E coverage of 2b-2b1's unexercised cases.** Ended (via End now), fifth-tab busy, dropped stream with `Last-Event-ID` (`context.setOffline`) and stopped, Restart, live are e2e here. A runtime crash is produced by a new stack helper that SIGKILLs the control service's runtime child (found with POSIX `ps -A -o pid=,pgid=,args=` in the stack's process group by the runtime entry path; no `/proc`, no `lsof`). Gap resync stays unit-tested only (`use-console-stream.test.ts`, `console-stream.runtime.test.ts`): no product path produces a gap without a test hook in product code.

## Review Focus

1. **Two tabs, one action.** Two console tabs confirm Move on for the same scene, or release the same fact: exactly one applies; the other shows "The scene changed. Review the live view and try again." or "That fact is already released."; a double click sends one command (Tasks 4, 8, 12, 15).
2. **Unconfirmed outcomes.** The live socket drops or the runtime stalls while a command waits: the answer is 504 with "Check the live view before you try again", nothing retries, and a late ack never confirms the next command (Tasks 4, 6, 11).
3. **Lobby and ended state.** A command before the start never starts the session (even with every seat ready); after the end there is no channel; Remove after the start is refused with its copy (Tasks 1, 7, 8).
4. **Facilitator-only data in player frames.** `by`, `ref`, `ack`, a whisper to another role, goals, fact text and an unfired inject's content never reach a player frame while the console works the session (Tasks 2, 8).
5. **Untrusted text in controls and dialogs.** Markup, U+202E and control characters in inject content, fact text, goals, names, whisper and closing text render as literal text in panels and confirmations, create no element, and do not reorder neighbouring text (Tasks 12, 13).

## File Structure

| File | Responsibility |
|---|---|
| `services/runtime/src/host/{protocol,ws-server,session-host}.ts`, `packages/events/src/player-view.ts` | `ref`/`ack`; no auto-start with `ref`; `FacilitatorScene` with injects |
| `apps/web/src/server/wire.ts` | Mirror: `command`, `end_now` with `ref`, `ack`, `error.ref`, `hiddenFacts`, facilitator scenes |
| `apps/web/src/server/facilitator-hub.ts` | Channel lookup, `send` with ref correlation, `characters` frame |
| `apps/web/src/server/facilitator-copies.ts` | `consoleScenes`, `consoleCharacters` |
| `apps/web/src/server/console-command.ts` (new), `app/api/v1/console/sessions/[id]/command/route.ts` (new) | Command route: parse, wire mapping, answers |
| `apps/web/src/server/console-sessions.ts`, `launcher-client.ts`, `app/api/v1/console/sessions/[id]/remove/route.ts` (new) | Remove route; `guard` and `readBody(maxBytes)` exported |
| `apps/web/src/lib/use-console-stream.ts` | Injects in scenes, `characters` |
| `apps/web/src/lib/console-commands.ts`, `console-confirm.ts` (new) | Browser command client and hook; confirmation copy |
| `apps/web/src/components/console/{ConsoleControls,SessionControls,InjectsPanel,WhisperForm,CharactersPanel}.tsx` (new), `ConfirmDialog.tsx`, `LiveView.tsx`, `SessionConsole.tsx`, `Readiness.tsx` | Controls, dialogs, Remove |
| `apps/web/e2e/console-controls.spec.ts` (new), `e2e/helpers/{start-launcher-stack,players}.ts` | Flows, channel cases, Axe |

---

## PR 1: runtime acknowledgement and injects (`feature/EPIC-0002-US-0059-command-ack`, from `develop`)

### Task 1: `ref` and `ack` on console commands; no auto-start with `ref`

**Files:** Modify `services/runtime/src/host/protocol.ts` (`command`, `end_now`, `ServerMessage`), `host/ws-server.ts` (`handle`, `fail`); Test `services/runtime/src/host/__tests__/ws-server.ack.test.ts` (new; harness as `ws-server.end-now.test.ts`, whose "during an interrupted start" case shows how to hold a start in flight).

**Interfaces:**
- Produces: `MAX_REF_CHARS = 64`; `command` and `end_now` gain `ref?: string` (`/^[A-Za-z0-9-]{1,64}$/`); `ServerMessage` gains `{ type: "ack"; ref: string }` and `error` gains `ref?: string`. `fail(code, message, ref?)`. In the `command` branch: with `ref` and `!host.hasStarted`, `fail(host.isStarting ? "starting" : "not_started", <same code>, ref)` and return; else as today. After `await host.endNow(...)` / `await host.command(...)`, `send({ type: "ack", ref })` when `ref` is set; the `catch` passes the ref of the message being handled to `fail` (a `forbidden` too).

- [ ] **Step 1: Write the failing tests:** `a command with ref is answered by an ack with that ref after its facilitator.command event`; `a refused command with ref (stale_scene, unknown_fact) gets an error carrying the ref and no ack`; `end_now with ref is acked after session.ended; before the start it is not_started with the ref`; `a command with ref in a lobby whose seats are all ready is not_started, appends nothing and the status stays idle`; `a command with ref during an interrupted start is starting`; `a command without ref still auto-starts and gets no ack (terminal unchanged)`; `a ref of 65 characters or with a space is bad_message`; `the ack goes only to the sending facilitator connection, the event to both`; `a player connection never receives an ack or a ref`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/ws-server.ack.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `ws-server.end-now.test.ts`, `ws-server.test.ts`, typecheck; run the new file in the node:22 container (root and `--user node`); expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console commands carry a ref and are acknowledged`.

### Task 2: The facilitator's scenes carry their injects

**Files:** Modify `packages/events/src/player-view.ts` (types, exported from the package index), `services/runtime/src/host/session-host.ts` (`allScenes`, `sceneList`), `host/protocol.ts` (`joined.scenes` type and doc); Test `services/runtime/src/host/__tests__/ws-server.scenes.test.ts`.

**Interfaces:**
- Produces: `type FacilitatorInject = { id: string; to: string[]; content: string; atMinute?: number }`; `type FacilitatorScene = PlayerScene & { injects: FacilitatorInject[] }`; `SessionHost.allScenes(): FacilitatorScene[]` (script order, `injects` `[]` when none, `atMinute` only when set). `scenesFor` returns plain `PlayerScene` objects (no `injects` key).

- [ ] **Step 1: Write the failing tests:** `the facilitator's joined lists each scene's injects with id, to, content and atMinute`; `a player's joined scenes have no injects key`; `before cfo_pressure fires, no frame any player receives contains its content`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, the runtime suite and typecheck (the web still compiles: `FacilitatorScene` extends `PlayerScene`); node:22 container for the file; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: the facilitator's scene list includes injects`.

### Task 3: PR 1 docs and pull request

**Files:** Modify `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md` (section "Live console runtime protocol"), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Architecture and threat model: `ref`/`ack` (sender only, never to players), a `ref`'d command never auto-starts (C2), injects in the facilitator's scenes (W1). CHANGELOG "Changed".
- [ ] **Step 2:** Assign the next free ids (expected AC-0354, TC-0095, TASK-0097) with an "Assigned 2026-11-xx (slice 2b-2b2, PR 1)" line. `AC-0354: a facilitator command or end_now that carries a ref is answered by an ack or an error with that ref to the sender only, and a command with a ref is refused before the start instead of starting the session` (checked, TC-0095 naming Task 1 and 2 files). `TASK-0097 (US-0059): Facilitator command route, controls and confirmations (slice 2b-2b2)`, In Progress, Branch `feature/EPIC-0002-US-0059-command-ack` (PR 2 `feature/EPIC-0002-US-0059-command-route`, PR 3 `feature/EPIC-0002-US-0059-console-controls`), Notes naming this plan.
- [ ] **Step 3:** `npm run plan:generate` (no parse errors); commit `[docs] US-0059: record the command acknowledgement`.
- [ ] **Step 4:** Push, open PR 1 into `develop` (body: US-0059, AC-0354, TASK-0097). Wait for the squash merge before PR 2.

---

## PR 2: command route (`feature/EPIC-0002-US-0059-command-route`, from `develop` after PR 1)

### Task 4: Wire mirror and the hub's command channel

**Files:** Modify `apps/web/src/server/wire.ts`, `facilitator-hub.ts`; Test `apps/web/src/server/__tests__/facilitator-hub.test.ts`, `wire.test.ts`, `hub.runtime.test.ts` ("wire contract: facilitator").

**Interfaces:**
- `wire.ts`: `ClientMessage` gains `{ type: "command"; command: FacilitatorCommand; expectSceneId?: string; by?: string; ref?: string }` and `{ type: "end_now"; message?: string; by?: string; ref?: string }` with `FacilitatorCommand` mirroring the runtime union; `ServerMessage` gains `{ type: "ack"; ref: string }`, `error.ref?: string`; `JoinedFrame.hiddenFacts?: Record<string, string[]>`, `scenes?: (PlayerScene & { injects?: FacilitatorInject[] })[]`. `type CommandMessage = Omit<Extract<ClientMessage, { type: "command" | "end_now" }>, "ref">`.
- `facilitator-hub.ts`: `COMMAND_TIMEOUT_MS = 10_000`; options gain `commandTimeoutMs?: number; newRef?: () => string`; `type CommandOutcome = { kind: "ok" } | { kind: "refused"; code: string } | { kind: "unconfirmed" } | { kind: "no_channel" } | { kind: "pending" }`; `FacilitatorHub.send(a: { sessionId: string; channel: string; message: CommandMessage }): Promise<CommandOutcome>`. Streams are kept in a `Map<channel, Stream>` holding `sessionId`; a channel of another session is `no_channel`; `finish` resolves a pending command `unconfirmed`; `conn.send` throwing is `unconfirmed`. Correlation per Global Constraints.

- [ ] **Step 1: Write the failing tests** (hub, `FakeConn`, `manualTimers`): `send writes the message with a fresh ref and resolves ok on its ack`; `an error with the ref resolves refused with its code and nothing reaches the page`; `a ref-less rate_limited, bad_json or bad_message while pending answers it; a ref-less log_failed is forwarded and answers nothing`; `an ack or error with another ref is dropped, not forwarded`; `a second send while one is pending is pending and writes nothing to the socket`; `an unknown channel, another session's channel and a finished stream are no_channel`; `the timeout resolves unconfirmed and a later ack is dropped`; `a runtime close or a stalled page resolves the pending command unconfirmed`. hub.runtime "wire contract: facilitator": a ref'd `pause` yields an `ack` frame with exactly `type, ref`; a ref'd stale `advance` an `error` with exactly `type, code, message, ref`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/facilitator-hub.test.ts src/server/__tests__/hub.runtime.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, the web suite and typecheck; `hub.runtime.test.ts` in the node:22 container; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: the facilitator hub sends commands and correlates acks`.

### Task 5: Injects and AI characters for the console

**Files:** Modify `apps/web/src/server/facilitator-copies.ts`, `facilitator-hub.ts` (`open`, `forward`); Test `facilitator-copies.test.ts`, `facilitator-hub.test.ts`.

**Interfaces:**
- `type ConsoleCharacter = { roleId: string; goals: string[]; facts: { n: number; text: string; released: boolean }[] }`.
- `consoleScenes(scenes: unknown): ConsoleScene[]` where `ConsoleScene = PlayerScene & { injects: FacilitatorInject[] }`: picks `id, title, goal, timeBoxMinutes` and each inject's `id, to` (strings only), `content`, `atMinute` (finite number only); malformed entries dropped. Replaces the inline pick at `facilitator-hub.ts:57`.
- `consoleCharacters(hiddenFacts: Record<string, string[]> | undefined, npcs: Record<string, { goals: string[]; released: string[] }>): ConsoleCharacter[]`: one entry per own key of `npcs` (order of `npcs`), `goals` strings only, `facts` numbered from 1 over `hiddenFacts[roleId]` with `released` by exact text; never `knowledge`.
- Hub writes `characters { roles }` after `joined` (and after `reset` when sent) from `frame.hiddenFacts` and `frame.state.npcs`, and again after forwarding each `npc.updated` (that role's entry replaced from the event's `goals` and `released`; the event itself stays text-free). No id on `characters`.

- [ ] **Step 1: Write the failing tests:** copies: `consoleScenes keeps scene and inject fields and nothing else`; `consoleCharacters numbers facts, marks released by text, never carries knowledge, treats a "__proto__" role as an ordinary entry and drops non-string goals`. hub: `writes characters after joined from the joined state and hidden facts`; `after an npc.updated it writes characters with that role updated while the event keeps empty goals and released`; `a skipped replayed npc.updated after a reset writes no characters frame`.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, the web suite and typecheck; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: the console stream names injects and AI characters`.

### Task 6: The command route

**Files:** Create `apps/web/src/server/console-command.ts`, `apps/web/src/app/api/v1/console/sessions/[id]/command/route.ts`; Modify `console-sessions.ts` (export `guard`; `readBody(req, allowed, maxBytes = MAX_BODY_BYTES)`), `routes.ts`; Test `apps/web/src/server/__tests__/console-command.test.ts` (new), `routes.test.ts`.

**Interfaces:**
- `COMMAND_KINDS = ["pause", "resume", "advance", "fire_inject", "whisper", "release_hidden", "set_npc_stance", "end_now"] as const`; `type ConsoleCommand` (union per Global Constraints); `parseConsoleCommand(body: Record<string, unknown>): { channel: string; command: ConsoleCommand } | null`; `toWire(c: ConsoleCommand, by: string): CommandMessage`; `COMMAND_ANSWERS` (the table); `handleConsoleCommand(req: Request, deps: Deps): Promise<Response>`; route file re-exports `consoleCommandPOST` with `runtime = "nodejs"`, `dynamic = "force-dynamic"`.

- [ ] **Step 1: Write the failing tests** (spy hub):
  - `a foreign or missing Origin, a missing X-Requested-With and Sec-Fetch-Site cross-site are 403 and the hub is not called`; `a player cookie is 401; a disabled console is 503`.
  - `each kind maps to its runtime message with by from the cookie`; `a body carrying by is 400`.
  - `unknown keys, an unknown kind, fact 0, 51 or 1.5, whisper text empty, blank or 2001 units, 11 goals or a 501-unit goal, a closing message of 301 code points, a non-UUID channel, text/plain and a 16 KiB + 1 body are 400`.
  - one case per row of the answers table (exact status, code and message), including `stale_scene is 409 with "The scene changed. Review the live view and try again."`.
  - `a refusal is answered with fixed copy only: the runtime's message text never appears in the body`; `responses carry noindex and no-store`. routes: `consoleCommandPOST` exists.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, the web suite and typecheck; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console command route over the tab's socket`.

### Task 7: The remove route

**Files:** Modify `apps/web/src/server/launcher-client.ts` (`reissue`), `console-sessions.ts`, `routes.ts`; Create `apps/web/src/app/api/v1/console/sessions/[id]/remove/route.ts`; Test `launcher-client.test.ts`, `console-sessions.test.ts`, `routes.test.ts`.

**Interfaces:** `LauncherClient.reissue(id: string, roleId: string, by: string, reason?: "removed"): Promise<string>` (`reason` in the body only when given); `handleConsoleRemove(req: Request, deps: Deps): Promise<Response>` as in Global Constraints; `consoleRemovePOST`.

- [ ] **Step 1: Write the failing tests:** launcher-client `reissue with reason removed sends roleId, by and reason; without it the body has no reason key`; console-sessions `remove sends the cookie's name and reason removed and returns the new code once`; `a launcher conflict is 409 "A participant can only be removed before the start."`; `remove checks Origin, the custom header and the cookie like reissue`; `a body with by or reason is 400`.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run and the web suite; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: remove a participant from the console before the start`.

### Task 8: Real-runtime contract for commands

**Files:** Create `apps/web/src/server/__tests__/console-command.runtime.test.ts` (harness of `console-stream.runtime.test.ts`: in-process runtime by computed path, `TRUST_PROXY=1`, `FACILITATOR_TOKEN`, mock models, private `mkdtemp`, `vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })`, stub launcher); Modify `console-stream.runtime.test.ts` ("no hidden-fact text reaches the console stream" becomes `hidden-fact text reaches the console stream only in characters frames`).

- [ ] **Step 1: Write the tests:** `every kind posted to the route with the stream's channel is applied once and logged with by from the cookie` (pause, resume, whisper, fire_inject, release_hidden, set_npc_stance, advance, then end_now with a message; the console stream shows each event; the route answers 200); `a stale expectSceneId is 409 stale_scene and appends nothing`; `two tabs releasing the same fact: one 200, one 409 already_released`; `a command before the start with every seat ready is 409 not_started and the session stays idle`; `end_now ends the session: the console stream forwards session.ended then ended; a later command is no_channel; a connected player's stream carries the closing message and no by`; `with a console stream and three player streams open, no player frame carries the facilitator's name, a ref, an ack, a whisper to another role, a goal or fact text`; `the route opens no runtime socket (budget live in use 1, short 0, while commands run)`. (Remove goes through the control service, which this harness stubs: it is covered by Task 7 and the e2e of Task 15, on top of 2b-2a's `reissue.remove.test.ts`.)
- [ ] **Step 2:** Run the file; these are contract tests over Tasks 1 to 7 and may pass at once; break one thing on purpose (e.g. drop the ref check in the hub) and see the matching test fail. A real failure is fixed in code, never in the assertion.
- [ ] **Step 3:** Run it in the node:22 container (root and `--user node`); expect PASS.
- [ ] **Step 4:** Commit `[test] US-0059: console commands against the real runtime`.

### Task 9: PR 2 docs and pull request

**Files:** Modify `docs/THREAT_MODEL.md` ("Live console channel" section gains "Commands"), `docs/ARCHITECTURE.md`, `README.md` (console API list item 5 and a new item), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Threat model: `by` from the cookie only (a label, not proof); CSRF checks; fixed copy; commands over the tab's socket (no new socket, budget unchanged); W2 widening (goals and fact text on the facilitator's screen, shoulder-surfing like codes; knowledge never); Remove's route. Architecture: route, correlation, `characters`. README: the two routes and the corrected "never carries" sentence. CHANGELOG "Added".
- [ ] **Step 2:** Assign the next free ids (expected AC-0355, AC-0356, TC-0096, TC-0097). `AC-0355: POST /api/v1/console/sessions/:id/command sends pause, resume, advance, inject, whisper, release fact, NPC stance and end_now over the console tab's own facilitator socket, with by taken only from the console cookie, Origin and X-Requested-With checked, a strict JSON body and fixed refusal copy; a command never starts the session` (checked, TC-0096). `AC-0356: the console stream names each scene's injects and, in its characters frame only, each AI character's goals and hidden facts with their release state; no player frame carries them` (checked, TC-0097). AC-0314 note: "the BFF route POST /api/v1/console/sessions/:id/remove is built in 2b-2b2 PR 2; the button follows in PR 3".
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage`; commit `[docs] US-0059: document the console command route`.
- [ ] **Step 4:** Push, open PR 2 into `develop` (body: US-0059, AC-0355, AC-0356, TASK-0097). Wait for the squash merge before PR 3.

---

## PR 3: controls and confirmations (`feature/EPIC-0002-US-0059-console-controls`, from `develop` after PR 2)

### Task 10: The stream hook carries injects and characters

**Files:** Modify `apps/web/src/lib/use-console-stream.ts`; Test `apps/web/src/lib/__tests__/use-console-stream.test.ts`.

**Interfaces:** client mirrors (no server import): `ConsoleInject = { id: string; to: string[]; content: string; atMinute?: number }`, `ConsoleScene = PlayerScene & { injects: ConsoleInject[] }`, `ConsoleCharacter` (Task 5 shape). `ConsoleStreamUi.scenes: ConsoleScene[]`, `ConsoleStreamUi.characters: ConsoleCharacter[]` (`[]` initially; replaced whole on each `characters` frame; kept across `joined`, cleared by `clear`). A scene without valid `injects` gets `[]`.

- [ ] **Step 1: Write the failing tests:** `joined scenes keep their injects; a malformed inject is dropped`; `a characters frame replaces the list; a malformed entry is ignored, the rest kept`; `a reconnect's joined keeps characters until the next characters frame`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run and the web suite (LiveView compiles: `ConsoleScene` extends `PlayerScene`); expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: the console hook keeps injects and AI characters`.

### Task 11: Command client, confirmation copy and the dialog body

**Files:** Create `apps/web/src/lib/console-commands.ts`, `apps/web/src/lib/console-confirm.ts`; Modify `apps/web/src/components/console/ConfirmDialog.tsx`; Test `apps/web/src/lib/__tests__/console-commands.test.ts`, `console-confirm.test.ts` (new), `apps/web/src/components/__tests__/ConfirmDialog.test.tsx`.

**Interfaces:**
- `console-commands.ts`: `COMMAND_KINDS` and `ConsoleCommand` (mirror of Task 6; a test in `console-command.test.ts` asserts the two `COMMAND_KINDS` are equal); `commandUrl(sessionId: string): string`; `sendCommand(sessionId: string, channel: string, c: ConsoleCommand, fetchImpl?: typeof fetch): Promise<ApiResult>` (`postJson`); `useConsoleCommands(sessionId: string, channel: string | null, fetchImpl?: typeof fetch): { pending: boolean; status: string | null; error: string | null; run(c: ConsoleCommand): Promise<boolean> }` (one at a time; `run` while pending or without a channel returns false and sends nothing; success sets `status` to the announcement for the kind; failure sets `error`: status 0 `CONSOLE_COPY.unreachable`, 401 `CONSOLE_COPY.signedOut`, else the BFF's `message`; never retries).
- `console-confirm.ts`: `type ConfirmSubject = { kind: "advance"; scene: string } | { kind: "end_now" } | { kind: "fire_inject"; injectId: string; audience: string[]; again: boolean } | { kind: "whisper"; recipient: string } | { kind: "release_hidden"; fact: number; character: string } | { kind: "remove"; name?: string; role: string }`; `confirmCopy(s: ConfirmSubject): { title: string; description: string; confirmLabel: string }` (exact copy of Global Constraints); `audienceText(labels: string[]): string`; `who(roleId: string, o: { names: Record<string, string>; ai: boolean }): string`.
- `ConfirmDialogProps` gain `children?: ReactNode` (between description and actions; focus trap includes its fields) and `tone?: "danger" | "primary"` (default `danger`, the current look).

- [ ] **Step 1: Write the failing tests:** confirm: one case per subject with the exact strings; `audienceText of one, two and three labels`; `a name with U+202E is isolated in the title`. commands: `sendCommand posts the channel and the command with X-Requested-With`; `run is one at a time: a second run while pending sends nothing`; `a 409 stale_scene shows the BFF's message; status 0 shows the unreachable copy; 401 the signed-out copy`; `a 504 is shown and nothing is sent again`. ConfirmDialog: `children are rendered and Tab cycles through a textarea in them`; `tone primary changes only the confirm button class`.
- [ ] **Step 2:** Run the three files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run; expect PASS (existing ConfirmDialog tests unchanged).
- [ ] **Step 5:** Commit `[feat] US-0059: command client and confirmation copy`.

### Task 12: Session controls: pause, resume, move on, end now

**Files:** Create `apps/web/src/components/console/SessionControls.tsx`, `ConsoleControls.tsx`; Modify `apps/web/src/lib/app.css` (classes only); Test `apps/web/src/components/__tests__/SessionControls.test.tsx` (new).

**Interfaces:**
- `ConsoleControls({ sessionId, ui, fetch }: { sessionId: string; ui: ConsoleStreamUi; fetch?: typeof fetch })`: section `aria-labelledby` h2 "Facilitator controls"; owns `useConsoleCommands(sessionId, ui.channel, fetch)`, one open confirmation at a time, the status (`role="status"`) and error (`role="alert"`) lines; renders `SessionControls`, then (Task 13) `InjectsPanel`, `WhisperForm`, `CharactersPanel`. Disabled per Global Constraints.
- `SessionControls({ state, scenes, disabled, onCommand, onConfirm })`: Pause (when not paused) or Resume (when paused), no dialog; "Move on" (enabled with a current scene and not `advanceRequested`; else "Moving on…" disabled) opens the advance confirmation with the scene title captured then; "End session" opens the end_now confirmation with the closing message `textarea` (`maxLength` 300, label and hint of Global Constraints, `tone` danger).

- [ ] **Step 1: Write the failing tests:** `Pause sends pause without a dialog and announces Paused.`; `when paused only Resume is shown`; `Move on opens the dialog with the scene title and sends advance with the scene id captured when it opened, even if the scene changed before confirming`; `a stale answer shows "The scene changed. Review the live view and try again." in an alert`; `End session sends end_now with the trimmed message, or none when empty`; `a double click on Pause sends one command`; `controls are disabled while reconnecting, while pending and once ended`; `Escape closes the dialog and focus returns to its opener`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `src/__tests__/source-rules.test.ts`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: pause, resume, move on and end now in the console`.

### Task 13: Interventions: injects, whisper, AI characters

**Files:** Create `apps/web/src/components/console/InjectsPanel.tsx`, `WhisperForm.tsx`, `CharactersPanel.tsx`; Modify `ConsoleControls.tsx`, `app.css`; Test `apps/web/src/components/__tests__/Interventions.test.tsx` (new).

**Interfaces:**
- `InjectsPanel({ scene, fired, label, disabled, onConfirm })`: h3 "Injects"; each inject of the current scene with its content (text), audience (`audienceText`), "fires at minute <n>" when `atMinute` is set, "Fired" when in `state.injectsFired`; button "Fire" / "Fire again" opens the fire_inject confirmation (content in the dialog body). No current scene: "No scene is running."
- `WhisperForm({ recipients, label, disabled, onConfirm })`: h3 "Whisper"; `select` labelled "To" (players of the current scene, else every player role, each `who(...)`), `textarea` labelled "Message" (`maxLength` 2000); "Send whisper" opens the whisper confirmation (text in the body).
- `CharactersPanel({ characters, factsEarned, label, disabled, onConfirm, onStance })`: h3 "AI characters"; per character an h4 with its label, "Goals" list, a stance form (`textarea` labelled "Goals, one per line", pre-filled, submit "Set stance", no dialog; 1..10 non-empty lines of at most 500 characters, else an inline error), and `<details>` "Hidden facts (<count>)" listing "Fact <n>: <text>" with "Released", "Suggested by the Game Master" (in `factsEarned[roleId]`, not released) or a "Release" button (opens release_hidden). The Game Master suggestion needs no role or number to be typed (one click to the confirmation).

- [ ] **Step 1: Write the failing tests:** `firing an inject names its audience and content in the dialog and sends fire_inject with the scene id`; `whisper recipients are the current scene's players; the dialog names the recipient and shows the text; sends whisper`; `a suggested fact shows "Suggested by the Game Master" and its Release opens "Release fact 1 of Client sponsor?"`; `a released fact has no Release button`; `the facts list is closed by default`; `stance sends set_npc_stance with the edited lines; 11 lines show an inline error and send nothing`; `markup, U+202E and a tab in inject content, fact text, a goal, a name and whisper text render as literal text with no img, b or script element, names in bdi`.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run with `source-rules.test.ts`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: injects, whisper and AI character controls`.

### Task 14: Remove in the lobby and the controls on `/console/[id]`

**Files:** Modify `apps/web/src/components/console/Readiness.tsx`, `LiveView.tsx`, `SessionConsole.tsx`; Test `apps/web/src/components/__tests__/Readiness.test.tsx`, `LiveView.test.tsx`, `SessionConsole.test.tsx`.

**Interfaces:**
- `Readiness`: `Confirm` gains `{ kind: "remove"; roleId: string; opener: HTMLElement }`; while `status === "idle"` each joined row has "Remove" (`aria-label` "Remove <name> from <role>"), confirmed with `confirmCopy({ kind: "remove", ... })`, posting `remove { roleId }` and showing the new code once through `CodesPanel` ("New code for <role>").
- `LiveViewProps` gain `controls?: ReactNode`, rendered after the "Live session" card. `SessionConsole` passes `<ConsoleControls sessionId ui fetch />` in live mode while `ui.final` is null.

- [ ] **Step 1: Write the failing tests:** Readiness `Remove is offered only for joined seats before the start; its dialog names the person and the role; the new code is shown once`; `a 409 shows "A participant can only be removed before the start."`. LiveView `controls render after the status card`. SessionConsole `live mode shows Facilitator controls; an ended final hides them and keeps the view`.
- [ ] **Step 2:** Run the files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run and the web suite; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: console controls and Remove on the session page`.

### Task 15: End-to-end and accessibility

**Files:** Create `apps/web/e2e/console-controls.spec.ts` (helpers of `console-live.spec.ts`: `startedSession`-style setup with `startLauncherStack`, `facilitator`, `createSession`, `seatLauncher`, `say`, `checkBothSchemes`, `noHorizontalScroll`, `FAC_NAME`); Modify `apps/web/e2e/helpers/start-launcher-stack.ts` (`crashRuntimes(): Promise<void>`: SIGKILL every process in the control service's process group whose `args` contain the runtime entry path, found with `ps -A -o pid=,pgid=,args=`; resolves when `GET /sessions` reports `stopped`), `e2e/helpers/players.ts` (`trackStreams(page, path = "/api/v1/stream")`).

- [ ] **Step 1: Write the specs:**
  - `pause, whisper and resume: the player sees the pause and the whisper, another player does not see the whisper, the console timeline says "Paused by Ann Facilitator" and no player page contains the facilitator's name`.
  - `fire the scene's inject again: the dialog names the three players; each sees it twice`.
  - `move on in one tab while a second tab's Move on dialog is open: the second gets "The scene changed. Review the live view and try again."; the console shows "Call with Priya"`.
  - `release a hidden fact and change a stance: the dialog reads "Release fact 1 of Client sponsor?"; the timeline shows the release and the stance change by Ann Facilitator; no player page contains the fact text`.
  - `end now with a closing message: players see the message, the console keeps its view and shows "The session has ended.", and a reload shows the lobby's ended status with no controls`.
  - `remove a participant before the start: the dialog names the person and the role, the player sees "Removed from the session", a new code is shown once and the old code is refused`.
  - `channel cases: a fifth console tab shows the busy message; with the console offline a player's line is said, and back online the console stream reopens with a Last-Event-ID and shows the line once; after crashRuntimes the console shows "The session stopped. Restart it from this page.", Restart brings the live view back, paused, with the earlier line`.
  - `no serious or critical Axe violations with the controls, the expanded facts list and each confirmation dialog open, at 1280 px and 400 px, light and dark, with no horizontal scroll at either width`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web e2e console-controls.spec.ts` locally (chromium per Global Constraints), then the whole `pnpm --filter @acr/web e2e`; expect PASS; the CI Web E2E job must pass too.
- [ ] **Step 3:** Commit `[test] US-0059: console controls flow, channel cases and Axe`.

### Task 16: PR 3 docs, pull request and close-out

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md`, `README.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`, `docs/memory/architecture-and-security.md`.

- [ ] **Step 1:** Assign the next free ids (expected AC-0357, TC-0098, TC-0099). `AC-0357: when the scene changed between opening a confirmation and confirming it, the console shows "The scene changed. Review the live view and try again." and nothing is applied` (checked, TC-0098). Check AC-0311 (controls part: TC-0098), AC-0312 (TC-0096, TC-0098), AC-0315 (TC-0098) and AC-0316 (Axe on the controls and dialogs at 400 px and 1280 px, light and dark: TC-0099, `console-controls.spec.ts`). AC-0314 note: the console button is built (TC-0098). TASK-0097 Done with the three PRs. US-0059 Done when every AC is checked.
- [ ] **Step 2:** Threat model: confirmations, text-only rendering in dialogs, the closed facts list. Architecture: the controls. README: the console runs a whole session. CHANGELOG "Added": the controls and confirmations.
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage` twice (once under load); record coverage and the Axe result in `progress.md`; update `MEMORY.md` and `docs/memory/architecture-and-security.md` (ref/ack, no auto-start with ref, `characters`, command answers, Remove route). Commit `[docs] US-0059: document the console controls and close 2b-2b2`.
- [ ] **Step 4:** Push, open PR 3 into `develop` (body: US-0059, AC-0311, AC-0312, AC-0314, AC-0315, AC-0316, AC-0357, TASK-0097). After the merge the 2b-3a plan is written next.

## Open questions for the owner

1. **W2:** the console shows AI characters' current goals and hidden-fact text (facts list closed by default; knowledge never). The terminal facilitator already sees them; the new exposure is a projected or shared screen. The plan proceeds with W2; the alternative (fact numbers only, stance without current goals) makes Release and Stance blind choices.
