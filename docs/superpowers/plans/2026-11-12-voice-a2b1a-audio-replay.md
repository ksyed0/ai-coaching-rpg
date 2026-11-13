# Voice A2b-1a: Session Marker, Audio Listing and Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A facilitator can list and play a session's recorded audio through the control service, with every play audited before any byte leaves; the audio folder records which session it belongs to.

**Architecture:** The speech worker writes a `session.json` marker in each identity's audio folder (lazily, before the first WAV); control's `AudioCatalog` finds every folder naming a session by scanning for that marker (no cache), lists segments from each `index.jsonl`, and serves one WAV per request as a buffered whole-file `200` after an `audio.played` audit line (`AuditLog.append` now reports success, so a failed audit means `503` and zero body bytes). Delete is slice A2b-1b (separate plan).

**Tech Stack:** TypeScript, Node fs/http, zod, vitest (existing stack; no new dependency).

**Spec:** `docs/superpowers/specs/2026-11-12-voice-a2b1-audio-replay-delete-design.md` (Draft 2, all six section-11 decisions confirmed by the owner 2026-11-12); parents `docs/superpowers/specs/2026-11-09-voice-a2a-audio-store-design.md`, `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` sections 7 to 9, `docs/THREAT_MODEL.md` (voice audio store, slice A2a).

**Filing:** file the story in Task 1's commit from `docs/ID_REGISTRY.md` (`RELEASE_PLAN.md`, `TEST_CASES.md`; expected US-0074, TASK-0110, AC-0434 onward, TC-0219 onward; one AC and TC per task group, edge cases take the next free ids). Branch `feature/EPIC-0003-US-0074-voice-audio-replay`, cut from `develop`; PR to `develop`.

## Global Constraints

- Marker: `<AUDIO_DIR>/<identity>/session.json` = `{ "v": 1, "sessionId": "<id>" }`, mode 0600, written lazily BEFORE the first WAV of that identity (temp file, rename, directory fsync); a marker failure stops the store with `write_error`. `SPEECH_SESSION_ID` is set by `buildSpeechEnv` from `extra` only (never inherited, never on the allowlist), validated with `isValidSessionId`, and required whenever the store is configured.
- Catalog: `find(sessionId)` returns EVERY identity whose marker names the session; it scans `<audioDir>` on every request (no cache); markers are read `O_NOFOLLOW`, at most 4 KB; a marker that is missing, torn, a link, of another `v`, or naming another session is ignored; index read cap 64 MiB, torn lines skipped. A session with no marker folder (and no fallback hit) is `404`. Never call `supervisor.get`.
- Listing: `{ identities, recordingStopped, segments: [{ identity, role, segment, participantId, startMs, endMs, status, seq?, audio: "available" | "deleted" | "missing" }] }`; never `raw`.
- Replay: `200`, whole file, `Accept-Ranges: none`, any `Range` header ignored; buffered read (never streamed); check order: validate `:role` and `:segment` with the file-safe rule (404 before any file call) -> open identity and role folders as real directories of this user -> `open(O_RDONLY|O_NOFOLLOW)` the WAV -> `fstat` the descriptor (regular file, own uid, `nlink === 1`, 44 <= size <= 512 KB) -> read all through the descriptor -> require the segment's index line to exist and not be marked deleted (else 404 / 410 `audio_deleted`) -> append `audio.played { role, segment, by }` to THAT identity's audit log (`false` means `503 audit_unavailable`, zero body bytes) -> `writeHead(200)` with exact `Content-Length`, `Content-Type: audio/wav`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. At most 8 replays in flight, else `503 busy`. No check-then-use of a path anywhere (CodeQL `js/file-system-race`).
- `by`: `X-Acr-By` header validated like the review layer's console name (`isConsoleName`, suffix `-console`, at most 56 characters); missing or bad is `400`. The control token is checked before routing (an unauthenticated request gets `401` before any file call).
- Codes: 400 bad `by`, 401 no token, 404 bad path id / no marker folder / no such segment, 410 `audio_deleted`, 503 `audit_unavailable` or `busy`. Nothing logs a path, id, name or content.
- `AuditLog.append` returns `Promise<boolean>` (true on success, false on every failure path; it still never rejects); `lineOf` keeps rebuilding lines field by field.
- Control imports `@acr/runtime` only through allowed subpaths and `@acr/speech` only as `@acr/speech/protocol`; `services/speech/src/protocol.ts` imports only `zod` and `@acr/events`.
- Commit format `[TYPE] US-0074: description` (max 72 chars). All tests pass and coverage stays at or above 80% before each commit. Never log a path, id, name, text or token.

