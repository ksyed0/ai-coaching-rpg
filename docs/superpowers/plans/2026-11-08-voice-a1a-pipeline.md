# EPIC-0003 voice A1a: the pipeline on file ingest — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Story: proposed **US-0070** (EPIC-0003, High, L), ids filed in Task 0 from `docs/ID_REGISTRY.md`. Branch: `feature/EPIC-0003-US-0070-voice-pipeline`, cut from `develop` after the docs PR with the spec and the three plans has merged. TDD per task: write the failing test, run it and see it fail for the stated reason, then the code.

**Goal:** A participant's speech, fed from WAV files, is segmented, transcribed by a speech-to-text adapter and recorded in the session log as an `utterance` with `channel: "voice"` under their own role, with the NPC round, the Game Master and AI-player bots reacting once per voice turn, and every refusal and failure path closed; all dark behind `VOICE_ENABLED`.

**Architecture:** A per-session speech worker (`services/speech`, forked by control, no network listener) runs ingest → segmenter → noise gate → STT (limited, retried, per-track FIFO) → normaliser and sends `voice_line` and `speech_activity` to control over IPC. Control's `VoiceHost` relays them to the runtime over the parent channel and relays the runtime's seat state back as `voice_state`. The runtime records a line through `SessionHost.onVoiceUtterance` only for the current human holder who chose voice, answers with the `seq`, and keeps one turn timer.

