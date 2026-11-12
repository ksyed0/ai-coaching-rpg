# Voice slice A2b-1: facilitator audio replay and delete, control API (design)

Status: Draft 2 (2026-11-12): after an independent Opus review of the in-chat design against the code (4 Critical, 7 Important findings, all incorporated), the owner CONFIRMED all six changes of section 11 on 2026-11-12. Parents: `2026-11-08-voice-part-a-design.md` sections 7 to 9 and 16, `2026-11-09-voice-a2a-audio-store-design.md`, `docs/THREAT_MODEL.md` (voice audio store, slice A2a). Proposed stories (not yet filed): A2b-1a and A2b-1b (EPIC-0003), dark behind `VOICE_ENABLED`. A2b-2 (web BFF routes and the console AudioPanel) is a separate later spec.

## 1. Intent

A facilitator can listen to what a participant said and can delete it, through the control service only. Every play and every deletion is audited. Participants, the evaluator and the AI characters never receive audio.

**Already decided (owner) and kept:** A2b is split into a control-API slice (this spec) and a BFF and console slice; the session id is mapped to its audio by a marker in the audio folder; delete is refused while the session is live; one audit line per play, written before any audio, failing closed; audio recorded before an opt-out stays until expiry or a manual delete (2026-11-11); participants get no access to their own audio (they ask the facilitator); deleting audio never changes the transcript.

**Out of scope:** BFF routes, the console AudioPanel, per-address throttles (A2b-2); live partials and mute (A3); participant self-access.

## 2. Components

| Unit | Where | Job |
| --- | --- | --- |
| Session marker | speech `store/session-marker.ts` + `audio-store.ts` | Writes `<identity>/session.json` `{ "v": 1, "sessionId": "<id>" }` (0600) lazily, before the first WAV of that identity (temp file, rename, directory fsync, like `ended.json`). A marker failure stops the store with `write_error`. `SPEECH_SESSION_ID` is set by `buildSpeechEnv` from `extra` only (never inherited, never on the allowlist), validated with the session-id rule in the worker config, and required whenever the store is configured. |
| `AudioCatalog` | control `voice/audio-catalog.ts` | `find(sessionId)` returns EVERY identity whose marker names the session (a restart on the same session id can rotate the log and get a new identity, so several folders per session is normal). It scans `<audioDir>` on every request (no cache: roughly 30 days of folders, one small `O_NOFOLLOW` read of at most 4 KB each). Lists roles and segments from each `index.jsonl` (64 MiB cap, torn lines skipped). |
| Replay routes | control `voice/audio-routes.ts` | Listing and one-segment WAV (section 5). |
| Delete | control `voice/audio-delete.ts` + route | Section 6. |
| Audit log | control `voice/audit-log.ts` | `append` returns `Promise<boolean>` (section 7). |
| Sweep change | control `voice/sweep.ts` | Deleted-aware orphan pass (section 6). |

## 3. Finding a session's audio

A session with no marker folder answers 404. Folders recorded before the marker existed (A2a ran dark and in pre-production only): fall back to the session log's `session.started.logIdentity` (the same file report jobs already read); if that fails, only the sweep handles them. The route never calls `supervisor.get` (audio outlives the session list; the revoke route skips that check for the same reason). A marker that is missing, torn, a link, of another `v`, or names another session is ignored for that folder. The marker ties a session id to a folder: low sensitivity next to the `raw` transcript text already in the index.

## 4. Listing: `GET /sessions/:id/audio`

200 with `{ identities: n, recordingStopped: bool, segments: [{ identity, role, segment, participantId, startMs, endMs, status, seq?, audio: "available" | "deleted" | "missing" }] }`; never `raw`. `recordingStopped` comes from `voice.recording_stopped` in the audit log. A session with no audio is 404 (none, deleted, or expired are not distinguished). **The listing is not audited** (recorded 2026-11-12, built in A2b-1a): it exposes metadata only (ids, times, status), not audio, so it is not "hearing a recording" under ADM-04; it is still facilitator-only and, like the replay, needs `X-Acr-By`; it has no in-flight limit (only the 64 MiB index caps). `audio: available` means only that the WAV opens as a regular file of this user with one link, not that the replay size window (44 to 524288 bytes) holds.

## 5. Replay: `GET /sessions/:id/audio/:role/:segment`