## Review Focus

1. Two identity folders for one session (a restart rotated the log): list and replay must cover both; replay finds the segment in whichever holds it (Task 4, 6).
2. The audit append fails: `503` and not one body byte, and a mutation that writes before the audit fails a test (Task 6, 7).
3. A role folder that is a symlink, a WAV with `nlink > 1`, a WAV swapped for a link: refused, nothing outside `audioDir` read (Task 6).
4. A marker naming another session, torn, linked or of another `v`: ignored, never trusted (Task 4).
5. A segment whose WAV exists but whose index line is not there yet (worker mid-write) or is marked deleted: not served (Task 5, 6).
6. A huge or malformed `Range` header, a bad `X-Acr-By`, a path id with separators or uppercase: no file call, the right status (Task 7).

## File Structure

Create: `services/speech/src/store/session-marker.ts`; `services/control/src/voice/{audio-catalog,audio-replay,audio-routes}.ts`; tests beside each. Modify: `services/speech/src/{config,protocol?}.ts` (config only), `services/speech/src/store/{audio-store,store-setup}.ts`, `services/control/src/voice/{speech-env,voice-host,audit-log}.ts`, `services/control/src/{api,http-util,main}.ts`, `docs/{ID_REGISTRY,RELEASE_PLAN,TEST_CASES,THREAT_MODEL,VOICE_RUNBOOK}.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md`, `.env.example` (no new settings expected).

---

### Task 1: Marker writer in the speech store (and file the story)

**Files:** Create `services/speech/src/store/session-marker.ts`; modify `services/speech/src/config.ts` (store block requires `sessionId`), `services/speech/src/store/audio-store.ts` (lazy marker), `services/speech/src/store/store-setup.ts` (pass it), `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md` (file the story). Tests: `services/speech/src/__tests__/store/{session-marker,audio-store}.test.ts`, `services/speech/src/__tests__/config.test.ts`.

**Interfaces:** Produces `writeSessionMarker(dir: string, sessionId: string, fs?: StoreFs): void` (atomic temp + rename + directory fsync, 0600, no link followed) and `AudioStore` option `sessionId: string`, which writes the marker once, inside `write`'s try block, before the first WAV of the process (a failure follows the existing stop path: `write_error`, partial files removed). `WorkerConfig.store` gains `sessionId: string` (env `SPEECH_SESSION_ID`, `isValidSessionId`; a missing or invalid value when `AUDIO_DIR` is set is a config error naming only the variable).

- [ ] **Step 1: Failing tests:** `test_marker_written_before_the_first_wav` (marker exists with `{v:1,sessionId}`, mode 0600, when the first write returns `written`; a second write does not rewrite it); `test_no_marker_when_nothing_is_written` (a skipped or refused segment leaves no folder and no marker); `test_marker_failure_stops_the_store_with_write_error` (fault injection after temp create and at rename; no WAV, `onStopped("write_error")` once); `test_marker_never_follows_a_link` (a planted symlink at `session.json` is replaced, not followed); config: a store with no `SPEECH_SESSION_ID`, an invalid one (`../x`, uppercase, 65 chars) is refused and no value is echoed.
- [ ] **Step 2: Run** `pnpm --filter @acr/speech test` -> FAIL.
- [ ] **Step 3: Implement** the three signatures above; mirror `markEnded`'s temp/rename/fsync code (extract a shared helper only if it removes duplication). File the story, task, ACs and TCs in the three documents in the formats of US-0073/TASK-0109.
- [ ] **Step 4: Run** the speech suite and `pnpm -r typecheck` -> PASS; `npm run plan:generate` parses.
- [ ] **Step 5: Commit** `[feat] US-0074: audio folder records its session; file A2b-1a`.

