# Voice A3a: Facilitator Mute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator can mute and unmute one human seat's microphone during a live session; the mute is logged with `by`, survives refresh, rejoin, reissue and restart, and every participant sees it by role label.

**Architecture:** A new `FacilitatorCommand` `mute_seat {roleId, muted}` goes through the existing console command channel into the runtime and is appended as `facilitator.command` with `by`. The state lives in the shared reducer's `SessionState` (a set of facilitator-muted seats), so engine restore rebuilds it from the log. The host unions it with the participant's own mute everywhere recording is decided; the speech worker already ignores a seat whose `recording` is false.

**Tech Stack:** TypeScript, pnpm workspaces (`@acr/events`, `@acr/runtime`, `@acr/control`, `@acr/web`), vitest (`pnpm --filter @acr/<pkg> exec vitest run <path>`), Next.js app router, React.

**Spec:** `docs/superpowers/specs/2026-11-16-voice-a3a-facilitator-mute-design.md` (Draft 3, committed 85cee42f). Calls C1 to C11 and owner decisions 1 to 5 are binding. Read it first.

## Global Constraints

- Command name is `mute_seat` (never `mute_voice`); body `{ command: "mute_seat", roleId: string, muted: boolean }`, strict, no free text.
- `by` comes only from the sealed console cookie (a body carrying `by` is refused); shared-secret sign-ins use the typed name (C4). `by` and any person name never reach a player.
- The participant's own mute stays in memory (`voiceMuted` in `session-host.ts`); the facilitator set is in `SessionState` and is cleared only by `mute_seat` with `muted: false` (not by `release`, `forgetVoice`, reissue, pause, rejoin).
- Refusal order: `voice_off`, `unknown_role`, `forbidden` (not a human seat), `ended`. Allowed while paused. A seat with no holder or a text-only holder is accepted.
- Ordering (C7): a mute applies on receipt and is rolled back if refused or its append fails; an unmute applies only after its append succeeds; the `voice_line` recording check is repeated inside the engine mutex.
- Before the start (C6): held in memory, written as `facilitator.command` straight after `session.started`; a restart before the start loses it (pinned residual).
- No Game Master tick after `mute_seat` (C9). `LOG_FORMAT` is NOT changed (C11).
- The muted speaker's refused line keeps the generic `not_recording` notice (C10).
- Player copy by role label only: "The <role> microphone has been muted by the facilitator" / "... is on again". Muted participant: "The facilitator has muted your microphone" / "You can speak again". Console label: "Muted by facilitator". Words, never colour alone.
- Commits: `[TYPE] A3A: description` (max 72 chars), trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Tests pass and coverage stays at or above 80% before each commit. Do not push or open a PR.
- Proposed ids (builder confirms against `docs/ID_REGISTRY.md`): story US-0091, tasks from TASK-0143, AC from AC-0550, TC from TC-0322.

## Review Focus

Failure modes the spec implies that no single task's happy path covers; each has a pinning test in the owning task.

1. A `voice_line` that passed the recording check while a mute was queued must be refused, not appended after the mute (Task 2).
2. An unmute whose append fails must leave the seat muted; a mute whose append fails must be rolled back and the console must not show it muted (Task 2).
3. A player who joins fresh (no `lastSeq`) mid-session must see a mute that happened earlier, and must not be told again as if it just happened (Task 3).
4. A `mute_seat` event must not leak `by` or a person name into any player frame, snapshot or peers roster (Task 3).
5. A control bot must not be "resumed" by a `mute_seat` event (Task 4).

---

### Task 1: Command, state and engine (events + engine)

**Files:**
- Modify: `packages/events/src/events.ts` (the `FacilitatorCommand` union, next to `prompt_ai` at line 24)
- Modify: `packages/events/src/state.ts` (reducer and `SessionState`)
- Modify: `services/runtime/src/engine/session-engine.ts` (`doCommand` near line 287 to 321; restore)
- Modify: `services/runtime/src/host/protocol.ts` (`FacilitatorCommandSchema`)
- Test: `packages/events/src/__tests__/` (reducer), `services/runtime/src/engine/__tests__/session-engine.test.ts`, `session-engine-restore.test.ts`

