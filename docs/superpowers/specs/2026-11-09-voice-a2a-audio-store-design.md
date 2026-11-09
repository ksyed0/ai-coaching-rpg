# Voice slice A2a: the audio store, disk guard and retention sweep (design)

Status: Draft 1 (2026-11-09). Parent: `2026-11-08-voice-part-a-design.md` section 8 and the overview's contracts 5 and 6. Proposed story: US-0073a (EPIC-0003), dark behind `VOICE_ENABLED`.

## 1. Intent

The speech worker keeps each recorded segment as an audio file the facilitator can later replay, and nothing it keeps outlives `AUDIO_MAX_RETENTION_DAYS` (default 30, range 1 to 30). A2a builds the **store and its expiry only**. Replay, manual delete, the `audio.played` event and the console panel are **A2b** (split decided by the owner, 2026-11-09).

Already decided and not reopened: audio is facilitator-only; the audit log is mandatory; deleting audio never changes the transcript; `SessionLock` is copied into `services/speech` (owner, 2026-11-08); legal and HR sign-off is deferred in pre-production; no change to the session log format or the consent file.

## 2. Approach

One WAV per closed segment (16 kHz mono 16-bit PCM), written by the worker through an injected `AudioStore`. Rejected: one continuous file per role with offsets (deleting one participant after a seat reissue means rewriting a large file, and a crash can corrupt a whole role); handing audio to control over IPC (the spec keeps native audio code out of control).

## 3. Components

| Unit | Where | Job | Depends on |
| --- | --- | --- | --- |
| `AudioStore` | `services/speech/src/store/audio-store.ts` | `write(role, segment)`: validate ids, create dirs, write the file, append the index `segment` line. Returns ok or a stop reason. | `StoreLock`, `DiskGuard`, injected clock and fs |
| `IndexFile` | `store/index-file.ts` | Append and read-merge of `index.jsonl` lines (`segment`, `seq`, `deleted`); last line wins per field. | fs |
| `StoreLock` | `store/store-lock.ts` | Copy of the `SessionLock` pattern (`O_CREAT\|O_EXCL\|O_RDWR\|O_NOFOLLOW`, 0600, `{pid, host, startedAt}`, heartbeat, stale takeover by rename-aside with device and inode proof). One writer per `<logIdentity>` directory. | fs |
| `DiskGuard` | `store/disk-guard.ts` | Free-space check before each write against `AUDIO_MIN_FREE_MB` (default 2048, range 512 to 1 000 000). | injected `statfs` |
| `AuditLog` | `services/control/src/voice/audit-log.ts` | Append-only `<logIdentity>.audio-audit.jsonl` under its own lock `<logIdentity>.audio-audit.lock`; A2a writes `audio.deleted` (reason `expired`) and `voice.recording_stopped`. | `SessionLock` pattern (control copy or shared export; see section 9, question 1) |
| `Sweep` | `control/src/voice/sweep.ts` | At start-up and hourly: find expired audio, skip any session with a live worker, delete, audit. | `AuditLog`, supervisor (live workers), injected clock |

Hook points: `TrackPipeline` hands each closed segment to the store (the segment id is already worker-made and file-safe); `worker.ts` handles `voice_line_result` by appending the `seq` line (today unused, `worker.ts:50`).

## 4. Layout and permissions

`<AUDIO_DIR>/<logIdentity>/<roleId>/<segment>.wav` and `index.jsonl`. `AUDIO_DIR` defaults to `<CONTROL_DATA_DIR>/audio`, must be absolute, and reaches the worker through the speech env allowlist. The directory name is the log's 32-hex identity, not the session id. Directories `0700`, files `0600`, created exclusively without following symlinks. Every segment id and role id is validated against `FILE_SAFE_ID_PATTERN` before any path is joined, and the resolved path must stay inside the session directory.

## 5. Write path and failure behaviour

1. Disk guard: free space below the floor means no write. 2. Write the audio file (exclusive create). 3. Append the `segment` line to the index. 4. Control relays `voice_line_result`; the worker appends the `seq` line. A crash leaves at most an orphan `.wav` with no index line; the sweep removes it.

A low-disk condition or any write error **stops recording for the session** (the transcript continues, so the privacy invariant "no record without consent" is unaffected): the worker sends `voice_alert disk_low` or `write_error`, control raises the facilitator alert and appends `voice.recording_stopped { reason }` to the audit log. Recording does not restart on its own within the session.

## 6. Retention sweep (control)

Runs at control start-up and every hour. The expiry clock starts at session end, or at the last recorded activity plus 24 hours when the session never ended; file times are the backstop. A directory older than `AUDIO_MAX_RETENTION_DAYS` is deleted (files, then the index, then the directory), and one `audio.deleted { scope: session, reason: expired, by: system, segments: n }` line is appended **after** the delete succeeds. The sweep never touches a session that has a live worker. It also removes orphan files. A failed delete is logged by name only and retried next run.

## 7. Settings

`AUDIO_DIR`, `AUDIO_MIN_FREE_MB`, `AUDIO_MAX_RETENTION_DAYS`, added to `docs/memory/models-and-providers.md`, `.env.example` and, for the worker, the speech env allowlist. `voice:check` reports free space against the floor.

## 8. Testing and security

- Unit: id and path validation (separators, `..`, absolute, symlink in the tree); permissions of the directory and files; exclusive create refusing an existing file; write order and orphan handling (fault injection between steps); disk guard thresholds; lock acquire, heartbeat, stale takeover and a second writer refused; index merge (last line wins); sweep selects by the right clock, skips a live worker, audits after delete, retries after a failed delete; recording stops and alerts on `disk_low` and on a write error, and the transcript still gets the line.
- Mutation checks on the guard, the path join and the live-worker skip.
- Threat model: new entries for the audio directory, the lock, the sweep and the audit log. Rollback: `VOICE_ENABLED=0`; an older build ignores the audio directory and the audit file.
- Out of scope here (A2b): replay route, delete, `audio.played`, console panel.

## 9. Open questions for review

1. Control also needs the lock pattern (audit log, sweep). Copy a second time or export `SessionLock` as a sixth `@acr/runtime` subpath?
2. Contract 5 says one writer (the worker) per index, but also has control write `deleted` lines. A2a only expires whole sessions (directory removal), so `deleted` lines are an A2b concern; confirm.
3. How does the sweep learn "session ended" and "last activity" without reading the session log: from the session list, from the voice record, or from file times only?
