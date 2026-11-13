# Voice A2b-1b Audio Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator can delete a session's audio (session, role or participant scope) through control only, audited first, refused while live, with partial results across identity folders.

**Architecture:** `DELETE /sessions/:id/audio` calls `AudioService.delete`, which runs `deleteAudio` (new `voice/audio-delete.ts`): per identity, one at a time, it try-takes a shared in-process mutex and the store lock (typed acquirer), reads the role indexes through a fail-closed reader, appends the audit line, then one `deleted` index write per role, then unlinks the WAVs. The sweep shares the mutex and becomes deleted-aware. The `deleted` line format lives in `@acr/speech/protocol`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `fs` descriptors, vitest, the existing `@acr/runtime/files` `SessionLock`.

**Spec:** `docs/superpowers/specs/2026-11-13-voice-a2b1b-audio-delete-design.md` (Draft 2, owner-approved 2026-11-13). Parent: `docs/superpowers/specs/2026-11-12-voice-a2b1-audio-replay-delete-design.md` (sections 5 to 10), merged code from PR #139 (`services/control/src/voice/audio-*.ts`).

## Global Constraints

- Control imports only `@acr/speech/protocol` from speech. No check-then-use of a path (CodeQL `js/file-system-race`): open, then check the descriptor.
- No hand-written id regexes: use `isFileSafeId`, `isLowerHex`, `isValidSessionId` (accepts upper case). The runtime `id-rules.files.test.ts` scans for violations.
- Locks are released by the holder, never unlinked by path. Nothing logs a path, an id, an identity or a name.
- `AuditLog.append` returns `Promise<boolean>`, never rejects. `by` is `<name>-console` (`parseBy`, header at most 64 characters, name at most 56).
- Error codes: 400 bad body or `by`; 401 no token (before any file call); 404 bad session id or no audio; 409 `session_live`; 503 the worst pending reason in the order `store_unsafe` > `audit_unavailable` > `busy`, `Retry-After: 1` only with `busy`; delete in-flight cap 4 gives 503 `busy` at once.
- Commit format `[TYPE] SHORT-ID: description` (max 72 characters), story id `US-0075`; end commits with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. All tests pass before each commit; keep at least 80% coverage.
- New ids to use: US-0075, AC-0442 onward, TC-0233 onward, TASK-0111 (check `docs/ID_REGISTRY.md` first).

## Review Focus

1. A delete that arrives during a worker restart backoff, `mediaLost` or a probe: 409, nothing written (Task 7 test).
2. Two deletes for one session at once: the second reports `busy` for the held identity and writes no second audit line (Task 7).
3. A role index whose last line is torn (no newline): the `deleted` lines still start on their own line (Task 1).
4. A participant id with spaces or non-ASCII characters (up to 128 characters): deletes by participant, never appears in a path (Task 7).
5. A session whose audio sits only in a pre-marker (fallback) folder: delete must delete it, not skip it with a 200 `deleted: 0` (Tasks 4 and 7).
6. A replay racing a delete: the replay's audit line is written while the delete marks and unlinks; no byte may go out for a segment that is marked by then (Task 4).
7. A role entry that is a link or another user's folder under an identity, for the session and participant scopes: the identity is `pending store_unsafe`, never silently skipped (Task 7).
8. A retry after a partial result does only the remainder and never a second audit line for finished identities (Task 7).

---

### Task 1: The `deleted` index line in the protocol, and the story filing

**Files:**
- Modify: `services/speech/src/protocol.ts`; `services/speech/src/__tests__/imports.test.ts`
- Create: `services/speech/src/__tests__/protocol-deleted-line.test.ts`
- Modify: `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md` (file US-0075 under EPIC-0003, the ACs for each section 4 behaviour, TASK-0111, placeholder TCs; follow the A2b-1a entries)

**Interfaces:**
- Produces (exported from `@acr/speech/protocol`):
  - `type DeletedIndexLine = { v: 1; kind: "deleted"; segment: string; op: string; ts: number }`
  - `isDeletedLine(x: unknown): x is DeletedIndexLine` (`v === 1`, `kind === "deleted"`, `segment` passes `isFileSafeId`, `op` passes `isLowerHex(op, 16)`, `ts` finite and at least 0)
  - `appendDeletedLines(file: string, lines: DeletedIndexLine[], write?: (fd: number, buf: Buffer, off: number, len: number) => number): void` (test seam `write`)