### Task 2: Control hands the session id to the worker

**Files:** Modify `services/control/src/voice/speech-env.ts`, `services/control/src/voice/voice-host.ts`. Tests: `services/control/src/__tests__/voice/{speech-env,voice-host}.test.ts`.

**Interfaces:** `buildSpeechEnv(parentEnv, roles, extra?: { logIdentity?; sessionsDir?; audioDir?; minFreeMb?; sessionId?: string })` sets `SPEECH_SESSION_ID` from `extra.sessionId` only, and only together with a valid `logIdentity` (same rule as the other store variables); `VoiceHost` passes the session id it already keys the worker by.

- [ ] **Step 1: Failing tests:** the worker env carries `SPEECH_SESSION_ID` equal to the session id when the identity is valid; an inherited `SPEECH_SESSION_ID` is ignored; no identity means no store variables at all; `isAllowedSpeechVar("SPEECH_SESSION_ID")` is false.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** run the control suite -> PASS. **Step 5:** commit `[feat] US-0074: hand the session id to the speech worker`.

### Task 3: `AuditLog.append` reports success; `audio.played` event

**Files:** Modify `services/control/src/voice/audit-log.ts`. Tests: `services/control/src/__tests__/voice/audit-log.test.ts`.

**Interfaces:** `append(logIdentity: string, e: AuditEvent): Promise<boolean>`; callers that fire-and-forget keep working unchanged. `AuditEvent` gains `{ type: "audio.played"; role: string; segment: string; by: string }`; `lineOf` rebuilds it field by field (`{ v: 1, ts, type, role, segment, by }`).

- [ ] **Step 1: Failing tests:** `append` resolves `true` after a written line; resolves `false` (never rejects) for a malformed identity, an unsafe audio directory, a lock held past all attempts, and a write error; the `audio.played` line has exactly those keys and an extra key on the event object is dropped; existing events still serialize identically; the sweep and VoiceHost tests still pass.
- [ ] **Step 2:** FAIL. **Step 3:** implement (each failure path in `write` returns `false`; the chain stays unbroken). **Step 4:** run the control suite -> PASS. **Step 5:** commit `[feat] US-0074: audit appends report success; audio.played event`.

### Task 4: `AudioCatalog.find`: the session's audio folders

**Files:** Create `services/control/src/voice/audio-catalog.ts`. Test: `services/control/src/__tests__/voice/audio-catalog.test.ts`.

**Interfaces:** `class AudioCatalog { constructor(o: { audioDir: string; fallbackIdentity?: (sessionId: string) => Promise<string | undefined> }); find(sessionId: string): Promise<string[]> }` returns every 32-hex identity directory whose marker names the session, sorted; uses only the open-then-fstat pattern (`O_RDONLY|O_NOFOLLOW`, regular file, own uid, at most 4 KB); entries that are not real directories of this user or whose name is not 32 lower-case hex are skipped; if nothing matches and `fallbackIdentity` returns an identity whose folder exists, that one is returned.

- [ ] **Step 1: Failing tests:** one match; two identities for one session (both returned, sorted); markers that are torn, a link, `v: 2`, naming another session, over 4 KB, or in a non-hex folder are ignored; a foreign-owned folder skipped (skip when uid 0); no cache (a marker created after a first miss is found by the next call); the fallback is used only when no marker matches and is ignored when its folder is missing; `audioDir` missing returns `[]`.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `[feat] US-0074: find a session's audio folders by marker`.

### Task 5: Pre-marker fallback and segment listing

**Files:** Modify `services/control/src/voice/audio-catalog.ts`; create nothing else. Test: `audio-catalog.test.ts` (extend).

**Interfaces:** `list(identity: string): Promise<{ segments: SegmentInfo[]; recordingStopped: boolean }>` where `SegmentInfo = { role; segment; participantId; startMs; endMs; status; seq?; audio: "available" | "deleted" | "missing" }`; reads each role folder's `index.jsonl` (O_NOFOLLOW, 64 MiB cap, torn or unparseable lines skipped, `raw` never copied), applies `deleted` lines (kind `deleted` marks the segment `deleted`), sets `audio` from a descriptor-based existence check of the WAV (`missing` when the index line exists but the WAV does not), and `recordingStopped` is true when the identity's audit file has a `voice.recording_stopped` line. The production `fallbackIdentity` (wired in Task 8) reads `session.started.logIdentity` from the session log the way `services/control/src/report-job.ts` already does (read how it builds the path; reuse its reader, do not re-implement it).

