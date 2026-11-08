# EPIC-0003 voice, part A: master implementation plan (overview)

> **For agentic workers:** this is the master plan. Each slice gets its own full plan, written just before it starts: A1a is `2026-11-08-voice-a1a-pipeline.md` (full); A1b, A1c, A2 and A3 are outlined in `2026-11-08-voice-a1b-a1c-a2-a3-outline.md` and must be expanded first. Execute a full plan with superpowers:subagent-driven-development (recommended) or superpowers:executing-plans.

**Goal:** Voice into the transcript: what each participant says enters the session log under their own role as an ordinary `utterance` with `channel: "voice"`, with audio kept for facilitator replay, while text-only participants and the log format stay unchanged.

**Architecture:** A new per-session speech worker (`services/speech`), forked by the control service, segments audio, calls a speech-to-text adapter (`packages/adapters/src/speech`) and sends lines to control over IPC; control relays them to the runtime over the existing parent channel; the runtime records them through a new host method and runs the NPC round after a voice-turn pause. LiveKit (A1b), operations (A1c), the audio store and audit log (A2) and facilitator tools (A3) follow.

**Tech Stack:** TypeScript, pnpm workspaces, Node 22 (`fork()` IPC, global `fetch`/`FormData`), zod 4 (strict schemas), Vitest, whisper.cpp `whisper-server` 1.9.5 (Homebrew, native, loopback), LiveKit (A1b), Caddy (A1c).

**Spec:** `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` (Draft 2). This plan argues from it; where the two differ, the section "Contradictions with the spec" below lists the exact change and the owner decides. The spec is not edited by this plan.

**Verified against:** `brainstorm/EPIC-0003-voice` at `ad55fb8`, whose code is identical to `develop` at `96e4483` (the branch adds only the spec). Every `file:line` below is from that tree.

---

## Contradictions with the spec (read first)

Each item names the spec section, what the code shows, and the exact change recommended. None is applied to the spec by this plan.

| # | Spec says | Code / finding | Recommended spec change |
| --- | --- | --- | --- |
| **C1** | §12: A1a delivers "voice lines through the new host method" and the runtime "refuses a `voice_line` for ... `recording` other than `yes`" (§4); the voice record, opt-in and notice v3 are in A1b. | The runtime can only decide `recording` from the voice record. Without it in A1a every voice line is refused (`not_recording`), so A1a cannot show a single voice line reaching the log, and `pnpm demo --voice` has nothing to demonstrate. A control-forked runtime loads the notice only from `<repo>/consent` (`services/runtime/src/main.ts:118`; `consentDir` is a `bootstrap` option, not an environment setting), so a demo through real control cannot point at a fixture notice. | **Move the runtime half of the voice choice into A1a:** the voice record file and its never-inherited rules, the player messages `voice_opt_in` / `voice_opt_out` on the runtime socket, the runtime's `VOICE_ENABLED` refusals, and a **draft** `consent/notice-v3.md` (wording from §6, marked for legal review). A1b keeps the final notice wording, the web consent route, lobby, roster and readiness fields, the mic check, LiveKit, mute, the web `voice_notice`, the console indicator and supervision with restart. Owner decision: **Open Question 1** (alternative B there). |
| **C2** | §4 lists the channels: worker→control `voice_line`, `speech_activity`; control→runtime `voice_line` (answered with `seq`); control→worker `voice_state`. | The runtime is the only process that knows holders, pause and end (`SessionHost.assignments`, `session-host.ts:163,170,219`; pause in the engine state), so control cannot build `voice_state` without being told. The host keeps the turn timer (§7.5) but `speech_activity` has no route to it. Bots live in control (`services/control/src/main.ts:66-69`) and cannot see the host's timer. Failed and empty segments must reach the speaker and the facilitator (§7.4) but have no message. | Add to §4 (exact schemas in "Cross-slice interfaces" below): runtime→control `voice_seats`, `voice_turn`, `voice_choice`, `voice_line_ack`, `voice_line_refused`, and an optional `voice: true` on `ready`; control→runtime `speech_activity`, `voice_notice`, `voice_alert`; worker→control `segment_failed`, `worker_ready`; control→worker `voice_line_result`. |
| **C3** | §7.5: the round runs after `TURN_END_MS` "with no active speech on any human track, measured from the last speech frame"; `speech_activity { roleId, active }`. | An `active: false` edge can only be sent once the hangover (500 ms) has passed, and the line arrives after transcription (spike p95 652 to 752 ms end of speech to text). With only `{roleId, active}` the host cannot measure from the last speech frame, and a round started from the edge can run before the turn's last line is recorded. | `speech_activity` gains `silentMs` (milliseconds since the track's last speech frame, on `active: false` only); the worker sends the `false` edge **after** the closing segment's outcome (line or failure) has been sent; the host arms the timer for `max(0, TURN_END_MS - silentMs)` and starts the round only after every voice line received so far is recorded. |
| **C4** | §4: "`scripts/check-sdk-imports.sh` is extended to the LiveKit packages". | The script has one package list and one allowed directory, `./packages/adapters` (`scripts/check-sdk-imports.sh:8,13`). The worker needs `@livekit/rtc-node` (`services/speech`, §4, §9) and the browser needs `livekit-client` (`apps/web`). Adding `@livekit/...` to the one list would fail both. | "Extended with a second rule that leaves the provider rule unchanged: `livekit-server-sdk` only in `packages/adapters`; `@livekit/rtc-node` only in `services/speech`; `livekit-client` only in `apps/web`." The first rule's list and prune path stay byte-identical. |
| **C5** | §6: the voice record is `<logIdentity>.voice.json`. | Every per-session file in the sessions directory is named by the session id (`<id>.consent.json`, `<id>.codes.json`, `<id>.lock`) and a failed create deletes exactly `<sessionId>.*` (`services/control/src/supervisor.ts:268-273`). A file named by the log identity would survive a rolled-back create and would not be covered by the lock-file naming. | Name it `<sessionId>.voice.json` and **bind** it inside to `{sessionId, logIdentity}`; a record whose binding does not match (a fresh start on an old id) is ignored as "no choices" and removed under the lock. The audio directory stays keyed by the log identity (§8). |
| **C6** | §4 Supervision: "the worker re-attaches when its runtime restarts on a new port (control pushes the current state)". | The worker has no connection to the runtime at all (D8, IPC to control only), so the runtime's port is irrelevant to it. | "After every runtime `ready` and every `voice_seats`, control pushes the current `voice_state`; until the first one arrives after a restart the worker treats every track as not recording." |
| **C7** | §7.5: "the cadence counts voice turns (a turn = the lines up to a `TURN_END_MS` pause), not segments." | The Game Master is ticked by the host's ticker about once a second, not only after rounds (`agents/game-master.ts:81`, `host/session-host.ts:480-483`), counts every utterance of the scene (`game-master.ts:95-96`), and is restored from the same count (`session-host.ts:315-316`). A turn boundary is not in the log (no log change, D7). | Add: "The Game Master counts each non-voice utterance as one unit and each **closed** voice turn as one unit, does not evaluate while a voice turn is open, and is restored with the same count. After a restart the turn boundaries are not known; a maximal run of consecutive voice lines then counts as one turn (fewer evaluations, never more)." |
| **C8** | §7.5: "AI-player bots ... too wake once per voice turn." | A bot's parsed utterance has no `channel` (`services/control/src/bots/bot-frames.ts:10`), and its hold flag already belongs to prompt reservations (`bot-host.ts:146-188`, `turn-policy.ts:164`). | "The runtime tells control when a voice turn opens and closes (`voice_turn`); while one is open a bot begins no turn and coalesces human lines into one; the reservation hold is a separate flag." |
| **C9** | §9: "Check whether `whisper-server` supports any authentication; if not, loopback is the only control and the spec says so." | `whisper-server --help` (1.9.5) lists no authentication option; the binary has no API-key or bearer strings. It does contain CORS header strings (`Access-Control-Allow-Origin`, `content-type, authorization`) and a `/load` endpoint (swap the model by path). If it answers any origin, a web page open in a browser on the host could POST audio to it or call `/load`. **Inferred from strings, not run.** | §9: "whisper-server has no authentication. Loopback binding, a port chosen by `voice:up` (not 8080), an unguessable `--request-path` prefix kept in `.env` as part of `STT_URL`, and `--convert` never set. The threat model records the same-host browser path and `/load`." A1c verifies the CORS answer with `curl` against a running server. |
| **C10** | §6: "`voice_opt_in` (explicit; allowed any time; the first one needs notice v3 accepted)". | Consent cannot be given after the start (`session-host.ts:285` `refuseOnceStarting`), and a started session keeps an adopted older-version consent (R15, `engine/consent.ts:61`). | Add: "A participant whose recorded consent is to a notice that does not name voice cannot opt in during that session; they take part by text." |
| **C11** | Citations | `protocol.ts:73-77` (consent refused after start) is `host/protocol.ts:54-57` plus `session-host.ts:285`; `protocol.ts:84` (`joined.consent`) is `host/protocol.ts:79-80`; `session-host.ts:399` (hard-coded `"text"`) is `:401`; `stream-hub.ts:221` is `:222` (comment) inside `onFrame` `:205-223`. | Correct the line numbers. |