- [ ] **Step 1: Write failing tests** in `protocol-deleted-line.test.ts`: `isDeletedLine` accepts a valid line and rejects each of: wrong `v`, wrong `kind`, a segment with `/` or `..`, an `op` of 15 or 17 hex or upper-case, a negative or `NaN` `ts`. `appendDeletedLines` on a temp file: writes N lines in ONE `write` call and one fsync (count via the seam); starts the first line on its own line when the file ends without `\n`; refuses a symlink (throws), a non-regular file, a file of another user (assert the check with a stubbed `fstat` where a real foreign file cannot be arranged), and a missing file (no `O_CREAT`: the file stays absent); continues a short write; a write that makes no progress throws an error whose `code` is `short_write`; the error message never contains the path.
- [ ] **Step 2: Run** `npm test -w @acr/speech -- protocol-deleted-line` and confirm FAIL (not defined).
- [ ] **Step 3: Implement** the three exports in `protocol.ts`. `appendDeletedLines` opens `O_WRONLY|O_APPEND|O_NOFOLLOW` (no `O_CREAT`), `fstat`s the descriptor (regular file), uses ONE `O_RDWR|O_APPEND|O_NOFOLLOW` descriptor (as `appendIndexLine` in `store/index-file.ts` does; never a second open by path) and reads the last byte through it to terminate a torn line, checks on that descriptor's `fstat` that it is a regular file owned by this user, builds one buffer, writes it with an inlined loop (`writeFully` lives in speech's store and cannot be imported here), `fsync`s, closes. Errors carry the errno code only.
- [ ] **Step 4: Widen `imports.test.ts`** so `protocol.ts` may import `node:fs` besides `@acr/events` and `zod`, and nothing else; add an assertion that a `node:child_process` import in `protocol.ts` would still fail.
- [ ] **Step 5: Add a speech test** (in the existing index-file test) that `readIndex` skips a `{ v: 1, kind: "deleted", ... }` line and still returns the segment entries.
- [ ] **Step 6: File the story** in the tracker docs (US-0075, ACs, TASK-0111, TC placeholders as Not Run) and record the next free ids in `ID_REGISTRY.md`.
- [ ] **Step 7: Run** `npm test -w @acr/speech` and `npm run typecheck -w @acr/speech`; expect PASS. **Commit** `[feat] US-0075: deleted index line in the speech protocol`.

### Task 2: Widen the audit event

**Files:**
- Modify: `services/control/src/voice/audit-log.ts`; `services/control/src/__tests__/voice/audit-log.test.ts`

**Interfaces:**
- Produces: `AuditEvent` member `{ type: "audio.deleted"; scope: { kind: "session" } | { kind: "role"; role: string } | { kind: "participant"; participant: string }; reason: "expired" | "facilitator" | "participant_request"; by: string; segments: number; op?: string }`. The sweep's call `{ scope: { kind: "session" }, reason: "expired", by: "system", segments }` must still compile.

- [ ] **Step 1: Failing tests**: a `facilitator` role-scope line, a `participant` scope line and a `participant_request` line are written with exactly the declared keys (`v, ts, type, scope, reason, by, segments, op`); an extra key on the event object is never written; `op` is absent from a sweep line; a smuggled `raw` or `path` key is dropped.
- [ ] **Step 2: Run** `npm test -w @acr/control -- audit-log` and confirm FAIL.
- [ ] **Step 3: Implement** in `lineOf`: build `scope` field by field per kind (`{kind}`, plus `role` or `participant` only for those kinds), include `op` only when it is a string. Update the file's doc comment.
- [ ] **Step 4: Run** the control audit tests and typecheck; expect PASS. **Commit** `[feat] US-0075: audit event for facilitator audio deletes`.

### Task 3: Typed store-lock acquirer and the identity mutex

**Files:**
- Create: `services/control/src/voice/store-lock.ts`; `services/control/src/__tests__/voice/store-lock.test.ts`
- Modify: `services/control/src/voice/sweep.ts` (`makeAcquireLock`, `startAudioSweep` deps)

