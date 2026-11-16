# Voice A2b-2: audio review and delete panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a session ends, the facilitator can listen to the recordings with their transcript lines, and delete a seat's audio or all audio, from the web console.

**Architecture:** Control gains `GET /sessions/:id/transcript` (a bounded, safe read of the session log). The web server gains three console routes (combined list, play, delete) that call control through `LauncherClient`, build `by` from the signed-in account, refuse shared-secret sign-ins, and join clips to transcript lines by `seq`. The console gains an `AudioPanel` in the after-end block.

**Tech Stack:** TypeScript, Node `http` (control), Next.js route handlers as plain `Request -> Response` functions (web), React client components, vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-voice-a2b2-audio-panel-design.md` (Draft 2, approved by the owner in chat 2026-11-16). Reviewed by an Opus agent against the code the same day; its findings are folded into the tasks below. Parents: `2026-11-12-voice-a2b1-audio-replay-delete-design.md`, `2026-11-13-voice-a2b1b-audio-delete-design.md`, `2026-11-13-facilitator-accounts-design.md`.

## Global Constraints

- Control: open-then-check file reads only (no check-then-use of a path; CodeQL `js/file-system-race`). No hand-written identifier-shaped regex character classes outside `packages/events/src/ids.ts` (runtime test `id-rules.files.test.ts`): use `isFileSafeId`, `isLowerHex`, `isValidSessionId`. Nothing logs a path, an id, an identity, a name, audio or transcript text.
- Web: the browser never sees control's address, token, an identity folder name or a file path. The web server talks to control only through `launcher-client.ts`. Every route runs through `guard` (`console-sessions.ts`; owner-or-admin, neutral 404) before anything else; a legacy sign-in (`who.accountId === null`) is refused 403 `account_required` before any control call. `by` is `` `${accountSlug(who.name, who.accountId)}-console` `` (control's audio routes do NOT append `-console`; `parseBy` in `services/control/src/voice/audio-routes.ts` requires it and at most 56 characters before it). It is sent as the `X-Acr-By` header on list and play, and as both the body `by` and `X-Acr-By` on delete. A `by` in a browser request body is ignored.
- Every response that carries audio or transcript text: `Cache-Control: no-store`; every console response keeps `Referrer-Policy: no-referrer` (the `priv` wrapper).
- Transcript caps (constants in `services/control/src/voice/transcript.ts`): log file at most 8 MiB, returned text at most 1,000,000 characters, 4 reads in flight; over a size cap is 413 `transcript_too_large`, never a partial list.
- Commit message format `[TYPE] SHORT-ID: description` (max 72 chars). Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Ids: this slice's story is filed in Task 8; take the next free ids from `docs/ID_REGISTRY.md` (its last row says: US-0090, AC-0540, TC-0310, TASK-0142). Until Task 8, commits use the branch's short id `A2B2`.
- Runner: `pnpm --filter @acr/<pkg> exec vitest run <path>` (there is no `vitest` script; packages `@acr/control`, `@acr/web`, `@acr/runtime`). Web DOM tests start with `// @vitest-environment jsdom`. The identifier-regex scan is `pnpm --filter @acr/runtime exec vitest run src/__tests__/id-rules.files.test.ts`. Typecheck: `pnpm --filter @acr/web typecheck` and the control equivalent; run to completion (slow under load). There is no `lint` script: CI runs `pnpm lint:sdk` plus eslint.
- Branch: `feature/EPIC-0003-US-0090-voice-audio-panel`, cut from `origin/develop` (which has #144 to #146). On develop `Supervisor.get` reads the owners file and can throw; internal callers use `supervisor.getWithoutOwner(id)`.
- Coverage at least 80 percent; all tests pass before each commit. Dark behind `VOICE_ENABLED` as the audio routes already are.

## Review Focus

1. A clip whose `seq` matches a transcript line of a different `roleId`: the text must be dropped (Task 4).
2. A shared-secret (legacy) cookie on any of the three routes: 403 and zero control calls, including no list call (Task 4).
3. A delete that control answers 503 with a partial body: the panel must show what was not deleted, never a success state (Tasks 3, 6).
4. A double click on play, or a second play while the first is still fetching: one request, one audit line (Task 6).
5. A torn last log line, a log with only non-utterance events, and a log over the cap (Task 1).

## File Structure

- Create `services/control/src/voice/transcript.ts`: reader and `TranscriptService`.
- Modify `services/control/src/api.ts` (route), `services/control/src/main.ts` (wiring).
- Modify `apps/web/src/server/launcher-client.ts`: audio and transcript calls.
- Create `apps/web/src/server/console-audio-join.ts`: the pure join.
- Create `apps/web/src/server/console-audio-handlers.ts`; modify `routes.ts`, `handlers.ts` (`Deps` throttles) and add three `route.ts` files under `apps/web/src/app/api/v1/console/sessions/[id]/audio/`.
- Modify `apps/web/src/lib/console-api.ts`, `apps/web/src/lib/messages.ts`; create `apps/web/src/components/console/AudioPanel.tsx`; modify `SessionConsole.tsx`.
- Docs: `docs/THREAT_MODEL.md`, `docs/VOICE_RUNBOOK.md`, `docs/ROLLBACK.md` (or the runbook's rollback section, wherever A2b-1a's entry lives), `CHANGELOG.md`, `docs/ID_REGISTRY.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `progress.md`, `MEMORY.md`.

## Rulings (plan-level, recorded for the executor)

- **R1, clip handle:** the spec's "opaque `id` mapped to `{ identity, role, segment }`" is replaced by the clip's `role` and `segment` ids. Control's own play route already takes `(sessionId, role, segment)` and finds the identity itself, and the delete scope names a role, so the identity folder name never needs to reach the browser at all. This meets the spec's intent (no identity in any response) with less machinery. Cost if wrong: none for security; the list is slightly more revealing of segment ids (file-safe ids, already facilitator-only).
- **R2, panel gate:** "only when `VOICE_ENABLED`" is read as "the roster has a human seat with a voice state" (the condition `VoicePanel` uses). If the roster is not available after the session ends, the panel renders anyway and shows "No recordings" when control has none.
- **R2 (revised after review):** the panel renders nothing when control has no audio (404 or no clips) and the roster shows no human voice seat; with a voice seat it shows "No recordings". After a page reload of an ended session the roster is empty, so seat names fall back to `roleLabel(roleId)` from `apps/web/src/lib/names`.
- **R4, transcript only when needed:** the list handler fetches the audio list first and asks control for the transcript only when at least one clip is `transcribed` with a `seq`, so a session with no transcribed audio never reads its log. (The spec said "in parallel"; this is cheaper and gives the same answers.)
- **R5, `by` form:** see Global Constraints (the first draft said control appends `-console`; it does not for audio).
- **R3, partial result to the browser:** the delete answer carries `deleted`, `done` (count of identity folders finished) and `pending: [{ reason }]`; it never carries an identity.

---

### Task 1: Control transcript reader

**Files:**
- Create: `services/control/src/voice/transcript.ts`
- Test: `services/control/src/__tests__/voice/transcript.test.ts` (where `log-identity.test.ts` lives)

**Interfaces:**
- Produces: `export type TranscriptLine = { seq: number; ts: number; roleId: string; text: string }`; `export type TranscriptRead = { kind: "ok"; lines: TranscriptLine[] } | { kind: "not_found" } | { kind: "too_large" }`; `export const MAX_LOG_BYTES = 8 * 1024 * 1024`; `export const MAX_TRANSCRIPT_CHARS = 1_000_000`; `export function readTranscript(sessionsDir: string, sessionId: string): TranscriptRead` (synchronous, never throws, logs nothing).

- [ ] **Step 1: Write the failing tests** in `transcript.test.ts`, each using a temp `sessionsDir` with `<id>.jsonl`:
  - `returns only utterance events as {seq, ts, roleId, text}` (a log with `session.started`, two `utterance` events with `channel`, an `inject.fired`: exactly two lines, in order, no `channel` key).
  - `skips a torn last line and an unparseable line`.
  - `a log with no utterance events gives ok with no lines`.
  - `a missing log is not_found; a bad session id is not_found without touching the disk`.
  - `a log over MAX_LOG_BYTES is too_large` (use an injected smaller cap via an optional third argument `caps?: { maxBytes?: number; maxChars?: number }` so the test stays small), and `text over maxChars is too_large, never a partial list`.
  - `refuses a symlinked log, a directory and another user's file` (symlink and directory; the uid case may be skipped when not runnable); `keeps only lines whose sessionId equals the requested id` (a log holding another session's utterance yields none of its lines).