**Interfaces:**
- Produces: `FacilitatorCommand` variant `{ command: "mute_seat"; roleId: string; muted: boolean }`; `SessionState.facilitatorMutedSeats: ReadonlySet<string>` (or a sorted `string[]` if state must stay JSON-plain; follow the existing field style); engine `command()` accepts it and appends `facilitator.command` with `by`.

- [ ] **Step 1: Write failing tests.** Reducer: `mute_seat {muted:true}` adds the seat, a later `{muted:false}` removes it, other commands leave it unchanged, last command per seat wins. Engine: appends `facilitator.command` with `by`, strict schema refuses extra keys and a missing `roleId`, `roleId` not a seat of the session is refused `unknown_role`, an ended session is refused `ended`, allowed while paused. Restore: a log with a `mute_seat` rebuilds the set; a log with mute then unmute rebuilds empty.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/events exec vitest run` and `pnpm --filter @acr/runtime exec vitest run src/engine`. Expected: FAIL (unknown command).
- [ ] **Step 3: Add the variant and schema entry** in `events.ts` and `protocol.ts` (strict, `roleId` checked like the other commands' role ids). **Step 4:** reducer in `state.ts`; the engine's `doCommand` does only the role-seat check (voice checks are the host's, Task 2). Existing exhaustive switches over commands (grep `prompt_ai`) get a `mute_seat` case or the compiler tells you.
- [ ] **Step 5: Run tests; expected PASS.** Then `pnpm --filter @acr/events exec tsc --noEmit` and the same for `@acr/runtime` (the player projection `PLAYER_SNAPSHOT` in `player-copies.ts` will force a decision: for now add the field as not-yet-projected and mark it with a TODO that Task 3 removes).
- [ ] **Step 6: Commit** `[feat] A3A: mute_seat command and reducer state`.

### Task 2: Host behaviour (checks, ordering, union, pre-start)

**Files:**
- Modify: `services/runtime/src/host/session-host.ts` (`command` near line 983, `isRecordingHolder` 909, `voiceMutedOf` 536, voice-seat computation ~612, line append path ~807 to 833, `start`)
- Modify: `services/runtime/src/host/voice.ts` (`isMuted` callback if its signature needs the union)
- Test: `services/runtime/src/host/__tests__/` (new `session-host.mute-seat.test.ts`)

**Interfaces:**
- Consumes: Task 1 variant and `SessionState.facilitatorMutedSeats`.
- Produces: `host.command(...)` handling `mute_seat` with refusal codes `voice_off`, `unknown_role`, `forbidden`, `ended`; `host.facilitatorMutedOf(roleId): boolean`; `host.voiceMutedOf(roleId)` now returns the union; `host.voiceMutedByOf(roleId): "facilitator" | undefined`.

- [ ] **Step 1: Write failing tests** (real engine, fake clock): refusals in the spec order (a non-human/AI seat gets `forbidden`; an unknown id gets `unknown_role`; voice disabled gets `voice_off` first); accepted for a seat with no holder and for a text-only holder; mute makes `recording` false and re-sends `voice_state`; `voice_line` for the seat refused `not_recording`; **Review Focus 1:** a line that passed the check before the mute, appended after it, is refused by the in-mutex guard; **Review Focus 2:** failing append on a mute rolls the seat back to unmuted and fails the command, failing append on an unmute leaves the seat muted; `release`, `forgetVoice` (reissue path) and pause/resume do not clear it; participant's own `voiceMuted` and the facilitator set are independent and the union is used by `isRecordingHolder`, the voice-seat `isMuted` and `voiceMutedOf`; no Game Master tick is scheduled after `mute_seat`; before the start the mute is held and, after `start()`, the log has `session.started` then the `facilitator.command` with the same `by`, and a restart before the start keeps nothing.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/session-host.mute-seat.test.ts`.
- [ ] **Step 3: Implement in `host.command`**: check `voice_off`, then delegate role validity, then `forbidden`/`ended`, before the engine call. On a mute: mark on receipt, call the engine append, roll back on refusal or throw. On an unmute: append first, then clear. Skip the tick for this command. **Step 4:** change `isRecordingHolder`, `voiceMutedOf` and the voice-seat `isMuted` to the union; pass an `isMuted`-style guard into the line-append so the check re-runs inside the engine mutex. **Step 5:** pre-start path: store in a host-local set, write after `session.started` inside `start()`.
- [ ] **Step 6: Run tests; expected PASS.** Also run the existing voice host tests: `pnpm --filter @acr/runtime exec vitest run src/host` (expected all PASS, no regressions).
- [ ] **Step 7: Commit** `[feat] A3A: host mute_seat with rollback and in-mutex guard`.