---

## Slices, order and dependencies

```
A1a (pipeline on file ingest) ──> A1b (LiveKit, consent UI, supervision) ──> A1c (operations) ──┐
                         └──────> A2 (audio store, audit log, replay, delete) ─────────────────┴──> release gate ──> A3 (facilitator tools)
```

| Slice | Proposed story | Branch (from `develop`) | Depends on | Scope (one line) |
| --- | --- | --- | --- | --- |
| A1a | US-0070 | `feature/EPIC-0003-US-0070-voice-pipeline` | spec + this plan on `develop` | Worker skeleton, all IPC and parent-channel messages with drift tests, segmenter, noise gate, STT adapter, contract suite and Whisper client, normaliser, host voice method, per-track FIFO, turn timer, GM and bot cadence, refusals and failures, the runtime voice choice (C1), `pnpm demo --voice` on file ingest with the fake adapter. |
| A1b | US-0071 | `feature/EPIC-0003-US-0071-voice-livekit-consent` | A1a merged | LiveKit `AudioIngest` and token adapter, control token route, grant, seat generations, `removeParticipant`, final notice v3, web consent route, lobby, roster and readiness voice state, mic check, mute, web `voice_notice`, console speaking indicator and alerts, worker restart with backoff, Whisper health polling. |
| A1c | US-0072 | `feature/EPIC-0003-US-0072-voice-operations` | A1b merged | `pnpm voice:up` / `voice:check`, compose services (LiveKit, Caddy), certificate path, loopback-only web server behind the proxy, runbook, threat-model section, `.env.example`, ROLLBACK, ARCHITECTURE deviations. |
| A2 | US-0073 | `feature/EPIC-0003-US-0073-voice-audio-retention` | A1a merged (A1b for the live path) | Audio store, index, lock, disk guard, sweep in control, replay, delete (session, role, participant), audit log, console additions. |
| A3 | US-0074 | `feature/EPIC-0003-US-0074-voice-facilitator-tools` | A1b, A2 merged | Live partials, mute a participant, push-to-talk option, capacity switch-off. |

**Ids.** Story numbers above are proposals (next free US-0070 at the time of writing, `docs/ID_REGISTRY.md:156`); nothing is reserved by this plan. Each slice's story, TASK, AC and TC ids are taken from `docs/ID_REGISTRY.md` when that slice's stories are filed (the first task of each slice plan), with a "Reserved blocks" or "Assigned" line in the registry's own style. If another story takes US-0070 first, every name in this plan shifts with the registry; branch names follow the filed id.