- [ ] **Step 2: Run** `pnpm --filter @acr/control exec vitest run src/__tests__/voice/transcript.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `readTranscript`** following `readHead` in `voice/log-identity.ts`: `openSync(file, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`, `fstatSync` on the descriptor (regular file, this user, `size <= maxBytes` else `too_large`), read in a loop through the descriptor, split on newline, `JSON.parse` each line in try/catch, keep `type === "utterance"` with `sessionId` equal to the requested id, numeric `seq` and `ts`, string `roleId` and `text`, add `text.length` to a running total and return `too_large` when it passes `maxChars`. Check `isValidSessionId` first. Pick fields one by one.
- [ ] **Step 4: Run the tests** again. Expected: PASS. Run the identifier-regex scan (command in Global Constraints) to confirm no forbidden regex.
- [ ] **Step 5: Commit** `[feat] A2B2: control transcript reader`.

---

### Task 2: Control transcript route and wiring

**Files:**
- Modify: `services/control/src/voice/transcript.ts` (add the service), `services/control/src/api.ts`, `services/control/src/main.ts`
- Test: `services/control/src/__tests__/voice/transcript-route.test.ts` (model it on `__tests__/voice/audio-routes.test.ts`; the 409 on `audio-delete.e2e.test.ts`)

**Interfaces:**
- Consumes: `readTranscript` (Task 1); `Supervisor.getWithoutOwner(id): SessionInfo | undefined` (`status` is `running | stopped | ended`; `get` can throw on an unreadable owners file); `VoiceHost.isLive(id)`.
- Produces: `export class TranscriptService { constructor(o: { sessionsDir: string; status: (id: string) => "ended" | "not_ended" | "unknown"; isLive: (id: string) => boolean; maxInFlight?: number; reader?: (dir: string, id: string) => TranscriptRead | Promise<TranscriptRead> }); read(sessionId: string): Promise<TranscriptResult> }` (async around the synchronous reader, like `AudioService.play`, so the in-flight cap is testable; the slot is released in `finally`) with `export type TranscriptResult = { ok: true; lines: TranscriptLine[] } | { ok: false; code: "not_found" | "session_live" | "too_large" | "busy" }`; `createApi` accepts `transcript?: TranscriptService`; route `GET /sessions/:id/transcript` answering `200 { lines, truncated: false }`.

- [ ] **Step 1: Write failing tests** (real HTTP through `createApi`, as `api.test.ts` does): `401 without the service token before any file call`; `404 on a bad session id`; `404 for an unknown session`; `409 session_live` (status and error code only; data null, via `failClosed(res, 409, "session_live")`) for a running session, for a stopped session, and for an ended session whose `isLive` is true (the voice host still draining); `200 { lines, truncated: false }` for an ended session; `413 transcript_too_large`; `404 when the log is missing`; `503 busy with Retry-After: 1 over the in-flight cap` (an injected `reader` that resolves only when the test releases it, with `maxInFlight: 1`); `no X-Acr-By needed and no audit line written`; `a session whose log holds another session's lines is not returned` (only this id's file is read).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `TranscriptService.read`: in-flight cap first (busy), then `status(id)` (`unknown` is `not_found`), then live (`status !== "ended"` or `isLive` true or an `isLive` that throws, failing closed, as `AudioService.liveNow` does) is `session_live`, then `readTranscript`. Add the route in `api.ts` next to the audio routes (after the id is validated by `sessionId(seg[1])`, `if (!deps.transcript) return notFound()`); answer 409 with `failClosed(res, 409, "session_live")` and 503 busy (`fail(res, 503, "busy", ..., false, 1)`); 413 uses `fail(res, 413, "transcript_too_large", ...)`. In `main.ts` build the service with `config.sessionsDir`, `status: (id) => { try { const s = supervisor.getWithoutOwner(id); return s === undefined ? "unknown" : s.status === "ended" ? "ended" : "not_ended"; } catch { return "not_ended"; } }` (a throw fails closed as live) and `isLive: (id) => voiceHost?.isLive(id) ?? false`, and pass it to `createApi`.
- [ ] **Step 4: Run** the new tests and `src/__tests__/api.test.ts`. Expected: PASS. Mutation check (record in the commit body): make `session_live` ignore `isLive`, and the draining-host test must fail; make the reader return a partial list over the cap, and the 413 test must fail; revert both.
- [ ] **Step 5: Commit** `[feat] A2B2: control GET /sessions/:id/transcript`.