**Interfaces:**
- Produces:
  - `class IdentityMutex { tryTake(identity: string): (() => void) | null }` (a `Set<string>`; the returned release is idempotent)
  - `type StoreLock = { kind: "held"; release(): void; assertHeld(): Promise<boolean> }` (`assertHeld` calls the `SessionLock`'s own `assertHeld()`, which verifies NOW; the `lost` getter only flips on the 5 s heartbeat and is a no-op right after acquiring) and `type StoreLockResult = StoreLock | { kind: "locked_other" } | { kind: "locked_here" } | { kind: "unsafe" } | { kind: "error" }`
  - `acquireStoreLock(dir: string, id: string, mutex: IdentityMutex): StoreLockResult`: mutex first (`null` gives `locked_here`), then `SessionLock.acquire(dir, id, { suffix: "store" })`; a `SessionLockError` with `code === "locked"` gives `locked_other` and frees the mutex; a `SessionLockError` with code `not_a_file` (the lock is a link, has extra hard links or belongs to another user: it never clears on its own) gives `unsafe`; anything else gives `error`; both free the mutex; `release()` releases both and never throws.
  - `makeAcquireLock(log?, mutex = new IdentityMutex())` keeps returning `StoreLockAcquirer` (`{ release } | null`), now built on `acquireStoreLock` (same logging rule as today: log `SWEEP_LOCK_FAILED` for `error` and `unsafe`).

- [ ] **Step 1: Failing tests**: a second `tryTake` of one identity returns null until released; `acquireStoreLock` returns `held` then `locked_here` for the same id and mutex; `locked_other` when a different mutex (a second acquirer instance simulating another process) holds the real `SessionLock`; `error` when `dir` does not exist; `unsafe` when the lock file is a symlink; `release()` lets the next acquire succeed and is safe to call twice; the existing sweep tests that use `makeAcquireLock` still pass.
- [ ] **Step 2: Run** `npm test -w @acr/control -- store-lock sweep` and confirm the new tests FAIL.
- [ ] **Step 3: Implement** `store-lock.ts`, rebuild `makeAcquireLock` on it, and let `startAudioSweep`'s `deps` accept an optional `mutex: IdentityMutex` that it passes to `makeAcquireLock` (default: a private one).
- [ ] **Step 4: Add a test** that scans the NON-test sources of `services/control/src` (skip `__tests__`, as speech's `imports.test.ts` `sources()` does; existing sweep tests call the lock directly) for `SessionLock.acquire(` with `suffix: "store"` and asserts only `store-lock.ts` calls it (this is what makes `locked_other` sound).
- [ ] **Step 5: Run** full control tests and typecheck; PASS. **Commit** `[feat] US-0075: typed store-lock acquirer and identity mutex`.

### Task 4: Fail-closed index reader

**Files:**
- Modify: `services/control/src/voice/audio-catalog.ts` (`readSegmentIndex`, `parseSegmentIndex`, `roleSegments`), `services/control/src/voice/audio-replay.ts`, `services/control/src/voice/audio-routes.ts`, `services/control/src/api.ts`
- Test: `services/control/src/__tests__/voice/audio-catalog.test.ts`, `audio-replay.test.ts`, `audio-routes.test.ts`

**Interfaces:**
- Produces: `openOwnDirErr(p: string): { ok: true; fd: number; st: Stats } | { ok: false; code: string }` (an errno-returning twin of `openOwnDir`, which stays as is for its other callers: `openOwnDir` folds ENOENT, ELOOP, ENOTDIR and a foreign owner into one `null`, so the reader cannot be built on it); `stillBelongs(audioDir: string, identity: string, sessionId: string): boolean` (true when `find` would still return the identity: its marker names the session, OR it is the fallback's pre-marker folder, i.e. a folder with NO `session.json` that the fallback maps to the session; export what it needs from the existing `folderMatches`/`preMarkerFolder` logic); `type IndexRead = { kind: "trusted"; index: SegmentIndex } | { kind: "untrusted" }`; `readSegmentIndex(audioDir, identity, role): Promise<IndexRead>` (a bad identity or role id is `untrusted`, as before no file call is made). Trusted: a missing identity folder, role folder or `index.jsonl` (ENOENT) gives an empty index. Untrusted: a link (`ELOOP`), `ENOTDIR`, another user's folder or file, an over-cap file, or any other error. `parseSegmentIndex` uses `isDeletedLine` from the protocol for deleted lines.
- `ReplayResult` gains the code `"store_unsafe"`; `PlayResult` includes it. The route answers `failClosed(res, 503, "store_unsafe")`.

- [ ] **Step 1: Failing tests** (catalog): the table above, one case each (missing folders and file trusted-empty; symlinked role folder, foreign-owner file, 64 MiB + 1 file, `ENOTDIR` untrusted); a `deleted` line without `op` or `ts` is ignored. (Replay): an untrusted index for the first identity returns `store_unsafe` and never asks the next identity; the second read (after the WAV) untrusted also returns `store_unsafe` (not `not_found`); a deleted mark still returns `audio_deleted`. (Listing): the segments of an untrusted role are omitted, the others still listed.
- [ ] **Step 1b: Failing tests** for `stillBelongs` (marker folder true; marker naming another session false; fallback pre-marker folder true; a folder with a `session.json` for another session false) and for the **replay-versus-delete race**: `replaySegment` with a blocking fake `audit.append` and a test that writes a `deleted` line for the segment while the append is blocked; after release the replay must answer `audio_deleted` and send zero bytes.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** `openOwnDirErr`, `stillBelongs` and the new return type (ENOENT on any level is trusted-empty; every other code untrusted), update every caller (`identitySegments`/`roleSegments` skip an untrusted role; `replaySegment` maps it to `store_unsafe` at both reads), and the route mapping. **Replay also re-reads the owner's index AFTER the audit append succeeds** and answers `audio_deleted` with no bytes when the segment is marked by then (the audit line over-reports, which is the recorded audit-first residual). Update the doc comments that say an untrusted index "counts as no line".
- [ ] **Step 4: Run** `npm test -w @acr/control -- voice` and typecheck; PASS. **Commit** `[feat] US-0075: replay and listing fail closed on an untrusted index`.

### Task 5: Deleted-aware sweep

**Files:**
- Modify: `services/control/src/voice/sweep.ts` (`indexedSegments`, `removeOrphans`)
- Test: `services/control/src/__tests__/voice/sweep.test.ts`

**Interfaces:**
- Consumes: `isDeletedLine` (Task 1). Produces: `indexedSegments(role)` returns the ids with a `kind:"segment"` line MINUS ids named by a valid deleted line; `null` (cannot tell) unchanged.

- [ ] **Step 1: Failing tests**: a kept folder with a WAV whose id has a segment line AND a valid deleted line: the pass unlinks it (`orphans` counts it); a WAV with a segment line only is kept; a deleted line with an invalid shape (no `op`) does not remove a WAV; an untrusted (linked) index still removes nothing.
- [ ] **Step 2: Run** and confirm FAIL.
- [ ] **Step 3: Implement** (parse deleted lines with `isDeletedLine`; subtract). No other sweep behaviour changes.
- [ ] **Step 4: Run** sweep tests; PASS. **Commit** `[feat] US-0075: sweep removes deleted-marked audio`.

### Task 6: `VoiceHost.isLive`

**Files:**
- Modify: `services/control/src/voice/voice-host.ts`; test `services/control/src/__tests__/voice/voice-host.test.ts`

**Interfaces:**
- Produces: `isLive(sessionId: string): boolean` on `VoiceHost`: true when an entry exists for the session that is not `ended` and not `voiceOff`; false otherwise (no entry, ended, voice off); never throws, never creates an entry (use the `sessions` map, not the private `session()` that creates).

- [ ] **Step 1: Failing tests**: no entry false; after `voice_seats` (live) true; during a restart backoff true; during `mediaLost` true; after `end` false; after `voiceOff` false; calling it for an unknown id does not create an entry.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement.** **Step 4: Run** PASS. **Commit** `[feat] US-0075: VoiceHost.isLive for the delete check`.

### Task 7: `deleteAudio`

**Files:**
- Create: `services/control/src/voice/audio-delete.ts`; `services/control/src/__tests__/voice/audio-delete.test.ts`

**Interfaces:**
- Consumes: `AudioCatalog.find`, `stillBelongs` (Task 4), `readSegmentIndex` / `IndexRead` (Task 4), `acquireStoreLock` / `IdentityMutex` (Task 3), `AuditLog.append`, `appendDeletedLines` / `DeletedIndexLine` (Task 1), `openOwnDir`, `stillOwnDir`, `openPrivateRoot`, `FILE_FLAGS` (audio-catalog), `isLive` (Task 6).
- Produces:
  - `type DeleteScope = { kind: "session" } | { kind: "role"; role: string } | { kind: "participant"; participant: string }`
  - `type DeleteOutcome = { live: boolean; deleted: number; gone: string[]; identities: Array<{ identity: string; deleted: number; state: "done" }>; pending: Array<{ identity: string; reason: "busy" | "store_unsafe" | "audit_unavailable" }> }`
  - `deleteAudio(o: { audioDir: string; catalog: Pick<AudioCatalog, "find">; audit: Pick<AuditLog, "append">; mutex: IdentityMutex; isLive: (sessionId: string) => boolean; now: () => number; randomOp?: () => string }, sessionId: string, scope: DeleteScope, reason: "facilitator" | "participant_request", by: string): Promise<DeleteOutcome | null>` (`null` when the catalog finds no identity; `live: true` with the work done so far when a live signal stops it).

Per identity, in the catalog's sorted order, exactly the spec section 4 steps 1 to 8: try-take mutex (held gives `pending busy`); `acquireStoreLock` (`locked_other` stops the whole request as live; `locked_here` and `error` give `pending busy`; `unsafe` gives `pending store_unsafe`); re-check under the lock with `stillBelongs(audioDir, identity, sessionId)` (false: the identity is listed in `gone`, not silently dropped, and the body says so; a fallback-only session must still delete, see the test below); enumerate the identity's role folders through the verified identity descriptor (file-safe names only; a role entry that is a link, a non-directory or another user's folder makes the identity `pending store_unsafe` for the session and participant scopes, and for a role scope only when it is that role), then read each in-scope role index (untrusted gives `pending store_unsafe`, nothing written for the identity); choose undeleted segments in scope (participant scope matches the entry's `participantId` across every role); no segments: `facilitator` writes nothing, `participant_request` writes one audit line with `segments: 0` for an identity that holds audio (at least one WAV or one segment line in any role); audit line with `op` (16 hex) first (`false` gives `pending audit_unavailable`); `await lock.assertHeld()` (false: `pending store_unsafe`, no retry); one `appendDeletedLines` per role (a throw gives `pending store_unsafe`, nothing unlinked); `await lock.assertHeld()` again (false: `pending store_unsafe`; the marks already hold, the sweep finishes the unlink); unlink each WAV with the open-folder, open-WAV, `unlinkSync`, `stillOwnDir` sequence (nlink above 1 still counts; a failed unlink still counts as done); always release lock and mutex. `isLive` is checked before the first identity and again before each one.

- [ ] **Step 1: Write failing unit tests** (temp audio dir, real files, fake audit with call recording): session, role and participant scopes each mark and unlink exactly the in-scope segments and leave the others playable; the audit line is appended BEFORE any index write or unlink (a recording fake proves the order; an audit that returns `false` leaves files and index untouched and the identity `pending audit_unavailable`); live via `isLive` true returns `live: true` with nothing written; live via `locked_other` (a second acquirer holds the lock) returns `live: true`; the mutex held (simulating the sweep) gives `pending busy` and no audit line; two identities where the second is busy gives the first `done` and the second `pending`, and a retry deletes only the remainder with no second audit line for the first; untrusted index (symlinked `index.jsonl`) gives `pending store_unsafe` and nothing changes; an index write that throws leaves WAVs in place; `participant_request` with no segments writes one `segments: 0` line, `facilitator` writes none and returns `deleted: 0`; a participant id with spaces and non-ASCII (up to 128 characters) works; a torn last index line is terminated before the marks; a folder swapped for a symlink before the unlink is not followed; a WAV with `nlink` 2 is marked and our name unlinked; a fake lock whose `assertHeld` returns false before the index write gives `pending store_unsafe` and writes no index line (the audit line is already out: documented residual); a lock file that is a symlink gives `pending store_unsafe`, not `busy`; a **fallback-only** session (a pre-marker folder, no `session.json`) is deleted, not skipped; a folder that vanished between `find` and the lock appears in `gone`; a role folder that is a symlink gives `pending store_unsafe` for the session scope and nothing is touched for that identity.
- [ ] **Step 2: Run** `npm test -w @acr/control -- audio-delete` and confirm FAIL.
- [ ] **Step 3: Implement** `audio-delete.ts` to the signature and order above. Keep it free of path logging; `op` comes from `crypto.randomBytes(8).toString("hex")` unless `randomOp` is given.
- [ ] **Step 4: Run** the new tests and the whole control suite plus typecheck; PASS. **Commit** `[feat] US-0075: audited delete of a session's audio`.

### Task 8: The route, the service and the wiring

**Files:**
- Modify: `services/control/src/voice/audio-routes.ts` (`AudioService.delete`, its own delete in-flight counter, separate from replay's `inFlight` of 8, cap 4); `services/control/src/api.ts`; `services/control/src/main.ts` (`buildAudioService`, `startAudioSweep`, the shared mutex); `services/control/src/http-util.ts` only if `send` needs nothing new (it already takes `retryAfterSeconds`)
- Test: `services/control/src/__tests__/voice/audio-routes.test.ts` (the HTTP audio tests live here; there is no `api.audio.test.ts`). `__tests__/voice/audio-replay.e2e.test.ts` calls `buildAudioService(config, { audit })`, so the new deps are OPTIONAL (`mutex` defaults to a private `IdentityMutex`, `isLive` to `() => false`) and that file needs no change

**Interfaces:**
- Consumes: `deleteAudio`, `IdentityMutex`, `VoiceHost.isLive`.
- Produces: `AudioService.delete(sessionId: string, body: { scope: DeleteScope; reason: "facilitator" | "participant_request"; by: string }): Promise<{ ok: true; outcome: DeleteOutcome } | { ok: false; code: "busy" }>`; `buildAudioService(config, deps: { audit; mutex?: IdentityMutex; isLive?: (id: string) => boolean })`; one `IdentityMutex` created in `main.ts` and passed to both `startAudioSweep` and `buildAudioService`; the Supervisor's VoiceHost is built inside `new Supervisor(...)`, so the `isLive` closure captures the host through a `let` assigned in that factory.

Route behaviour (`DELETE /sessions/:id/audio`, length-3 path only): service token already checked before routing; bad session id 404; `audio` absent 404; body via `jsonBody` and a strict zod schema (`scope` discriminated on `kind`, `role` file-safe, `participant` a string of 1 to 128 characters and not `rebind-pending`, `reason` enum, `by` string passing `parseBy`; unknown keys rejected) giving 400 with the same code and message the GET route uses for a bad `by` (`fail(res, 400, "invalid", BAD_REQUEST)`), for every 400 of this route; `X-Acr-By`, when present, must equal `body.by` else 400; outcome `null` is 404 `NO_AUDIO`; `live` is 409 `session_live` with the outcome body; pending is 503 with the worst code and the body (`send(res, 503, { success: false, data: body, error: { code } }, false, code === "busy" ? 1 : undefined)`); otherwise `ok(res, body)`.

- [ ] **Step 1: Failing HTTP tests** (real server, fake service where useful): 401 with no token and no file call (spy); 404 bad id; 400 for each: missing body, unknown key, two scope kinds, bad `by`, header differing from body, `rebind-pending` participant, oversize body; 200 with the outcome shape for each scope; 409 with live; 503 `busy` carries `Retry-After: 1` and the partial body; 503 `store_unsafe` and `audit_unavailable` carry NO `Retry-After`; worst-reason ordering with mixed pendings; the 5th concurrent delete while 4 are in flight gets 503 `busy` immediately and the slot is freed on every path (success, throw); an upper-case session id works; nothing in any response, and nothing the test logger saw, contains the audio path.
- [ ] **Step 2: Run** and confirm FAIL. **Step 3: Implement** the service method, the route, the schema and the wiring. **Step 4: Run** all control tests, typecheck and `npm run lint`; PASS. **Commit** `[feat] US-0075: DELETE /sessions/:id/audio route and wiring`.

### Task 9: Real-store end to end and mutation checks

**Files:**
- Create: `services/control/src/__tests__/voice/audio-delete.e2e.test.ts` (model it on `audio-replay.e2e.test.ts`: real speech store, real sweep, real audit, real HTTP)

- [ ] **Step 1: Write the tests**: the real store writes a session; list shows it; DELETE by role gives 200, replay of a deleted segment gives 410, the others still play; the audit file holds one `audio.deleted` line with the `facilitator` reason and no text, path or audio field; a crash injected after the audit line and before the index write (a `deleteAudio` seam or a throwing `appendDeletedLines` stub) leaves audio playable, and a retry writes a NEW line with a new `op`; a crash after the index write and before the unlink is repaired by `sweepAudio` (WAV gone, `orphans` counts it); a delete racing a real sweep in one process gives `pending busy` not 409 (arrange it with the sweep over an EXPIRED session and a blocking fake audit so it holds the mutex across an await; a kept-folder pass holds it synchronously and cannot interleave); a replay racing a delete never returns bytes for a segment marked meanwhile; a live session (VoiceHost `isLive` true) gives 409 and a second process holding the real store lock gives 409; two identity folders for one session, one held by the test, gives 503 with partial counts and a retry finishing the rest; the session scope leaves `session.json` and the index so replay answers 410 not 404.
- [ ] **Step 2: Run** them; fix only test mistakes (production code gets fixed in its own task, with a regression test there).
- [ ] **Step 3: Mutation checks.** For each of: (a) write the index marks before the audit line; (b) skip the `isLive` check; (c) skip the mutex take; (d) skip writing the deleted mark; (e) treat an untrusted index as empty; (f) drop path containment in the unlink (use an unchecked path); apply the change, run the control suite, record the NAME of the test that failed, revert. Append the table (mutation, failing test) to the end of the plan's section in the test file as a comment. If a mutation survives, add a test that kills it.
- [ ] **Step 4: Run** the full workspace: `npm test`, `npm run typecheck`, `npm run lint`; PASS. **Commit** `[test] US-0075: audio delete end-to-end and mutation checks`.

### Task 10: Docs and close-out

**Files:**
- Modify: `docs/THREAT_MODEL.md` (delete route, mutex, audit-first residual, untrusted-index fail-closed, the identity returned in the response, stuck-live after a crash), `docs/VOICE_RUNBOOK.md` (how a facilitator deletes; 409 means end or restart the session first; reading a partial 503), `docs/ROLLBACK.md` (US-0075 entry: control only; speech needs the protocol export only for the type), `CHANGELOG.md` (`[Unreleased]`), `docs/RELEASE_PLAN.md` and `docs/TEST_CASES.md` (statuses; TC for each AC; any owner-run case Not Run), `docs/ID_REGISTRY.md`, `progress.md` (Session 46), `MEMORY.md` (a fact for the delete contract), A2a contract 5 reworded "one writer at a time, under the store lock" in the A2a spec.

- [ ] **Step 1: Write the docs** above, matching the style of the US-0074 entries. Record the residuals: audit-then-mark crash window, the stale-lock-after-sleep window (optional speech hardening left as a follow-up), synchronous index reads, the stuck-live decision.
- [ ] **Step 2: Regenerate** the dashboard with `npm run plan:generate` and review the diff.
- [ ] **Step 3: Run** the full workspace tests, typecheck and lint once more; PASS. **Commit** `[docs] US-0075: delete route threat model, runbook, rollback and close-out`.

---

## Self-review

- **Spec coverage:** sections 4 (route, order, response, live) in Tasks 7 and 8; 5 (acquirer, mutex, writer) in Tasks 1 and 3; 6 (fail-closed reader) in Task 4; 7 (sweep) in Task 5; 8 (audit) in Task 2; 10 (tests, mutations) in Tasks 7 to 9; 12 (risks) and the docs in Task 10; the live rule via `isLive` in Task 6.
- **Types:** `IndexRead` (Task 4) is consumed by Task 7; `DeletedIndexLine`/`appendDeletedLines` (Task 1) by Tasks 4, 5 and 7; `IdentityMutex`/`acquireStoreLock` (Task 3) by Tasks 7 and 8; `DeleteOutcome` (Task 7) by Task 8.
- **Left to the implementer** (spec section 11): exact helper names inside each file, how the `lost` flag is read from `SessionLock`, and the unlink helper's internals.