**Release gate (spec §12, unchanged):** voice is enabled for a pilot only when A1a, A1b, A1c and A2 are complete, the owner-run room test passes (spec §13), and legal and HR have signed off the notice v3 wording (spec §14 item 7). Until then `VOICE_ENABLED` stays `0` in every shipped configuration; each slice is dark behind it. A3 may ship after the pilot starts.

**Docs-first:** the spec and these three plans land on `develop` through one docs PR before A1a's branch is cut (the precedent of slice 2c-4, Task 0).

---

## Cross-slice interfaces (exact)

All schemas are zod `strictObject` (unknown keys refused). `RoleId` is the parent-channel rule (`services/runtime/src/host/parent-channel.ts:12`: `isScenarioId && !isReservedRoleId`, at most `CLIENT_ID_MAX_CHARS`). `ParticipantId` is `z.string().min(1).max(CLIENT_ID_MAX_CHARS)` refusing `REBIND_PENDING` (as `host/protocol.ts:42`). `SegmentId` is `isFileSafeId` (`packages/events/src/ids.ts:40-41`, `[a-z0-9_-]{1,64}`), generated by the worker as `randomBytes(8).toString("hex")`. No new regular expression is written outside `packages/events/src/ids.ts` (the US-0020 guard, see Resolved Facts F16).

### 1. Worker ↔ control (`services/speech/src/protocol.ts`, exported as `@acr/speech/protocol`)

One source of truth: control imports this module only (a control import test pins that no other `@acr/speech` path is imported, so native code never loads into control). The module imports only `zod` and `@acr/events`.

```ts
// worker -> control
type WorkerMessage =
  | { type: "worker_ready"; stt: "ok" | "unavailable" }                       // after the warm-up request
  | { type: "voice_line"; segmentId: SegmentId; roleId: RoleId; participantId: ParticipantId;
      text: string /* 1..2000, normalised */; startMs: number; endMs: number /* wall clock, injected */ }
  | { type: "speech_activity"; roleId: RoleId; active: boolean; silentMs?: number /* only with active:false, 0..60000 */ }
  | { type: "segment_failed"; segmentId: SegmentId; roleId: RoleId; participantId: ParticipantId; status: "empty" | "stt_failed" };
// control -> worker
type ControlToWorker =
  | { type: "voice_state"; paused: boolean; ended: boolean;
      holders: { roleId: RoleId; participantId: ParticipantId; recording: boolean }[] /* max 256 */ }
  | { type: "voice_line_result"; segmentId: SegmentId; seq: number /* int >= 1 */ }
  | { type: "voice_line_result"; segmentId: SegmentId; refused: VoiceRefusal };   // one schema: exactly one of seq | refused
```

A2 adds no message here (the worker writes its own store); A1b adds `livekit_join { url, token, room }` (control→worker) and `stt_health { ok }` (worker→control); A3 adds `partial { roleId, text }` (worker→control, facilitator only).

### 2. Control ↔ runtime (parent channel: `services/runtime/src/host/parent-channel.ts` and its copy `services/control/src/protocol.ts`, drift test `services/control/src/__tests__/protocol.drift.test.ts`)

```ts
type VoiceRefusal = "voice_off" | "not_started" | "unknown_role" | "ai_role" | "not_holder" | "not_recording"
                  | "paused" | "not_in_scene" | "ended" | "failed";
type VoiceNoticeCode = "stt_failed" | "empty" | "paused" | "not_in_scene" | "ended" | "not_recording" | "voice_unavailable";
type VoiceAlertCode = "worker_down" | "stt_unavailable" | "stt_failed";            // A1b adds "worker_restarting", "voice_off"; A2 adds "disk_low", "write_error"

// ParentMessage additions (control -> runtime)
| { type: "voice_line"; segmentId: SegmentId; roleId: RoleId; participantId: ParticipantId; text: string /* 1..MAX_UTTERANCE_CHARS (2000) */ }
| { type: "speech_activity"; roleId: RoleId; active: boolean; silentMs?: number }       // fire-and-forget
| { type: "voice_notice"; roleId: RoleId; participantId: ParticipantId; code: "stt_failed" | "empty" }  // fire-and-forget
| { type: "voice_alert"; code: VoiceAlertCode }                                          // fire-and-forget
// ChildMessage additions (runtime -> control)
| ready: { ...existing, voice?: true }      // present only when VOICE_ENABLED=1 was accepted at bootstrap
| { type: "voice_line_ack"; segmentId: SegmentId; seq: number }
| { type: "voice_line_refused"; segmentId: SegmentId; code: VoiceRefusal }
| { type: "voice_seats"; paused: boolean; ended: boolean; holders: { roleId; participantId; recording: boolean }[] }
| { type: "voice_turn"; open: boolean }
| { type: "voice_choice"; roleId: RoleId; participantId: ParticipantId; choice: "voice" | "text_only"; at: number }
```

The correlation id of a voice line is its `segmentId` (it already meets `isSafeId`). The runtime answers every `voice_line` exactly once; control times a pending line out after `VOICE_LINE_TIMEOUT_MS` (constant 10 000) and reports `refused: "failed"` to the worker. `voice_seats` is sent after `ready`, and then after every change of a holder, a recording flag, pause, resume and end, coalesced to at most one per event-loop turn.

### 3. Runtime ↔ player socket (`services/runtime/src/host/protocol.ts`)

```ts
// ClientMessage additions
| { type: "voice_opt_in"; noticeVersion: string /* 1..32 */ }
| { type: "voice_opt_out" }
// ServerMessage additions
| { type: "voice"; state: "voice" | "text_only" }                 // to the sender only, after an accepted opt-in / opt-out
| { type: "voice_notice"; code: VoiceNoticeCode }                 // to that role's live sockets only; never logged, never to others
// joined (players): voice?: { state: "none" | "voice" | "text_only" | "off" }   // own seat only; A1b reads it in the web
```