---

### Task 3: Launcher client audio and transcript calls

**Files:**
- Modify: `apps/web/src/server/launcher-client.ts`
- Also modify: `apps/web/src/server/__tests__/console-sessions.test.ts` (the table typed `Record<LauncherReason, ...>` near line 1085: add an entry for every new reason, `[502, "launcher_unavailable", ...]` as its neighbours do)
- Test: `apps/web/src/server/__tests__/launcher-client.audio.test.ts` (copy the fake-fetch setup of the existing launcher-client tests)

**Interfaces:**
- Produces, all methods of `LauncherClient`, each checking ids first (`this.id`; `isFileSafeId` for role and segment, as control does: a bad one throws `LauncherError("not_found")` before any network call):
  - `audioList(id: string, by: string): Promise<AudioListing | null>` where `AudioListing = { recordingStopped: boolean; segments: AudioSegment[] }`, `AudioSegment = { role: string; segment: string; participantId: string; startMs: number; endMs: number; status: string; seq?: number; audio: "available" | "deleted" | "missing" }`. `null` for control's 404 (no audio). Picks fields one by one; the identity field is dropped. Sends `X-Acr-By: <by>` (add an optional `headers` entry to `call`'s options for this).
  - `transcript(id: string): Promise<TranscriptAnswer>` where `TranscriptAnswer = { kind: "ok"; lines: { seq: number; ts: number; roleId: string; text: string }[] } | { kind: "too_large" }`. Other failures throw `LauncherError` (409 `session_live` becomes reason `session_live`, add it to `BY_CODE` and the `LauncherReason` union; `busy`, `not_found` as existing). Call `call` with `{ maxChars: MAX_REPORT_RESPONSE_CHARS }` (4 MiB): a transcript under control's 1,000,000-character cap can exceed the default 1 MiB response limit once JSON-escaped.
  - `audioPlay(id: string, role: string, segment: string, by: string): Promise<Uint8Array>` returns the WAV bytes (a new binary path: `arrayBuffer()`, a cap of 512 KiB plus a small margin, `redirect: "error"`, the same timeout and token header, `Accept: audio/wav`); control's 410 maps to reason `audio_deleted`, 503 `audit_unavailable` to `audit_unavailable`, 503 `store_unsafe` to `store_unsafe`, 503 `busy` to `busy`; add these reasons to `BY_CODE` and the reason union.
  - `audioDelete(id: string, scope: { kind: "session" } | { kind: "role"; role: string }, reason: "facilitator" | "participant_request", by: string): Promise<AudioDeleteAnswer>` where `AudioDeleteAnswer = { state: "done" | "pending" | "live"; deleted: number; done: number; pending: { reason: "busy" | "store_unsafe" | "audit_unavailable" }[] }`. Control answers `200` (done), `503` with an object `data` (pending: the partial result), `503` with null `data` (the in-flight cap: throw `LauncherError("busy")`), `409` (`live`: `data` holds the partial result) and `404` (no audio: throw `not_found`). This method reads `data` of the 200, 503-with-data and 409 answers (a variant of `call` returning `{ status, data }`) and uses a 15 s timeout (`REPORT_CALL_TIMEOUT_MS`), not the 5 s default. `done` is `identities.length`; no identity leaves.

