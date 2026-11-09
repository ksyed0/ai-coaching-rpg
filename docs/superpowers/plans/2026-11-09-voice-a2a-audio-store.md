# Voice A2a: Audio Store, Disk Guard and Retention Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The speech worker keeps each consented segment as a WAV the facilitator can later replay (A2b), and control deletes everything older than `AUDIO_MAX_RETENTION_DAYS`, all dark behind `VOICE_ENABLED`.

**Architecture:** A per-session `AudioStore` in `services/speech` holds each segment in memory until the runtime answers (`voice_line_result`), then writes it under `<AUDIO_DIR>/<logIdentity>/<role>/` only when the answer shows consent. One shared `SessionLock` (new `@acr/runtime/files` export) guards the directory for the worker and the sweep. A sweep and an audit log in `services/control` expire whole sessions.

**Tech Stack:** TypeScript, Node fs, zod, vitest (the repo's existing stack; no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-09-voice-a2a-audio-store-design.md` (Draft 2, owner-approved 2026-11-09). Parent: `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` section 8; contracts 1, 5, 6 of `docs/superpowers/plans/2026-11-08-voice-part-a-overview.md`.

**Filing:** file the story when Task 1 starts, from `docs/ID_REGISTRY.md` (expected US-0073, TASK-0109, AC-0426 onward, TC-0205 onward; one AC and one TC per task group below, edge cases take the next free ids). Branch `feature/EPIC-0003-US-0073-voice-audio-store`, cut from `develop`; PR to `develop`.

## Global Constraints

- `AUDIO_MAX_RETENTION_DAYS` default `30`, range 1 to 30; `AUDIO_MIN_FREE_MB` default `2048`, range 512 to 1 000 000; `AUDIO_DIR` default `<CONTROL_DATA_DIR>/audio`, absolute.
- Layout `<AUDIO_DIR>/<logIdentity>/<roleId>/<segment>.wav` + `index.jsonl`; lock `<AUDIO_DIR>/<logIdentity>.store.lock`; audit `<AUDIO_DIR>/<logIdentity>.audio-audit.jsonl` (lock `<logIdentity>.audio-audit.lock`). `logIdentity` is exactly 32 lower-case hex.
- Directories `0700`, files `0600`, created exclusively; every id passes `FILE_SAFE_ID_PATTERN` (`isFileSafeId`) before any path join; the resolved path stays inside the session directory.
- WAV: 16 kHz mono 16-bit PCM. Index lines `v: 1`. Audit lines `v: 1` with `ts`, never any text, audio or transcript.
- Audio is never written for a consent-class refusal (`not_recording`, `not_holder`, `voice_off`, `ai_role`, `unknown_role`) or for a line with no runtime answer in time.
- The sweep runs regardless of `VOICE_ENABLED`; the store lock is the only proof of a live worker.
- Control may import `@acr/runtime` only through its allowed subpaths (now six, including `files`) and `@acr/speech` only as `@acr/speech/protocol`; `services/speech/src/protocol.ts` imports only `zod` and `@acr/events`.
- Commit format `[TYPE] US-0073: description` (max 72 chars). All tests pass and coverage stays at or above 80% before each commit. Never log a path, text, token or identity; errors name the failure only.

## Review Focus

Failure modes the spec implies that no single task's happy path exercises, most likely first (each has a test in the owning task):

1. A participant opts out (or the seat is reissued) while a segment is waiting for its runtime answer: no file may appear (Task 6, 7).
2. Control restarts while the old worker is still flushing: the new sweep must not delete under it (Task 10).
3. `AUDIO_DIR` or a role folder is a symlink, or is group-writable: refuse, write nothing (Task 4, 6).
4. A segment id, role id or identity that contains `..`, a separator or uppercase hex (Task 3, 4).
5. A crash between the WAV and the index line, and a torn last index line (Task 6, 10).

## File Structure

Create: `services/runtime/src/files/index.ts`; `services/speech/src/store/{paths,index-file,disk-guard,consent-rule,wav,audio-store}.ts`; `services/control/src/voice/{audio-settings,audit-log,sweep}.ts`; tests beside each under `__tests__/`. Modify: `services/runtime/package.json`, `services/control/src/__tests__/bots/imports.test.ts`, `services/speech/package.json` and `src/__tests__/imports.test.ts`, `services/speech/src/{config,protocol,worker,track-pipeline,main}.ts`, `services/control/src/{config,protocol,main,supervisor}.ts`, `services/control/src/voice/{speech-env,voice-host}.ts`, `services/runtime/src/host/parent-channel.ts`, `services/control/src/__tests__/protocol.drift.test.ts`, `.env.example`, `docs/memory/models-and-providers.md`, `docs/THREAT_MODEL.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`.

---

### Task 1: Shared lock export `@acr/runtime/files`

**Files:** Create `services/runtime/src/files/index.ts`; modify `services/runtime/package.json` (exports `"./files": "./src/files/index.ts"`), `services/speech/package.json` (dependency `"@acr/runtime": "workspace:*"`), `services/control/src/__tests__/bots/imports.test.ts` (ALLOWED and the "exactly" test become six: add `@acr/runtime/files`), `services/speech/src/__tests__/imports.test.ts`. Test: `services/runtime/src/__tests__/files-export.test.ts`.

**Interfaces:** Produces (re-exports only, no logic moved): `SessionLock`, `SessionLockError`, `type LockOptions`, `assertInside(dir, file): void`, `ensurePrivateDir(dir): string | null`, `fsyncDirSync(dir): void`, `DEFAULT_LOCK_STALE_MS`. Note: `SessionLock.acquire(dir, id, opts)` takes any id passing `assertSessionId` (a 32-hex identity does).

- [ ] **Step 1: Write the failing tests.** `files-export.test.ts`: `test_files_reexports_the_same_SessionLock` asserts `Files.SessionLock === LogFiles.SessionLock` (import both) and that all seven names above exist. In control's `imports.test.ts` change the "exactly" test expectation to the six paths and the sentence in its title; in speech's `imports.test.ts` change "no speech source imports the runtime" to allow exactly `@acr/runtime/files` (any other `@acr/runtime` specifier, and any `runtime/src`, still fails) and add a case that `@acr/runtime/review` is refused.
- [ ] **Step 2: Run** `pnpm --filter @acr/runtime --filter @acr/control --filter @acr/speech test` → the new/changed tests FAIL.
- [ ] **Step 3: Implement** `files/index.ts` as `export { ... } from "../engine/log-files.js"`; add the package export and speech dependency; run `pnpm install`. Verify `log-files.ts` imports only node and `@acr/events` (the speech guard forbids dragging the engine); if not, move only what the lock needs.
- [ ] **Step 4: Run** the same command → PASS; also `pnpm -r typecheck`.
- [ ] **Step 5: Commit** `[feat] US-0073: share SessionLock as @acr/runtime/files`.

### Task 2: Settings (control config and speech env)

**Files:** Create `services/control/src/voice/audio-settings.ts`; modify `services/control/src/config.ts`, `services/control/src/voice/speech-env.ts`, `services/speech/src/config.ts`, `.env.example`, `docs/memory/models-and-providers.md`. Tests: `services/control/src/__tests__/voice/audio-settings.test.ts`, `services/speech/src/__tests__/config.test.ts` (extend).

**Interfaces:** Produces `parseAudioSettings(env: NodeJS.ProcessEnv, dataDir: string): { ok: true; audioDir: string; minFreeMb: number; maxRetentionDays: number } | { ok: false; errors: string[] }` (errors name the variable only; same absolute-path rules as `voice-ops/src/settings.ts:138-141`); `buildSpeechEnv(parentEnv, roles, extra?: { logIdentity?: string; sessionsDir?: string }): NodeJS.ProcessEnv` (sets `SPEECH_LOG_IDENTITY` and `SPEECH_SESSIONS_DIR` from `extra` only, never from the parent); `WorkerConfig.store?: { audioDir: string; minFreeMb: number; logIdentity: string; sessionsDir: string }`. `AUDIO_DIR` and `AUDIO_MIN_FREE_MB` join `SPEECH_ENV_ALLOWLIST.names`.

- [ ] **Step 1: Write failing tests:** defaults (30 days, 2048 MB, `<dataDir>/audio`); `AUDIO_MAX_RETENTION_DAYS` 0 and 31 refused, 1 and 30 accepted; `AUDIO_MIN_FREE_MB` 511 and 1 000 001 refused; relative `AUDIO_DIR` refused; `buildSpeechEnv` ignores a `SPEECH_LOG_IDENTITY` in the parent env and sets it from `extra`; worker config refuses a `SPEECH_LOG_IDENTITY` that is not 32 lower-case hex (uppercase, 31 chars, `../x`) and builds no `store` when no audio dir is set (store disabled, voice still works).
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement** the signatures above; wire the parsed values into control's config next to `dataDir`; worker uses `isLowerHex(v, 32)` from its own protocol.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `[feat] US-0073: audio settings and the worker store config`.

### Task 3: Identity hand-off from the runtime's `ready`

**Files:** Modify `services/control/src/supervisor.ts` (the `attach` call near line 441), `services/control/src/voice/voice-host.ts`, `services/control/src/protocol.ts:84`. Test: `services/control/src/__tests__/voice/voice-host.test.ts` (extend).

**Interfaces:** `VoiceHost.attach(sessionId, ready: { voice?: true; roles: string[]; logIdentity?: string }): void`; the session keeps `logIdentity?: string` (valid only if `isLowerHex(v, 32)`); a spawned worker gets `buildSpeechEnv(..., { logIdentity, sessionsDir })`.

- [ ] **Step 1: Failing tests:** a valid identity reaches the worker env; `ready.logIdentity` of `../x`, uppercase hex or 31 chars makes the session record no audio (worker env has no `SPEECH_LOG_IDENTITY`, voice still attaches); a kept worker (runtime restart) is stopped and respawned when the new `ready` has a different identity, and kept when it is the same.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** commit `[feat] US-0073: hand the log identity to the speech worker`.

### Task 4: Paths and the index file

**Files:** Create `services/speech/src/store/paths.ts`, `services/speech/src/store/index-file.ts`. Tests: `services/speech/src/__tests__/store/{paths,index-file}.test.ts`.

**Interfaces:** `class StorePathError extends Error`; `sessionDir(audioDir: string, identity: string): string`; `roleDir(audioDir, identity, roleId): string`; `segmentFile(audioDir, identity, roleId, segmentId): string` (each validates ids with `isLowerHex(identity, 32)` and `isFileSafeId`, joins, then checks the result stays inside `audioDir`, throwing `StorePathError`); `type IndexEntry = { v: 1; kind: "segment"; segment: string; participantId: string; startMs: number; endMs: number; status: "transcribed" | "empty" | "stt_failed" | `refused:${string}`; seq?: number; raw?: string; timings?: { vadEndMs?: number; sttMs?: number } }`; `appendIndexLine(file: string, entry: IndexEntry): void` (exclusive-friendly append, mode 0600, appends `\n` first if the file does not end in one); `readIndex(file: string): IndexEntry[]` (skips unparseable lines).

- [ ] **Step 1: Failing tests:** separators, `..`, empty, absolute, over-long and uppercase ids throw; a path outside `audioDir` throws; a symlinked `audioDir` or role folder is refused; append then read round-trips; a torn last line (no `\n`) gets a newline before the next append and the torn fragment is skipped by `readIndex`; file mode is `0600`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (`lstat` each folder after `mkdir`: directory, owned by this user, not a link; `ensurePrivateDir` for `audioDir` from the shared export). **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: audio store paths and index file`.

### Task 5: Disk guard

**Files:** Create `services/speech/src/store/disk-guard.ts`. Test: `services/speech/src/__tests__/store/disk-guard.test.ts`.

**Interfaces:** `class DiskGuard { constructor(o: { volumes: string[]; minFreeMb: number; statfs?: (p: string) => { bavail: bigint | number; bsize: bigint | number } }); check(nextBytes: number): { ok: true } | { ok: false; volume: "audio" | "sessions" } }`. `volumes` is `[audioDir, sessionsDir]`.

- [ ] **Step 1: Failing tests:** ok when both volumes exceed floor plus the next file; not ok when either is below (the result names which); exactly at the floor is not ok; a `statfs` that throws is not ok (fail closed).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: audio disk guard`.

### Task 6: The consent rule, WAV and `AudioStore`

**Files:** Create `store/consent-rule.ts`, `store/wav.ts`, `store/audio-store.ts` under `services/speech/src/`. Tests: `__tests__/store/{consent-rule,wav,audio-store}.test.ts`.

**Interfaces:** `decide(outcome: { kind: "accepted" } | { kind: "refused"; code: VoiceRefusal } | { kind: "no_text"; status: "empty" | "stt_failed" } | { kind: "timeout" }): { keep: true; status: IndexEntry["status"] } | { keep: false }` (table of spec section 2; exhaustive over `VOICE_REFUSALS`); `wavBytes(pcm: Int16Array | Buffer): Buffer` (44-byte RIFF header, 16 kHz, mono, 16-bit); `class AudioStore { constructor(o: { audioDir; logIdentity; sessionsDir; minFreeMb; now: () => number; lock: SessionLock; guard?: DiskGuard; fs?: StoreFs; onStopped: (reason: "disk_low" | "write_error") => void }); write(seg: { roleId; participantId; segmentId; startMs; endMs; pcm: Buffer; outcome: Parameters<typeof decide>[0]; seq?: number; raw?: string; timings?: ... }): "written" | "skipped" | "stopped"; markEnded(): void; get stopped(): boolean }`. `markEnded` writes `<sessionDir>/ended.json` `{ "v": 1, "endedAtMs": <now> }`. `write` order: `decide` → guard → exclusive create WAV (0600) → fsync file and directory → append index line; any failure deletes the partial file, sets `stopped`, calls `onStopped("write_error")`; a failed guard sets `stopped` and calls `onStopped("disk_low")`; `onLost` of the lock does the same with `write_error`. After `stopped`, every `write` returns `"stopped"` and writes nothing.

- [ ] **Step 1: Failing tests:** one test per `VOICE_REFUSALS` code against `decide` (a code added later with no row fails: iterate the const); `wavBytes` header fields and length; `write` of an accepted segment creates `<seg>.wav` (0600, dir 0700) and one index line with `status: "transcribed"` and `seq`; a consent-class refusal and a timeout return `"skipped"` and leave no file and no index; `empty` and `stt_failed` are kept; fault injection after create, after fsync and after append: no index line without a WAV, partial file removed, `stopped` set; guard failure stops with `disk_low` and later writes return `"stopped"`; a lost lock stops with `write_error`; `markEnded` writes the marker.
- [ ] **Step 2:** FAIL. **Step 3:** implement (`StoreFs` is a thin injected wrapper over node fs for fault injection). **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: AudioStore with the consent rule`.

### Task 7: Worker integration and the `store_stopped` message

**Files:** Modify `services/speech/src/{protocol,worker,track-pipeline,main}.ts`. Tests: `services/speech/src/__tests__/{worker-audio,protocol}.test.ts`.

**Interfaces:** new `WorkerMessage` `{ type: "store_stopped", reason: "disk_low" | "write_error" }` in the speech protocol; the pipeline option `onSegmentAudio?: (s: { roleId; participantId; segmentId; startMs; endMs; pcm: Buffer; outcome: "text" | "empty" | "stt_failed"; raw?: string; timings?: ... }) => void`, called inside the delivery queue AFTER the abort check and the "still recording" check (`track-pipeline.ts` near line 118) and BEFORE `send`; worker keeps `pending: Map<segmentId, { seg; timer }>` for text lines, resolved by `voice_line_result` (`seq` → accepted, `refused` → refused with that code) or by a `LINE_RESULT_WAIT_MS` timer (set to the value of `VOICE_LINE_TIMEOUT_MS` in `voice-host.ts`) → `{ kind: "timeout" }`; `empty` and `stt_failed` go straight to `store.write`. On `ended`: pending entries are dropped without writing, then `store.markEnded()`. No store (`cfg.store` undefined) means the whole path is a no-op.

- [ ] **Step 1: Failing tests (worker with a fake ingest, fake STT, fake clock):** accepted line writes WAV and index with its `seq`; the same segment refused `not_recording` writes nothing; no answer within the wait writes nothing; an opt-out `voice_state` while the segment waits writes nothing (Review Focus 1); a cancelled or replaced segment never reaches the store; `empty` is kept; `end` drops pending and writes `ended.json`; a `store_stopped` is sent once on a disk-low stop and the transcript line is still sent; the message schema accepts both reasons and refuses others.
- [ ] **Step 2:** FAIL. **Step 3:** implement; `main.ts` builds the `AudioStore` from `cfg.store` and the shared `SessionLock.acquire(audioDir, logIdentity, { onLost })` (a lock that cannot be taken disables recording with one fixed log sentence). **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: speech worker records consented audio`.

### Task 8: Control side: alert codes, `store_stopped`, audit log

**Files:** Create `services/control/src/voice/audit-log.ts`; modify `services/control/src/protocol.ts` and `services/runtime/src/host/parent-channel.ts` (add `disk_low`, `write_error` to `VOICE_ALERT_CODES` in both), `services/control/src/voice/voice-host.ts`, `services/control/src/__tests__/protocol.drift.test.ts`. Tests: `__tests__/voice/{audit-log,voice-host}.test.ts`.

**Interfaces:** `class AuditLog { constructor(o: { audioDir: string; now: () => number; lock: ... }); append(logIdentity: string, e: AuditEvent): void }`, `type AuditEvent = { type: "voice.recording_stopped"; reason: "disk_low" | "write_error" | "worker_down" } | { type: "voice.opted_in"; role: string; participant: string; noticeVersion: "v3" } | { type: "voice.opted_out"; role: string; participant: string } | { type: "audio.deleted"; scope: { kind: "session" }; reason: "expired"; by: "system"; segments: number }`; each line adds `v: 1` and `ts`; file 0600 under its own lock; no content fields exist in the type. `VoiceHost` on `store_stopped` raises `alert(sessionId, reason)` and appends `voice.recording_stopped`; on the runtime's `voice_choice` (dropped today, `voice-host.ts:372`) appends `voice.opted_in` / `voice.opted_out`; with no valid identity nothing is audited.

- [ ] **Step 1: Failing tests:** lines are valid JSON with `v`, `ts`, `type`; a second appender waits on or fails the audit lock rather than interleaving; file mode `0600`; the drift test covers the two new codes in both protocol copies and the new worker message; `store_stopped` reaches the facilitator alert and the audit log; opt-in and opt-out are audited with ids only (assert no `text` key).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: audit log and store alerts`.

### Task 9: The retention sweep

**Files:** Create `services/control/src/voice/sweep.ts`; modify `services/control/src/main.ts` (start-up run, then hourly, independent of `VOICE_ENABLED`). Test: `services/control/src/__tests__/voice/sweep.test.ts`.

**Interfaces:** `sweepAudio(o: { audioDir: string; retentionDays: number; now: () => number; audit: AuditLog; acquireLock: (dir: string, id: string) => { release(): void } | null; log: (m: string) => void }): Promise<{ deleted: number; skipped: number }>`. Rules: only entries matching 32 lower-case hex that are real directories owned by this user; for each, `acquireLock` without waiting (null means skip); clock = `ended.json` time, else (newest index `endMs` + 24 h), else newest file time, a future time counts as now; older than `retentionDays` → rename to `<id>.deleting-<rand>`, append `audio.deleted` (segments = WAV count), remove the renamed folder without following links, release the lock, remove the `.store.lock` file; a leftover `.deleting-*` folder is finished with no second audit line; orphan WAVs (no index line) in a kept directory are removed; a failed removal logs a fixed sentence and retries next run.

- [ ] **Step 1: Failing tests (temp dirs, injected clock):** boundary at exactly `retentionDays` and one ms either side; each clock source in turn and a future time; a held lock skips (an orphan worker after a control restart, Review Focus 2); audit line only after the rename and exactly once across a crash between rename and remove; `.deleting-*` finished without a second line; non-hex names, files and symlinks left untouched; orphan WAV removed; runs with `VOICE_ENABLED=0` in env; a removal failure leaves the folder and the next run completes it; the scheduler runs at start-up and hourly (fake timers).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `[feat] US-0073: audio retention sweep`.

### Task 10: End-to-end and mutation checks

**Files:** Test: `services/control/src/__tests__/voice/audio-store.e2e.test.ts` (or the repo's e2e location for the fake-ingest stack, found by reading how the A1a demo test is wired).

- [ ] **Step 1:** write a test that runs the real worker on file ingest with the fake STT through a real runtime child: one accepted line → WAV, index and `ended.json` exist with correct modes; an opted-out role → none; advance the clock past retention → the sweep removes the directory and the audit file has exactly one `audio.deleted`.
- [ ] **Step 2:** run it; fix wiring until it passes. **Step 3:** mutation checks, each must fail a named test then be reverted: remove the consent-class rule; skip the guard; skip the path containment check; drop the lock skip in the sweep. **Step 4:** run `pnpm -r test` and `pnpm -r typecheck` → all pass, coverage at or above 80%. **Step 5:** commit `[test] US-0073: audio store end-to-end and mutation checks`.

### Task 11: Documents and close-out

**Files:** Modify `docs/THREAT_MODEL.md` (audio directory, shared lock, sweep, audit log and its retention, identity hand-off), `docs/RELEASE_PLAN.md` (file US-0073 with ACs and TCs, set Complete when done), `docs/ID_REGISTRY.md`, the overview's contract 1 ("A2 adds no message here" now names `store_stopped` and the two alert codes) and the parent spec section 7 line on refused segments (narrowed, recorded as a deviation), `CHANGELOG.md` under `[Unreleased]`, `progress.md`, `MEMORY.md`; run `npm run plan:generate`.

- [ ] **Step 1:** make the edits. **Step 2:** `npm run plan:generate` → dashboard regenerated, no parse errors. **Step 3:** commit `[docs] US-0073: A2a threat model, plan status and close-out`.

## Self-Review (spec coverage)

Spec 2 (consent table) → Tasks 6, 7; 3 (components) → 4 to 9; 4 (identity, layout, permissions) → 2, 3, 4; 5 (write path, stops, alerts) → 6, 7, 8; 6 (sweep: lock proof, hex32 filter, clock, atomic delete) → 9; 7 (audit retention, settings) → 2, 8, 11; 8 (tests, threat model, rollback note, `CONTROL_GRACE_MS` orphan cleanup) → 9, 10, 11. Shared lock decision → Task 1. Out of scope (A2b): replay, manual delete, `audio.played`, `deleted` index lines, console panel.

**Decision for the owner at plan review:** the speech package's guard forbids importing the runtime (`services/speech/src/__tests__/imports.test.ts`). Sharing the lock through `@acr/runtime/files` needs that guard relaxed for exactly that one subpath (Task 1). The alternative that avoids the exception is moving `SessionLock` to a neutral package that runtime, control and speech all import, which is a larger move.