**Tech Stack:** TypeScript, pnpm workspaces, Node 22 `fork()` IPC and global `fetch`/`FormData`, zod 4 strict schemas, Vitest with injected clocks and timers. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` (Draft 2). **Master plan:** `docs/superpowers/plans/2026-11-08-voice-part-a-overview.md` — its "Contradictions with the spec" (C1 to C11), "Cross-slice interfaces" (exact message schemas, the voice record shape) and "Settings" are part of this plan's requirements and are not repeated here. This plan is written for **Open Question 1 option A** (the runtime voice choice is in A1a); Tasks 4 and 5 are the ones that change under option B (noted in each).

## Global Constraints

- **No change to the session log format**, `LOG_FORMAT`, the consent file or any existing event. A voice line is the existing `utterance` with `channel: "voice"` (`packages/events/src/events.ts:2`). No new event type.
- `VOICE_ENABLED` defaults to `0`; with `1` the runtime refuses to start unless `CONTROL_MANAGED=1` and the active notice names voice (`v3` or later); control starts no worker unless `ready.voice === true`.
- **Privacy invariant:** audio of a seat that is not (current human holder, voice chosen by that participant, not paused, not ended) is never segmented, never sent to STT and never produces a message. Enforced twice: in the worker (Task 17) and in the runtime (Task 6).
- The runtime is the only writer of the log; the worker never talks to the runtime and has no network listener; it reaches Whisper on loopback only (`STT_URL` host must be `127.0.0.1` or `[::1]`).
- Strict zod schemas everywhere (`strictObject`); runtime/control parent-channel copies stay equal (drift test); the worker protocol has one source (`@acr/speech/protocol`).
- No new regular expression with a letters-digits-underscore class outside `packages/events/src/ids.ts` (US-0020 guard, `services/runtime/src/__tests__/id-rules.files.test.ts:96-141`); ids use `isFileSafeId`, `isSafeId`, `isScenarioId`.
- Never log an environment-derived string, a path, a token or a transcript line; log fixed sentences and error names only (`docs/memory/architecture-and-security.md`, security conventions).
- Tests: no real-time sleeps, no absolute time assertions, injected clocks and `SetTimer`, private temp directories, generous timeouts for real-process tests (AGENTS.md §8 "Writing tests"). Segmenter tests use synthetic signals generated in the test.
- Coverage at least 80% per package; every commit passes `pnpm -r typecheck` and the touched package's tests.
- Commits: `[TYPE] US-0070: imperative description` (max 72 characters), ending with the attribution line the session's reminder gives. Types: feat, fix, test, docs, refactor, chore, style, perf.
- No new dependency (A1a). Exact versions only if that changes (AGENTS.md §19).

## Review Focus

Each line names the task whose tests pin it.

1. **A file for a seat that is not a recording holder** (a text-only seat, an AI seat, an unheld seat, a holder who chose text): no segment, no STT call, no message, and the runtime would refuse anyway. [Task 17 test `unconsented track produces nothing`; Task 6 refusal table; Task 20 check V-04]
2. **Opt-out or pause in the middle of a segment:** the open segment is discarded (not transcribed), no line follows, the turn timer is cleared, no round runs. [Task 17 `voice_state change discards the open segment`; Task 7 `pause clears the timer`]
3. **A reissue or a rebind while a line is in flight:** the line names the old participant and is refused `not_holder`; the new holder is `text_only` until they opt in themselves. [Task 5, Task 6]
4. **Whisper slow, failing or answering out of order:** one speaker's lines are logged in segment order; a segment past its deadline is `stt_failed` with a speaker notice and a facilitator alert, never a placeholder line. [Task 13, Task 17]
5. **The worker dies mid-session:** the session keeps running, text lines still work, the facilitator gets one alert, no restart yet (A1b). [Task 19 `worker exit leaves the session running`; Task 20 check V-07]

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `services/speech/package.json`, `tsconfig.json`, `vitest.config.ts` | `@acr/speech` package (exports `./protocol` only) | 1 |
| `services/speech/src/protocol.ts` | Worker ↔ control IPC schemas (overview §1) | 1 |
| `services/speech/src/__tests__/imports.test.ts` | Speech imports no runtime or control source | 1 |
| `services/runtime/src/host/parent-channel.ts`, `services/control/src/protocol.ts` | Parent-channel voice messages (overview §2) | 2 |
| `services/runtime/src/host/voice-config.ts` | `parseVoiceConfig(env, managed, noticeVersion)` | 3 |
| `services/runtime/src/host/limits.ts` | `noticeNamesVoice` | 3 |
| `consent/notice-v3.md` | DRAFT notice v3 (C1) | 3 |
| `services/runtime/src/engine/voice-file.ts` | Voice record read/write, `VoiceChoices` store | 4 |
| `services/runtime/src/host/protocol.ts`, `ws-server.ts` | `voice_opt_in`/`voice_opt_out`, `voice`, `voice_notice`, `joined.voice` | 5, 10 |
| `services/runtime/src/host/voice.ts` | `VoiceTurnTracker`, `voiceSeats()` builder, `gmUnits()` | 7, 8 |
| `services/runtime/src/host/session-host.ts` | `optInVoice`, `optOutVoice`, `voiceState`, `onVoiceUtterance`, `onSpeechActivity`, `voiceNotice`, `voiceAlert`, seat-change hooks | 5 to 10 |
| `services/runtime/src/host/reissue.ts` | Delete the role's voice entry | 5 |
| `services/runtime/src/agents/game-master.ts` | `units` and `hold` options | 8 |
| `services/runtime/src/main.ts` | Voice config, parent-message handling, `voice_seats`/`voice_turn`/`voice_choice` sends | 3, 5, 6, 7 |
| `services/control/src/bots/bot-host.ts`, `bots/bot.ts` | `voiceTurn(sessionId, open)`, coalescing | 9 |
| `packages/adapters/src/speech/*` | `SpeechToText` types, errors, fake, contract, Whisper HTTP client, limiter, 16-bit PCM WAV encode/decode (`wav.ts`) | 11, 12, 13 |
| `services/speech/src/segmenter.ts` | Energy VAD segmenter | 14 |
| `services/speech/src/noise-gate.ts` | Phantom-text gate | 15 |
| `services/speech/src/normalise.ts` | Deterministic normaliser | 16 |
| `services/speech/src/activity.ts`, `track-pipeline.ts`, `voice-gate.ts` | Activity edges, per-track FIFO pipeline, holder filter | 17 |
| `services/speech/src/ingest/audio-ingest.ts`, `ingest/file-ingest.ts`, `config.ts`, `worker.ts`, `main.ts` | `AudioIngest`, file ingest, worker settings, worker wiring, IPC entry | 18 |
| `services/control/src/voice/voice-host.ts`, `speech-spawn.ts`, `speech-env.ts`, `speech-command.ts` | Worker per session: spawn, relay, correlation, crash | 19 |
| `services/control/src/supervisor.ts`, `main.ts`, `child-env.ts` | Hooks into `goLive`/`onChildExit`/`onEnded`, allowlist | 3, 19 |
| `services/control/src/demo/voice-demo.ts`, `services/runtime/src/demo/args.ts`, `runner.ts` | `pnpm demo --voice` (checks V-01 to V-08) | 20 |

---

### Task 0: Branch, story and ids

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`.

- [ ] **Step 1:** Confirm the docs PR (spec plus the three plans) is on `origin/develop`; `git fetch && git switch -c feature/EPIC-0003-US-0070-voice-pipeline origin/develop`.
- [ ] **Step 2:** Read `docs/ID_REGISTRY.md` and take the next free ids (expected US-0070, TASK-0106, AC-0396.., TC-0162..; use the registry's actual values). File under EPIC-0003 (set it `In Progress`): **US-0070** "As a participant, I want what I say to appear under my name in the transcript, so that I can take part by voice" (Priority High, Estimate L, Planned → In Progress), TASK-0106 (Dev, Agent, this branch), and these ACs (each gets a TC in Task 21):
  - AC-a: a voice line from the current human holder who chose voice is recorded as an `utterance` with `channel: "voice"` and answered with its `seq`; the log format is unchanged.
  - AC-b: the runtime refuses a voice line for an AI role, an unknown or non-player role, a non-holder, a holder who has not chosen voice, while paused, between scenes and after the end, with the fixed codes of the overview; nothing is appended.
  - AC-c: a seat that is not a recording holder produces no segment, no STT request and no message (file-fed test).
  - AC-d: one speaker's lines are logged in segment order; a failed or empty segment produces no line, a speaker notice and a facilitator alert.
  - AC-e: the NPC round, the Game Master and AI-player bots react once per voice turn (`TURN_END_MS` after the last speech frame); a text line schedules at once; pause and end clear the timer.
  - AC-f: voice choice is per participant and never inherited across a reissue, a rebind or a restart; opt-out stops recording at once.
  - AC-g: any `SpeechToText` implementation passes one contract suite; the Whisper client sends only to loopback.
  - AC-h: a worker crash leaves the session running and alerts the facilitator.
  - AC-i: `pnpm demo --voice` runs the pipeline offline (file ingest, fake STT) and passes checks V-01 to V-08 in CI.
- [ ] **Step 3:** Add an "Assigned 2026-11-.. (EPIC-0003 voice A1a)" line to the registry; run `npx jest tests/unit/id-registry.test.js`. Expected: all pass.
- [ ] **Step 4:** Commit `[docs] US-0070: file the voice pipeline story and ids`.

### Task 1: `@acr/speech` package and the worker protocol

**Files:** Create `services/speech/package.json`, `services/speech/tsconfig.json`, `services/speech/vitest.config.ts`, `services/speech/src/protocol.ts`, `services/speech/src/__tests__/protocol.test.ts`, `services/speech/src/__tests__/imports.test.ts`; Modify `services/control/src/__tests__/bots/imports.test.ts` (add the speech rule); `pnpm-lock.yaml` (workspace link only).

**Interfaces:**
- Produces (`@acr/speech/protocol`): `WorkerMessageSchema`, `ControlToWorkerSchema` (zod discriminated unions, exact shapes in overview §1), types `WorkerMessage`, `ControlToWorker`, `VoiceHolder = { roleId: string; participantId: string; recording: boolean }`, `VoiceRefusal` (string union, overview §2), constants `MAX_VOICE_TEXT_CHARS = 2000`, `MAX_HOLDERS = 256`, `MAX_SILENT_MS = 60_000`; `SegmentIdSchema = z.string().refine(isFileSafeId)`.
- `package.json`: `"name": "@acr/speech"`, `"type": "module"`, `"exports": { "./protocol": "./src/protocol.ts" }`, scripts `typecheck`, `test`, `build` like `services/control/package.json`; dependencies `@acr/adapters`, `@acr/events` (`workspace:*`) and `zod` `4.6.7` (the version control pins); devDependencies copied exactly from `services/control/package.json`.
- `vitest.config.ts`: copy of `services/control/vitest.config.ts` (60 s timeouts, coverage threshold lines 80).

- [ ] **Step 1: Write the failing tests.**
  - `protocol.test.ts`: tables like `protocol.drift.test.ts:21-58`. Valid: each message of overview §1 with minimal fields; `speech_activity` with `active: false, silentMs: 0` and `60000`; `voice_state` with 0 and 256 holders; `voice_line_result` with `seq: 1` and with `refused: "not_holder"`. Invalid: unknown key on every type; `segmentId: "../x"`, `"A"`, 65 chars; `roleId: "facilitator"`; `text: ""` and 2001 chars; `silentMs` with `active: true`; `silentMs: -1`, `60001`, `1.5`; 257 holders; `voice_line_result` with both `seq` and `refused`, and with neither; `seq: 0`; `participantId: "rebind-pending"`.
  - `imports.test.ts` (reuse `specifiers()` from `services/control/src/__tests__/bots/imports.test.ts:17-19` by copying it): no source under `services/speech/src` imports `@acr/runtime`, `@acr/control`, `../../runtime` or `../../control`; `protocol.ts` imports only `zod` and `@acr/events`.
  - Control `imports.test.ts`: add `it("control imports @acr/speech only as @acr/speech/protocol")`.
- [ ] **Step 2:** Run `pnpm install && pnpm --filter @acr/speech exec vitest run src/__tests__/protocol.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `protocol.ts`. `RoleId` is built from `isScenarioId`/`isReservedRoleId`/`CLIENT_ID_MAX_CHARS` exactly as `parent-channel.ts:12`; `voice_line_result` is one `strictObject` with `seq` and `refused` optional plus a `.refine` that exactly one is present (or a `z.union` of two strict objects, implementer's choice, the tests decide).
- [ ] **Step 4:** Run the speech tests and `pnpm --filter @acr/control exec vitest run src/__tests__/bots/imports.test.ts` and `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: add the speech package and the worker protocol`.

### Task 2: Parent-channel voice messages and the drift test

**Files:** Modify `services/runtime/src/host/parent-channel.ts`, `services/control/src/protocol.ts`, `services/control/src/__tests__/protocol.drift.test.ts`, `services/runtime/src/host/__tests__/parent-channel.test.ts`.

**Interfaces:**
- Produces in both copies: `ParentMessageSchema` gains `voice_line`, `speech_activity`, `voice_notice`, `voice_alert`; `ChildMessageSchema` gains `voice_line_ack`, `voice_line_refused`, `voice_seats`, `voice_turn`, `voice_choice`, and `ready.voice: z.literal(true).optional()` (overview §2, exact fields). Exported constants `VOICE_REFUSALS`, `VOICE_ALERT_CODES` (readonly tuples) so later tasks use the same lists. `SegmentId` refines `isFileSafeId`.

- [ ] **Step 1: Write the failing tests.**
  - Drift test: extend `valid` with every new child message (incl. `ready` with `voice: true`, `voice_seats` with 0 and 256 holders, `voice_choice` with `choice: "text_only"`), extend `ok` with every new parent message; extend `invalid`/`bad` with: `ready` with `voice: false`; `voice_line` with `text: ""`, 2001 chars, `segmentId: "a/b"`, extra key; `speech_activity` with `silentMs` on `active: true`; `voice_notice` with `code: "paused"` (only `stt_failed`/`empty` come from control); `voice_alert` with `code: "nope"` and with a `message`; `voice_line_ack` with `seq: 0`; `voice_line_refused` with `code: "other"`; `voice_turn` with `open: "true"`; `voice_choice` with `choice: "voice_only"` and with `at: -1`.
  - `parent-channel.test.ts`: `an older runtime drops a parent message it does not know without throwing or answering` (feed `{type: "voice_line", ...}` to a channel built over a fake `proc` whose schema is the PRE-change one: assert by sending an unknown `{type: "voice_future"}` that `onMessage` never fires and `send` is never called). Pins F3.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/protocol.drift.test.ts` and `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/parent-channel.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Add the schemas to both files, identical text. `main.ts`'s `fail()` (`services/runtime/src/main.ts:261-265`) gets the new fire-and-forget types beside `bot_alert` (no reply) and `voice_line` replies `voice_line_refused { code: "failed" }`; `answer()` ignores the new types for now (Tasks 6, 7, 10 wire them). Control's `goLive` handler ignores the new child types for now (Task 19).
- [ ] **Step 4:** Re-run both files and `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: voice messages on the parent channel with drift tests`.

### Task 3: Voice settings, refusals and the draft notice v3

**Files:** Create `services/runtime/src/host/voice-config.ts`, `services/runtime/src/host/__tests__/voice-config.test.ts`, `consent/notice-v3.md`, `services/runtime/src/engine/__tests__/consent-notice-v3.test.ts`; Modify `services/runtime/src/host/limits.ts`, `services/runtime/src/main.ts` (after `:128`), `services/control/src/child-env.ts`, `services/control/src/__tests__/child-env.test.ts`, `services/runtime/src/__tests__/main*.test.ts` (the bootstrap refusal tests).

**Interfaces:**
- Produces `noticeNamesVoice(version: string): boolean` in `limits.ts` (`v<n>`, n >= 3; same parse as `noticeNamesAiPlayers`, `limits.ts:15-18`, no new regex: reuse the existing one through a shared private helper).
- Produces `type VoiceConfig = { enabled: false } | { enabled: true; turnEndMs: number }` and `parseVoiceConfig(env: NodeJS.ProcessEnv, o: { managed: boolean; noticeVersion: string }): ({ ok: true } & VoiceConfig) | { ok: false; errors: string[] }` in `voice-config.ts`. `VOICE_ENABLED` accepts `0`/`1` (default 0, via `parseRetryEnv` as `gm-config.ts:39` does); `TURN_END_MS` 300 to 3000, default 800. Fixed error sentences: `VOICE_ENABLED=1 needs a session started by the control service (CONTROL_MANAGED=1)`; `VOICE_ENABLED=1 needs a consent notice that describes voice recording (CONSENT_NOTICE_VERSION v3 or later)`.
- `bootstrap` holds `voice: VoiceConfig` and passes it to `SessionHost` (option `voice?: VoiceConfig`, default `{ enabled: false }`); `ready` carries `voice: true` only when enabled.
- `CHILD_ENV_ALLOWLIST.names` gains `"VOICE_ENABLED"`, `"TURN_END_MS"` (`child-env.ts:9-13`).
- `consent/notice-v3.md`: the v2 text plus the voice paragraphs of spec §6 (converted to text live; recorded; kept until the facilitator deletes it and deleted automatically the first time the application runs after 30 days; only the facilitator can hear it; the participant can ask for deletion; deletion applies to the session folder on the host computer, not to backups; use a headset in a private place, others nearby may be recorded; the choice "take part with voice" or "take part by text only"). First line of the file body: `Draft for legal and HR review; not for use with participants until signed off.` A1b replaces the file (Open Question 1).

- [ ] **Step 1: Write the failing tests.**
  - `voice-config.test.ts`: default disabled; `VOICE_ENABLED=1` + managed + `v3` gives `{enabled: true, turnEndMs: 800}`; `TURN_END_MS=299`, `3001`, `abc` are errors naming the variable only; `VOICE_ENABLED=1` unmanaged gives the first sentence; with `v2` the second; `VOICE_ENABLED=2` an error; `noticeNamesVoice("v3")`, `("v10")` true, `("v2")`, `("v3a")`, `("V3")` false.
  - Bootstrap tests (in the existing bootstrap test file that covers `CONSENT_NOTICE_VERSION`): `VOICE_ENABLED=1 without CONTROL_MANAGED refuses to start and opens no log`; `with CONTROL_MANAGED=1 and notice v2 refuses`; `with v3 starts and ready carries voice: true` (use the existing fake `parent`); `VOICE_ENABLED unset: ready has no voice key`.
  - `consent-notice-v3.test.ts`: `loadConsentNotice(<repo>/consent, "v3")` loads; the text contains "take part with voice", "take part by text only", "30 days", "only the facilitator"; `notice-v1.md` SHA test still passes (unchanged).
  - `child-env.test.ts`: `VOICE_ENABLED` and `TURN_END_MS` are copied; `VOICE_HANGOVER_MS`, `STT_URL`, `LIVEKIT_API_SECRET` are not.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/voice-config.test.ts src/engine/__tests__/consent-notice-v3.test.ts` and the control env test. Expected: FAIL.
- [ ] **Step 3:** Implement. In `main.ts`, call `parseVoiceConfig` right after the managed cap check (`:128`), with `noticeVersion` from `:115`.
- [ ] **Step 4:** Re-run, plus `pnpm --filter @acr/runtime test` and `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: voice settings, start refusals and a draft notice v3`.

### Task 4: The voice record file (option A; under option B this task becomes a test-only `voiceRecording` hook)

**Files:** Create `services/runtime/src/engine/voice-file.ts`, `services/runtime/src/engine/__tests__/voice-file.test.ts`.

**Interfaces:**
- Produces:
  - `voiceFileName(sessionId: string): string` → `<sessionId>.voice.json` (calls `assertSessionId`, `log-files.ts`).
  - `type VoiceChoice = "voice" | "text_only"`; `type VoiceEntry = { participantId: string; choice: VoiceChoice; noticeVersion: string; at: number }`.
  - `class VoiceChoices { static empty(bind: { sessionId: string; logIdentity: string }): VoiceChoices; static fromRecord(raw: unknown, bind): VoiceChoices /* throws VoiceRecordError, message never quotes the record */; set(roleId, entry: VoiceEntry): void; remove(roleId): boolean; entry(roleId): VoiceEntry | undefined; choiceFor(roleId: string, holder: string | undefined): "none" | VoiceChoice /* "text_only" when the entry names another participant */; toRecord(): object }`.
  - `readVoiceFile(dir, bind): { choices: VoiceChoices; problem?: "malformed" | "other_log" }` (missing → empty, no problem; malformed or mis-bound → empty with the problem; never throws for content; I/O errors other than ENOENT throw); `writeVoiceFile(dir, bind, choices, beforeCommit?)` and `removeVoiceFile(dir, sessionId)` via `writeSecureJson`/`removeSecureFile` (`secure-json-file.ts:56,85`), max read 64 KiB.

- [ ] **Step 1: Write the failing tests** (private temp dir per file, `mkdtemp` under a `TMPDIR` set in `beforeAll`): `a missing file reads as no choices`; `a written record reads back equal and the file is 0600` (read mode from ONE `open` + `fstat`, CodeQL rule); `a record for another logIdentity reads as no choices with problem other_log`; `extra key, missing key, v: 2, a non-string participantId, a choice "voice_only", a reserved role id (__proto__) and an entry for "rebind-pending" read as malformed`; `choiceFor returns none without an entry, the choice for the same participant and text_only for another participant`; `a symlink at the file path is refused, never followed`; `a file larger than 64 KiB is malformed`; `voiceFileName refuses a hostile session id before touching the disk` (reuse the HOSTILE list idea from `id-rules.files.test.ts:21`).
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/engine/__tests__/voice-file.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with the strict key check style of `consent.ts:116-130` (sorted keys joined), `isReservedRoleId`, `CLIENT_ID_MAX_CHARS`, `isNoticeVersion`, `HEX32` as in `credentials.ts`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: the per-session voice record file`.