**Whole file, no Range (deviation from parent spec section 8's "range requests"; owner confirmed 2026-11-12).** A WAV is accepted by the replay only up to 524288 bytes (512 KiB), and a segment is normally about 200 KB (A2a section 2), so control answers `200` with the full body, `Accept-Ranges: none`, and ignores any `Range` header (RFC 9110 allows this). This removes the audit hole of a client that never asks for byte 0 (Safari and Chrome media probes, direct seeks): every byte that leaves is audited, one `audio.played` line per successful request, which is what ADM-04 asks ("who heard recordings"). The console (A2b-2) plays through `fetch` to a Blob, so seeks never reach control.

**Buffered, not streamed.** The global `server.timeout = 0` would let a slow reader hold a descriptor forever, and `send` on a response whose headers are already sent just ends it (a truncated body would look complete). Order of checks: validate `:role` and `:segment` with the file-safe rule (404 on a bad id, before any file call) → for each identity from the catalog, open the identity and role folders as real directories of this user → `open(O_RDONLY|O_NOFOLLOW)` the WAV → `fstat` the descriptor (regular file, own uid, `nlink === 1`, 44 <= size <= 512 KB) → read everything through the descriptor → close → require the segment's index line to exist and not be marked deleted (else 404 or 410) → append `audio.played { role, segment, by }` to THAT identity's audit log; `false` means **503 `audit_unavailable` and zero body bytes** → `writeHead(200)` with exact `Content-Length`, `Content-Type: audio/wav`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. No check-then-use of a path anywhere (CodeQL `js/file-system-race` flagged those on the A2a PR). A concurrency cap of 8 in flight; over it, 503 `busy`. Replay is allowed during a live session (the worker writes the WAV, fsyncs, then writes the index line, and replay requires the index line).

**Auth and `by`.** Behind control's existing launcher-token check (timing-safe, before routing; an unauthenticated request gets 401 before any file-system call). The facilitator name comes in an `X-Acr-By` header (not the query string, so it stays out of URL logs) and is the review layer's author form `<name>-console`: the `-console` suffix is required and `<name>` must pass `isConsoleName` (a safe id of at most 56 characters), so **the whole header is at most 64 characters** (corrected 2026-11-12: this sentence said "at most 56 characters"; 56 is the name). It is required on **both** routes (the listing too) and is the audit line's `by` unchanged; a missing or bad one is 400. **Residuals recorded 2026-11-12 (built in A2b-1a):** (1) audit-before-bytes means a client that disconnects mid-write still leaves its `audio.played` line (it over-reports, never under-reports); (2) when an identity's role index cannot be trusted (a link, another user's file, over the cap, unreadable) the replay treats that identity as having no line for the segment and falls through to the next identity's copy of the same segment id, so a delete mark in the untrusted index would be bypassed (the bytes served are the next identity's own and are audited); a stricter reader that tells "missing" from "cannot tell" is left to A2b-1b; (3) the role index is read twice per replay (before and after the WAV, each up to 64 MiB, synchronous), bounded by the in-flight cap of 8.

## 6. Delete: `DELETE /sessions/:id/audio`

Strict body `{ scope, reason, by }`: `scope` is exactly one of `{ kind: "session" }`, `{ kind: "role", role }`, `{ kind: "participant", participant }`; `reason` is `facilitator` or `participant_request`; `by` as above. The participant scope covers every role and every identity of the session.

**Live means refuse (owner decision), judged in two ways:** the session is live when (a) VoiceHost has an entry for it that is not ended and not `voiceOff` (a worker, a restart backoff, `mediaLost`, or a probe in flight; the store lock is free during those), OR (b) the store lock for an identity is refused by another process. Either gives **409 `session_live`**. A new acquirer returns `held | locked_other | locked_here | error` (today `makeAcquireLock` folds every failure into `null`). Delete and the sweep are serialised by an in-process mutex per identity; `locked_here` (the sweep holds it) and `error` answer **503 `busy`** with `Retry-After`, never 409. Optional hardening in speech: re-verify the lock synchronously before each WAV create (a stale takeover after a host sleep can leave a live worker writing for up to one heartbeat).

**Order, with the store lock held for each identity (audit first, fails closed):**
1. Choose the segments in scope that are not already marked deleted. If none: a `facilitator` request writes nothing and returns `{ deleted: 0 }`; a `participant_request` still writes the audit line with `segments: 0` (proof the request was honoured).
2. Append `audio.deleted { scope, reason, by, segments: n, op }` to the identity's audit log (`op` = 16 hex). `false` means 503 and nothing else happens.
3. Append `{ "v": 1, "kind": "deleted", "segment": "<id>", "op": "<op>", "ts": <ms> }` to the role's `index.jsonl` for each segment (the segment is unplayable at once: 410).
4. Unlink each WAV.
Steps 2 and 3 run back to back with nothing awaited between them except the audit fsync. A crash after step 2 and before step 3 leaves audio playable while the audit says it was deleted: a documented residual; a retry writes a NEW line with a new `op` (a duplicate is acceptable). A crash after step 3 is repaired by the sweep. **No folder is renamed aside for the session scope**: that would remove `session.json` and with it the session-to-folder mapping and the 410 answer; the session scope marks and unlinks like the role scope and keeps the folder, index and marker until expiry. `segments` counts index entries newly marked deleted. The lock is released (it unlinks its own file); the code never unlinks a lock path.

**Index writer.** Control cannot import speech's store modules (only `@acr/speech/protocol`). A minimal `appendDeletedLine` and the `deleted` entry parser are exported through the protocol subpath (or re-implemented in control with a drift test). Speech's `isEntry` already skips unknown kinds and the worker never reads the index. A2a contract 5 is reworded "one writer at a time, under the store lock".

**Sweep change (A2b-1b).** `indexedSegments` subtracts ids that have a `deleted` line; the kept-folder pass unlinks a WAV that is present but marked deleted (the crash repair above). `audio.deleted` from the sweep keeps its own shape (`reason: "expired"`).

## 7. Audit log

`AuditLog.append` returns `Promise<boolean>` (true on success; every failure path false; the sweep keeps awaiting and ignoring it). Events: `audio.played { role, segment, by }`; `audio.deleted { scope: { kind: "session" } | { kind: "role", role } | { kind: "participant", participant }, reason: "expired" | "facilitator" | "participant_request", by, segments, op? }` (`op` only for facilitator deletes). `lineOf` keeps rebuilding each line field by field, so an extra key is never written; tests prove it.

## 8. Errors and HTTP

`send` helpers are JSON; add a small binary-response helper that writes the exact status, headers and `Content-Length`, sets no keep-alive surprises, and never reuses `send` after headers are out. Codes: 400 bad body or bad `by`; 401 no token; 404 bad path id, no marker folder, or no such segment; 409 `session_live`; 410 `audio_deleted`; 503 `audit_unavailable` or `busy`. Nothing logs a path, an id or a name.

## 9. Security and threat-model additions

Path containment and no check-then-use (open first, check the descriptor); `nlink === 1`; ids validated before any join; header values never taken from ids; `by` validated; a replay cap; audit before bytes; the sweep and delete never race (mutex plus lock); the marker is not trusted without `v` and a matching session id. A new THREAT_MODEL section covers the replay and delete routes, the marker, the multiple-identity case, the audit-first residual and the whole-file decision.

## 10. Testing

Unit and real-HTTP tests; a real-store end-to-end (worker writes, control lists, replays, deletes, the sweep finishes a half-delete). Required cases: two identities for one session; marker missing, torn, linked, wrong `v`, naming another session; delete and sweep at the same time in one process gives 503 not 409; delete refused during a respawn backoff and during `mediaLost`; crash injection after each delete step then a sweep run; a deleted segment gives 410 and its WAV is removed by the orphan pass; an audit failure gives 503 and zero body bytes (a mutation that writes before the audit must fail); a role folder that is a symlink, and a WAV with `nlink > 1`; an unauthenticated GET gives 401 before any file-system call; the body schema is strict with exactly one scope kind; extra audit keys are dropped. Mutation checks: audit before bytes, the live check, path containment, the deleted marker.

## 11. Owner decisions (changes from the in-chat design; ALL SIX CONFIRMED 2026-11-12)

1. **Whole-file replay, no Range** (deviation from parent spec section 8). Replaces "audit on a Range starting at byte 0", which leaves a hole for clients that never send it. Fallback if Range must stay: audit the first request per (identity, segment, facilitator) inside a 120 s window, whatever range it asks for.
2. **Slicing:** A2b-1a = marker, catalog, listing, replay, `audio.played`, `append: boolean`; A2b-1b = delete, the deleted-aware sweep, the mutex and acquirer. Two plans, two PRs.
3. **`by` rule and header:** the review layer's console name rule in an `X-Acr-By` header, not the free-text label.
4. **Delete order:** audit first with an `op` id, and the documented crash residual (a retry duplicates the audit line).
5. **`busy` is 503, not 409**, when the sweep (or an error) holds the lock; 409 is only for a genuinely live session.
6. **Marker is written lazily** (before the first WAV), so a voice session where nobody consents creates no folder.