- [ ] **Step 1: Write failing tests** with a fake `fetchFn`: list maps fields and drops `identity`; list sends `X-Acr-By`; list 404 gives `null`; transcript ok and 413 give `too_large`; a transcript near 1,000,000 characters parses (the 4 MiB cap); transcript 409 throws reason `session_live`; play returns the bytes and sends no body; play maps 410, 503 `audit_unavailable`, 503 `busy`; play over the size cap throws `failed`; delete 200 gives `done`, 503 with a partial body gives `pending` with the reasons and `done` count and no identity, 503 with null data throws `busy`, 404 throws `not_found`, 409 gives `live`; delete sends `{ scope, reason, by }` and `X-Acr-By` equal to `by`; bad role or segment never reaches `fetchFn`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/launcher-client.audio.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the four methods and the small shared raw-request helper; reuse `timeoutMs`; extend `BY_CODE` and the reason union and fix whatever the typecheck then flags (the table in `console-sessions.test.ts`; `failure()` and `reportFailure` have `default:` branches) (`pnpm --filter @acr/web typecheck`; run it to completion, it is slow on a loaded machine).
- [ ] **Step 4: Run** tests and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `[feat] A2B2: launcher client audio and transcript calls`.

---

### Task 4: The join and the web handlers

**Files:**
- Create: `apps/web/src/server/console-audio-join.ts`, `apps/web/src/server/console-audio-handlers.ts`
- Modify: `apps/web/src/server/handlers.ts` (`Deps`: add `consoleAudioReadThrottle: JoinThrottle; consoleAudioWriteThrottle: JoinThrottle`), `apps/web/src/server/routes.ts` (construct them next to `consoleReportThrottle`; export `consoleAudioGET`, `consoleAudioPlayGET`, `consoleAudioDeletePOST` as `route(handler)`), `apps/web/src/server/__tests__/routes.test.ts` (add the three routes to its `CONSOLE` table), every hand-built `Deps` literal that would now miss the two throttles (`ai-roles.runtime.test.ts`, `handlers.test.ts`, `handlers.runtime.test.ts`, `handlers.launcher.test.ts`, `report-handlers.test.ts`, `report-writes.test.ts`, `voice-handlers.test.ts` under `apps/web/src/server/__tests__/`, and `test-support/console-fixtures.ts` `fakeDeps`, which is cast so it compiles but would be undefined at runtime), `apps/web/src/lib/messages.ts` (fixed sentences, in their own audio map: `say()` in the report handlers is typed to `ReportRefusal`), three route files `apps/web/src/app/api/v1/console/sessions/[id]/audio/route.ts` (`GET`, re-export path `../` x7), `.../audio/play/route.ts` (`GET`, x8), `.../audio/delete/route.ts` (`POST`, x8), each only re-exporting like the existing `report/route.ts` (count the depth from it)
- Test: `apps/web/src/server/__tests__/console-audio-join.test.ts`, `console-audio-handlers.test.ts` (setup as `console-report-handlers-b.test.ts`: fake control `answer`, `withConsoleAuth`, account and legacy cookies from `test-support/console-fixtures`)