- [ ] **Step 1: Failing tests:** an index with two roles yields their segments with exact fields and no `raw`; a deleted line marks `deleted`; a WAV removed on disk gives `missing`; a segment with a WAV but no index line is NOT listed (worker mid-write); a torn last line and an over-cap index are survived (over-cap: that role contributes nothing); `recordingStopped` true/false from a real audit file.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `[feat] US-0074: list a session's audio segments`.

### Task 6: `readSegmentAudio`: the safe whole-file read

**Files:** Create `services/control/src/voice/audio-replay.ts`. Test: `services/control/src/__tests__/voice/audio-replay.test.ts`.

**Interfaces:** `type ReplayResult = { ok: true; identity: string; bytes: Buffer } | { ok: false; code: "not_found" | "audio_deleted" | "audit_unavailable" }`; `replaySegment(o: { audioDir: string; identities: string[]; role: string; segment: string; by: string; audit: Pick<AuditLog, "append"> }): Promise<ReplayResult>`. Order per the Global Constraints: ids validated first (a bad id is `not_found`, no file call); for each identity in order: folders opened as real directories of this user; WAV opened `O_NOFOLLOW`, `fstat` (regular, own uid, `nlink === 1`, 44 to 524288 bytes), read fully through the descriptor, closed; the identity's index must hold the segment's line and no deleted mark (a deleted mark returns `audio_deleted`); then `audit.append(identity, { type: "audio.played", role, segment, by })`; `false` returns `audit_unavailable` WITHOUT returning bytes.

- [ ] **Step 1: Failing tests:** happy path returns the exact bytes and writes exactly one `audio.played` line (real `AuditLog`) AFTER the file was read and BEFORE the function returns bytes (a spy `audit` asserts the order with a read hook); a failing audit returns `audit_unavailable` and no bytes; two identities: the segment is found in the second; a segment with no index line, a deleted one (`audio_deleted`), a missing WAV, a role folder that is a symlink, a WAV that is a symlink, a WAV with `nlink 2`, a WAV of size 43 and 524289, a bad id (`../x`, `A`, 65 chars, NUL): each refused and nothing outside `audioDir` is read (assert via a recording fs hook); no audit line for any refusal.
- [ ] **Step 2:** FAIL. **Step 3:** implement (open-then-check everywhere; no `existsSync`/`stat` of a path before use). **Step 4:** PASS. **Step 5:** commit `[feat] US-0074: audited whole-file segment read`.

### Task 7: HTTP routes, binary response, `X-Acr-By`

**Files:** Create `services/control/src/voice/audio-routes.ts`; modify `services/control/src/http-util.ts` (binary helper), `services/control/src/api.ts` (new optional dep `audio?: AudioService`; routes `GET /sessions/:id/audio` and `GET /sessions/:id/audio/:role/:segment`). Tests: `services/control/src/__tests__/voice/audio-routes.test.ts` (real HTTP against `createApi` with a real temp store).

**Interfaces:** `class AudioService { constructor(o: { catalog: AudioCatalog; audit: Pick<AuditLog,"append">; audioDir: string; maxInFlight?: number /* default 8 */ }); list(sessionId: string): Promise<ListBody | null>; play(sessionId: string, role: string, segment: string, by: string): Promise<ReplayResult | { ok: false; code: "busy" }> }`; `sendBytes(res: ServerResponse, status: number, headers: Record<string,string>, bytes: Buffer): void` (exact `Content-Length`, never reuses `send` after headers are out). `parseBy(header: string | undefined): string | null` implements the console-name rule (find `isConsoleName` and the `-console` suffix in `services/control/src/moderation.ts`; export it if it is not exported; do not copy the regex). Route mapping: bad session/role/segment path id -> 404 (as the existing router does, before any file call); missing/bad `X-Acr-By` -> 400; no marker folder -> 404; `audio_deleted` -> 410; `audit_unavailable` / `busy` -> 503 (`Retry-After` on busy); success -> 200 with `Accept-Ranges: none`. No `supervisor.get` call. `Range` is ignored.

