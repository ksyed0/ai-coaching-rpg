# EPIC-0002 Slice 2b-2a: Runtime Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The runtime gives players allowlisted copies, records the facilitator's name (`by`) on commands, folds words spoken per role, lets a facilitator end a session now, and lets the control service remove a participant before the start, so the live console (2b-2b) has a complete, leak-safe protocol to drive.

**Architecture:** Player copies move into one allowlist module (`host/player-copies.ts`) used by `snapshotFor` and `viewFor`; a new state field reaches players only if that table says so. `by` is an optional, cleaned field on `facilitator.command`. Talk time is a `talk` field folded from `utterance` in `@acr/events` (`reduce` and `reduceReplay`), facilitator snapshot only. `end_now` is a new facilitator client message handled outside the `command` branch, appended as three events in one engine mutex run, with a restore repair. Remove is the existing parent-only `reissue` IPC with `reason: "removed"` and close code 4003.

**Tech Stack:** TypeScript, Node 22, zod 4.6.6, ws, vitest 5.0.3, Next.js 16.4.1 and React 19.3.0 (two small player-page changes). **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-10-31-slice-2b-remaining-design.md` section 3 and the stack table (binding; it wins over the parent), and `docs/superpowers/specs/2026-10-30-web-client-slice-2b-design.md` sections 7.2, 7.4, 9, 11. Stories: US-0059 (AC-0311 talk-time projection, AC-0312 `by`, AC-0313 `end_now`, AC-0314 remove; runtime parts only). Security posture: `docs/THREAT_MODEL.md`.

## Global Constraints

- `by`: optional on `facilitator.command`, raw at most 200 UTF-16 units on the wire, stored cleaned (tabs and line breaks flattened, hidden, bidi and control characters stripped, trimmed) and cut to at most 60 code points; empty after cleaning means absent. Terminal facilitators send none. A label, not proof of identity. Never in any player frame or player snapshot.
- Talk time: words and lines per role, folded from `utterance` only; a word is a whitespace-separated run of non-empty characters (`/\s+/u`); the console label is "Words spoken", never "time". Facilitator snapshot only.
- `end_now { message? }`: refused before the start (`not_started`), while `host.isStarting` or `engine.startIncomplete` (`starting`), and after the end (`ended`). Never triggers the auto-start. Event order inside one engine mutex run: `scene.exited { reason: "facilitator_end" }`, the facilitator-only `facilitator.alert` naming `by`, then `session.ended { reason: "facilitator_end", message? }` last. `message`: cleaned, at most 300 code points (longer is `bad_message`), whitespace-only means absent, rendered as text.
- `ExitReason` gains `facilitator_end` (a type only; `reduce` and the restore fold ignore exit reasons).
- Restore: a last `scene.exited` with reason `facilitator_end` and no `session.ended` after it is repaired with `end_session { reason: "facilitator_end" }`; the message is lost and the repair alert says so.
- Remove: the existing `reissueRole` with `reason: "removed"`, before the start only, close code **4003** (`CLOSE_REMOVED`, close reason `"removed"`), shown to the player as "The facilitator removed you from this session." Mid-session removal is out of scope.
- Players see today's snapshot and today's frames unchanged except: `session.ended` may carry `message`; a player removed sees the removal message.
- Commit format `[TYPE] US-0059: description` (max 72 chars), body optional, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Squash merges into `develop`. Before every commit: `pnpm -r --if-present typecheck` and the touched packages' vitest (`pnpm --filter <pkg> exec vitest run`); root Jest (`pnpm plan:test`) only when `tools/` or `tests/unit` change.
- Runtime and control-service changes are test first; every new socket, process or restore test also passes the node:22 container recipe (`AGENTS.md` section 8, as root and `--user node`). No elapsed-time assertions, injected clocks only, `vi.waitFor` on effects.
- BUG-0016 (a restart whose repair ends the session never tells the control service and never revokes credentials) is filed and fixed by Task 4b before `end_now` relies on it.
- Each PR adds its user-visible changes under `[Unreleased]` in `CHANGELOG.md`.

## Review Focus

1. A role id such as `__proto__` or `constructor` in an `utterance` must not pollute or crash the `talk` fold, live or on restore (Task 4).
2. A restart whose restore repair ends the session (the cut between the `end_now` appends) must still tell the control service `ended` and revoke every credential; today `markResumed` runs inside `openSession` before `main.ts` subscribes and before `SessionHost` exists, so neither happens (Task 4b, BUG-0016).
3. Two `end_now` clicks, or `end_now` racing a Game Master tick or an NPC reply, give exactly one `session.ended`, last, and nothing after it (Tasks 5, 6).
4. A closing message with markup, bidi or control characters, or only whitespace, reaches players cleaned and as text, or not at all (Task 6).
5. A remove that arrives while the start is in flight, or after it, changes nothing: the old code, credential, consent and socket stay as they were (Task 8).

## File Structure

| File | Responsibility |
|---|---|
| `services/runtime/src/host/player-copies.ts` (new) | Every allowlist of what a player may see: snapshot fields, `session.started`, `facilitator.command`, `session.ended` |
| `packages/events/src/{events,state,player-view}.ts` | `by`, `facilitator_end`, `message`, `talk`, `PlayerSnapshot`, `PlayerView.ended.message` |
| `services/runtime/src/engine/session-engine.ts` | `command` with `by`, `endNow`, the restore repair |
| `services/runtime/src/host/{session-host,ws-server,protocol,display-name,reissue,parent-channel}.ts`, `services/runtime/src/main.ts` | Wiring, cleaning, the `end_now` message, close code 4003, the IPC `reason` |
| `services/control/src/{protocol,supervisor,api}.ts` | `reason: "removed"` through the reissue route |
| `apps/web/src/server/{wire,runtime-connection,stream-hub,handlers}.ts`, `apps/web/src/lib/{use-session,messages}.ts`, `apps/web/src/components/SessionScreen.tsx` | `PlayerSnapshot` type, the 4003 ending, the closing message on the ended screen |

---

## PR 1: allowlisted player copies (`feature/EPIC-0002-US-0059-player-copies`, from `develop`)

This PR lands and merges first. It changes no frame a 2a player receives.

### Task 1: Allowlisted player copies

**Files:** Create `services/runtime/src/host/player-copies.ts`; Modify `services/runtime/src/host/session-host.ts` (move `STARTED_FOR_PLAYERS`, `startedForPlayer` (lines 32-45) and `redactRoles` (554-556) out; `snapshotFor` 462-469 and `viewFor` 540-541 and 529 use the new module); Test `services/runtime/src/host/__tests__/player-copies.test.ts`.

**Interfaces:**
- Produces, in `player-copies.ts`:
  - `type PlayerField<K extends keyof SessionState> = ((s: SessionState, who: string) => SessionState[K]) | "omit"`; `export const PLAYER_SNAPSHOT: { [K in keyof SessionState]: PlayerField<K> }` (every key listed, so a new `SessionState` field is a compile error until decided; in this task no entry is `"omit"`).
  - `snapshotForPlayer(s: SessionState, who: string): SessionState` (built only from `PLAYER_SNAPSHOT`, never by spread).
  - `startedForPlayer(e, who)`, `redactRoles(roles)` (moved, unchanged).
  - `commandForPlayer(e: CommandEvent, who: string): CommandEvent | null`: `pause`/`resume` copy exactly `type, seq, ts, sessionId, command`; a `whisper` to `who` copies those plus `roleId, text`; everything else null.
  - `endedForPlayer(e: EndedEvent): EndedEvent` with `ENDED_FOR_PLAYERS: Record<keyof EndedEvent, true>` (`type, seq, ts, sessionId, reason` now; Task 6 adds `message`).
  - `SessionHost.snapshotFor` and `viewFor` keep their signatures; the facilitator still gets `engine.state` and every event whole.

- [ ] **Step 1: Write the failing tests** (`player-copies.test.ts`, minimal fixture `packages/script/src/__tests__/fixtures/minimal`, `MemoryEventLog`, `FakeClock`, as in `session-host.test.ts`):
  - `pins today's player snapshot (2a sees no change)`: join `host` as `p1`, start, `onPlayerUtterance("host", "Hi Sam")`, `idle()`, `command({ command: "pause" })`; `expect(Object.keys(host.snapshotFor("host")).sort()).toEqual(["advanceRequested","currentScene","factsEarned","gmVerdicts","injectsFired","lastSeq","npcs","paused","pausedSince","roles","sceneHistory","scenarioId","status","transcript","version"])` and `toEqual` an inline literal of the whole snapshot (values as produced by today's code, captured once by running the test against the current `snapshotFor` before the refactor; record the literal in the test, never regenerate it).
  - `a pause or resume reaches a player with exactly type, seq, ts, sessionId and command`: feed `viewFor("host", { ...realPauseEvent, by: "LEAK-BY", note: "LEAK-N" } as SessionEvent)`; `expect(Object.keys(v!).sort()).toEqual(["command","seq","sessionId","ts","type"])`; `JSON.stringify(v)` has no `LEAK`.
  - `a whisper reaches only its role, with roleId and text and nothing else` (same extra-key injection; other role gets null).
  - `session.ended reaches a player as type, seq, ts, sessionId and reason only` (extra keys injected are dropped).
  - `the facilitator still receives every event and the state unchanged` (`viewFor("facilitator", e) === e`, `snapshotFor("facilitator") === engine.state`).
  - `replayFor uses the same copies` (a replay containing an injected pause carries no extra key).
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/player-copies.test.ts`; expect FAIL (module missing). Capture the pinned literal from the current code first (step 1's note).
- [ ] **Step 3:** Implement `player-copies.ts` to the interfaces and switch `session-host.ts` to it.
- [ ] **Step 4:** Run the file again and the whole runtime suite (`pnpm --filter @acr/runtime exec vitest run`) plus `pnpm --filter @acr/web exec vitest run src/server/__tests__/hub.runtime.test.ts`; expect PASS with no other test changed.
- [ ] **Step 5:** Typecheck and commit `[refactor] US-0059: allowlisted player copies of snapshot and events`.

### Task 2: PR 1 docs and pull request

**Files:** Modify `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/THREAT_MODEL.md`, `CHANGELOG.md`.

- [ ] **Step 1:** Reserve in `docs/ID_REGISTRY.md` first: AC-0351, TC-0087, TASK-0095 (next becomes AC-0352, TC-0088, TASK-0096; the registry test requires next = highest in use + 1, so each later PR assigns its own TC ids (the plan calls them TC-0088 to TC-0091) and BUG-0016 when it files them; add an "Assigned 2026-11-01 (slice 2b-2a)" line naming each use). In `docs/RELEASE_PLAN.md` under US-0059 add `AC-0351: players receive allowlisted copies: the join snapshot and every command and session.ended event are built from explicit field lists, so a facilitator-only field (by, talk time) never reaches a player and a 2a player sees no change` and `TASK-0095 (US-0059): Runtime protocol for the live console (slice 2b-2a)`, Status In Progress, Branch `feature/EPIC-0002-US-0059-player-copies` (PR 1; PR 2 and PR 3 use `feature/EPIC-0002-US-0059-runtime-protocol` and `feature/EPIC-0002-US-0059-remove-participant`), Notes naming this plan. Add TC-0087 for AC-0351 in `docs/TEST_CASES.md` (format per `plan_visualizer.md`).
- [ ] **Step 2:** `docs/THREAT_MODEL.md`, section "The web client", bullet "Player streams carry nothing a player may not see": add that the runtime builds player copies from allowlists (`host/player-copies.ts`), so a new field is denied until listed. `CHANGELOG.md` `[Unreleased]` "Changed": the allowlisted copies, no visible change for players.
- [ ] **Step 3:** `npm run plan:generate`; expect no parse errors. Commit `[docs] US-0059: file slice 2b-2a ids and the player-copy criterion`.
- [ ] **Step 4:** Push the branch, open PR 1 into `develop` (title as the Task 1 commit, body references US-0059, AC-0351, TASK-0095). Wait for review and the squash merge before PR 2.

---

## PR 2: `by`, talk time and `end_now` (`feature/EPIC-0002-US-0059-runtime-protocol`, from `develop` after PR 1)

### Task 3: Optional `by` on `facilitator.command`

**Files:** Modify `packages/events/src/events.ts:56`, `services/runtime/src/host/display-name.ts`, `host/reissue.ts:24-28`, `host/protocol.ts:38`, `host/session-host.ts:406`, `engine/session-engine.ts:262-291`, `host/ws-server.ts:422`; Test `host/__tests__/display-name.test.ts`, `engine/__tests__/session-engine.test.ts`, `host/__tests__/ws-server.test.ts`, `apps/web/src/server/__tests__/hub.runtime.test.ts`.

**Interfaces:**
- Produces: `EventBody` member `({ type: "facilitator.command"; by?: string } & FacilitatorCommand)`. `cleanFacilitatorLabel(raw: string | undefined): string | undefined` in `display-name.ts` (flatten `[\r\n\t]+` to a space, cut to `MAX_DISPLAY_NAME_CHARS` code points, `normalizeDisplayName`; undefined when absent, empty or refused). `actorLabel(by?: string): string` = `cleanFacilitatorLabel(by) ?? "the facilitator"`; `reissueActor` becomes an alias of it (behaviour unchanged). `MAX_BY_RAW_CHARS = 200` in `protocol.ts`; the `command` client message gains `by: z.string().max(MAX_BY_RAW_CHARS).optional()`. `SessionEngine.command(cmd, opts: { expectSceneId?: string; by?: string })` appends `by` only when given. `SessionHost.command(cmd, opts: { expectSceneId?: string; by?: string })` cleans with `cleanFacilitatorLabel` before calling the engine.

- [ ] **Step 1: Write the failing tests:**
  - display-name: `cleanFacilitatorLabel cuts at 60 code points, flattens line breaks, strips bidi and zero-width characters, and returns undefined for "", "   " and undefined`.
  - engine: `a command with by records it; without by the event has no by key`; `restore folds a log whose commands carry by (state equals the live state)`.
  - ws-server: `a facilitator command with by "Sam‮" is logged with by "Sam"; players' pause frame has no by key and no "Sam"; the facilitator's has it`; `a by nested inside command ({command:"pause", by:"x"}) is stripped by the schema, not recorded`; `a by of 201 characters is bad_message and nothing is appended`; `a lobby command with by still auto-starts exactly as before` (existing behaviour kept).
  - hub.runtime: the facilitator's pause sends `by: "LEAK-BY-7f3a"`; add `"LEAK-BY-7f3a"` to `FACILITATOR_ONLY` (present in `facText`, absent from every player stream).
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/display-name.test.ts src/engine/__tests__/session-engine.test.ts src/host/__tests__/ws-server.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run step 2 and `pnpm --filter @acr/web exec vitest run src/server/__tests__/hub.runtime.test.ts`; expect PASS, including the existing `reissueActor cleans and bounds the name` test.
- [ ] **Step 5:** Commit `[feat] US-0059: record the facilitator name as by on commands`.

### Task 4: Talk time in the shared reducer

**Files:** Modify `packages/events/src/state.ts` (type 6-27, `initialState` 29-35, `reduce` utterance 49-50, `reduceReplay` 93-99), `packages/events/src/player-view.ts:23`, `services/runtime/src/host/player-copies.ts`, `host/session-host.ts` (`snapshotFor` overloads), `host/protocol.ts:51` (`joined.state`), `apps/web/src/server/wire.ts:30`, `apps/web/src/lib/use-session.ts:53,105,122`; Create `packages/events/src/__tests__/talk.test.ts`; Test `services/runtime/src/engine/__tests__/session-engine-restore.test.ts`, `host/__tests__/player-copies.test.ts`, `apps/web/src/server/__tests__/hub.runtime.test.ts`.

**Interfaces:**
- Produces in `@acr/events`: `type TalkCount = { words: number; lines: number }`; `SessionState.talk: Record<string, TalkCount>` (every role that spoke, keyed by role id; the kind comes from `roles`, so NPC lines are counted apart as context); `initialState().talk = {}`; `countWords(text: string): number` (`text.split(/\s+/u).filter((w) => w.length > 0).length`, 0 for a non-string); `type PlayerSnapshot = Omit<SessionState, "talk">`. Both `reduce` and `reduceReplay` set `talk` through one helper that reads with `Object.hasOwn` and returns a new record (`{ ...talk, [roleId]: { words, lines } }`), so the restore fold stays linear.
- `PLAYER_SNAPSHOT.talk = "omit"`; `snapshotForPlayer` returns `PlayerSnapshot`. `SessionHost.snapshotFor(who: "facilitator"): SessionState; snapshotFor(who: string): PlayerSnapshot`. `ServerMessage` `joined.state: SessionState | PlayerSnapshot`. `initPlayerView(snapshot: PlayerSnapshot)`. Web `JoinedFrame.state` and `use-session` use `PlayerSnapshot`.

- [ ] **Step 1: Write the failing tests:**
  - `talk.test.ts`: `countWords` gives 0 for `""` and `"  \n\t"`, 2 for `"Hello there"`, `"a b"`, `"東京 です"` and `"👋 hi"`, 3 for `"line\nbreak\ttab"`; `reduce counts words and lines per role` (host says "one two three" then "four five", guest says "hi": `talk` is `{ host: { words: 5, lines: 2 }, guest: { words: 1, lines: 1 } }`); `reduceReplay agrees with reduce on talk` over the same sequence; `an utterance from "__proto__" or "constructor" is counted as an own key and leaves Object.prototype untouched` (`Object.hasOwn(s.talk, "__proto__")`, `({} as Record<string, unknown>).words === undefined`); `reduce does not mutate the previous state's talk`.
  - restore: `the restored talk equals the live talk` (drive a session with several lines, restore a fresh engine from the same log, compare `state.talk`).
  - player-copies: the Task 1 pin passes unchanged (no `talk` key for a player); `the facilitator snapshot carries talk`.
  - hub.runtime: add `"\"talk\":"` to `FACILITATOR_ONLY`.