### Task 5: Opting in and out, the seat state and never inheriting (option A)

**Files:** Modify `services/runtime/src/host/protocol.ts` (ClientMessage and ServerMessage additions, overview §3), `services/runtime/src/host/ws-server.ts` (handlers next to consent, `:403-424`), `services/runtime/src/host/session-host.ts`, `services/runtime/src/host/reissue.ts`, `services/runtime/src/main.ts`; Create `services/runtime/src/host/voice.ts` (the `voiceSeats` part), `services/runtime/src/host/__tests__/voice-choice.test.ts`, `services/runtime/src/host/__tests__/ws-voice.test.ts`.

**Interfaces:**
- Consumes: `VoiceChoices`, `readVoiceFile`, `writeVoiceFile`, `removeVoiceFile` (Task 4); `noticeNamesVoice` (Task 3).
- Produces on `SessionHost`:
  - `voiceStateOf(roleId: string): "none" | "voice" | "text_only" | "off"` (`off` when voice is disabled or the seat is AI; otherwise `choiceFor(roleId, holder)`).
  - `optInVoice(roleId: string, participantId: string, noticeVersion: string): void` — throws `HostError` `voice_off`, `forbidden` (AI seat), `not_joined` (not the holder, `holds`, `session-host.ts:280`), `consent_version` (not the current notice), `voice_notice_required` (the participant's consent entry is missing or its `noticeVersion` fails `noticeNamesVoice`; C10); sets the entry `{choice: "voice", noticeVersion, at: clock.now()}`, writes the file; on a write failure takes the entry back and throws (fail closed: not recording).
  - `optOutVoice(roleId, participantId): void` — `voice_off`, `forbidden`, `not_joined`; sets `text_only` in memory FIRST, then writes; on a write failure calls `removeVoiceFile`; if that also fails, pins the role to `off` for this process (`voiceBlocked: Set<string>`), raises a facilitator alert `voice choice could not be saved; voice is off for <role> until the session restarts`, and does not throw (recording has stopped either way).
  - `voiceSeats(): { paused: boolean; ended: boolean; holders: VoiceHolder[] }` (in `voice.ts`, pure over host state: every human player role with a holder; `recording = voiceStateOf(role) === "voice" && !voiceBlocked.has(role)`).
  - `onVoiceSeatsChanged(fn: (s: ReturnType<SessionHost["voiceSeats"]>) => void): () => void` — fired, coalesced with `queueMicrotask`, after a join, release, leave, withdraw, reissue, opt-in, opt-out, pause, resume and session end.
  - `onVoiceChoice(fn: (c: { roleId; participantId; choice; at }) => void)` — after a successful opt-in or opt-out write.
- `reissueRole` (`reissue.ts:53`): after revoking the credential, `d.host.forgetVoice(roleId)` removes the entry and writes the file (a failure is reported by name and leaves the role `text_only` because the new holder's id differs anyway).
- `main.ts`: when `parent` and voice enabled, subscribe and send `voice_seats` (once right after `ready`, then on every change) and `voice_choice`.
- WebSocket: `voice_opt_in`/`voice_opt_out` from a player socket call the host methods; success sends `{type: "voice", state}` to that socket only; refusals use the `error` frame with the codes above; the facilitator socket gets `forbidden`. A player's `joined` gains `voice: { state }` when the server keeps seats and the seat is human (never another role's).

- [ ] **Step 1: Write the failing tests.**
  - `voice-choice.test.ts` (host with fake seats, `FakeClock`, temp dir): `opt-in by the holder records voice and voiceSeats shows recording true`; `opt-in is refused voice_off when voice is disabled`, `forbidden for an AI seat`, `not_joined for a non-holder`, `consent_version for another notice version`, `voice_notice_required when the participant consented to v2 (adopted after the start)`; `opt-out stops recording at once even when the file write fails` (inject a failing writer: `voiceSeats().holders[0].recording` is false immediately and the file is gone); `opt-out with write AND remove failing keeps the role off and appends one facilitator alert`; **never inherited:** `after a reissue the next participant is text_only and the old entry is deleted`, `after a rebind (claimRebind) the new holder is text_only`, `after a restart the record still applies to the same participant and only to them`, `a record whose logIdentity differs (fresh start on an old id) is ignored and removed`, `R14 seeding of consent never creates a voice entry`; `voice_seats changes are coalesced into one notification per turn`; `voiceSeats lists holders in scenario player order and never an AI seat or an NPC`.
  - `ws-voice.test.ts` (real `startServer` on port 0, the pattern of the existing ws tests, `vi.setConfig({ testTimeout: 90_000 })`): `a player's voice_opt_in answers {type: "voice", state: "voice"} to that socket only`, `another player's socket receives no voice frame`, `joined.voice carries only the joining player's own state`, `the facilitator's voice_opt_in is forbidden`, `voice_opt_in with an extra key is bad_message`.
- [ ] **Step 2:** Run both files with `pnpm --filter @acr/runtime exec vitest run <file>`. Expected: FAIL.
- [ ] **Step 3:** Implement; the host reads the voice file at construction when `seats` exist (bind `{sessionId, logIdentity: seats.credentials.logIdentity}`) and reports a `problem` with a fixed sentence.
- [ ] **Step 4:** Re-run, plus `pnpm --filter @acr/runtime exec vitest run src/host`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: voice opt-in and opt-out, never inherited`.

### Task 6: Voice lines through `onVoiceUtterance`

**Files:** Modify `services/runtime/src/host/session-host.ts` (beside `onPlayerUtterance`, `:395-404`), `services/runtime/src/main.ts` (`answer`, `:266-282`); Create `services/runtime/src/host/__tests__/voice-line.test.ts`, `services/runtime/src/__tests__/main.voice-line.test.ts`.

**Interfaces:**
- Consumes: `voiceStateOf`, `holds` (Task 5), `VOICE_REFUSALS` (Task 2).
- Produces `SessionHost.onVoiceUtterance(roleId: string, participantId: string, text: string): Promise<{ seq: number }>` throwing `VoiceRefusedError { code: VoiceRefusal }`. Order of checks: voice disabled → `voice_off`; not started (after awaiting a start in flight, as `:399`) → `not_started`; not an own-property player role → `unknown_role`; AI seat → `ai_role`; `!holds(roleId, participantId)` → `not_holder`; `voiceStateOf(roleId) !== "voice"` or blocked → `not_recording`; then `engine.say(roleId, text, "voice")` mapping `EngineError` `paused` → `paused`, `not_in_scene`/`stale_scene` → `not_in_scene`, `ended` → `ended`, anything else → `failed` (and a fatal log failure stays fatal). On success: `pendingAnswer = null`, hand the line to the turn tracker (Task 7; until then call `scheduleRound()`), return `{ seq: event.seq }`.
- `main.ts` `answer()`: `voice_line` → `host.onVoiceUtterance(...)` then `parent.send({type: "voice_line_ack", segmentId, seq})`, or on `VoiceRefusedError` `voice_line_refused {segmentId, code}`, on anything else `code: "failed"`. Exactly one answer per message, never a thrown handler.

- [ ] **Step 1: Write the failing tests.**
  - `voice-line.test.ts` (host over a real engine on a temp log, mock providers): `a holder who chose voice is recorded with channel voice and the returned seq equals the event's seq`; refusal table, each asserting the code AND that the log length is unchanged: `voice_off`, `not_started`, `unknown_role` (`__proto__`, `constructor`, an NPC id gives `unknown_role` too), `ai_role`, `not_holder` (another participant id), `not_recording` (holder without a choice, holder with `text_only`), `paused`, `not_in_scene` (between scenes; role outside the scene), `ended`; `a reissue between segment and line: the old participant's line is not_holder` (Review Focus 3); `a voice line's utterance reaches players exactly like a text line and no player frame carries segmentId or participantId` (leak scan over every player frame of the test, Review Focus and spec §13).
  - `main.voice-line.test.ts` (bootstrap with a fake parent): `voice_line answers voice_line_ack with the seq`; `a refused line answers voice_line_refused with the code`; `an internal failure answers failed`; `every voice_line gets exactly one answer` (send 5, count 5).
- [ ] **Step 2:** Run both. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, plus `pnpm --filter @acr/runtime exec vitest run src/host src/__tests__/main`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: record voice lines through a new host method`.

### Task 7: Turn-taking: `speech_activity`, the turn timer and `voice_turn`

**Files:** Modify `services/runtime/src/host/voice.ts`, `services/runtime/src/host/session-host.ts`, `services/runtime/src/main.ts`; Create `services/runtime/src/host/__tests__/voice-turn.test.ts`.

**Interfaces:**
- Produces in `voice.ts`: `type SetTimer = (fn: () => void, ms: number) => () => void` (the Supervisor's shape, `supervisor.ts:36`) and `class VoiceTurnTracker { constructor(o: { turnEndMs: number; setTimer: SetTimer; onTurnEnd: () => void; onOpenChange: (open: boolean) => void }); activity(roleId: string, active: boolean, silentMs?: number): void; textLine(): void; clear(): void; get open(): boolean; get closedTurnEnds(): readonly number[] }`. Rules:
  - `open` is true while any role is active or the timer is pending; `onOpenChange` fires only on changes.
  - `active: true` for a role cancels a pending timer; `active: false` marks the role silent and, when no role is active, arms the timer for `max(0, turnEndMs - (silentMs ?? 0))`; a later `false` with no active role re-arms from its own `silentMs`.
  - Timer fire → `onTurnEnd()`; `textLine()` cancels a pending timer and calls `onTurnEnd()` at once; `clear()` (pause, end) cancels the timer, forgets active roles, closes without calling `onTurnEnd`.
- `SessionHost` gains option `setTimer?: SetTimer` (default `setTimeout(...).unref()`), `onSpeechActivity(roleId, active, silentMs?)` (ignored unless voice enabled, started, not paused, and `roleId` is a recording holder), and a `voiceChain: Promise<void>` that every `onVoiceUtterance` extends; `onTurnEnd` runs `voiceChain.then(() => { recordTurnEnd(lastSeq); scheduleRound(); })`, so the round starts only after every received voice line is recorded (C3). `onVoiceUtterance` no longer calls `scheduleRound()` directly: when the tracker is closed (no speech, no timer), the line itself ends the turn (`onTurnEnd` path); otherwise the pending timer will. `onPlayerUtterance` calls `tracker.textLine()` before `scheduleRound()` (which keeps "at most one waiting", `:406-409`). `command("pause")` and end call `tracker.clear()`.
- `onVoiceTurn(fn: (open: boolean) => void)`; `main.ts` sends `voice_turn {open}` on each change and routes `speech_activity` to `onSpeechActivity` (fire-and-forget).

- [ ] **Step 1: Write the failing tests** (`voice-turn.test.ts`, a manual `SetTimer` that records `[fn, ms]` and fires on demand; no real time):
  - Tracker: `a false edge with silentMs 500 arms 300 ms when turnEndMs is 800`; `silentMs above turnEndMs arms 0`; `new speech on any role cancels the timer`; `two speakers: the timer arms only when both are silent`; `textLine ends the turn at once and cancels the timer`; `clear closes without onTurnEnd`; `onOpenChange fires once per change`.
  - Host: `two voice lines then a false edge run ONE round after the timer`; `the round waits for a voice line still being recorded` (hold `engine.say` with a deferred; fire the timer; the round has not started; release; exactly one round); `a voice line arriving with no speech active and no timer schedules a round at once`; `a text line during an open voice turn runs a round at once and the later timer adds at most one more` (R25); `pause clears the timer and no round runs; resume does not start one`; `end clears it`; `speech_activity for a non-recording role is ignored`; `a running round is not interrupted by new speech`; `voice_turn open/close is sent in order` (main with fake parent).
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/voice-turn.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/runtime exec vitest run src/host`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: one NPC round per voice turn`.

### Task 8: Game Master cadence by voice turn

**Files:** Modify `services/runtime/src/agents/game-master.ts` (`tick` `:89-111`, `finalEvaluation` `:119-138`), `services/runtime/src/host/voice.ts`, `services/runtime/src/host/session-host.ts` (construction and `:315`); Create `services/runtime/src/agents/__tests__/game-master.voice.test.ts`.

**Interfaces:**
- Produces `gmUnits(sceneLines: { seq: number; channel: Channel }[], closedTurnEnds: readonly number[]): number` in `voice.ts`: each non-voice line counts 1; voice lines count 1 per closed turn that holds at least one of them (a turn = the voice lines with seq above the previous boundary and at most this boundary); voice lines after the last boundary count 0 (open turn). With `closedTurnEnds` empty (after a restart) each maximal run of consecutive voice lines counts 1, except a trailing run while the tracker is open.
- `GameMaster` options `units?: (lines: Utterance[]) => number` (default `lines.length`) and `hold?: () => boolean` (default false): `tick` and `finalEvaluation` use `units(sceneLines)` where they used `.length` (`:95`, `:126`) and skip evaluation (not `engine.tick`) while `hold()` is true. `SessionHost` passes `units: (l) => gmUnits(l, tracker.closedTurnEnds)` and `hold: () => tracker.open` when voice is enabled, and computes the restore count (`:315`) with the same `units` over the lines before `lastGmSeq`.

- [ ] **Step 1: Write the failing tests:** `gmUnits counts text lines one each`; `six voice segments in one closed turn count one`; `two closed turns count two`; `an open turn counts zero`; `NPC lines inside a voice turn count one each and do not split the turn`; `with no boundaries consecutive voice runs count one each`; GameMaster with a fake engine and a counting provider: `with everyN 3, nine voice segments in three turns cause one evaluation, not three` (spec §7.5); `no evaluation while hold() is true, and the next tick after release evaluates`; `restore uses units, so a restart does not evaluate earlier than without one`; `text-only sessions are unchanged` (default options; the existing GM tests pass untouched).
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/agents/__tests__/game-master.voice.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/runtime exec vitest run src/agents`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: the Game Master counts voice turns`.

### Task 9: AI-player bots wake once per voice turn

**Files:** Modify `services/control/src/bots/bot.ts` (`onUtterance` `:288-299`, `arm` `:319-325`), `services/control/src/bots/bot-host.ts`; Create `services/control/src/__tests__/bots/bot.voice-turn.test.ts`.

**Interfaces:**
- Produces `BotHost.voiceTurn(sessionId: string, open: boolean): void` (never throws; unknown session is a no-op) and `Bot.setVoiceTurn(open: boolean): void`. While open: `arm()` sets no wake; human lines are added to the view (`lines`) but their `observe` is deferred, keeping only the last deferred human line; on close: one `observe({ kind: "line", roleId: <last human speaker>, ai: false })` if any was deferred, then `arm()`. AI lines (own and other bots') are observed as now. The reservation hold (`setHeld`, `bot.ts:157`) is untouched and independent. A pause or end observed while open drops the deferred line.

- [ ] **Step 1: Write the failing tests** (the existing bot test harness with a fake socket, `FakeClock`-style `now` and manual `setTimer`): `three human lines in an open voice turn give one reply after close`; `no wake is armed while open`; `a prompted turn (reservation) still runs while a voice turn is open` (prompt bypasses hold, `turn-policy.ts:141`); `closing with no deferred line only re-arms`; `releasing a reservation does not end the voice hold`; `BotHost.voiceTurn for an unknown session does nothing`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/bots/bot.voice-turn.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (the call from control's child-message handler is wired in Task 19).
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/control exec vitest run src/__tests__/bots`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: AI players wake once per voice turn`.

### Task 10: Speaker notices and facilitator alerts

**Files:** Modify `services/runtime/src/host/protocol.ts`, `ws-server.ts`, `session-host.ts`, `main.ts`; Create `services/runtime/src/host/__tests__/voice-notice.test.ts`.

**Interfaces:**
- Produces `SessionHost.voiceNotice(roleId: string, participantId: string, code: VoiceNoticeCode): void` (sent only when `holds(roleId, participantId)`; rate-limited to one per role and code per `NOTICE_MIN_INTERVAL_MS` 10 000 on the host clock; never logged) and `onVoiceNotice(fn: (roleId, code) => void)` used by `ws-server.ts` to send `{type: "voice_notice", code}` to that role's live player sockets only. Refusals from Task 6 that a speaker should hear (`paused`, `not_in_scene`, `ended`, `not_recording`) produce a notice; `not_holder`, `ai_role`, `unknown_role`, `voice_off`, `not_started` do not (no such speaker is listening).
- Produces `SessionHost.voiceAlert(code: VoiceAlertCode): Promise<void>`: one facilitator-only `engine.alert` with a FIXED sentence per code (`worker_down`: "Voice input stopped: the speech worker is not running. Participants can continue by text."; `stt_unavailable`: "Voice input is unavailable: the speech-to-text server does not answer."; `stt_failed`: "A spoken line could not be transcribed; the speaker was told."), at most one per code per `ALERT_MIN_INTERVAL_MS` 30 000; nothing before the start or after the end (as `noteFacilitator`, `session-host.ts:192-196`).
- `main.ts` routes parent `voice_notice` and `voice_alert` (fire-and-forget).

- [ ] **Step 1: Write the failing tests:** `a voice_notice reaches only the speaker's socket`; `it is not in the log, not in another player's frames, not in the facilitator's events` (scan); `a second notice of the same code within 10 s is dropped, after 10 s it is sent` (host clock); `a notice for a non-holder is dropped`; `voice_alert appends one facilitator.alert with the fixed sentence and none within 30 s`; `no alert before the start`; `a player never receives a facilitator.alert` (existing `viewFor`, regression guard).
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/runtime test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: private speaker notices and voice alerts`.

### Task 11: `SpeechToText` adapter: types, errors, fake and the contract suite

**Files:** Create `packages/adapters/src/speech/types.ts`, `errors.ts`, `fake.ts`, `contract.ts`, `__tests__/fake.contract.test.ts`, `__tests__/errors.test.ts`; Modify `packages/adapters/src/index.ts`.

**Interfaces:**
- `type SpeechSegment = { id: string; pcm: Int16Array; sampleRate: 16000; deadline: number /* absolute, injected clock */ }`.
- `type Transcript = { text: string; durationMs: number; noSpeechProb?: number; avgLogprob?: number }`.
- `interface SpeechToText { transcribe(seg: SpeechSegment, signal?: AbortSignal): Promise<Transcript>; health(signal?: AbortSignal): Promise<boolean>; warmUp(signal?: AbortSignal): Promise<void> }`.
- Errors (`errors.ts`): `class SpeechUnavailableError` (connection refused, 5xx; transient), `SpeechTimeoutError` (deadline or abort; transient), `SpeechRefusedError` (4xx, malformed answer; not transient); each `extends Error` with `readonly transient: boolean` and `name` set; messages are fixed sentences (no URL, no body).
- `FakeSpeechToText` (`fake.ts`): `constructor(o: { script: (seg: SpeechSegment, call: number) => Transcript | Error | Promise<Transcript | Error> })` plus `calls: string[]` (segment ids in call order). Used by every pipeline test and the demo.
- `speechToTextContract(name: string, make: () => Promise<{ stt: SpeechToText; control: ContractControl; close(): Promise<void> }>)` (`contract.ts`, a `describe` block like `modelProviderContract`, `packages/adapters/src/index.ts:5`), where `ContractControl = { answer(text: string, extra?: Partial<Transcript>): void; fail(kind: "unavailable" | "refused" | "hang"): void }`. Cases: returns the scripted text and a non-negative `durationMs`; empty audio (0 samples) gives text `""` or a `SpeechRefusedError`, never a throw of another type; unavailable gives `SpeechUnavailableError`; refused gives `SpeechRefusedError`; a hang past the deadline gives `SpeechTimeoutError` within the deadline (the control fires the abort; no real waiting); an aborted signal gives `SpeechTimeoutError`; `health()` is true when up and false when unavailable, never throws; the text is a string with no leading or trailing whitespace.

- [ ] **Step 1: Write the failing tests:** `fake.contract.test.ts` runs `speechToTextContract("fake", ...)`; `errors.test.ts`: `transient is true for Unavailable and Timeout, false for Refused`; `messages contain no URL` (construct each with a cause that holds a URL).
- [ ] **Step 2:** Run `pnpm --filter @acr/adapters exec vitest run src/speech`. Expected: FAIL.
- [ ] **Step 3:** Implement; export from `index.ts`.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: speech-to-text adapter interface and contract suite`.

### Task 12: The local Whisper HTTP client and WAV encoding

**Files:** Create `packages/adapters/src/speech/whisper-http.ts`, `packages/adapters/src/speech/wav.ts`, `packages/adapters/src/speech/__tests__/whisper-http.test.ts`, `__tests__/whisper.contract.test.ts`, `__tests__/wav.test.ts`, `__tests__/whisper.live.test.ts` (skipped unless `STT_LIVE=1`).

**Interfaces:**
- `encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array` and `decodeWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number }` (RIFF, `fmt ` PCM 1 channel 16 bit; anything else throws `RangeError` with a fixed sentence) in `wav.ts` (the worker imports them from `@acr/adapters`).
- `parseSttUrl(raw: string | undefined): { ok: true; url: URL } | { ok: false; error: string }`: `http:` only, host exactly `127.0.0.1` or `[::1]`, a port, an optional path prefix, no user info, no query or fragment (errors name `STT_URL` only).
- `class WhisperHttpSpeechToText implements SpeechToText { constructor(o: { url: URL; fetch?: typeof fetch; now?: () => number }) }`: `transcribe` POSTs `multipart/form-data` to `<url>/inference` with `file` (the WAV), `response_format=verbose_json`, `temperature=0.0`; reads at most 256 KiB of body; maps: network error/5xx → Unavailable, 4xx or unparsable → Refused, abort/deadline → Timeout. Parses `text` (trimmed) and, defensively, `segments[].no_speech_prob` (max over segments) and `segments[].avg_logprob` (duration-weighted mean), each only when finite numbers (F1; layout unverified). `health` GETs `<url>/health` with a 2 s abort, true only on 200. `warmUp` transcribes 1 s of silence once and ignores the text. The URL, the body and the response are never logged.

- [ ] **Step 1: Write the failing tests:**
  - `wav.test.ts`: `encode then decode is identity for random samples`; `header fields are little-endian 16 kHz mono 16-bit`; `a stereo or 8-bit file is refused`; `a truncated file is refused`.
  - `whisper-http.test.ts` (a real `node:http` server on `127.0.0.1:0` in the test; `vi.setConfig({ testTimeout: 90_000 })`): `parseSttUrl accepts http://127.0.0.1:9000 and http://[::1]:9000/abc and refuses localhost, 0.0.0.0, a LAN address, https, a query and user info`; `the request is multipart with file, response_format=verbose_json and temperature`; `verbose_json with segments gives noSpeechProb and avgLogprob`; `a json answer with only text leaves both undefined`; `NaN or string probabilities are ignored`; `a 503 is Unavailable, a 400 is Refused, HTML is Refused, a 300 KiB body is Refused`; `a server that never answers gives Timeout when the signal aborts` (abort by hand, no sleep); `health is false on a refused connection` (a closed port).
  - `whisper.contract.test.ts`: `speechToTextContract("whisper-http", ...)` against the same test server, scripted by `ContractControl`.
  - `whisper.live.test.ts`: `describe.skipIf(process.env.STT_LIVE !== "1")`: against `STT_URL`, transcribes a 1 s silence and checks the answer parses (records whether `no_speech_prob` and `avg_logprob` were present: this is the opt-in check that resolves F1).
- [ ] **Step 2:** Run `pnpm --filter @acr/adapters exec vitest run src/speech`. Expected: FAIL.
- [ ] **Step 3:** Implement with global `fetch`, `FormData`, `Blob`.
- [ ] **Step 4:** Re-run. Expected: PASS (live test skipped).
- [ ] **Step 5:** Commit `[feat] US-0070: local Whisper client on loopback only`.

### Task 13: Deadlines, retries and the in-flight cap

**Files:** Create `packages/adapters/src/speech/limited.ts`, `packages/adapters/src/speech/__tests__/limited.test.ts`.

**Interfaces:**
- `class LimitedSpeechToText implements SpeechToText { constructor(inner: SpeechToText, o: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; setTimer: (fn: () => void, ms: number) => () => void; maxInFlight?: number /* 2 */; maxRetries?: number /* 2 */; baseMs?: number /* 150 */; queueAlertAt?: number /* 16 */; onQueueAlert?: () => void }) }` and `get queued(): number`, `get inFlight(): number`.
- Rules: at most `maxInFlight` inner calls; FIFO queue beyond that (no drop: an item whose deadline passes while queued fails with `SpeechTimeoutError` without calling inner); each call gets an `AbortSignal` that fires at `seg.deadline` (via `setTimer`); transient errors retry after `baseMs * 2^(n-1)` (150, 300), never past the deadline (a retry that cannot start before the deadline fails with the last error); `SpeechRefusedError` never retries; `onQueueAlert` fires once each time `queued` reaches `queueAlertAt`.

- [ ] **Step 1: Write the failing tests** (fake inner, manual timers, recorded sleeps): `three calls with maxInFlight 2 start two, then the third after one finishes`; `a transient failure retries at 150 then 300 and succeeds`; `retries stop at 2`; `Refused is not retried`; `a retry that would end after the deadline is not attempted` (deadline 200 ms after start, first failure at 100: no 150 ms sleep); `a queued item past its deadline fails Timeout without calling inner`; `the deadline aborts an in-flight call`; `onQueueAlert fires once at 16`; and the contract: `speechToTextContract("limited(fake)", ...)`.
- [ ] **Step 2:** Run `pnpm --filter @acr/adapters exec vitest run src/speech/__tests__/limited.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: bounded retries and an in-flight cap for speech-to-text`.

### Task 14: The segmenter

**Files:** Create `services/speech/src/segmenter.ts`, `services/speech/src/__tests__/segmenter.test.ts`, `services/speech/src/__tests__/signals.ts` (test helper: `tone(ms, dbfs)`, `silence(ms)`, `concat(...)`, at 16 kHz).

**Interfaces:**
- `type SegmenterSettings = { hangoverMs: number /* 300..600 */; maxSegmentMs: number /* 2000..6000 */; frameMs: 20; thresholdDbfs: -45; leadInMs: 200; minSpeechMs: 300; splitSearchMs: 1000 }` and `DEFAULT_SEGMENTER` (`hangoverMs` 500, `maxSegmentMs` 2500).
- `type SegmentOut = { pcm: Int16Array; startMs: number; endMs: number; speechMs: number; lastSpeechMs: number; reason: "silence" | "split" | "flush"; meanDbfs: number }` (times are stream milliseconds from the first frame pushed).
- `class Segmenter { constructor(s: SegmenterSettings); push(frame: Int16Array /* exactly frameMs of samples */): { started?: true; segments: SegmentOut[] }; flush(): SegmentOut[]; discard(): void; get speaking(): boolean }`.
- Algorithm (what the tests pin): a frame is speech when its RMS is at or above `thresholdDbfs`; a segment starts at the first speech frame and includes up to `leadInMs` of the frames before it; it closes after `hangoverMs` of continuous non-speech (`reason: "silence"`; the segment's audio ends with those hangover frames, `endMs` is the end of the last hangover frame and `lastSpeechMs` the end of the last speech frame); a segment whose speech frames total less than `minSpeechMs` is not emitted; when a segment reaches `maxSegmentMs` while speaking it is split after the quietest frame within its last `splitSearchMs` (ties: the latest frame), `reason: "split"`, and the remainder begins the next segment with no lead-in duplicated; `flush()` emits an open segment as `reason: "flush"` (subject to `minSpeechMs`); `discard()` drops the open segment and the lead-in buffer.

- [ ] **Step 1: Write the failing tests** (synthetic signals only): `1 s tone between silences gives one segment with 200 ms lead-in and endMs one hangover after the tone`; `a 250 ms tone is dropped (under minSpeechMs)`; `two tones 400 ms apart with hangover 500 merge into one; 600 ms apart split into two`; `a 7 s tone with maxSegmentMs 2500 splits at 2500 and 5000 when the signal is flat (latest frame wins the tie)`; `a 7 s tone with a 40 ms dip at 2.1 s splits at the dip`; `total samples out equal samples in minus the dropped silence (no duplication across a split)`; `flush emits the open segment`; `discard drops it and the next tone starts fresh`; `started is reported once per segment start`; `settings outside the ranges throw RangeError`.
- [ ] **Step 2:** Run `pnpm --filter @acr/speech exec vitest run src/__tests__/segmenter.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (pure; no clock).
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: energy segmenter with forced splits`.

### Task 15: The noise gate

**Files:** Create `services/speech/src/noise-gate.ts`, `services/speech/src/__tests__/noise-gate.test.ts`.

**Interfaces:** `gate(seg: { speechMs: number; meanDbfs: number }, t: Transcript): { keep: true } | { keep: false; reason: "empty" | "low_energy" | "no_speech" | "low_confidence" }` with the constants of the overview (`GATE_MIN_RMS_DBFS` -50, `GATE_NO_SPEECH_PROB` 0.6, `GATE_AVG_LOGPROB` -1.0, `GATE_SHORT_MS` 400). Rules in order: blank text (after trim) → `empty`; `meanDbfs < -50` → `low_energy`; `noSpeechProb > 0.6` → `no_speech`; `avgLogprob < -1.0` → `low_confidence`; a segment shorter than 400 ms of speech is dropped when `noSpeechProb > 0.3` or `avgLogprob < -0.7` (the "very short combined with those" rule). When the scores are absent (F1 not confirmed) only blank text and energy apply. No phrase list.

- [ ] **Step 1: Write the failing tests:** one per rule; `"Thank you." with good scores is kept` (no blocklist); `absent scores: only empty and energy apply`; `a short segment with good scores is kept`.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: noise gate on signal, not phrases`.

### Task 16: The conservative transcript cleaner

**Files:** Create `services/speech/src/normalise.ts`, `services/speech/src/__tests__/normalise.test.ts`.

**Interfaces:** `normalise(raw: string): string`, deterministic and idempotent (`normalise(normalise(x)) === normalise(x)`). **Owner decision 2026-11-08: conservative, it never rewrites words.** Rules (table-driven tests are the specification): strip control, bidi and zero-width characters (reuse the cleaner used by `cleanFacilitatorLabel` if it is exported from `@acr/events`, else write one with Unicode property escapes `\p{Cc}\p{Cf}` and no letter-digit-underscore class, US-0020); collapse whitespace and trim; drop a duplicated currency word directly after a currency amount ("$11,000 dollars" becomes "$11,000", likewise £ and pounds, € and euros); everything else unchanged (spelled numbers, times, percentages and "a hundred ways" stay exactly as the model wrote them). Text over 2000 characters is cut at 2000 code units on a code-point boundary.

- [ ] **Step 1: Write the failing tests:** a table of at least 20 input/output pairs covering each rule plus explicit non-rules ("forty-two thousand", "nine thirty", "ten percent", "one of them" all stay unchanged), idempotence over the table, the bidi/zero-width strip, the 2000 cut on a surrogate pair.
- [ ] **Step 2:** Run the file. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, plus `pnpm --filter @acr/runtime exec vitest run src/__tests__/id-rules.files.test.ts`. Expected: PASS (no id-rule spelling introduced).
- [ ] **Step 5:** Commit `[feat] US-0070: conservative transcript cleaner`.

### Task 17: Activity edges, the per-track pipeline and the holder filter

**Files:** Create `services/speech/src/activity.ts`, `services/speech/src/voice-gate.ts`, `services/speech/src/track-pipeline.ts`, `services/speech/src/__tests__/activity.test.ts`, `__tests__/voice-gate.test.ts`, `__tests__/track-pipeline.test.ts`.

**Interfaces:**
- Consumes: `Segmenter` (14), `gate` (15), `normalise` (16), `SpeechToText`/`LimitedSpeechToText` (11, 13), protocol types (1).
- `class VoiceGate { update(s: ControlToWorker & { type: "voice_state" }): { stopped: string[] /* roles that lost recording */ }; recordingFor(roleId: string): { participantId: string } | null; get paused(): boolean; get ended(): boolean }` — `null` unless the role is a listed holder with `recording: true` and the state is not paused or ended; before the first `voice_state` everything is `null` (C6).
- `class ActivityReporter { constructor(send: (m: WorkerMessage) => void, now: () => number); speechStarted(roleId): void; segmentClosed(roleId, lastSpeechAt: number, outcomeSent: Promise<void>): void; stop(roleId): void }` — sends `active: true` once per transition; on a silence close sends `active: false, silentMs: now() - lastSpeechAt` only after `outcomeSent` resolves and only if the role has not become active again meanwhile; `stop` sends `active: false, silentMs: 0` at once if the last edge sent was `true`.
- `class TrackPipeline { constructor(o: { roleId: string; segmenter: Segmenter; stt: SpeechToText; gate: VoiceGate; activity: ActivityReporter; send: (m: WorkerMessage) => void; now: () => number /* wall clock */; newSegmentId: () => string; deadlineMs: number /* 5000 */ }); push(frame: Int16Array): void; stop(): void; flush(): Promise<void> }` — frames are ignored entirely (not even segmented) while `gate.recordingFor(roleId)` is null; a gate change to null calls `segmenter.discard()` and `activity.stop`; each closed segment gets a server-made id (`randomBytes(8).toString("hex")`, checked with `isFileSafeId`), captures the participant id at segment START, is transcribed with deadline `now() + deadlineMs`, gated, normalised, and delivered **in segment order per track** (a later result waits for earlier ones; a failed or empty one is delivered as `segment_failed` in its place); a delivery for a participant who is no longer the recording holder is dropped silently (the runtime would refuse it anyway).

- [ ] **Step 1: Write the failing tests:**
  - `voice-gate.test.ts`: `null before any voice_state`; `null while paused or ended`; `recording holders only`; `update reports the roles that stopped`.
  - `activity.test.ts`: `true once per start`; `false waits for the outcome and carries silentMs`; `a restart before the outcome suppresses the stale false`; `stop sends false with silentMs 0 only after a true`.
  - `track-pipeline.test.ts` (FakeSpeechToText with deferred answers, synthetic signals, injected clock): **`unconsented track produces nothing`** (no `voice_state`, a `text_only` holder, an unheld role, an AI-like role absent from holders: zero STT calls, zero messages; Review Focus 1); `one tone gives one voice_line with normalised text and startMs/endMs from the wall clock`; **`out-of-order answers are delivered in segment order`** (answer segment 2 before 1); `an empty answer gives segment_failed empty and no voice_line`; `a Refused or Timeout gives segment_failed stt_failed`; **`voice_state change discards the open segment`** (opt-out mid-tone: no STT call for it; Review Focus 2); `pause mid-tone discards it`; `a delivery for a participant replaced since segment start is dropped`; `flush at end transcribes the open segment once`; `segment ids are 16 hex and unique across 1000 segments`.
- [ ] **Step 2:** Run `pnpm --filter @acr/speech exec vitest run src/__tests__/activity.test.ts src/__tests__/voice-gate.test.ts src/__tests__/track-pipeline.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: per-track pipeline with in-order delivery`.

### Task 18: File ingest and the worker process

**Files:** Create `services/speech/src/ingest/audio-ingest.ts`, `ingest/file-ingest.ts`, `src/config.ts`, `src/worker.ts`, `src/main.ts`, `src/__tests__/file-ingest.test.ts`, `__tests__/config.test.ts`, `__tests__/worker.test.ts`, `__tests__/main.process.test.ts`; Modify `services/speech/package.json` (`"start": "tsx src/main.ts"`).

**Interfaces:**
- `interface AudioIngest { start(onFrame: (roleId: string, frame: Int16Array) => void): Promise<void>; stop(): Promise<void> }`.
- `class FileIngest implements AudioIngest { constructor(o: { dir: string; roles: string[]; frameMs: 20; pace: (ms: number) => Promise<void> }) }` — reads `<dir>/<roleId>.wav` for each listed role (role ids checked with `isFileSafeId` before any path join; a missing file means no audio for that role), decodes with `decodeWav`, emits 20 ms frames in role-interleaved time order, awaiting `pace(20)` between frame times (tests and CI pass a no-op; the demo's real run may pace).
- `parseWorkerConfig(env): { ok: true; cfg: WorkerConfig } | { ok: false; errors: string[] }` with `WorkerConfig = { segmenter: SegmenterSettings; stt: { kind: "whisper"; url: URL } | { kind: "fake"; scriptFile: string }; ingest: { kind: "file"; dir: string; roles: string[] } }` from `VOICE_HANGOVER_MS`, `VOICE_MAX_SEGMENT_MS`, `STT_URL` (Task 12's `parseSttUrl`), `STT_PROVIDER` (`whisper` default, or `fake` with `STT_FAKE_SCRIPT` a JSON file `{ "<roleId>": ["line 1", "line 2", ...] }`, answers by segment ordinal per role, and appends one line `{"roleId": "...", "n": 1}` per call to `<script file>.calls.jsonl` beside it, 0600: no text, used by the demo's V-04), `SPEECH_INGEST=file`, `SPEECH_INGEST_DIR` (absolute), `SPEECH_INGEST_ROLES` (comma list). A1a supports only file ingest; A1b adds `livekit`. Errors name variables only.
- `startWorker(o: { cfg: WorkerConfig; send: (m: WorkerMessage) => boolean; now: () => number; setTimer; stt?: SpeechToText }): { onControl(m: ControlToWorker): void; stop(): Promise<void> }` — builds one `TrackPipeline` per role lazily, warms STT up and sends `worker_ready` (`stt: "unavailable"` when warm-up fails: the worker keeps running and its tracks produce `segment_failed stt_failed`), starts ingest after the first `voice_state`, flushes and stops on `voice_state.ended`.
- `main.ts`: only when `process.send` exists (forked); parses config (exit 2 with fixed errors on stderr), validates every incoming message with `ControlToWorkerSchema` (drops others), exits 0 on IPC disconnect with a hard-exit backstop (the `watchParent` shape, `services/runtime/src/main.ts:103-115`), never logs an environment value.

- [ ] **Step 1: Write the failing tests:** `file-ingest.test.ts` (temp dir with WAVs written by `encodeWav`): `frames are 320 samples and interleaved by time`, `a role id with a separator is refused before reading`, `a missing file yields no frames for that role`, `a stereo file is refused with a fixed error`; `config.test.ts`: defaults, ranges, `STT_URL` refusals, fake script parse, unknown `SPEECH_INGEST` refused; `worker.test.ts` (in-process, fake STT): `nothing is ingested before the first voice_state`; `worker_ready is sent after warm-up`; `two roles' files give their lines under their own role ids`; `ended flushes and stops`; `a failed warm-up reports stt unavailable and segments fail`; `main.process.test.ts` (real fork via `tsx`, `vi.setConfig({ testTimeout: 90_000 })`): `the forked worker answers voice_state with voice_line messages for a fixture file and exits 0 when the parent disconnects`; `an invalid message from the parent is ignored`.
- [ ] **Step 2:** Run `pnpm --filter @acr/speech exec vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: speech worker process with file ingest`.

### Task 19: Control's `VoiceHost`: spawn, relay and crash

**Files:** Create `services/control/src/voice/voice-host.ts`, `voice/speech-spawn.ts`, `voice/speech-env.ts`, `voice/speech-command.ts`, `src/__tests__/voice/voice-host.test.ts`, `src/__tests__/voice/speech-env.test.ts`, `src/__tests__/voice/voice.real.test.ts`; Modify `services/control/src/supervisor.ts` (`goLive` `:326-344`, `onChildExit` `:393-419`, `onEnded` `:380-391`, constructor option), `services/control/src/main.ts` (`:66-69`), `services/control/package.json` (`@acr/speech` `workspace:*`).

**Interfaces:**
- `speechCommand(): { execPath; execArgv: ["--import", "tsx"]; entry: <services/speech/src/main.ts> }` and `speechCwd()` (copy of `runtime-command.ts:7-18`).
- `SPEECH_ENV_ALLOWLIST = { names: ["PATH", "VOICE_HANGOVER_MS", "VOICE_MAX_SEGMENT_MS", "STT_URL", "STT_MODEL", "STT_PROVIDER", "STT_FAKE_SCRIPT", "SPEECH_INGEST", "SPEECH_INGEST_DIR"], prefixes: ["NODE_"] }` and `buildSpeechEnv(parentEnv, roles: string[]): NodeJS.ProcessEnv` (adds `SPEECH_INGEST_ROLES`; never `LIVEKIT_*`, `LAUNCHER_TOKEN`, `FACILITATOR_SECRET`, provider keys).
- `speechSpawn(): SpeechSpawnFn` where `SpeechSpawnFn = (o: { env; logFile }) => WorkerHandle` and `WorkerHandle = { send(m: ControlToWorker): boolean; onMessage(fn: (raw: unknown) => void): void; onExit(fn): void; kill(): void; forceKill(): void; disconnect(): void }` (same body as `forkSpawn`, `spawn.ts:17-63`, log `<logDir>/<sessionId>.speech.log`).
- `class VoiceHost { constructor(o: { spawn: SpeechSpawnFn; config: ControlConfig; parentEnv; log; setTimer: SetTimer; toRuntime: (sessionId: string, m: ParentMessage) => boolean; bots?: { voiceTurn(sessionId: string, open: boolean): void } }); attach(sessionId: string, ready: { voice?: true; roles: string[] }): void; fromRuntime(sessionId: string, m: Extract<ChildMessage, { type: "voice_seats" | "voice_turn" | "voice_choice" | "voice_line_ack" | "voice_line_refused" }>): void; detach(sessionId: string): void /* runtime exited */; end(sessionId: string): void /* session ended */; shutdown(): Promise<void> }`. Behaviour:
  - `attach` spawns one worker only when `ready.voice === true` and none runs; on a runtime restart (detach then attach) the worker is kept and receives the next `voice_state` (C6).
  - Worker messages are parsed with `WorkerMessageSchema`; `voice_line` → `toRuntime(voice_line {segmentId, roleId, participantId, text})` with a pending entry timed out after `VOICE_LINE_TIMEOUT_MS` (10 000) → `voice_line_result { refused: "failed" }` to the worker; `speech_activity` → `toRuntime(speech_activity)`; `segment_failed` → `toRuntime(voice_notice {code: status})` and, for `stt_failed`, `toRuntime(voice_alert {code: "stt_failed"})`; `worker_ready {stt: "unavailable"}` → `voice_alert stt_unavailable`.
  - Runtime messages: `voice_seats` → `voice_state` to the worker (same fields); `voice_line_ack/refused` → `voice_line_result` to the worker (a reply with no pending entry is dropped); `voice_turn` → `bots.voiceTurn`; `voice_choice` → dropped in A1a (A2 writes the audit log).
  - Worker exit while the session runs → `voice_alert {code: "worker_down"}`, pending lines answered nowhere (worker gone), worker forgotten; **no restart in A1a** (A1b). `end` sends a final `voice_state` with `ended: true`, then stops the worker after `graceMs` (stopChild shape).
  - Errors are logged by name only; never a path, a text or an id beyond the session id.
  - `workerPid(sessionId: string): number | undefined` exists for the demo's V-07 and the real-process tests only (the `pid` getter `forkSpawn`'s handle already has, `spawn.ts:45-47`).
- `Supervisor` gains option `voice?: (deps: { toRuntime }) => VoiceHost` (the `bots` pattern, `supervisor.ts:104,123`); `goLive` calls `voice.attach` with the ready's `voice` flag and the player roles, routes the five child types to `voice.fromRuntime`; `onChildExit` calls `voice.detach`; `onEnded` calls `voice.end`; `shutdown` awaits `voice.shutdown()`. `ReadyInfo` and `awaitReady`'s resolve carry `voice`.
- `main.ts`: `voice: (deps) => new VoiceHost({ spawn: speechSpawn(), config, parentEnv: env, log, setTimer, bots: <the BotHost>, ...deps })`.

- [ ] **Step 1: Write the failing tests:**
  - `speech-env.test.ts`: allowlisted names copied; `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, `LAUNCHER_TOKEN`, `FACILITATOR_SECRET`, `HOME` never copied; `SPEECH_INGEST_ROLES` set from the roles.
  - `voice-host.test.ts` (fake worker and fake runtime sink, manual timers): `no worker without ready.voice`; `one worker per session`; `voice_line is relayed and the ack returns as voice_line_result with the seq`; `a refused line returns refused with the code`; `a line with no answer in 10 s returns refused failed`; `voice_seats becomes voice_state`; `segment_failed becomes voice_notice, and stt_failed also an alert`; `voice_turn reaches the bots`; **`worker exit leaves the session running`** (Review Focus 5: the supervisor's live entry is still `running`, one `worker_down` alert, no respawn); `a runtime restart keeps the worker and pushes the new state`; `end sends ended then stops the worker`; `an invalid worker message is dropped`; `nothing logged contains the transcript text or a participant id` (capture `log`).
  - `voice.real.test.ts` (real `forkSpawn` runtime and real `speechSpawn` worker, fake STT script, temp data dir, `vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })`): `a session with VOICE_ENABLED=1 logs the scripted voice lines under their roles`. Run once in the Linux container before pushing (gate list below).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/voice`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/control test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0070: control relays voice between worker and runtime`.

### Task 20: `pnpm demo --voice`

**Files:** Create `services/control/src/demo/voice-demo.ts`, `services/control/src/demo/voice-client.ts` (a small player WebSocket client: join by code with `issueCredential: false`, consent, `voice_opt_in`, record frames), `services/control/src/__tests__/demo/voice-demo.test.ts`; Modify `services/control/package.json` (`"demo:voice": "tsx src/demo/voice-demo.ts"`), `services/runtime/src/demo/args.ts` (flag `voice`, usage line, "runs on its own" like `--web` `:114-116`), `services/runtime/src/demo/runner.ts` (`spawnVoice` like `spawnWeb`, `:97-113,144-151`), `services/runtime/src/demo/__tests__/args.test.ts`, `runner.test.ts`, `.github/workflows/ci.yml` (`demo-run` job: `- run: pnpm demo --voice`).

**Interfaces:**
- `runVoiceDemo(o: { root?: string; stdout; stderr; env: NodeJS.ProcessEnv }): Promise<number>` (0 all checks passed, 1 a check failed): in a private temp tree, writes two WAVs (synthetic tone bursts for the first two human player roles of `scenarios/friday-escalation`, three bursts for one, two for the other, the second speaker overlapping the first once) and a fake STT script with **different, labelled lines per person**; starts control in-process (`startControl` with `port: 0`, `CONTROL_DATA_DIR` the temp tree, `VOICE_ENABLED=1`, `CONSENT_NOTICE_VERSION=v3`, `MODEL_PROVIDER` mock, `STT_PROVIDER=fake`, `SPEECH_INGEST=file`), creates a session, joins both human roles with the returned codes, gives consent, opts in ONE role only (the second role stays text-only to prove V-04), starts, waits (`vi.waitFor`-style polling on the log, bounded by a 60 s watchdog) and runs the checks; then closes control and removes the tree.
- Checks (printed like W-01..W-08): **V-01** every scripted line of the voice role is in the log as `channel: "voice"` under that role, in order; **V-02** no scripted line of the text-only role appears in the log; **V-03** NPC rounds: one round per voice turn (count NPC utterance runs against closed turns); **V-04** the seat that did not opt in got no STT call (its role is absent from the fake's `calls.jsonl`); **V-05** the Game Master evaluated per turn, not per segment (count `gm.decision`/`gm.no_verdict` against turns with everyN 3); **V-06** no player frame of either client contains `segmentId` or `participantId` of another; **V-07** killing the worker (SIGKILL through a test hook that exposes the worker pid) leaves the session running: a typed `say` afterwards is recorded and one `worker_down` alert exists; **V-08** the log's `session.started.logFormat` equals the value for a session without voice (no format change).
- `args.ts`: `--voice` runs on its own (only `--no-color`); runner: `spawnVoiceDemo` runs `pnpm --filter @acr/control demo:voice` in the repo root.

- [ ] **Step 1: Write the failing tests:** `args.test.ts`: `--voice parses`, `--voice with --fast is refused with the fixed sentence`; `runner.test.ts`: `--voice hands over and returns the child's exit code` (fake `spawnVoice`); `voice-demo.test.ts` (`vi.setConfig({ testTimeout: 120_000 })`): `runVoiceDemo returns 0 and prints V-01 to V-08 as passed`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/demo/__tests__/args.test.ts src/demo/__tests__/runner.test.ts` and `pnpm --filter @acr/control exec vitest run src/__tests__/demo/voice-demo.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run, then `pnpm demo --voice`. Expected: PASS and exit 0 with eight passed checks.
- [ ] **Step 5:** Commit `[feat] US-0070: pnpm demo --voice on file ingest`.