### Task 3: Players, protocol frames and console roster (runtime outward)

**Files:**
- Modify: `services/runtime/src/host/player-copies.ts` (`commandForPlayer` ~line 75, `PLAYER_SNAPSHOT` line 21)
- Modify: `services/runtime/src/host/roster.ts` (peers roster, console roster)
- Modify: `services/runtime/src/host/ws-server.ts` (`joined.voice` ~411, voice answers ~474 and ~484, `voice_mute` handling)
- Modify: `services/runtime/src/host/protocol.ts` (`ServerMessage` voice frame, `VOICE_REFUSALS`)
- Modify: `services/runtime/src/host/parent-channel.ts` (add `muted_by_facilitator` to the refusal list if the participant's `voice_mute` refusal travels that way)
- Test: `services/runtime/src/host/__tests__/player-copies.test.ts`, `ws-server.*.test.ts` (new `ws-server.mute-seat.test.ts`)

**Interfaces:**
- Consumes: `host.voiceMutedByOf`, `host.facilitatorMutedOf`.
- Produces: `commandForPlayer` returns `{ command: "mute_seat", roleId, muted }` and nothing else for this command; `ServerMessage` voice frame `{ type: "voice", state, muted, mutedBy?: "facilitator" }`; `joined.voice` carries `mutedBy`; the runtime pushes a `voice` frame to the holder's socket when the facilitator state changes; peers roster entry carries `facilitatorMuted: boolean`; console roster entry carries `facilitatorMuted: boolean`; `voice_mute {muted:false}` while facilitator-muted is refused `muted_by_facilitator`.

- [ ] **Step 1: Write failing tests.** `commandForPlayer` for `mute_seat` returns exactly `{command, roleId, muted}` (**Review Focus 4**: a command with `by: "Alex"` yields no `by` and no name anywhere in the serialised frame, snapshot or peers roster); real-socket: holder gets a pushed `voice` frame `{muted:true, mutedBy:"facilitator"}` on mute and `muted:false` without `mutedBy` on unmute; the holder's `voice_mute{muted:false}` is refused `muted_by_facilitator`, `muted:true` accepted; **Review Focus 3:** a player joining fresh with no `lastSeq` sees the seat as facilitator-muted in the snapshot or peers roster, and a reconnect with `lastSeq` receives only later mute events; other players receive the role-label mute event; AI seats get no frame; console roster has `facilitatorMuted`.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/player-copies.test.ts src/host/__tests__/ws-server.mute-seat.test.ts`.
- [ ] **Step 3: Implement** the `commandForPlayer` case; project the new state in `PLAYER_SNAPSHOT` (remove Task 1's TODO); add roster fields in `roster.ts`; add the push and `mutedBy` in `ws-server.ts`; add the refusal. The runtime's `ServerMessage` has no schema or version, so `mutedBy` is additive.
- [ ] **Step 4: Run tests; expected PASS**, then `pnpm --filter @acr/runtime exec vitest run` (full runtime suite).
- [ ] **Step 5: Commit** `[feat] A3A: players and roster see facilitator mute`.

### Task 4: Control bots stay unaffected

**Files:**
- Modify (only if the test fails): `services/control/src/bots/bot.ts` (the "any non-pause command means resumed" logic near line 351), `services/control/src/bots/bot-frames.ts`
- Test: `services/control/src/__tests__/bots/bot.test.ts`

**Interfaces:** Consumes the player-facing event from Task 3.

- [ ] **Step 1: Write the failing test (Review Focus 5):** a bot that is paused and receives a `facilitator.command` with `command: "mute_seat"` stays paused; a bot never receives a `voice` frame (`bot-frames.ts` enum drops it).
- [ ] **Step 2: Run:** `pnpm --filter @acr/control exec vitest run src/__tests__/bots/bot.test.ts`. If it passes already, keep the test as the pin and skip Step 3.
- [ ] **Step 3: Fix** so only `resume` clears paused (not "any non-pause command"), keeping existing behaviour for other commands.
- [ ] **Step 4: Run the bots tests; expected PASS. Step 5: Commit** `[test] A3A: bots ignore mute_seat`.

### Task 5: Web server (command kind, copy, stream)

**Files:**
- Modify: `apps/web/src/server/console-command.ts` (`COMMAND_KINDS`, validation, refusal mapping ~118 to 124)
- Modify: `apps/web/src/server/facilitator-copies.ts` (the `facilitator.command` switch ~91 to 101; add a `mute_seat` case)
- Modify: `apps/web/src/server/wire.ts` (command wire type), `apps/web/src/server/stream-hub.ts` (VOICE_SEND_ERRORS line 21, unsolicited `voice` frame ~251, `playerJoined` ~97, `peerEntryOf` ~81), `apps/web/src/server/handlers.ts` (`VOICE_ANSWERS` ~81)
- Modify: `apps/web/src/lib/messages.ts` (fixed copy for `voice_off`, `forbidden`)
- Test: `apps/web/src/server/__tests__/console-command.test.ts`, `facilitator-copies.test.ts`, `stream-hub*.test.ts`, `handlers*.test.ts`

**Interfaces:**
- Consumes: runtime frames from Task 3.
- Produces: console command kind `mute_seat` with body `{ channel, kind: "mute_seat", roleId, muted }`; stream forwards a server-pushed `voice` frame as a named event with `mutedBy`; `muted_by_facilitator` is in `VOICE_SEND_ERRORS` and `VOICE_ANSWERS`.

- [ ] **Step 1: Write failing tests:** strict keys (an extra key and a body `by` are refused), the guard (owner or admin, neutral 404), throttle, legacy shared-secret sign-in allowed with the typed name as `by` (C4), fixed sentences for `voice_off` and `forbidden`, `unknown_role` keeps the shared sentence, `ended` keeps its sentence; `facilitator-copies` returns a defined value for `mute_seat` (never undefined); stream forwards the unsolicited `voice` frame with `mutedBy`; `playerJoined` keeps `mutedBy`; a send of `voice_mute{false}` returns the specific `muted_by_facilitator` answer immediately (no 2 s wait).
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/web exec vitest run src/server`.
- [ ] **Step 3: Implement.** **Step 4: Run tests; expected PASS**, then the full `pnpm --filter @acr/web exec vitest run`.
- [ ] **Step 5: Commit** `[feat] A3A: web mute_seat command and stream`.

### Task 6: Console UI (button, state, status line)

**Files:**
- Modify: `apps/web/src/lib/console-voice.ts` (`pickVoice`), `apps/web/src/lib/console-view.ts` (command send), `apps/web/src/lib/console-api.ts`
- Modify: `apps/web/src/components/console/VoicePanel.tsx` (`VoicePanelEntry` line 11)
- Test: `apps/web/src/components/console/__tests__/VoicePanel.test.tsx`, `apps/web/src/lib/__tests__/console-voice.test.ts`

**Interfaces:**
- Consumes: console roster `facilitatorMuted`, command kind from Task 5.
- Produces: `VoicePanelEntry.facilitatorMuted: boolean`; a Mute/Unmute native button per human seat with a voice state, accessible name naming the seat; a polite live region announcing the result (new: the panel has none today); a refused command shows its fixed sentence; in-flight guard (a double press sends one command).

- [ ] **Step 1: Write failing component tests:** the button toggles label by state, label text "Muted by facilitator" shown as words, accessible name names the seat, double press sends one command, a refusal shows its sentence and the status line announces results, AI seats have no button, a seat without a voice state has no button.
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/web exec vitest run src/components/console src/lib`.
- [ ] **Step 3: Implement. Step 4: Run; expected PASS. Step 5: Commit** `[feat] A3A: console mute button and status line`.

### Task 7: Participant page notices

**Files:**
- Modify: the participant voice-controls component under `apps/web/src/components/` (locate with `grep -rl "voice_mute\|voiceMuted\|mutedBy" apps/web/src`), the player stream client, `apps/web/src/lib/messages.ts`
- Test: the component's `__tests__`

**Interfaces:** Consumes `voice` frame `mutedBy`, peers roster `facilitatorMuted`, the role-label `mute_seat` event.

- [ ] **Step 1: Write failing tests:** muted participant sees "The facilitator has muted your microphone" (aria-live), their unmute button is disabled while `mutedBy` is `facilitator`, and on unmute they see "You can speak again" once; every participant's page shows the role-label line for a mute and for an unmute; a fresh join with the seat already muted shows the state but does not announce it (Review Focus 3); no person or facilitator name is rendered.
- [ ] **Step 2: Run to verify fail. Step 3: Implement. Step 4: Run; expected PASS. Step 5: Commit** `[feat] A3A: participant mute notices`.

### Task 8: End to end, mutation checks, docs

**Files:**
- Test: `services/control/src/__tests__/` or the existing voice real-store e2e harness (find it by grep for `voice_state` in `services/*/src/__tests__`), plus the mutation-check notes in the task report
- Modify: `docs/THREAT_MODEL.md`, `docs/VOICE_RUNBOOK.md`, `docs/ROLLBACK.md`, `CHANGELOG.md` (`[Unreleased]`), `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `progress.md`, `MEMORY.md`

- [ ] **Step 1: Write the real-store end-to-end test:** with a muted seat, the speech worker's `voice_state` handling ignores that seat's frames and writes no audio file while muted; after unmute audio is written again.
- [ ] **Step 2: Mutation checks, each must make a named test fail (record the test names in the report), then revert:** remove the facilitator set from the union; clear it in `release`; drop the `muted_by_facilitator` refusal; leak `by` to a player in `commandForPlayer`; check the mute after the append instead of on receipt.
- [ ] **Step 3: Docs.** THREAT_MODEL: facilitator mute, `by` in the log, role-label visibility, residuals (muted person can still talk in the room; a line before the mute stays). VOICE_RUNBOOK and ROLLBACK: "a runtime rolled back to before A3a drops all facilitator mutes, so re-mute after a rollback", "deploy web with or before runtime", pre-start mute lost on a pre-start restart. CHANGELOG `[Unreleased]`, RELEASE_PLAN story and tasks, TEST_CASES (automated cases Pass; the real-room check "facilitator mutes a real participant in a live voice session" as Not Run), ID_REGISTRY next free ids, progress.md, MEMORY.md. Run `npm run plan:generate`.
- [ ] **Step 4: Run all suites:** `pnpm --filter @acr/events exec vitest run`, then runtime, control, web (expected PASS, coverage at or above 80%).
- [ ] **Step 5: Commit** `[docs] A3A: threat model, runbook, rollback, tracker, changelog` (tests in a separate `[test] A3A: mute end to end` commit).
