# Voice slice A2b-1b: facilitator audio delete, control API (design)

Status: Draft 2 (2026-11-13): after an independent builder check (14 findings: 11 settled in the doc, 3 owner decisions answered). Parent: `2026-11-12-voice-a2b1-audio-replay-delete-design.md` (Draft 2, owner-confirmed 2026-11-12; sections 6, 7, 9 and 10 stay in force and are refined here), `2026-11-09-voice-a2a-audio-store-design.md`, `docs/THREAT_MODEL.md`. A2b-1a (US-0074, PR #139) is merged. Proposed story: US-0075 (not yet filed), EPIC-0003, dark behind `VOICE_ENABLED`. A2b-2 (web BFF and console AudioPanel) and A3 stay separate later slices.

## 1. Intent and why

A facilitator can delete what a participant said (the whole session, one role, or one participant), through the control service only. It exists because participants have no access to their own audio: they ask the facilitator, and the facilitator must be able to honour that, with proof. Every deletion is audited before anything is removed, and a deleted segment can never be played again. Deleting audio never changes the transcript.

**Already decided (owner) and kept:** delete is refused while the session is live (409); audit first, failing closed; the session scope keeps the folder, index and marker until expiry (no rename aside); audio recorded before an opt-out stays until expiry or a manual delete; participants never get their own audio.

**Decided 2026-11-13 (owner), new in this spec:**
1. **Partial results.** A session can have several identity folders. Delete works one folder at a time and reports what was done and what was not (section 4). It never holds several locks at once.
2. **Index writer through the protocol subpath.** One definition of the `deleted` index line, exported from `@acr/speech/protocol`, used by control to write it and by speech to skip it (section 5).
3. **Fail closed on an untrusted index.** When a role's index cannot be trusted, replay and delete both answer 503 `store_unsafe` for that role and touch nothing; replay no longer falls through to another identity's copy (section 6).

## 2. Goals, non-goals, anti-goals

Goals: `DELETE /sessions/:id/audio`; the live check; the per-identity mutex shared with the sweep; the typed lock acquirer; the `deleted` index line; the deleted-aware sweep; the fail-closed index reader; THREAT_MODEL, VOICE_RUNBOOK, ROLLBACK, CHANGELOG and tracker updates; unit, real-HTTP and real-store end-to-end tests with mutation checks.

Non-goals: any UI or BFF (A2b-2); live partials and mute (A3); un-delete; deleting transcript text; a participant-facing request path; per-segment delete (scopes are session, role, participant); changing retention.

Anti-goals (a failure even if it technically works): any audio byte or file path in a response, log or audit line; a delete that reports success while a WAV is still playable; a delete racing the sweep or a live worker; a deleted segment that replays through another identity's copy; blocking the event loop for a long delete.

## 3. Constraints

Control imports only `@acr/speech/protocol` from speech. No check-then-use of a path anywhere (CodeQL `js/file-system-race`): open, then check the descriptor. No hand-written id regexes (use `isFileSafeId`, `isLowerHex`, `isValidSessionId`; the runtime `id-rules.files.test.ts` scans). Locks are released by the holder and never unlinked by path. Speech's `isEntry` already skips unknown index kinds and the worker never reads the index. `AuditLog.append` returns `Promise<boolean>` and never rejects. Nothing logs a path, an id, an identity or a name. Control and speech still deploy together (A2b-1a ROLLBACK entry); this slice adds no new coupling beyond a protocol export that speech reads and control writes.

## 4. The route and its behaviour

`DELETE /sessions/:id/audio`, behind the service token (401 before any file call), `:id` validated with `isValidSessionId` (404 on a bad id, as every audio route does, before any file call). Strict JSON body `{ scope, reason, by }` (unknown keys 400, body size and type via `http-util`): `scope` is exactly one of `{ kind: "session" }`, `{ kind: "role", role }` (role file-safe), `{ kind: "participant", participant }` (the protocol's participant-id rule: a string of at most 128 characters, never `rebind-pending`; the id is never a path); `reason` is `facilitator` or `participant_request`; `by` is the review layer's `<name>-console` form (`parseBy`) and is **required in the body**; `X-Acr-By`, when present, must equal it (else 400; a repeated header is already refused by `parseBy`). *(Builder-check calls, 2026-11-13.)* The participant scope covers every role and every identity of the session.

**Live check, per request, before any file call:** the session is live when (a) VoiceHost holds an entry for it that is not ended and not `voiceOff` (worker, restart backoff, `mediaLost`, probe in flight), through a new read-only `VoiceHost.isLive(sessionId)` passed to the audio service; or (b) a typed store-lock acquire for an identity returns `locked_other`. Either gives **409 `session_live`** and nothing is written. (a) is checked first and again per identity, because a worker can start while earlier identities are being processed.

**Per identity, in the catalog's sorted order, one at a time:**
1. Try-take the in-process mutex for the identity (the sweep takes the same one; it never queues). Held (by the sweep or another delete): this identity is `pending` (reason `busy`).
2. Acquire the store lock with the typed acquirer (section 5). Once held, **re-check under the lock** that the identity folder and its `session.json` marker still exist and still name this session (the sweep may have renamed the folder away between the catalog's `find` and the lock, as `sweepOne` re-checks); if not, the identity is skipped as gone. `locked_other` while no host entry exists is still `session_live`: the whole request stops with 409 and reports the identities already done. `locked_here` and `error` make this identity `pending`.
3. Read each role index in scope through the fail-closed reader (section 6); an untrusted index makes the identity `pending` (reason `store_unsafe`) and nothing is written for it.
4. Choose the segments in scope not already marked deleted. If none: a `facilitator` request writes nothing for this identity; a `participant_request` still writes one audit line with `segments: 0` (proof the request was honoured) per identity that holds audio.
5. Append `audio.deleted { scope, reason, by, segments: n, op }` to the identity's audit log (`op` = 16 random hex, one per identity per request). `false` makes the identity `pending` (reason `audit_unavailable`) and nothing else happens for it.
6. Check `lock.lost` (as `AudioStore` does), then append the `{ v: 1, kind: "deleted", segment, op, ts }` lines for a role in **one write with one fsync** (not one fsync per segment: the lock heartbeat is 5 s, stale after 30 s, and a worker waiting on the lock gives up after 35 s). The segments are unplayable at once (410). An index write that fails makes the identity `pending` (reason `store_unsafe`) and nothing is unlinked for it.
7. Check `lock.lost` again, then unlink each WAV. Node has no `unlinkat`, so the sequence is: open the role folder `O_DIRECTORY|O_NOFOLLOW` and `fstat` it as a real folder of this user; open the WAV `O_NOFOLLOW|O_NONBLOCK` and `fstat` it; `unlinkSync(path)`; then `stillOwnDir`. The remaining same-user race is a recorded residual (the root's 0700 rule bounds it). A WAV with `nlink > 1` is marked, our name is unlinked and it counts as deleted. A failed unlink still counts as `done`: the mark already makes it unplayable and the sweep repairs it.
8. Release the lock and the mutex on every path.

Steps 5 and 6 run back to back with nothing awaited between them except the audit fsync. A crash after 5 and before 6 leaves audio playable while the audit says it was deleted (documented residual; a retry writes a NEW `op`, a duplicate line is acceptable). A crash after 6 is repaired by the sweep (section 7).

**Response.** `200 { deleted: n, identities: [{ identity, deleted, state: "done" }...], pending: [] }` when every identity is done. `identity` is the 32-hex value, exactly as the listing already returns it (facilitator-only API; stable across a retry, unlike a list position). When any identity is `pending`: **503** with the same body and `pending: [{ identity, reason: "busy" | "store_unsafe" | "audit_unavailable" }]`. **The error code is the worst reason present** (owner, 2026-11-13), in the order `store_unsafe` > `audit_unavailable` > `busy`, and `Retry-After: 1` is sent **only** with `busy` (a failure that cannot clear on its own is never retried blindly). `deleted` is the total newly marked. Retry is safe: segments already marked are skipped, so a second call only does the rest. A session with no marker folder is 404 (as the listing and replay); a session whose audio is already all deleted is 200 `{ deleted: 0 }`. 409 carries the same body shape with what finished before the live signal. The route answers through `send(res, 503, { success: false, data: body, error: { code } }, false, retryAfter)`, which already carries both a body and `Retry-After`.

**Live after a crash (owner, 2026-11-13):** when a runtime crashes without the session ending, VoiceHost keeps the entry (`Supervisor.onChildExit` detaches the voice but the session is not ended), so delete answers 409 until the session is ended or restarted. Accepted: VOICE_RUNBOOK says "end or restart the session first".

Error codes: 400 bad body or `by`; 401 no token; 404 bad session id or no audio for the session; 409 `session_live`; 503 (the worst reason, with the partial body); a delete in flight cap of 4 returns 503 `busy` at once. Nothing logs a path, an id or a name.

## 5. Lock acquirer, mutex and index writer

**Typed acquirer.** New `acquireStoreLock(dir, id)` returning `{ kind: "held", release } | { kind: "locked_other" } | { kind: "locked_here" } | { kind: "error" }`. `makeAcquireLock` (the sweep's `null`-folding form) is rebuilt on it so the sweep is unchanged in behaviour. `locked_here` is reported when this process's own mutex is held; `locked_other` only when `SessionLock.acquire` is refused by another live holder. `SessionLock.acquire` throws the same `locked` for a hold inside this process and for another process, so `locked_other` is sound only if every store-lock acquire in control goes through the mutex first; a test pins that.

**Mutex.** One in-process **try-lock** per identity (a `Set<string>`, not a queueing chain: both callers need "held means skip or pending"), shared by `sweepAudio` and delete through an object created in `main.ts` and passed to both `startAudioSweep` and `buildAudioService`. It serialises delete against the sweep inside one control process; the store lock serialises against a speech worker. VoiceHost is built inside `new Supervisor(...)` in `main.ts`, so the audio service's factory closure captures it before `buildAudioService` runs.

**Index writer.** `@acr/speech/protocol` gains `DeletedIndexLine` (`{ v: 1, kind: "deleted", segment, op, ts }`), `isDeletedLine(x)` and `appendDeletedLine(file, line)` (O_APPEND|O_NOFOLLOW, **no O_CREAT** (a segment to delete implies its index exists, and creating one could plant an index in the wrong folder), regular file of this user, terminates a torn last line first, writes fully with its own inlined write loop since `writeFully` lives in speech's store, fsyncs). `speech/src/__tests__/imports.test.ts` pins the protocol's imports to `@acr/events` and `zod`: it is widened to allow `node:fs` and nothing else. The catalog's and the sweep's index parsers call `isDeletedLine`, so no third parser exists. Speech's `appendIndexLine` and control's writer share the one definition of the line, and speech's reader skips it (a speech test asserts this). The protocol subpath is currently types and guards only, so the module note is updated; it must stay free of any speech-internal import. A2a contract 5 is reworded "one writer at a time, under the store lock".

## 6. Fail-closed index reader

`readSegmentIndex` (A2b-1a) today reads a link, another user's file, an over-cap file or an unreadable one as "no lines", and replay then falls through to the next identity. New: the reader returns `{ trusted: true, entries, deleted: Set<segment> } | { trusted: false }`. A missing index file, a missing role folder or a missing identity folder (`ENOENT`) is a trusted empty index (an identity that never recorded a role is not an error); a link (`ELOOP`), a non-directory (`ENOTDIR`), another user's file or folder, an over-cap file or any other failure is untrusted. Replay and delete answer 503 `store_unsafe` for a role whose index is untrusted and do not try another identity for that segment; replay's second index read (after the WAV) also answers `store_unsafe` (today it answers `not_found`). The listing keeps omitting the segments of an untrusted role (an untrusted index yields no segment ids). A deleted mark in an index that is later untrusted is therefore never bypassed.

## 7. Deleted-aware sweep

`indexedSegments` subtracts ids that have a `deleted` line, so a deleted-but-unlinked WAV is an orphan; the kept-folder pass unlinks a WAV that is present but marked deleted (the crash repair). The sweep takes the shared mutex before the store lock; `locked_here` leaves the identity for the next run (as `locked` does today). `audio.deleted` from the sweep keeps its own shape (`reason: "expired"`, `by: "system"`). The sweep treats an untrusted index as it does today (skips the orphan pass for that role, never deletes a WAV it cannot account for).

## 8. Audit

`AuditEvent` `audio.deleted` widens to `scope: { kind: "session" } | { kind: "role", role } | { kind: "participant", participant }`, `reason: "expired" | "facilitator" | "participant_request"`, `by`, `segments`, and `op` (facilitator and participant deletes only). `lineOf` still rebuilds every line field by field; a test proves an extra key is never written and a `facilitator` line has no raw text, audio or path.

## 9. Approaches considered

- **Index line writer:** (1) export it through `@acr/speech/protocol` — CHOSEN by the owner; one definition of the format that decides playability, at the cost of some write code in a mostly-types package; (2) re-implement in control with a drift test (rejected: two definitions to keep in step); (3) move delete into speech (rejected: needs a new control-to-speech channel while no worker may run, and drops the confirmed "control only" design).
- **Several identities:** (a) partial results, one folder at a time — CHOSEN by the owner; (b) all-or-nothing by holding every lock at once (rejected: it can deadlock against the sweep and holds a worker-visible lock longer).
- **Untrusted index:** fail closed with 503 `store_unsafe` — CHOSEN by the owner; the alternative (keep the fall-through) lets a delete mark be bypassed.

## 10. Tests and verification

Unit and real-HTTP tests; a real-store end-to-end (worker writes, control lists, deletes, replay gives 410, the sweep finishes a half-delete). Required cases: live via VoiceHost (worker, backoff, `mediaLost`, probe) and live via `locked_other` both 409 with nothing written; delete and the sweep at the same time in one process gives 503 not 409; two identities with one busy gives 503 with partial counts and a retry finishing it; an audit failure gives that identity `pending` and no index line, no unlink (mutation: writing before the audit must fail); crash injection after step 5 and after step 6 then a sweep run; a deleted segment gives 410 and the sweep removes its WAV; participant scope across roles and identities; `participant_request` with no audio still writes `segments: 0`; untrusted index (a link, another user's file, over the cap) gives 503 `store_unsafe` for replay and delete and no fall-through; a role folder that is a link, a WAV with `nlink > 1`; unauthenticated 401 before any file call; strict body (one scope kind, unknown keys, header and body `by` differing); extra audit keys dropped; speech's reader skips a `deleted` line. Mutation checks, each failing a named test: audit before marks, the live check, the mutex, the deleted mark, the fail-closed reader, path containment.

## 11. Left to the builder

Names of files and functions (suggested: `voice/audio-delete.ts`, `voice/store-lock.ts`, `voice/index-reader.ts`); how the in-flight cap and the per-identity mutex are composed; whether `VoiceHost.isLive` is a method or an injected predicate; the exact `unlink` mechanics through a descriptor on macOS and Linux; the TC and AC numbers (next free: US-0075, AC-0442, TC-0233, TASK-0111).

## 12. Risks and residuals

The audit-then-mark crash window (4 above). A stale lock takeover after a host sleep can leave a live worker writing for up to one heartbeat; the optional speech hardening (re-verify the lock before each WAV create) is left as a follow-up unless the builder finds it cheap. Synchronous index reads still block the event loop (bounded by the 64 MiB cap and the in-flight caps); an async reader is a recorded follow-up.
