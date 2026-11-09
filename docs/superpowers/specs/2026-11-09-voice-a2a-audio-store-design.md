# Voice slice A2a: the audio store, disk guard and retention sweep (design)

Status: Draft 2 (2026-11-09), after an independent Opus review of Draft 1 against the code (3 Critical, 10 Important findings, all incorporated below except where marked **Owner decision**). Parent: `2026-11-08-voice-part-a-design.md` section 8 and the overview's contracts 1, 5 and 6. Proposed story: US-0073a (EPIC-0003), dark behind `VOICE_ENABLED`.

## 1. Intent

The speech worker keeps each recorded segment as an audio file the facilitator can later replay, and nothing it keeps outlives `AUDIO_MAX_RETENTION_DAYS` (default 30, range 1 to 30). A2a builds the **store and its expiry only**. Replay, manual delete, the `audio.played` event, `deleted` index lines and the console panel are **A2b** (split decided by the owner, 2026-11-09).

Already decided and not reopened: audio is facilitator-only; the audit log is mandatory; deleting audio never changes the transcript; legal and HR sign-off is deferred in pre-production; no change to the session log format or the consent file.

## 2. Approach

One WAV per segment (16 kHz mono 16-bit PCM, at most about 200 KB: a segment is at most 6 s plus a 200 ms lead-in), written by the worker through an injected `AudioStore`. Rejected: one continuous file per role with offsets (deleting one participant after a seat reissue means rewriting a large file, and a crash can corrupt a whole role); handing audio to control over IPC (the spec keeps native audio code out of control).

**Write after the runtime answers (review C3).** A segment is held in memory until the runtime's `voice_line_result` arrives (or `VOICE_LINE_TIMEOUT_MS` passes), and only then written. This replaces the draft's write-then-back-fill design: audio never reaches disk for a line the runtime refused for consent reasons, and the `seq` back-fill line disappears. Rules:

| Outcome | Audio | Index status |
| --- | --- | --- |
| Line accepted (`seq`) | kept | `transcribed`, with `seq` |
| Refused: `not_recording`, `not_holder`, `voice_off`, `ai_role`, `unknown_role` (consent or seat class) | **never written** | none |
| Other refusal (for example paused or between scenes) | kept | `refused:<code>` |
| `empty`, `stt_failed` (no line sent; the worker's gate already passed) | kept | `empty`, `stt_failed` |
| No answer by `VOICE_LINE_TIMEOUT_MS` | **never written** (consent cannot be shown) | none |

The exact refusal codes are taken from `VOICE_REFUSALS` in `services/speech/src/protocol.ts:125`; the plan lists them and a test fails when a code is added without a row here. Parent spec section 7's "audio follows normal retention" for refused segments is narrowed to the non-consent refusals; recorded as a deviation.

## 3. Components

| Unit | Where | Job | Depends on |
| --- | --- | --- | --- |
| `AudioStore` | `services/speech/src/store/audio-store.ts` | Per the table above: validate, create dirs, write the WAV (fsync), then append the index line. Returns ok or a stop reason. | `StoreLock`, `DiskGuard`, injected clock and fs |
| `IndexFile` | `store/index-file.ts` | Append and read of `index.jsonl`. On open, a file not ending in `\n` gets one appended first; readers skip unparseable lines. | fs |
| `StoreLock` | see **Owner decision** below | The `SessionLock` pattern on `<AUDIO_DIR>/<logIdentity>.store.lock`, outside the directory the sweep deletes (review I6). | fs |
| `DiskGuard` | `store/disk-guard.ts` | Before each write: `statfs` of `AUDIO_DIR` **and** of the sessions directory must each exceed `AUDIO_MIN_FREE_MB` plus the size of the next file (review I9; the pair `voice:check` already checks, `voice-ops/src/check.ts:115`). | injected `statfs` |
| `AuditLog` | `services/control/src/voice/audit-log.ts` | Append-only `<logIdentity>.audio-audit.jsonl` under its own lock `<logIdentity>.audio-audit.lock`. A2a writes `audio.deleted` (reason `expired`, scope shape `{ kind: "session" }` per contract 6), `voice.recording_stopped`, and `voice.opted_in` / `voice.opted_out` (control drops `voice_choice` today, `voice-host.ts:372`; review I3). | lock |
| `Sweep` | `control/src/voice/sweep.ts` | See section 6. | `AuditLog`, store lock, injected clock |

**Owner decision (review open question 1).** Control (sweep, audit log) and the worker must judge the same lock file the same way, and two copies can drift. The reviewer recommends one shared implementation: export `@acr/runtime/files` (`SessionLock`, `assertInside`, `ensurePrivateDir`), add it to control's import allowlist and its "exactly" assertion (`services/control/src/__tests__/bots/imports.test.ts:22,31`) and use it from speech too. That reopens the 2026-11-08 decision to copy the pattern into `services/speech`. **Recommended: the shared export. This draft assumes it; the owner confirms or returns to the copy.** Fallback if the owner keeps the copy: export the speech copy as `@acr/speech/store-lock` and widen the guard at `imports.test.ts:47-53`.

## 4. Identity, layout and permissions

**The worker must learn the identity (review C1).** Today it does not (`speech/src/config.ts:7-12`, `speech-env.ts:19-23`), and `ready.logIdentity` is only an optional length-limited string (`control/src/protocol.ts:84`). So:

- Control passes `ready.logIdentity` to `VoiceHost.attach`; it must match `/^[0-9a-f]{32}$/`, otherwise the session records no audio (voice still works as text).
- `buildSpeechEnv` sets `SPEECH_LOG_IDENTITY` from that value, never from the parent environment; the worker re-checks it against the same pattern.
- A worker kept across a runtime restart (`voice-host.ts:167`) is stopped and respawned when the new `ready` carries a different identity.

Layout: `<AUDIO_DIR>/<logIdentity>/<roleId>/<segment>.wav` and `index.jsonl`; lock `<AUDIO_DIR>/<logIdentity>.store.lock`. `AUDIO_DIR` defaults to `<CONTROL_DATA_DIR>/audio`, must be absolute, is added to control's `config.ts` (beside `dataDir`) with the same validation as `voice-ops/src/settings.ts:138-141`, and reaches the worker through the speech env allowlist. Directories `0700`, files `0600`, created exclusively. `AUDIO_DIR` itself is checked with the `ensurePrivateDir` rule (fails when group or others can write). After each `mkdir`, `lstat` the folder (a directory, owned by this user, not a link), because `O_NOFOLLOW` protects only the last path part. Every segment id and role id is validated against `FILE_SAFE_ID_PATTERN` before any join, and the resolved path must stay inside the session directory.

## 5. Write path and failure behaviour

1. The write happens **inside the pipeline's delivery queue**, after the abort check and the "still recording" check (`track-pipeline.ts:118-120`) and after the runtime's answer, so cancelled or replaced segments are never written (review I1).
2. Disk guard (section 3). 3. Create the WAV exclusively, write, fsync the file and its directory. If anything fails, delete the partial file. 4. Append the index line. There is no line for a segment without a WAV, and no WAV is promised without an index line: a crash between steps 3 and 4 leaves an orphan WAV that the sweep removes (review I2).

**A stop.** Low disk, a write error, or a lost lock (`onLost`) **stops recording for this worker process**; the transcript continues, so "no record without consent" is untouched. The worker sends a new worker→control message `store_stopped { reason: "disk_low" | "write_error" }` (review I4: `WorkerMessage` has none today, `speech/src/protocol.ts:46-106`); `disk_low` and `write_error` are added to `VOICE_ALERT_CODES` in both protocol copies (`control/src/protocol.ts:47`, `parent-channel.ts:49`), the drift test is extended, and overview contract 1 ("A2 adds no message here") is amended. Control raises the facilitator alert and appends `voice.recording_stopped { reason }`. A respawned worker starts fresh and checks the guard again (review I5); recording resumes only if space allows, and each stop is audited.

## 6. Retention sweep (control)

Runs at control start-up and every hour, **independent of `VOICE_ENABLED`** (review I7): the notice promises automatic deletion, and `VOICE_ENABLED=0` is the rollback, so a rollback must not strand audio. Control never reads that flag today and does not start to.

**Finding what is live (review C2).** The supervisor keys sessions by session id and does not know the identity, and an old worker can outlive a control restart by up to `HARD_EXIT_MS` (5 s). So the **store lock is the proof**: for each directory the sweep tries to take the lock without waiting; refused means skip. The sweep keeps the lock until the directory has been renamed aside.

**Which directories (review C1).** Only `readdir` entries matching `/^[0-9a-f]{32}$/` that are real directories owned by this user (`lstat`); everything else is left alone and never deleted.

**The clock (review open question 3).** Read from the audio directory only; the session list is unsuitable (limited to three keys, `session-list.ts:19`, no timestamps, no identity). The worker writes an `ended` marker in `end()` after the flush (`worker.ts:124-133`). Expiry starts at the marker's time; with no marker, at "last activity plus 24 hours", where last activity is the largest `endMs` in the indexes, with the newest file time as the backstop. A recorded time later than "now" counts as "now". The age limit is `AUDIO_MAX_RETENTION_DAYS`.

**Deleting atomically, auditing once (review I8).** Rename `<id>` to `<id>.deleting-<rand>`, append `audio.deleted { scope: { kind: "session" }, reason: "expired", by: "system", segments: n }`, then remove the renamed folder without following links. A later run finishes any leftover `.deleting-*` folder **without** a second audit line. Orphan WAVs (no index line) inside a live-by-lock-free directory are removed in the same pass. A failed removal is logged by name only and retried.

## 7. Audit log retention and settings

The audit log holds participant ids and facilitator labels, never content (review I10). It is kept as long as the session's log is kept (not deleted by the audio sweep), stated in the threat model and the notice wording for the plan to carry. Settings: `AUDIO_DIR`, `AUDIO_MIN_FREE_MB`, `AUDIO_MAX_RETENTION_DAYS` in `docs/memory/models-and-providers.md`, `.env.example`, control config and the speech env allowlist. `voice:check` already reports free space (A1c); A2a only adds the `AUDIO_DIR` volume if it is not covered.

## 8. Testing and security

- Unit: malformed identity refused; respawn on a different identity; id and path validation (separators, `..`, absolute, a link in the tree); permissions; exclusive create; fsync order and partial-file cleanup (fault injection between each step); torn last index line; disk guard on both volumes and the next-file size; lock acquire, heartbeat, stale takeover, second writer refused, `onLost` stops recording.
- Consent: a consent-class refusal never writes audio; a timeout never writes audio; a non-consent refusal keeps audio with `refused:<code>`; every code in `VOICE_REFUSALS` has a row.
- Sweep: selects by the right clock (marker, last activity, file time, future time); refused by the store lock while a worker runs, including an orphan worker after a control restart; audits after the rename; finishes `.deleting-*` without a second audit line; ignores non-hex32 and non-directory entries; runs with `VOICE_ENABLED=0`; a failed removal retries.
- Alerts: `store_stopped` reaches the facilitator and the audit log; `voice.opted_in` and `voice.opted_out` are audited.
- Mutation checks on the guard, the path join, the lock skip and the consent-refusal rule.
- Threat model: new entries for the audio directory, the lock, the sweep, the audit log (and its retention) and the identity hand-off. Rollback: `VOICE_ENABLED=0`; an older build ignores the audio directory and the audit file. `CONTROL_GRACE_MS` (default 30 s) can cut a flush short; the orphan cleanup covers it and a test shows it.
- Out of scope (A2b): replay route, manual delete, `audio.played`, `deleted` index lines (for A2b, reword contract 5 as "one writer at a time, under the store lock"), console panel.

## 9. Review log

Draft 1 questions answered: (1) lock: shared export recommended, owner confirms (section 3); (2) `deleted` lines are A2b; (3) the clock comes from an `ended` marker plus the indexes (section 6). Not verified: behaviour on a real LAN, real disks near the floor, and APFS-specific rename atomicity under load (the sweep's rename is on one volume).