- [ ] **Step 1: Failing tests:** list returns the Global-Constraints shape for a two-identity session and 404 for an unknown one; replay returns exact bytes, `Content-Type: audio/wav`, `Cache-Control: no-store`, `nosniff`, exact `Content-Length`, `Accept-Ranges: none`; a `Range: bytes=10-20` and `bytes=0-0,5-9` and `bytes=99999999999999999999-` all still get the full 200; no token -> 401 and a spy proves no file call; bad `X-Acr-By` (missing, `x`, 57+ chars, control chars, no `-console` suffix) -> 400 with no file call and no audit line; deleted segment -> 410; audit failure -> 503 with an EMPTY body; 9 concurrent replays held open by a slow audit -> the 9th is 503 `busy`; every response carries the existing envelope headers where JSON; one `audio.played` line per 200.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** PASS (control suite). **Step 5:** commit `[feat] US-0074: facilitator audio listing and replay routes`.

### Task 8: Wiring and end-to-end with a real store

**Files:** Modify `services/control/src/main.ts`; test `services/control/src/__tests__/voice/audio-replay.e2e.test.ts`.

**Interfaces:** `main.ts` builds `AudioCatalog` (with the production `fallbackIdentity` from Task 5), `AudioService` from the existing `audit` and `config.audioDir`, and passes `audio` to `createApi`; with voice off the routes still work for existing audio (replay does not depend on `VOICE_ENABLED`).

- [ ] **Step 1:** write the test with the REAL worker `AudioStore` (marker, WAV, index) written on a temp dir, then the REAL control API over HTTP: list shows the segment; replay returns the bytes and the audit file has exactly one `audio.played` with the facilitator name and no content keys; two identities for one session; after the sweep expires the folder, list and replay are 404; with `VOICE_ENABLED=0` the routes still answer.
- [ ] **Step 2:** run; fix wiring until it passes. **Step 3:** mutation checks, each must fail a named test then be reverted (never committed): (a) write the audit AFTER the bytes are returned; (b) skip the `nlink` check; (c) skip the index-line requirement; (d) ignore the audit result (`false` still serves); (e) accept any `by`. A mutation that fails no test is a gap: add the test. **Step 4:** `pnpm -r test` and `pnpm -r typecheck` pass, coverage at or above 80%. **Step 5:** commit `[test] US-0074: audio replay end-to-end and mutation checks`.

### Task 9: Documents and close-out

**Files:** Modify `docs/THREAT_MODEL.md` (the replay route, the marker, the multiple-identity case, whole-file and no-Range, audit-before-bytes failing closed), `docs/VOICE_RUNBOOK.md` (how a facilitator's replay is audited; what `503 audit_unavailable` means), `docs/superpowers/plans/2026-11-08-voice-part-a-overview.md` and `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` (record the no-Range deviation from section 8), `docs/RELEASE_PLAN.md` and `docs/TEST_CASES.md` (set results honestly), `docs/ID_REGISTRY.md`, `CHANGELOG.md` `[Unreleased]` (API only, dark), `progress.md`, `MEMORY.md`.

- [ ] **Step 1:** make the edits. **Step 2:** `npm run plan:generate` parses; `pnpm -r test` and `pnpm -r typecheck` pass. **Step 3:** commit `[docs] US-0074: A2b-1a threat model, plan status and close-out`.

## Self-Review (spec coverage)

Spec section 2 (components) -> Tasks 1 to 7; section 3 (finding audio, fallback, no `supervisor.get`) -> 4, 5, 7; section 4 (listing) -> 5, 7; section 5 (replay, whole file, order, audit before bytes, cap, auth, `by`) -> 3, 6, 7; section 7 (audit log) -> 3; section 8 (HTTP, codes) -> 7; section 9 and 10 (security, tests, mutation checks) -> 6, 8, 9. Delete (spec section 6), its audit events, the `deleted` writer, the sweep change, the mutex and acquirer are A2b-1b (separate plan). A2b-2 (BFF, console) is separate.