**Interfaces:**
- Consumes: Task 3's `LauncherClient` methods; `guard` from `console-sessions.ts`; `accountSlug` (exported from `console-report-handlers.ts`); `fail` and `ok` from `envelope.ts`; `priv` and `throttleKey` are not exported yet: export them from `console-report-handlers.ts` rather than copy.
- Produces: `export type Clip = { role: string; segment: string; startMs: number; endMs: number; status: string; audio: "available" | "deleted" | "missing"; text?: string }`; `export function joinClips(segments: AudioSegment[], lines: { seq: number; roleId: string; text: string }[]): Clip[]` (ordered by `startMs`; `text` only when `status === "transcribed"`, `seq` is defined, a line with that `seq` exists and its `roleId` equals the clip's `role`; never `participantId`, `seq` or identity in the output); `handleConsoleAudioList`, `handleConsoleAudioPlay`, `handleConsoleAudioDelete`, each `(req: Request, deps: Deps) => Promise<Response>`.
- List answer: `200 { recordingStopped, clips, textUnavailable?: true, tooLongForText?: true }`, `{ recordingStopped: false, clips: [] }` when control has no audio. R4: the audio list is fetched first; the transcript only if some clip is `transcribed` with a `seq`. A transcript `session_live` makes the whole route `409 session_live`; a transcript `too_large` sets `tooLongForText`; any other transcript failure sets `textUnavailable`. A list-call `session_live` is also 409. Play: query `?role=<id>&segment=<id>`; `200 audio/wav` with `Cache-Control: no-store`, `Accept-Ranges: none`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `410 audio_deleted`, `503 audit_unavailable`, `503 store_unsafe`, `503 busy` with `Retry-After`. Delete: body `{ scope: { kind: "session" } | { kind: "role", role }, reason: "facilitator" | "participant_request" }` (strict: no other keys; max 1 KiB), answer is the `AudioDeleteAnswer` with HTTP 200 for `done`, 503 for `pending` (worst reason as the error code in the envelope, the partial result in `data`), 409 for `live`. Throttles keyed by account (use the `throttleKey` pattern; export it from `console-report-handlers.ts`): list and play share the read throttle, delete uses the write throttle; over the limit is 429 with `Retry-After`.

- [ ] **Step 1: Write failing join tests**: `joins a transcribed clip to the line with its seq`; `drops the text when the line's roleId is another seat's` (Review Focus 1); `no text for status empty, stt_failed and refused:no-consent`; `no text for a clip without seq or without a matching line`; `ordered by startMs`; `output has no participantId, seq or identity key`.
- [ ] **Step 2: Write failing handler tests**: (the console auth always asks control, so count only requests whose path starts with `/sessions/<id>/audio` or `/sessions/<id>/transcript`) legacy cookie gets `403 account_required` from all three routes and no such request reaches the fake control (Review Focus 2); a facilitator account that does not own the session gets the neutral 404 with no such request; the `by` sent to control (`X-Acr-By`, and body `by` on delete) equals exactly `` `${accountSlug(name, accountId)}-console` `` and a `by` in the browser's delete body is ignored (the request is still accepted); the transcript is not requested when no clip is `transcribed` with a `seq`; a transcript `session_live` makes the list 409; control's 503-busy (null data) on delete gives web 503 `busy`, control 404 gives web 404; list joins list and transcript, and a transcript `LauncherError` gives `textUnavailable: true` while a transcript `too_large` gives `tooLongForText: true`, both with clips still returned; list 404 from control gives `{ clips: [] }`; control `session_live` gives `409`; play returns the bytes with the four headers and sends the server-built `by`; play with a bad role or segment is 404 before control; play maps 410, 503 and busy; delete `pending` gives 503 with the partial body and no success state, and carries no identity (Review Focus 3); delete rejects unknown keys, a role scope without a role, a bad reason; reads and writes are throttled per account and a new cookie for the same account does not reset the budget.
- [ ] **Step 3: Run** `pnpm --filter @acr/web exec vitest run src/server/__tests__/console-audio-join.test.ts src/server/__tests__/console-audio-handlers.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the join and the three handlers. Order inside each: `guard(req, deps, change)` (reads `false`, delete `true`), then the legacy refusal (`g.who.accountId === null`), then the throttle, then parse, then control. Fetch the list, then (R4) the transcript, as above. All control failures go through `reportFailure` extended for the new reasons (`session_live` 409, `audio_deleted` 410, `audit_unavailable` 503) with fixed sentences from `messages.ts`; never control's text.
- [ ] **Step 5: Run** the tests, the existing `console-*.test.ts` files, and typecheck. Expected: PASS. Mutation checks, each making a named test fail, then reverted: remove the legacy refusal; send a body `by` instead of the server-built one; drop `no-store`; join by array index instead of `seq`; map a 503 pending to 200.
- [ ] **Step 6: Commit** `[feat] A2B2: web audio list, play and delete routes`.

---

### Task 5: Browser client functions

**Files:**
- Modify: `apps/web/src/lib/console-api.ts`
- Test: `apps/web/src/lib/__tests__/console-api.audio.test.ts` (next to the existing console-api tests)

**Interfaces:**
- Consumes: the routes of Task 4. `type Fetch = typeof fetch` as the panel components receive it (`resolved.fetch`).
- Produces: `fetchAudioList(fetch, sessionId): Promise<{ ok: true; data: AudioListView } | { ok: false; code: string }>` (`ApiResult` in `lib/api.ts` is not generic) with `AudioListView = { recordingStopped: boolean; clips: ClipView[]; textUnavailable: boolean; tooLongForText: boolean }` (`ClipView` = the web `Clip`; a parser in the style of `parseReportOverview` that rejects anything malformed); `playClip(fetch, sessionId, role, segment): Promise<{ ok: true; blob: Blob } | { ok: false; code: string }>`; `deleteAudio(fetch, sessionId, scope, reason): Promise<DeleteView>` with `DeleteView = { state: "done" | "pending" | "live" | "refused" | "failed"; deleted: number; pending: { reason: string }[]; code?: string }` which reads the body of 503 and 409 answers; `audioFailureText(code: string): string` mapping to `messages.ts` sentences.

- [ ] **Step 1: Write failing tests**: list parses a valid answer and rejects a clip with a non-string role; play returns a Blob with `audio/wav` content and maps 410 to `audio_deleted`; delete 503 with a partial body gives `state: "pending"` with its reasons (not an error); delete 200 gives `done`; 403 `account_required` gives code `account_required`; network failure gives `failed`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the four functions and the `messages.ts` copy: `AUDIO_CONSOLE` with heading "Recordings", the note "Each play is logged.", the states (no recordings; session still ending, try again in a moment; sign in with your own account to hear or delete recordings; transcripts unavailable right now; transcript too long to show, clips still listed; no transcript; audio deleted), confirmation sentences ("This permanently deletes N clips (M min S s). It cannot be undone."), reason labels ("Facilitator decision", "Participant asked"), pending reasons in plain words (`busy` "try again", `store_unsafe` and `audit_unavailable` "needs the operator"), and `audioFailureText`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `[feat] A2B2: console audio client functions and copy`.

---

### Task 6: The AudioPanel and its wiring

**Files:**
- Create: `apps/web/src/components/console/AudioPanel.tsx`
- Modify: `apps/web/src/components/console/SessionConsole.tsx`
- Modify: `apps/web/src/server/headers.ts` (the page CSP has no `media-src`, so `default-src 'self'` refuses `<audio src="blob:...">` in a real browser: add `media-src 'self' blob:`) and its test `apps/web/src/server/__tests__/headers.test.ts`
- Test: `apps/web/src/components/__tests__/AudioPanel.test.tsx` (start with `// @vitest-environment jsdom`; stub `URL.createObjectURL`, `URL.revokeObjectURL` and `HTMLMediaElement.prototype.play`/`pause`, which jsdom lacks; model on the existing console component tests in that folder); extend `apps/web/src/components/__tests__/SessionConsole.test.tsx`

**Interfaces:**
- Consumes: Task 5's functions; `ConfirmDialog.tsx`-free: confirmation is inline, not a modal; `roster: readonly { roleId: string; name?: string; ai?: true }[]` for seat names.
- Produces: `export function AudioPanel(props: { sessionId: string; fetch: typeof fetch; roster: readonly VoicePanelEntry[] }): JSX.Element | null`. Rendered in `SessionConsole` inside the `endedFinal || polledEnded` block after `ReportLinksPanel`, gated per R2 (revised): it renders nothing when control has no audio and the roster shows no voice seat.

Behaviour (each is a test): loads the list on mount and after every finished delete; groups clips by `role` with the roster name (`<bdi>`, untrusted text) or `roleLabel(roleId)` from `lib/names`; each row shows its start time and the text or "No transcript"; a clip with `audio !== "available"` shows "Audio deleted" and has no play button; one `<audio>` element labelled with the clip; play fetches through `playClip` into an object URL, stops any other clip first, ignores a second click while a fetch is in flight, revokes the previous URL (Review Focus 4); a clip that answers `audio_deleted` flips to "Audio deleted" without a reload; seat and "Delete all audio" buttons open an inline confirmation naming the count and duration, saying it cannot be undone, with a reason radio group defaulting to "Facilitator decision"; confirming calls `deleteAudio`; `done` reloads; `pending` (and any other delete outcome, a timeout included) reloads the list, so clips control did delete show "Audio deleted", and keeps the unfinished parts listed in plain words with a Retry button; it never shows a success state (Review Focus 3); `live` shows "the session is still ending, try again in a moment" with a Retry button; `account_required` shows the sign-in sentence and no list; list failure shows a retry; focus returns to the seat's button, or the panel heading when the group is gone; messages through `role="status"`, errors `role="alert"`.

- [ ] **Step 1: Write the failing component tests** for the behaviours above with a fake `fetch`.
- [ ] **Step 2: Run** `pnpm --filter @acr/web exec vitest run src/components/__tests__/AudioPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** `AudioPanel` (state machine: `loading | ready | live | account_required | failed`; the in-flight play guard is a ref), wire it into `SessionConsole` with the roster gate, keep markup in the console's existing classes (`card`, `stack`, `muted small`).
- [ ] **Step 4: Run** the panel tests, `SessionConsole` tests, `headers.test.ts` and the web typecheck. Expected: PASS. Mutation checks: remove the in-flight guard (double click test fails); render success on `pending` (partial-delete test fails); revert both.
- [ ] **Step 5: Commit** `[feat] A2B2: console AudioPanel`.

---

### Task 7: End-to-end and accessibility check

**Files:**
- Test: `apps/web/src/server/__tests__/console-audio.e2e.test.ts`

**Interfaces:** consumes everything above.

- [ ] **Step 1: Write the test** that runs the three web handlers against a real in-process control `createApi` (apps/web has no `@acr/control` dependency: import it by computed path as `ai-roles.runtime.test.ts` does around lines 268-290; real HTTP on an ephemeral port, a temp audio store built with `services/control/src/__tests__/voice/audio-e2e-harness.ts`, a temp session log with utterances, an ended session): list returns clips with the right text and no identity; play returns the WAV and exactly one `audio.played` audit line appears per play; delete of one role returns done, the list then shows "deleted" for it and its transcript text is unchanged; a second play of a deleted clip is 410; a running session gives 409 from list and transcript; a legacy cookie gets 403 `account_required` and control sees no `/audio` or `/transcript` request. Front the real `LauncherClient` with `withConsoleAuth` (the real `createApi` here has no accounts service, so without it the legacy request would fail at the auth lookup with 502 before the refusal and pass for the wrong reason).
- [ ] **Step 2: Run.** Expected: it should pass if Tasks 1 to 4 are right; any failure is a defect in the earlier task to fix there.
- [ ] **Step 3: Run** the web accessibility lint or axe check the repo already has for console components (`grep -rn axe apps/web` to find it); if none exists, add keyboard assertions to the panel tests (every control reachable by Tab, status and alert roles present).
- [ ] **Step 4: Commit** `[test] A2B2: audio panel end to end`.

---

### Task 8: Docs, tracker and close-out

**Files:** the Docs list under File Structure.

- [ ] **Step 0:** Change the spec's status line to "Draft 2, approved by the owner 2026-11-16".
- [ ] **Step 1:** File the story, task, ACs and TCs in `docs/RELEASE_PLAN.md` and `docs/TEST_CASES.md` using the next ids from `docs/ID_REGISTRY.md` and add the registry row (assigned date, branch, ids, next free). One AC each for: transcript route, the three web routes, legacy refusal, the join, the panel states, partial delete, no cache, one play one audit line; one TC each, plus the owner-run real-room test (Not Run, like TC-0242).
- [ ] **Step 2:** `docs/THREAT_MODEL.md`: the browser play path (one fetch, one audit line, no range), the transcript route (facilitator-only, no audit, bounded read), the legacy refusal, no identity to the browser, no-store. `docs/VOICE_RUNBOOK.md`: the panel, what `store_unsafe` and `audit_unavailable` pending mean and the operator action, the transcript 413 and 409. Rollback entry: deploy control before web; web without the new control route shows "transcripts unavailable" and everything else works; control alone changes nothing visible.
- [ ] **Step 3:** `CHANGELOG.md` under `[Unreleased]`; `progress.md`, `MEMORY.md` per Session Close; update the backlog note that A2b-2 is done.
- [ ] **Step 4:** `npm run plan:generate`, then the full suites (`pnpm -r test`, the typechecks, `pnpm lint:sdk`) and confirm all green. Add an owner-run test case (Not Run): in a real browser a clip actually plays (the CSP `media-src` with a blob URL cannot be proven in jsdom).
- [ ] **Step 5: Commit** `[docs] A2B2: threat model, runbook, rollback, tracker, changelog`.