- [ ] **Step 2:** Run `pnpm --filter @acr/events exec vitest run` and the runtime files above; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run step 2, the whole events, runtime and web suites (the existing `reduceReplay agrees with reduce` and `applyPlayerEvent against reduce` property tests must still pass); `pnpm -r --if-present typecheck`.
- [ ] **Step 5:** Commit `[feat] US-0059: fold words spoken per role (facilitator only)`.

### Task 4b: A resume whose repair ends the session ends it for the control service (BUG-0016)

Pre-existing bug, found while planning `end_now`: the `script_complete` repair already hits it. Fixed first, on its own, so the `facilitator_end` repair of Task 5 lands on correct behaviour.

**Files:** Modify `services/runtime/src/main.ts:209-231` (`markResumed` runs inside `openSession` before `main.ts` subscribes to the engine and before `SessionHost` exists, so the `ended` IPC and `endSeats` never run); `docs/BUGS.md`, `docs/ID_REGISTRY.md` (BUG-0016, next becomes BUG-0017), `CHANGELOG.md`; Test `services/runtime/src/__tests__/main.parent.test.ts`.

**Interfaces:**
- Produces: after `ready`, `main.ts` checks `host.engine.state.status === "ended"` once; if so it sends `ended` at once and calls `host.endSeats()` (a failure is reported, not thrown). Nothing else changes: a running resume behaves as today.