### Task 21: Documents, gates, review and the PR

**Files:** Modify `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `docs/ARCHITECTURE.md`, `docs/memory/models-and-providers.md`, `docs/memory/architecture-and-security.md`, `.env.example`, `CHANGELOG.md`, `MEMORY.md`, `progress.md`, `findings.md` (no new dependency: a line saying so), `README.md` (one sentence: voice is off by default and not yet usable).

- [ ] **Step 1: Test cases.** File one TC per AC of Task 0 (AC-a to AC-i), plus separate negative and edge TCs: refusal table (AC-b), never inherited (AC-f: reissue, rebind, restart, other log), out-of-order and deadline (AC-d), leak scan (no `segmentId`/`participantId` in a player frame), worker crash (AC-h). Update the registry's next TC.
- [ ] **Step 2: Threat model.** New section "Voice input, slice A1a (US-0070)": the worker channel (IPC only, no listener, environment allowlist, no LiveKit secret), the runtime's double gate (holder, own choice, not paused), the voice record (0600, bound to the log identity, ignored when mis-bound, never inherited, the opt-out write-failure path and its residual risk), loopback-only `STT_URL` and C9 (no authentication on whisper-server; same-host browser path; `/load`), private notices, fixed alert sentences, the Game Master's residual risk note of US-0019 extended (a voice turn covers less conversation per line; spec §7.5).
- [ ] **Step 3: Rollback** (`docs/ROLLBACK.md`, section "US-0070: voice pipeline"): `VOICE_ENABLED=0` turns it off; no log, consent or session-file format change; an older build ignores `<id>.voice.json` and `consent/notice-v3.md`; control and runtime ship from one checkout, so no skew; a rolled-back build with `CONSENT_NOTICE_VERSION=v3` would show the draft notice: keep it unset.
- [ ] **Step 4: Architecture** (`docs/ARCHITECTURE.md`): record the two deviations of spec §4 (speech in a separate worker; audio outside object storage, A2) and the message routes of the overview.
- [ ] **Step 5: Settings and memory.** `docs/memory/models-and-providers.md`: `VOICE_ENABLED`, `TURN_END_MS`, `VOICE_HANGOVER_MS`, `VOICE_MAX_SEGMENT_MS`, `STT_URL`, `STT_MODEL`, `STT_PROVIDER`, the STT retry limits (2 retries, base 150 ms, bounded by the 5 s deadline, in-flight 2) and the error classes; `.env.example` gets the names with placeholder values and comments (no secret); `MEMORY.md` and `docs/memory/architecture-and-security.md` a short "Voice A1a" entry (routes, the gate, the turn tracker, the GM units rule).
- [ ] **Step 6: Changelog and progress.** `CHANGELOG.md` `[Unreleased]` Added: "Voice input pipeline behind `VOICE_ENABLED` (off by default; not usable by participants yet)". `progress.md`: a session entry with what was built, the coverage numbers of both runs, the container run result, known gaps (no LiveKit, no audio retention, no restart).
- [ ] **Step 7: Gates** (record each result in `progress.md`; do not claim a gate that was not run):
  - `pnpm -r typecheck` — clean.
  - `pnpm test:coverage` — all pass, every package at or above 80% lines; run it a second time under load (`for i in 1 2 3 4 5 6 7 8; do yes > /dev/null & done`, then `kill %1 %2 %3 %4 %5 %6 %7 %8`) — all pass.
  - `pnpm lint:sdk` and `bash scripts/check-sdk-imports.test.sh` — ok (unchanged in A1a).
  - `npx eslint .` — clean.
  - Linux container run of the filesystem and process tests, per AGENTS.md §8 (from a `git archive` tree): `services/runtime/src/engine/__tests__/voice-file.test.ts`, `services/speech/src/__tests__/main.process.test.ts`, `services/control/src/__tests__/voice/voice.real.test.ts`, `services/control/src/__tests__/demo/voice-demo.test.ts`, once as root and once with `--user node`.
  - `npx jest tests/unit/id-registry.test.js` — pass; `pnpm --filter @acr/runtime exec vitest run src/__tests__/id-rules.files.test.ts` — pass.
  - `pnpm demo --voice` and the existing `pnpm demo --fast`, `--security`, `--resume`, `--showcase --fast` — all pass (a text-only session is unchanged).
  - `npm run plan:generate` — regenerates `docs/plan-status.*`.
- [ ] **Step 8: Independent review.** A fresh reviewer on the most capable model gets the diff (excluding `docs/plan-status.*`) and the spec, not this plan's conclusions, with probes requested for: the privacy invariant (a non-holder's file), opt-out mid-segment, the refusal table, never-inherited paths, the turn timer ordering, and the worker crash. Fix Critical and Important findings with tests; file Minor ones as BUGs.
- [ ] **Step 9:** Commit `[docs] US-0070: close out the voice pipeline slice`, push, open the PR into `develop` (title in the commit format, body references US-0070 and ends with the Claude Code line), wait for green CI. Do not merge without the owner's say-so. US-0070 stays `In Progress` until merged; tick each AC with its test name.

---

## Self-review notes (for the executor)

- Spec coverage: every A1a item of spec §12 maps to a task (skeleton 1; IPC and parent-channel with drift tests 1, 2; segmenter 14; noise gate 15; STT adapter, contract and Whisper client 11 to 13; normaliser 16; host method 6; per-track FIFO 17; `speech_activity` and the timer 7; GM and bot cadence 8, 9; refusals and failures 6, 10, 17, 19; demo 20); plus C1's voice choice (3 to 5).
- Not in A1a (by design): LiveKit, tokens, web UI, mute, restart with backoff, Whisper health polling, audio files, index, audit log, replay, partials.
- Names used across tasks: `VoiceRefusal`, `VOICE_REFUSALS`, `VoiceNoticeCode`, `VoiceAlertCode` (Task 2); `VoiceChoices` (4); `voiceStateOf`, `voiceSeats`, `holds` (5); `onVoiceUtterance`, `VoiceRefusedError` (6); `VoiceTurnTracker`, `SetTimer` (7); `gmUnits` (8); `BotHost.voiceTurn`, `Bot.setVoiceTurn` (9); `SpeechToText`, `Transcript`, `SpeechSegment`, `FakeSpeechToText`, `speechToTextContract` (11); `WhisperHttpSpeechToText`, `parseSttUrl`, `encodeWav`, `decodeWav` (12); `LimitedSpeechToText` (13); `Segmenter`, `SegmentOut` (14); `gate` (15); `normalise` (16); `VoiceGate`, `ActivityReporter`, `TrackPipeline` (17); `AudioIngest`, `FileIngest`, `parseWorkerConfig`, `startWorker` (18); `VoiceHost`, `speechSpawn`, `buildSpeechEnv` (19); `runVoiceDemo` (20).