Refusals use the existing `error` frame: `voice_off` (VOICE_ENABLED off), `forbidden` (facilitator, AI seat), `not_joined` (not the holder), `voice_notice_required` (the participant's consent does not name voice), `consent_version` (opt-in names another notice version), `bad_message`.

### 4. Voice record file (runtime, A1a; spec §6 with C5)

`<SESSION_DATA_DIR>/<sessionId>.voice.json`, mode 0600, written only by the runtime under its session lock through `writeSecureJson` (`services/runtime/src/engine/secure-json-file.ts:56-81`: O_EXCL temp, fsync, rename, directory fsync); read through one descriptor (`readSecureJson`, `:26-30`), max 64 KiB.

```json
{ "v": 1, "sessionId": "<id>", "logIdentity": "<32 hex>",
  "entries": { "<roleId>": { "participantId": "<id>", "choice": "voice" | "text_only", "noticeVersion": "v3", "at": 1731050000000 } } }
```

Rules: keys exactly as above (strict, like `consent.ts:119`); a missing, malformed or mis-bound file means "no choices" (never refuses a session start; a malformed one is reported by name only and removed under the lock); an entry counts only when its `participantId` equals the current holder (`SessionHost.holds`, `session-host.ts:280-282`) and its role is a human player role; a reissue, rebind or remove deletes the role's entry; nothing is seeded from the log (R14 seeds consent only, `session-host.ts:325-334`); an older build never reads it.

Voice state per seat (what `joined.voice` and, in A1b, the roster show): `none` (no choice yet), `voice` (entry for this holder with `choice: "voice"`), `text_only` (entry with `text_only`, or an entry for another participant), `off` (VOICE_ENABLED off, or the seat is an AI seat). `recording` in `voice_seats` is `state === "voice" && !muted` (mute arrives in A1b).

### 5. Audio index entry (A2; spec §8)

`<AUDIO_ROOT>/<logIdentity>/<roleId>/index.jsonl` (append-only, 0600, directory 0700, one writer: the worker under the A2 lock). Lines:

```json
{ "v": 1, "kind": "segment", "segment": "<id>", "participantId": "<id>", "startMs": 0, "endMs": 0,
  "status": "transcribed" | "empty" | "stt_failed" | "refused:<VoiceRefusal>", "raw": "<raw text or absent>",
  "timings": { "vadEndMs": 0, "sttMs": 0 } }
{ "v": 1, "kind": "seq", "segment": "<id>", "seq": 42 }            // back-fill, appended when control relays voice_line_result
{ "v": 1, "kind": "deleted", "segment": "<id>", "at": 0 }          // written by control on delete (A2), so a deleted segment shows as "audio deleted"
```

Back-fill and deletion are appended, never rewritten; a reader merges by `segment` (the last `kind` wins per field). Audio: `<segment>.wav`, 16 kHz mono 16-bit PCM. Write order: audio file, then the `segment` line, then (control → worker) the `seq` line.

### 6. Audio audit log (A2; spec §8)

`<AUDIO_ROOT>/<logIdentity>.audio-audit.jsonl`, append-only, 0600, written only by control under its own lock file `<logIdentity>.audio-audit.lock` (the `SessionLock` pattern). One JSON object per line, all with `v: 1`, `ts` (control clock) and `type`:

```json
{ "type": "audio.played", "role": "<roleId>", "segment": "<id>", "by": "<facilitator label>" }
{ "type": "audio.deleted", "scope": { "kind": "session" } | { "kind": "role", "role": "<id>" } | { "kind": "participant", "participant": "<id>" },
  "reason": "facilitator" | "expired" | "participant_request", "by": "<label>" | "system", "segments": 12 }
{ "type": "voice.opted_in", "role": "<id>", "participant": "<id>", "noticeVersion": "v3" }
{ "type": "voice.opted_out", "role": "<id>", "participant": "<id>" }
{ "type": "voice.recording_stopped", "reason": "disk_low" | "write_error" | "worker_down" }
```

No text, audio or transcript content is ever written to it. `by` is the facilitator label cleaned like `cleanFacilitatorLabel` (60 code points). The `voice.*` events come from the runtime's `voice_choice` messages; before A2 control drops them.

### 7. LiveKit token grant (A1b; spec §9)

Minted in control through `packages/adapters/src/livekit/token.ts` (`livekit-server-sdk`), never in `apps/web`:

```ts
{ identity: `${roleId}.g${generation}` /* generation: 8 hex, new on every create, reissue, rebind and control start */,
  ttl: 600 /* seconds, never more */,
  grant: { room: <room>, roomJoin: true, canPublish: true, canPublishSources: ["microphone"],
           canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false } }
```

`room` is `v` + 32 random hex per session, held in control memory only. A token is issued only to the current holder whose voice state is `voice` (from the last `voice_seats`); a reissue or opt-out calls `removeParticipant(room, identity)`. The worker's own token (`canSubscribe: true`, `canPublish: false`) goes to it through `livekit_join`, never through its environment.

---

## Files and packages per slice

**A1a** (full list in the A1a plan): create `services/speech/` (`package.json` `@acr/speech`, `tsconfig.json`, `vitest.config.ts`, `src/protocol.ts`, `src/segmenter.ts`, `src/noise-gate.ts`, `src/normalise.ts`, `src/track-pipeline.ts`, `src/activity.ts`, `src/voice-gate.ts`, `src/ingest/audio-ingest.ts`, `src/ingest/file-ingest.ts`, `src/config.ts`, `src/worker.ts`, `src/main.ts`, `src/__tests__/*`); create `packages/adapters/src/speech/` (`types.ts`, `errors.ts`, `fake.ts`, `wav.ts`, `whisper-http.ts`, `limited.ts`, `contract.ts`, `__tests__/*`) and export from `packages/adapters/src/index.ts`; create `services/runtime/src/engine/voice-file.ts`, `services/runtime/src/host/voice.ts` (turn tracker and gate), `services/runtime/src/host/voice-config.ts`; modify `services/runtime/src/host/parent-channel.ts`, `host/protocol.ts`, `host/session-host.ts`, `host/ws-server.ts`, `host/reissue.ts`, `host/limits.ts`, `agents/game-master.ts`, `main.ts`, `demo/args.ts`, `demo/runner.ts`; modify `services/control/src/protocol.ts`, `child-env.ts`, `supervisor.ts`, `main.ts`, `bots/bot-host.ts`, `bots/bot.ts`, `package.json` (`@acr/speech` dependency, `demo:voice` script); create `services/control/src/voice/` (`voice-host.ts`, `speech-spawn.ts`, `speech-env.ts`, `speech-command.ts`) and `services/control/src/demo/voice-demo.ts`; create `consent/notice-v3.md` (draft, C1); docs (see the A1a plan's last task).

**A1b:** create `packages/adapters/src/livekit/token.ts`, `services/speech/src/ingest/livekit-ingest.ts`, `services/control/src/voice/tokens.ts`, `services/control/src/voice/restart.ts`, web files under `apps/web/src/server/` (voice token route, hub allowlist) and `apps/web/src/components/` (`VoiceChoice.tsx`, `MicCheck.tsx`, `MicButton.tsx`, console `SpeakingIndicator.tsx`); modify `scripts/check-sdk-imports.sh` and its test, `apps/web/src/server/stream-hub.ts` (`voice_notice` named event, send allowlist), `wire.ts`, `handlers.ts`, `console-roster.ts`, `facilitator-hub.ts`, `consent/notice-v3.md` (final). New dependencies: `livekit-server-sdk` (adapters), `@livekit/rtc-node` (speech), `livekit-client` (web).

**A1c:** create `scripts/voice-up.sh`, `scripts/voice-check.ts` (or `.sh`), `deploy/compose/voice.yml` (LiveKit, Caddy), `deploy/compose/Caddyfile`, `deploy/compose/livekit.yaml`, `docs/VOICE_RUNBOOK.md`; modify `package.json` (`voice:up`, `voice:check`), `.env.example`, `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `docs/ARCHITECTURE.md`, `apps/web` start configuration (loopback, `TRUST_PROXY`).

**A2:** create `services/speech/src/store/` (`audio-store.ts`, `index-file.ts`, `store-lock.ts`, `disk-guard.ts`), `services/control/src/voice/` (`audit-log.ts`, `sweep.ts`, `replay-routes.ts`, `delete.ts`), web console routes and `AudioPanel.tsx`; modify the worker pipeline (write audio and index), `voice-host.ts` (seq back-fill, audit events from `voice_choice`).

**A3:** modify the worker (partials, capacity switch), control (partials relay, mute), web console (`LivePartials.tsx`, mute control) and participant page (push-to-talk).

---

## New dependencies

A1a adds **none**: WAV encoding and parsing are written by hand (16-bit PCM, about 40 lines), HTTP uses Node 22's global `fetch`, `FormData` and `Blob`, and the test HTTP server is `node:http`.

| Package | Where (only) | Slice | Purpose |
| --- | --- | --- | --- |
| `livekit-server-sdk` | `packages/adapters` | A1b | Token minting and `removeParticipant` |
| `@livekit/rtc-node` | `services/speech` | A1b | Server participant: subscribe to holder tracks, read 16 kHz mono frames (the spike used 1.2.1) |
| `livekit-client` | `apps/web` | A1b | Publish the microphone |
| LiveKit server image, Caddy image | `deploy/compose/voice.yml` | A1c | Media server, TLS proxy (spike: LiveKit 1.13.11) |

Rules for each (AGENTS.md §19 and §12): exact version in `package.json` (no `^`, `~`, `*` or `latest`), a version at least two weeks old, `pnpm audit --audit-level=high` clean, licence checked (MIT, Apache-2.0 or BSD), one `findings.md` row each with name, version, purpose, licence and last-maintenance date, and the `MEMORY.md` dependency section updated; container images pinned by digest. Versions are chosen when the A1b and A1c plans are expanded (this plan did not look them up). `lint:sdk` is extended as in C4.

---

## Settings

| Name | Default | Range / rule | Read by | Reaches a child through |
| --- | --- | --- | --- | --- |
| `VOICE_ENABLED` | `0` | `0` or `1`; with `1` the runtime refuses to start unless `CONTROL_MANAGED=1` and the notice names voice (v3 or later) | control, runtime | `CHILD_ENV_ALLOWLIST.names` (runtime); control decides the worker |
| `VOICE_HANGOVER_MS` | `500` | 300 to 600 | worker | speech env allowlist |
| `TURN_END_MS` | `800` | 300 to 3000 (plan's bound; spec gives the default only) | runtime | `CHILD_ENV_ALLOWLIST.names` |
| `VOICE_MAX_SEGMENT_MS` | `2500` | 2000 to 6000 | worker | speech env allowlist |
| `STT_URL` | none (required when `VOICE_ENABLED=1`) | `http://127.0.0.1:<port>[/<path>]` or `http://[::1]:...`; any other host refused | worker | speech env allowlist |
| `STT_MODEL` | `small.en` | a label (1 to 64, `isSafeId` plus `.`, see Open Question 6) | worker (label), `voice:up` (A1c) | speech env allowlist |
| `STT_PROVIDER`, `STT_FAKE_SCRIPT`, `SPEECH_INGEST`, `SPEECH_INGEST_DIR` | `whisper`, none, `file` (A1a; `livekit` from A1b), none | `whisper` or `fake`; an absolute JSON file; `file` or `livekit`; an absolute directory. The fake and file values exist for the offline demo and tests, like the mock model provider | worker | speech env allowlist (control adds `SPEECH_INGEST_ROLES` itself) |
| `AUDIO_MAX_RETENTION_DAYS` | `30` | 1 to 30 | control (sweep) | n/a (A2) |
| `AUDIO_MIN_FREE_MB` | `2048` | 512 to 1 000 000 | worker, control, `voice:check` | speech env allowlist (A2) |
| `AUDIO_DIR` | `<CONTROL_DATA_DIR>/audio` | absolute | worker, control | speech env allowlist (A2) |
| `LIVEKIT_URL` | none | `wss://...` (browser) | control (returned with the token) | never to a runtime |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | none, `.env` only | generated by `voice:up` | control only | never (the worker gets a token over IPC) |

Constants (not settings; changed only by code review): `VAD_FRAME_MS` 20, `VAD_THRESHOLD_DBFS` -45, `LEAD_IN_MS` 200, `MIN_SPEECH_MS` 300, `SPLIT_SEARCH_MS` 1000, `STT_DEADLINE_MS` 5000, `STT_MAX_RETRIES` 2, `STT_RETRY_BASE_MS` 150, `STT_MAX_IN_FLIGHT` 2, `STT_QUEUE_ALERT` 16, `VOICE_LINE_TIMEOUT_MS` 10 000, `NOTICE_MIN_INTERVAL_MS` 10 000 (per role and code), `ALERT_MIN_INTERVAL_MS` 30 000 (per session and code), noise gate `GATE_NO_SPEECH_PROB` 0.6 and `GATE_AVG_LOGPROB` -1.0 (whisper-server's own defaults `-nth 0.60`, `-lpt -1.00`), `GATE_MIN_RMS_DBFS` -50, `GATE_SHORT_MS` 400; A1b: restart backoff 5 tries, base 500 ms, doubling; Whisper health poll 5 s. Every setting goes into `docs/memory/models-and-providers.md` and `.env.example` in the slice that adds it.

---

## Risks (in addition to spec §14)

1. **Turn timer versus transcription time.** With a 500 ms hangover and 800 ms turn end, transcription has about 300 ms before the round would start; C3's ordering (edge after outcome, round after recorded lines) removes the race at the cost of the round starting no earlier than the last line. A late line still never goes unanswered (the host's "at most one waiting" rule, `session-host.ts:406-409`).
2. **Game Master after a restart** counts consecutive voice lines as one turn (C7): fewer evaluations until the next closed turn. Accepted; tested.
3. **Opt-out write failure.** The opt-out takes effect in memory first (recording stops at once); if the file write fails the runtime removes the file instead, and if that fails too it alerts the facilitator and keeps voice off for that seat for the rest of the process. A crash between the failed write and the removal could, on restart, show the old choice: tested and recorded in the threat model.
4. **Holder means connected.** A seat's holder is released when its socket closes (`ws-server.ts:470-481`); a line in flight during a reconnect is refused `not_holder` and the speaker gets no notice (they are not connected). Accepted (Open Question 3).
5. **whisper-server reachable from a browser on the host** (C9).
6. **Speaker notices for empty segments** could be noisy (Open Question 2); rate-limited to one per role and code per 10 s.
7. **Worker process count:** one worker per running voice session (MAX_SESSIONS bounds it); each holds Whisper connections only through the shared in-flight cap of its own process, so the GPU cap is per worker, not global (Open Question 9).

---

## Resolved Facts (spec §14 "verify when the plan is written", and the checks this plan was asked to make)

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| F1 | Does `whisper-server` return the no-speech score and the average confidence? | Yes, in `response_format=verbose_json` (per segment, upstream layout): the binary carries `no_speech_prob`, `avg_logprob`, `verbose_json`, `no_speech_thold` and `/health`. The exact JSON nesting was **not** observed (no server was started); the contract test parses defensively and the opt-in live check confirms it. | `whisper-server --help` (1.9.5, `/opt/homebrew/Cellar/whisper.cpp/1.9.5/bin/whisper-server`): `-nth --no-speech-thold [0.60]`, `-lpt --logprob-thold [-1.00]`, `-nlp ... exclude language probabilities from verbose_json output`; `strings` on the binary. |
| F2 | Does `whisper-server` support authentication? | No. No option in `--help`; no API-key or bearer strings. CORS header strings and a `/load` endpoint exist (C9). Options worth using: `--host 127.0.0.1`, `--port`, `--request-path`, `-sns` (suppress non-speech tokens, such as bracketed blank markers). | same commands |
| F3 | How does an older runtime treat a new parent message? | It drops it silently: `onMessage` passes only a `ParentMessageSchema.safeParse` success (`parent-channel.ts:84-89`); the handler never answers. In practice there is no version skew: control forks the runtime from its own checkout (`services/control/src/runtime-command.ts:7-13`). Control still sends voice messages only to a runtime whose `ready` carried `voice: true`, and times pending lines out. A newer runtime's `ready.voice` would make an OLDER control refuse `ready` (strict, `protocol.ts:37-50`): the runtime adds the field only when `VOICE_ENABLED=1`. | cited lines |
| F4 | How is a parent-channel message, its strict schema and its drift test added? | Add the `strictObject` to `ParentMessageSchema`/`ChildMessageSchema` in the runtime (`parent-channel.ts:22-58`) and an identical copy in control (`services/control/src/protocol.ts:20-56`; control must not import the runtime); the type-equality test and the shared valid/invalid tables in `protocol.drift.test.ts:10-82` cover both. Runtime handling is in `bootstrap`'s `answer` (`services/runtime/src/main.ts:266-282`, installed at `:283`; a fire-and-forget precedent is `bot_alert`, `:268`); replies through `parent.send` (`:235` for `ready`); control parses child messages in `goLive` (`supervisor.ts:331-338`) and in `awaitReady` (`:197-217`, which drops everything after `ready` except `ended`). | cited lines |
| F5 | How does the Supervisor spawn and track children? | `SpawnFn` (`supervisor.ts:34`) returns a `ChildHandle` (`:25-32`: `send`, `onMessage`, `onExit`, `kill`, `forceKill`, `disconnect`); the real one is `forkSpawn` (`spawn.ts:17-63`: `fork` with exactly the given environment, stdout/stderr to a 0600 `O_NOFOLLOW` log, IPC). `trackExit` (`:174-183`), `awaitReady` with an injected `SetTimer` (`:190-219`), `stopChild` (kill, `graceMs`, forceKill, `:231-240`), `goLive` (`:326-344`), and a crash marks the session `stopped` with manual restart (`onChildExit`, `:393-419`). The in-process `BotHost` is the model for a per-session companion: `attach` on `goLive` (`:341`, `attachBots` `:350-359`), `detach` on child exit (`:408`), `end` on `ended` (`:389`), all fire-and-forget and logged by error name only (`botsCall`, `:362-367`). The speech worker follows the same hooks through a `VoiceHost`, with its own `forkSpawn`-style spawn and its own environment allowlist; restart with bounded backoff (A1b) uses the injected `SetTimer`. | cited lines |
| F6 | Where is a player utterance appended? | `SessionHost.onPlayerUtterance` (`session-host.ts:395-404`) waits for a start in flight, refuses `not_started`, calls `engine.say(roleId, text, "text", opts)` (`:401`), clears `pendingAnswer` and calls `scheduleRound()` (`:406-427`, at most one round waiting, `roundQueued`). `SessionEngine.say` (`engine/session-engine.ts:264`) runs `doSay` (`:265-277`) under the mutex: refuses `ended`, `not_in_scene`, `stale_scene`, `unknown_role`, `paused`, `not_in_scene` (no scene, or role outside it) and returns the emitted event (with `seq`). It does not check the role kind; the WebSocket path calls it only for the joined role (`ws-server.ts:432`). The new `onVoiceUtterance` calls `engine.say(roleId, text, "voice")` with no `expectSceneId` and returns the event's `seq`. | cited lines |
| F7 | GM cadence and bot wake-up code | `DEFAULT_GM_EVERY_N_UTTERANCES = 3` (`agents/gm-config.ts:5`); `GameMaster.tick` (`game-master.ts:89-111`) counts `transcript.filter(u => u.sceneId === scene.id).length` (`:95`) and evaluates when `count - evaluatedCount >= everyN` (`:96`); `finalEvaluation` (`:119-138`) and `restore` (`:75-78`, fed by `session-host.ts:315-316`) use the same count. The host's ticker calls it about once a second (`game-master.ts:81`, `startTicker` `session-host.ts:480`) and after every round (`:425`) and command (`:468`). A transcript entry carries `channel` (`packages/events/src/state.ts:103,154`). Bots: `Bot.onUtterance` (`bots/bot.ts:288-299`) observes every line and re-arms (`arm`, `:319-325`); `BotEvent.utterance` has no `channel` (`bot-frames.ts:10`); `TurnPolicy.setHeld` (`players/turn-policy.ts:164`) is owned by reservations (`bot-host.ts:146-188`). | cited lines |
| F8 | SessionLock pattern | `SessionLock.acquire` (`engine/log-files.ts:248-262`): `O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW`, 0600, `{pid, host, startedAt}`, heartbeat on the descriptor, stale takeover by rename-aside with device and inode proof (`:212-225`). Control and the worker cannot import it (control's guard allows only five `@acr/runtime` subpaths, `services/control/src/__tests__/bots/imports.test.ts:22`); A2 either adds a sixth export `@acr/runtime/files` exposing `SessionLock` or copies the pattern into `services/speech/src/store/store-lock.ts` with its own tests. The A2 plan decides (Open Question 10). | cited lines |
| F9 | Join-code file exclusive-create pattern | `join-code-file.ts:8-9` and `secure-json-file.ts:8-9,56-81`: write a new `O_EXCL|O_NOFOLLOW` 0600 temp, fsync, rename over, fsync the directory; read through one descriptor opened with `O_NOFOLLOW` and judged by `fstat` (`:26-30`); stale temps swept under the lock (`:98-112`). The voice record uses these functions directly. | cited lines |
| F10 | Consent, `claimRebind` and R14 seeding that voice must not break | Consent record is strict and versioned (`engine/consent.ts:116-120`); `REBIND_PENDING` marks a seat released by a reissue after the start (`:31`, `releaseForRebind` `:73-79`), and the next participant to join claims it (`claimRebind` `:91-103`, called from `SessionHost.join` `session-host.ts:159-169`); R14 seeds missing consents from `session.started` (`adoptStartedConsents`, `:325-334`, `ConsentStore.adopt` `consent.ts:61`). The voice record is a separate file and none of these paths read or write it; the gate compares the entry's participant with the current holder, so a rebind or a seeded consent never carries voice. Reissue (`host/reissue.ts:53-73`) gains one step: delete the role's voice entry. | cited lines |
| F11 | `lint:sdk` and import-boundary tests | `package.json` `"lint:sdk": "bash scripts/check-sdk-imports.sh"`; the script (`scripts/check-sdk-imports.sh:8-29`) greps sources and every `package.json` for a provider-SDK list, pruning only `./packages/adapters` (`:13`); fixture tests in `scripts/check-sdk-imports.test.sh`; CI runs both (`.github/workflows/ci.yml:160-161`). It can be extended without touching the existing rule (C4). Control's runtime-import guard: `imports.test.ts:22-46`. | cited lines |
| F12 | Web consent route, lobby, roster and readiness fields (for A1b) | Consent route `POST /api/v1/consent` (`apps/web/src/server/handlers.ts:336-342`, `routes.ts:130`); hub send allowlist say, consent, withdraw_consent, leave (`stream-hub.ts:25,178`); `joined.consent` in the BFF wire type (`wire.ts:59`) and runtime (`host/protocol.ts:79-80`); facilitator roster entry (`wire.ts:63`, `host/roster.ts:4`) and peer entry (`roster.ts:6`), built in `buildRoster` (`:13-28`); console copy picks fields one by one (`console-roster.ts:12-13`); readiness counts "not joined and consented" humans (`console-sessions.ts:178-180`) and the runtime gate is `seats_not_ready` (`session-host.ts:363-368`). Each gains a voice state in A1b, picked field by field. | cited lines |
| F13 | Unknown server frames on the player stream | Dropped (`stream-hub.ts:205-223`, comment at `:222`), so `voice_notice` needs an explicit branch (A1b). `viewFor` forwards an utterance whole (`session-host.ts:601`). | cited lines |
| F14 | Is `channel` read downstream? | The spec's claim was checked for the Game Master (counts only), bots (field dropped, `bot-frames.ts:10`) and the player view (`viewFor` forwards). The evaluator and reports were not re-read by this plan (the spec records them as verified). | cited lines |
| F15 | Existing `pnpm demo` structure for `--voice` | `pnpm demo` runs `tsx src/demo/run.ts` in `@acr/runtime` (`services/runtime/package.json`); flags in `demo/args.ts:14-17,80`; `--web` "runs on its own" (`args.ts:114-116`) and hands over to another package's demo with `spawnWebDemo` (`demo/runner.ts:97-113,144-151`) because the runtime never imports that package. `--voice` copies this: it runs `pnpm --filter @acr/control demo:voice`, because the voice path needs control (relay and worker) and the runtime cannot import control. CI's `demo-run` job (`ci.yml:215-235`) gains `pnpm demo --voice`. | cited lines |
| F16 | Id-rule guard (US-0020) constraints | `id-rules.files.test.ts:96-141` scans every `.ts` under `packages/` and `services/` (not `apps/`), except `__tests__` and `fixtures`, and fails on any character class containing `a-z`, `0-9` and `_`, or `\w` with `-`, or a quoted `__proto__`/`constructor`/`prototype` outside `packages/events/src/ids.ts`. So: segment ids use `isFileSafeId`, LiveKit identities are split and checked with `isScenarioId`, and the normaliser's number patterns must not combine letters, digits and `_` in one class. | cited lines |
| F17 | Managed runtime, environment and voice refusal hook | `managed = opts.env.CONTROL_MANAGED === "1"` (`main.ts:72`); settings are parsed in order with early `{ok:false, errors}` returns (`:96-128`), the notice is loaded at `:115-119`, and `playerRoleCapError` is already managed-only (`:128`): the voice refusals go right after `:128`. The child environment is an allowlist (`child-env.ts:8-16`) with fixed values set by `buildChildEnv` (`:30-52`). | cited lines |
| F18 | Notice version helper | `noticeNamesAiPlayers` accepts `v<n>` with n >= 2 (`host/limits.ts:15-18`), so v3 already passes the AI-player rule; A1a adds `noticeNamesVoice` (n >= 3) beside it. Only `consent/notice-v1.md` and `notice-v2.md` exist. | cited lines |
| F19 | Host timers | `Clock` has `now()` only (`engine/clock.ts:1-7`); the host has no timer seam besides `startTicker` (`setInterval`, `session-host.ts:480-483`). The turn timer is a new injected `SetTimer` (the Supervisor's shape, `supervisor.ts:36`). | cited lines |
| F20 | Retry and contract precedents | `withRetry`/`RetryOptions` (`packages/adapters/src/model/retry.ts:12-24,147`) and `modelProviderContract` (`packages/adapters/src/index.ts:5`) are the patterns for the STT adapter. `architecture/ERROR_TAXONOMY.md` named by AGENTS.md §13 does not exist in the repo; the new error classes are documented in `docs/memory/models-and-providers.md` beside `ModelProviderError`. | cited lines |
| F21 | Safari support for the microphone and the LiveKit client | **Not verified** (no browser was run; no network lookup). Part of the room test and A1b's browser matrix. | none |

---

## Open Questions (owner)

1. **Slicing (C1).** A: move the runtime voice choice (record, `voice_opt_in`/`out` on the runtime socket, refusals) and a draft `consent/notice-v3.md` into A1a; the demo then runs through real control with real participants opting in. B: keep them in A1b; A1a's runtime then has a test-only injected gate (`bootstrap({ voiceRecording })`), its demo runs a fixture runtime child with a fixture notice, and no voice line can reach a real session before A1b. **Recommended: A.** The A1a plan is written for A and marks the two tasks that change under B.
2. **Speaker notice for an `empty` segment:** keep (spec §7.4, rate-limited to one per 10 s) or drop for `empty` only (noise blips are common)?
3. **Holder means connected** (Risk 4): accept that lines in flight during a reconnect are dropped as `not_holder`, or let a voice line through for the participant who held the seat at segment start?
4. **`TURN_END_MS` range:** the spec gives only the default 800; the plan bounds it 300 to 3000. Confirm.
5. **whisper-server hardening (C9):** accept random port plus `--request-path` prefix plus loopback, or require a local proxy with a token in front of it?
6. **`STT_MODEL`:** the worker cannot choose the model of a running `whisper-server` except through `/load`, which this plan never calls. Is `STT_MODEL` a label for `voice:check` and the run summary plus the model file `voice:up` starts with (plan's reading), or something else?
7. **Normaliser rules:** the plan's rules are: spelled numbers to digits, thousands separators from 10,000 ("42,000"), "N percent" to "N%", "N dollars/pounds/euros" to "$N/£N/€N", "half past nine"-style phrases left as words, "9.30" or "nine thirty" followed by am/pm or after "at" to "9:30". Confirm or change (it affects evaluator quotes, which must match the logged text).
8. **Spec §16 items** (participant access to their own audio; REC-07 correction deferred; audit log mandatory) are still the owner's; the plans follow the spec's defaults.
9. **GPU cap scope** (Risk 7): per worker (plan) or one cap across all sessions (needs a shared limiter in control)?
10. **Lock for the audio store (F8):** export `SessionLock` as `@acr/runtime/files` (a sixth allowed subpath) or copy the pattern into `services/speech`? Decided in the A2 plan; the owner may prefer one now.
11. **Legal and HR sign-off** on notice v3 (release gate) and **a domain and certificate** (US-0048) are prerequisites outside this epic's code.

---

## Not verified by this plan

- whisper-server's actual JSON layout, its CORS answer and its `/health` body (no server was started, by instruction).
- Safari and mobile browser support (F21).
- Versions, licences and maintenance dates of the LiveKit packages and images (no network lookup).
- The evaluator's and reports' indifference to `channel` (spec claim, not re-read; F14).
- No test, build or command of the existing code was run for this plan, apart from the read-only `whisper-server --help`, `strings` on its binary, `grep`/`sed`/`awk` reads and `git` queries.