- [ ] **Step 1: Write the failing tests** (`main.parent.test.ts`): `a resume whose repair ended the session (log cut after the last scene's exit, script_complete repair) sends ready then ended, and every credential is revoked`; `a normal resume sends ready and no ended`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/__tests__/main.parent.test.ts`; expect FAIL on the first test.
- [ ] **Step 3:** Implement to the interface.
- [ ] **Step 4:** Re-run, then the runtime suite; run the file in the node:22 container (root and `--user node`); expect PASS.
- [ ] **Step 5:** File BUG-0016 in `docs/BUGS.md` as Fixed (Related Story US-0059, Fix Branch `feature/EPIC-0002-US-0059-runtime-protocol`), update `ID_REGISTRY.md` and `CHANGELOG.md` "Fixed"; commit `[fix] US-0059: tell the control service when a resume ends the session`.

### Task 5: `end_now` in the engine and its restore repair

**Files:** Modify `packages/events/src/events.ts:10,58`, `services/runtime/src/engine/session-engine.ts` (`Repair` 49-56, `describeRepair` 57-60, `EngineErrorCode` 74, fold 405-446, the `!cur` repair 470-474, `markResumed` 502-503, `applyRepair` 532), `services/runtime/src/demo/showcase.ts:106-110` (type `EXIT_LABEL` as `Record<ExitReason, string>`, add `facilitator_end: "the facilitator ended the session"`); Create `services/runtime/src/engine/__tests__/session-engine-end-now.test.ts`; Test `services/runtime/src/evaluator/__tests__/transcript.test.ts`, `services/control/src/__tests__/log-tail.test.ts`.

**Interfaces:**
- Produces: `ExitReason` includes `"facilitator_end"`; `session.ended` is `{ reason: "script_complete" | "facilitator_end"; message?: string }`. `EngineErrorCode` gains `"not_started" | "starting"`. `SessionEngine.endNow(o: { actor: string; message?: string }): Promise<void>` (caller passes cleaned values): inside `this.mutex.run`, refuse `status === "idle"` (`not_started`), `this.opening !== null` (`starting`), `status === "ended"` (`ended`); then emit `scene.exited { sceneId, reason: "facilitator_end" }` when there is a current scene, `facilitator.alert { level: "info", message: \`the session was ended now by ${actor}${message ? "; participants were shown a closing message" : ""}\` }`, `session.ended { reason: "facilitator_end", ...(message ? { message } : {}) }`.
- `Repair` member `{ kind: "end_session"; reason?: "facilitator_end" }`. The fold keeps `lastExit: ExitReason | null` (set on `scene.exited`, reset on `scene.entered`); with no current scene and `lastExit === "facilitator_end"` the repair is `{ kind: "end_session", reason: "facilitator_end" }`. `describeRepair` for it: `"ended the session (the facilitator had ended it; any closing message to participants was lost)"`; `markResumed`'s closing sentence for it: `". The facilitator had ended the session, so it ends now"`. `applyRepair` emits `session.ended` with the repair's reason (default `script_complete`) and never a message.

- [ ] **Step 1: Write the failing tests** (`session-engine-end-now.test.ts`, `JsonlEventLog` in a private `mkdtemp`, `FakeClock`):
  - `endNow appends scene.exited, the alert, then session.ended last`: the last three types, `scene.exited.reason === "facilitator_end"`, the alert names the actor, `session.ended` carries the message; `state.status === "ended"`, `currentScene === null`.
  - `without a message session.ended has no message key`.
  - `refused before the start (not_started), during an interrupted opening (starting, using a log that fails one scene.entered append as in the BUG-0015 tests) and after the end (ended); each refusal appends nothing`.
  - `two endNow calls in flight give one session.ended; the second rejects with ended`.
  - `say, recordGmVerdict, recordGmNoVerdict, recordFactEarned, alert and tick queued behind endNow append nothing after session.ended` (start them without awaiting after `endNow`; afterwards the last event is `session.ended`).
  - `a cut after scene.exited, and a cut after the alert, restore as running with repair end_session/facilitator_end; markResumed ends the session with reason facilitator_end and no message, its alert says the closing message was lost, and the live state equals the fold of the file`; `a cut before scene.exited restores the scene (nothing was ended)`; `a complete facilitator_end log restores as ended`.
  - transcript: `a log ended with facilitator_end renders "--- Scene N ends (facilitator_end) ---" and counts as complete`.
  - log-tail: `readLogStatus is "ended" for a complete facilitator_end log and "running" for one cut between the appends`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/engine/__tests__/session-engine-end-now.test.ts src/evaluator/__tests__/transcript.test.ts` and `pnpm --filter @acr/control exec vitest run src/__tests__/log-tail.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run step 2 and `src/engine/__tests__/crash-cut-prefixes.test.ts` (unchanged script ends still repair to `script_complete`); expect PASS. Run the new file once in the node:22 container.
- [ ] **Step 5:** Commit `[feat] US-0059: end_now in the engine with a restore repair`.

### Task 6: `end_now` message, host and server

**Files:** Modify `services/runtime/src/host/protocol.ts:27-45` (new message), `host/display-name.ts`, `host/session-host.ts` (`HostErrorCode` 25, new `endNow`), `host/ws-server.ts:413-423`, `host/player-copies.ts` (`ENDED_FOR_PLAYERS` gains `message`), `services/runtime/src/main.ts` (the live `ended` IPC already fires on `session.ended`; confirm only); Create `services/runtime/src/host/__tests__/ws-server.end-now.test.ts`; Test `services/runtime/src/__tests__/main.parent.test.ts`.

**Interfaces:**
- Consumes: Task 5's `SessionEngine.endNow`, Task 3's `actorLabel`, Task 4b's resume `ended`.
- Produces: client message `{ type: "end_now"; message?: string /* raw, max 1_200 */; by?: string /* raw, max MAX_BY_RAW_CHARS */ }`. `MAX_END_MESSAGE_CHARS = 300` and `cleanClosingMessage(raw: string | undefined): string | undefined` in `display-name.ts` (`cleanText(raw, 300, "message", [])`; whitespace-only gives undefined; too long throws `HostError("bad_message")` at the host). `HostErrorCode` gains `"starting"`. `SessionHost.endNow(o: { by?: string; message?: string }): Promise<void>`: `!this.started` throws `HostError(this.isStarting ? "starting" : "not_started")`; then `engine.endNow({ actor: actorLabel(o.by), message })`, `stopTicker()`, `pendingAnswer = null`. In `ws-server.ts` a separate branch before `command`: a non-facilitator gets `forbidden`; never calls `host.start()`.

- [ ] **Step 1: Write the failing tests:**
  - `ws-server.end-now.test.ts` (real server, minimal fixture, join codes, `vi.setConfig({ testTimeout: 90_000 })`): `in the lobby end_now is not_started, nothing is appended and the session does not start`; `a player's end_now is forbidden`; `during an interrupted start end_now is starting and nothing is appended`; `running: end_now with by "Sam" and message "Thanks, <b>all</b>" gives players session.ended with that exact message text and no alert, no "Sam"; the facilitator gets scene.exited, the alert naming Sam, then session.ended`; `a second end_now is ended`; `a 301-code-point message is bad_message and nothing is appended`; `a whitespace-only message gives session.ended without message`; `an NPC reply in flight when end_now lands (a mock provider whose reply resolves after the end) appends nothing after session.ended`; `the ticker is stopped after end_now` (spy on `stopTicker`).
  - main.parent: `end_now sends ended once`.
- [ ] **Step 2:** Run each file (`pnpm --filter @acr/runtime exec vitest run <file>`); expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, then the runtime suite; run `ws-server.end-now.test.ts` and `main.parent.test.ts` in the node:22 container (root and `--user node`); expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: end_now facilitator message with a closing message`.

### Task 6b: The closing message reaches players and clients

**Files:** Modify `packages/events/src/player-view.ts:19,65-66`, `services/runtime/src/cli/render.ts:60`, `apps/web/src/components/SessionScreen.tsx:147`; Test `packages/events/src/__tests__/player-view.test.ts`, `services/runtime/src/cli/__tests__/render.test.ts`, `apps/web/src/components/__tests__/session-screen.test.tsx`.

**Interfaces:**
- Consumes: Task 6's `session.ended.message` on the player copy.
- Produces: `PlayerView.ended: { reason: string; message?: string } | null` (message copied only when a string). The terminal client prints the cleaned message on its own line; the web ended screen renders `view.ended.message` in a `<p className="body">` prefixed "Message from the facilitator:", as a text child only.

- [ ] **Step 1: Write the failing tests:** player-view: `session.ended copies a string message into ended and ignores a non-string one`; render: `a session.ended with a message prints the cleaned message on its own line`; session-screen: `the ended screen shows the facilitator's message as text under the end notice` (the `<b>` arrives as literal text, no `b` element).
- [ ] **Step 2:** Run each file; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run the events, runtime and web suites and `pnpm -r --if-present typecheck`; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: show the closing message to players`.

### Task 7: PR 2 docs and pull request

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/THREAT_MODEL.md`, `README.md` (the "For client authors (protocol)" paragraph near line 137), `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** `docs/RELEASE_PLAN.md`: reword AC-0313 to the addendum (refusal before the start, while starting and after the end; event order; restore repair; message cleaned, at most 300, rendered as text) and check it; add to AC-0312 and AC-0311 a note that the runtime parts (`by` recorded; talk-time projection "Words spoken") landed in 2b-2a and the console parts follow in 2b-2b. File TC-0088 (`by`, AC-0312), TC-0089 (talk time, AC-0311), TC-0090 (`end_now` incl. the restore cut, AC-0313) in `docs/TEST_CASES.md`, with the test files as Actual Result.
- [ ] **Step 2:** `docs/THREAT_MODEL.md` new section "Live console runtime protocol (EPIC-0002 slice 2b-2a)": `by` is an attested label (cleaned, 60 code points, never in a player frame); allowlisted copies; talk time is facilitator-only; `end_now` is facilitator-only, never auto-starts, refused while a start is in flight; the closing message is participant-visible untrusted text, cleaned and rendered as text; a restart that cuts the end loses the message. README protocol paragraph: `command.by`, `end_now { message? }`, the refusal codes. `CHANGELOG.md` `[Unreleased]` "Added" lines for `by`, words spoken and `end_now`.
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage`; record coverage in `progress.md`; update `MEMORY.md` (the `end_now` order and repair, `PlayerSnapshot`). Commit `[docs] US-0059: document by, words spoken and end_now`.
- [ ] **Step 4:** Push, open PR 2 into `develop` (body references US-0059, AC-0311 to AC-0313, TASK-0095). Wait for the squash merge before PR 3.

---

## PR 3: remove a participant (`feature/EPIC-0002-US-0059-remove-participant`, from `develop` after PR 2)

### Task 8: Remove as the reissue IPC, runtime and control service

**Files:** Modify `services/runtime/src/host/ws-server.ts:18-20,358`, `host/reissue.ts:50-81`, `host/parent-channel.ts:20-25`, `services/runtime/src/main.ts:235-249`, `services/control/src/protocol.ts:16-21`, `services/control/src/supervisor.ts:394`, `services/control/src/api.ts:23,142-146`; Create `services/runtime/src/host/__tests__/reissue.remove.test.ts`; Test `services/runtime/src/__tests__/main.parent.test.ts`, `services/control/src/__tests__/{protocol.drift,api,supervisor.lifecycle}.test.ts`.

**Interfaces:**
- Produces: `export const CLOSE_REMOVED = 4003` (ws-server; `kickWith` maps it to the close reason `"removed"`). Both `ParentMessageSchema` copies gain `reason: z.literal("removed").optional()`. `reissueRole(d, roleId, by?: string, reason?: "removed"): Promise<string>`: with `reason === "removed"` and `d.host.hasStarted`, throw `RemoveRefusedError` before any write (nothing changes); otherwise the existing order, kicking with `CLOSE_REMOVED` instead of `CLOSE_REISSUED`. `main.ts` passes `m.reason` and answers a `RemoveRefusedError` with the fixed reason `"a participant can only be removed before the start"` (every other failure keeps `"the code could not be reissued"`). `Supervisor.reissue(id, roleId, by?, reason?: "removed")`. `ReissueBody` gains `reason: z.literal("removed").optional()`, refused (400) without `roleId`.

- [ ] **Step 1: Write the failing tests:**
  - `reissue.remove.test.ts` (real server): `remove before the start closes the socket with 4003 "removed", revokes the credential, withdraws the consent, frees the seat and returns a new code`; `the old code is refused (unauthorized) and the new code joins`; `remove after the start is refused and changes nothing (codes file bytes, credential, consent, socket open)`; `remove while the start is in flight is refused and changes nothing`; `a plain reissue still closes with 4002`.
  - main.parent: `a reissue with reason removed reaches reissueRole and a refusal answers the fixed reason`.
  - protocol.drift: add `{ ..., reason: "removed" }` to the valid parent messages and `reason: "other"` to the invalid ones.
  - api: `POST /sessions/:id/codes/reissue { roleId, reason: "removed" } returns the code and sends reason removed`; `{ reason: "removed" } without roleId is 400`.
- [ ] **Step 2:** Run the runtime and control files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run, then both suites; run `reissue.remove.test.ts` in the node:22 container; expect PASS.
- [ ] **Step 5:** Commit `[feat] US-0059: remove a participant before the start (close 4003)`.

### Task 9: The removed player's screen

**Files:** Modify `apps/web/src/server/runtime-connection.ts:22-36`, `apps/web/src/server/stream-hub.ts:39,55-57,229`, `apps/web/src/server/handlers.ts:287`, `apps/web/src/lib/messages.ts`, `apps/web/src/lib/use-session.ts:30,41-49`, `apps/web/src/components/SessionScreen.tsx:72-73`; Test `apps/web/src/server/__tests__/stream-hub.test.ts`, `apps/web/src/server/__tests__/handlers.test.ts`, `apps/web/src/lib/__tests__/use-session.test.ts`, `apps/web/src/components/__tests__/session-screen.test.tsx`.

**Interfaces:**
- Consumes: Task 8's close code 4003.
- Produces: `CLOSE_REMOVED = 4003` in `runtime-connection.ts`, `classifyClose` gives `"removed"`; stream-hub `FinalEvent` gains `"removed"` (terminal, writes `{ message: REMOVED_MESSAGE }`); the join path maps `"removed"` to `sseFinal("removed", { message: REMOVED_MESSAGE }, CLEAR_COOKIE)`; `REMOVED_MESSAGE = "The facilitator removed you from this session."` exported beside `SIGNED_OUT_MESSAGE` and equal to `MESSAGES.removed`; `FinalKind` and `CLOSING_EVENTS` gain `"removed"`; `FinalScreen` title "Removed from the session".

- [ ] **Step 1: Write the failing tests:** `a runtime close 4003 ends the stream with a removed event carrying the message and no reconnect`; `a join refused with 4003 clears the cookie`; `use-session finishes on removed with MESSAGES.removed`; `the removed screen shows the title and message`; `REMOVED_MESSAGE equals MESSAGES.removed`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run` on those files; expect FAIL.
- [ ] **Step 3:** Implement to the interfaces.
- [ ] **Step 4:** Re-run the web suite and `pnpm --filter @acr/web e2e`; expect PASS (Axe unchanged).
- [ ] **Step 5:** Commit `[feat] US-0059: tell a removed player the facilitator removed them`.

### Task 10: PR 3 docs, pull request and close-out

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/THREAT_MODEL.md`, `docs/ARCHITECTURE.md` (lines near 304 and 310), `README.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** Reword AC-0314 to the addendum (Remove is the parent-only reissue with reason removed, before the start only, new code written first, credential revoked, consent withdrawn, persisted, kicked with 4003 and swapped; the old code cannot reopen the seat) and check it; file TC-0091 (AC-0314); set TASK-0095 Done with the three PRs in its notes.
- [ ] **Step 2:** `docs/THREAT_MODEL.md` (the 2b-2a section): remove has no network surface, no revoke-then-reissue gap, mid-session removal is out of scope (end the session instead). `docs/ARCHITECTURE.md` and README: close code 4003. `CHANGELOG.md` `[Unreleased]` "Added" line.
- [ ] **Step 3:** `npm run plan:generate`; `pnpm test:coverage` twice (once under load, `AGENTS.md` section 8); record in `progress.md`; `MEMORY.md`. Commit `[docs] US-0059: document remove and close 2b-2a`.
- [ ] **Step 4:** Push, open PR 3 into `develop` (body references US-0059, AC-0314, TASK-0095). After the merge, the 2b-2b1 plan is written next.
