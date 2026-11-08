# EPIC-0003 voice, part A: voice into the transcript — design

> Status: DRAFT 3 (2026-11-08): Draft 2 was revised after an independent Opus review (31 findings, all accepted except where section 16 notes an owner decision); Draft 3 folds in the 11 contradictions the planning pass found against the code (C1 to C11, listed in `docs/superpowers/plans/2026-11-08-voice-part-a-overview.md`). Epic: EPIC-0003 (Planned, MVP). Brainstormed with the owner on 2026-11-08; the decisions in section 2 are the owner's. No story ids are reserved yet; the proposed stories (section 12) are filed when the plan is written.
> Product basis: `docs/PRODUCT_SPEC.md` (RUN-01, RUN-02, REC-07, ADM-04, the latency row, the 2026-10-01 decision that the MVP is voice-enabled); `docs/ARCHITECTURE.md` sections 2 to 4 and 8 (this spec deviates from it in two places, section 4).

## 1. Purpose and scope

The product is text-only today: every `utterance` event comes from a typed line or an AI character's reply. EPIC-0003 adds voice, split into parts:

| Part | What | Status |
| --- | --- | --- |
| **A (this spec)** | Voice **into the transcript**: a participant speaks, the system transcribes it per participant, the line enters the log as an ordinary `utterance` with `channel: "voice"`. Audio is retained for facilitator replay. AI characters still answer in text. | this spec |
| B | Voice **out**: text-to-speech for AI characters, interruption, masking latency | later |
| C | Remote participants (tunnels, TURN), latency instrumentation as a product feature | backlog |

Part A is **not** voice chat between participants: in the pilot's single room people hear each other directly; the system only listens.

**Success looks like:** in a real room, with two or more people on laptop microphones and headsets, what each person says appears under their name in the transcript within the targets of section 12, the Game Master, evaluator and reports treat it like typed lines, text-only participants are unaffected, and audio is kept, replayable by the facilitator (every replay audited), and deleted on request or at the cap.

## 2. Decisions

| # | Decision (owner unless noted) | Reason |
| --- | --- | --- |
| D1 | Spike first, then part A. The spike ran and answered yes (appendix A). | Latency was unmeasured. |
| D2 | **LiveKit rooms** (ARCHITECTURE section 3), built behind an `AudioIngest` interface with a file-fed implementation. | Part B needs outbound tracks and mixing; the seam gives deterministic tests. |
| D3 | **Speech-to-text is local-first behind an adapter**; default Whisper on the host; a cloud provider is a later drop-in. | "Runs on a laptop, nothing leaves the machine"; no speech keys exist. |
| D4 | **Audio is retained**, until the facilitator deletes it, with a hard cap `AUDIO_MAX_RETENTION_DAYS` (default 30). | Replay and correction value. |
| D5 | **Access mode: everyone on one LAN with a real hostname and certificate.** Remote participants are a backlog item. | The mic needs a secure context; avoids a third party hearing audio. |
| D6 | Part A ships as slices A1a, A1b, A1c, A2, A3 (section 12), dark behind `VOICE_ENABLED`; voice goes live only when the release gate of section 12 is met. | Size; the privacy wording must be complete before a participant sees voice. |
| D7 | (reviewer, accepted) **No change to the session log format.** Audio audit events go to a separate audit log (section 8). | The format lives only in `session.started` and cannot be raised later; nothing can append to an ended log. |
| D8 | (reviewer, accepted) The speech worker is a **child of the control service**, talking to the runtime over the existing parent channel, with no network listener. | Managed runtimes have no `.env` and an OS-picked port (section 4). |

## 3. Non-goals

Text-to-speech and interruption (part B); remote participants and TURN; Teams or Zoom; voice enrolment or any biometric matching (attribution is by track only); cloud speech-to-text; audio compression (Opus, backlog; WAV first); facilitator correction of a mis-heard line and re-transcription (backlog: see section 16, item 2); audio in any report, export or evaluator input; voice chat between participants.

## 4. Architecture

```
browser (https/wss) --mic track--> LiveKit --per-track--> speech worker (child of control) --IPC--> control --parent channel--> runtime (host, log)
   ^ text box always works                                   |  VAD, STT calls, audio store                                         |
                                                            +--> local Whisper server (host, loopback)                             +--> facilitator socket (console)
```

- **Speech worker (new package `services/speech`, one worker per session).** Joins the LiveKit room as a server participant, subscribes **only** to identities named in the current holders list with `recording: yes` (so an unconsented track is never subscribed and never written), segments speech, calls the speech-to-text adapter, writes audio. Native LiveKit code lives here so a native fault costs voice, not the session: the runtime is the single writer of the log with fail-stop rules and must not share a process with it.
- **Channels (no network listener, no shared secret).** A managed runtime runs with `NO_DOTENV=1` and an allowlisted environment (`services/control/src/child-env.ts`) and binds an OS-picked loopback port known only to control and the web server, so a static secret would be shared by every session and readable from a child's environment. So:
  - worker → control: schema-validated IPC messages `voice_line { segmentId, roleId, participantId, text, startMs, endMs }` and `speech_activity { roleId, active }`;
  - control → runtime: a new parent-channel message `voice_line` (a strict object with a drift test, like `protocol.drift.test.ts`; precedent `bot_alert`, `parent-channel.ts:33`); the runtime answers with the recorded `seq`, which control gives to the worker's index (section 8);
  - control → worker: `voice_state { paused, ended, holders: [{ roleId, participantId, recording }] }` on every change of pause, end, seat, reissue or opt-in;
  - the runtime refuses a `voice_line` for an AI role, a non-holder, `recording` other than `yes`, or an unknown role;
  - **the full message set** (resolved in the plan, whose overview holds the exact schemas): runtime → control `voice_seats`, `voice_turn`, `voice_choice`, `voice_line_ack`, `voice_line_refused` and a `voice` field on `ready` (control cannot otherwise know holders, pause, end or choices); control → runtime `speech_activity`, `voice_notice`, `voice_alert`; worker → control `segment_failed`, `worker_ready`; control → worker `voice_line_result`.
  - **Turn timing.** `speech_activity` carries `silentMs` so the host's timer counts from the last speech frame; the worker sends the "speech stopped" edge only after that segment's line or failure has gone out, and the round starts only after every voice line received so far is recorded.
- **Supervision.** The Supervisor today ends a crashed child as `stopped`, restart is manual, and the native Whisper server is not supervised at all. So part A defines: automatic worker restart with bounded exponential backoff (5 tries, base 500 ms, doubling, then a facilitator alert and voice off for the session); segment ids unique across restarts (random, created with `O_EXCL`); the worker never connects to the runtime: control pushes the current `voice_state` after every runtime `ready` and every `voice_seats` change, so a runtime restart on a new port needs nothing from the worker; Whisper health is polled during the session (every 5 s) and drives the "voice unavailable" notice, not only readiness at start.
- **Runtime.** Accepts a voice line only from the parent channel, records it with `channel: "voice"` through a **new host method** (`onPlayerUtterance` hard-codes `"text"`, `session-host.ts:401`), and schedules the NPC round (section 7.5). Voice requires a control-managed runtime (`CONTROL_MANAGED=1`; the runtime refuses `VOICE_ENABLED` otherwise, which also excludes the Alpine compose runtime).
- **Where tokens are minted.** In the **control service** through an adapter in `packages/adapters` (so the LiveKit server SDK stays out of `apps/web`; `scripts/check-sdk-imports.sh` has one package list and one allowed directory today, `:8,13`, so a **second rule** is added: the server SDK only in `packages/adapters`, `@livekit/rtc-node` only in `services/speech`, `livekit-client` only in `apps/web`, with the existing rule left byte-identical). The web server asks control through the existing launcher client.
- **Local Whisper server.** A native host process (whisper.cpp on Metal; Docker on macOS has no GPU), started by `pnpm voice:up` beside the compose services (LiveKit, the certificate proxy), bound to `127.0.0.1`.
- **Interfaces, one job each:** `AudioIngest` (audio frames tagged with a seat identity; LiveKit and file-fed implementations), `SpeechToText`, `Segmenter`, `AudioStore`, `VoiceGate` (consent, pause, mute, holders).
- **Deviations from ARCHITECTURE.md, to be recorded there:** (1) speech runs in a separate worker, not inside the runtime (the diagram's `speech` service is closer to this than section 2's text); (2) audio is stored as local files outside the object-storage adapter, instead of LiveKit egress to object storage. A per-stage OpenTelemetry span (VAD end, STT done, line appended) is emitted for each segment (section 11 of ARCHITECTURE).

## 5. Events and the log

- The log's `utterance` is unchanged except `channel: "voice"` (the type already allows it, `packages/events/src/events.ts:2`). **No new field, no new event type, no new log format.** `viewFor` forwards an utterance whole (`session-host.ts:601`) and the player stream forwards it unchanged (`stream-hub.ts:210`), so a link stored in the event would reach players; therefore the link between a line and its audio lives **only in the audio index** (the runtime's answer to `voice_line` carries the `seq`; section 8).
- Nothing downstream reads `channel` (evaluator, Game Master, reports, player view): verified. Two things do change and are specified in 7.5: when the Game Master judges and when AI-player bots react.
- **Ordering.** The sequence number follows when transcription finished (the engine rule). Lines of one speaker are delivered in segment order (per-track FIFO, 7.3); lines of different speakers can appear out of speech order by up to about the forced-split length plus transcription time (section 7.1). Documented limitation, with a test that shows the bound; `startMs` in the index lets replay show true order.
- Audio events (`audio.played`, `audio.deleted`, opt-in and opt-out) go to a separate **audio audit log**, not the session log (section 8).

## 6. Consent and privacy

- **Notice v3** (`consent/notice-v3.md`, `CONSENT_NOTICE_VERSION=v3`, which `noticeNamesAiPlayers` already accepts) says: voice is converted to text live; the audio is recorded; it is kept until the facilitator deletes it and **deleted automatically the first time the application runs after 30 days** (the sweep needs the application running); only the facilitator can hear it; the participant can ask for deletion; deletion applies to the session folder on the host computer, not to backups (the runbook tells the host to exclude the audio directory); use a headset in a private place, other people nearby may be recorded; and the choice **take part with voice** or **take part by text only**.
- **The choice is a separate record, not a change to the consent file.** The consent file's strict shape and `v: 1` check (`consent.ts:118-120`) would make an older build refuse every session's consent, text-only sessions included. So the choice is held in a separate per-session voice record (`<sessionId>.voice.json`, owner-only, holding `{sessionId, logIdentity}`; named by session id because a failed create deletes exactly `<sessionId>.*`, `supervisor.ts:268-273`), per seat, bound to the **participant id** of the person who chose; an older build ignores the file.
- **Never inherited.** `claimRebind` hands a seat's consent to whoever joins next after a reissue, and the restart seeding (R14) restores roles from `session.started.consents`. Voice is not carried by either: after a reissue, a rebind or a restart, a seat whose recorded participant is not the current holder is `text_only`.
- **Opt-in and opt-out after the start.** `consent` and `withdraw_consent` are refused once the start has begun (`host/protocol.ts:54-57` and `session-host.ts:285`), so voice gets its own player messages: `voice_opt_in` (explicit; allowed any time; the first one needs notice v3 accepted) and `voice_opt_out` (allowed at any time; stops recording at once, the control service removes the LiveKit participant, the worker drops the track). Both are written to the audit log.
- **Late opt-in has a precondition.** A participant whose consent is to a notice that does not name voice cannot accept v3 after the start (consent is refused once the start has begun), so such a seat stays text-only for that session; a voice session needs every voice participant to have accepted notice v3 before the start.
- **What the browser and the runtime see.** `joined.consent` and the roster gain a voice state per seat (`none | voice | text_only | off`); the web consent route, the lobby and the readiness gate carry the choice (`joined.consent` today is only `{noticeVersion, notice, given}`, `host/protocol.ts:79-80`). A player's own frame carries only their own choice.
- Voice is off unless `VOICE_ENABLED=1`; the runtime refuses to start voice without notice v3.
- Audio is voice data: no voice profile, no matching, no use but facilitator replay. Attribution is only from the track identity.

## 7. The live pipeline (speech worker and host)

### 7.1 Segmenter (per track)
Energy-based voice detection; hangover `VOICE_HANGOVER_MS` (default 500, range 300 to **600**); 200 ms lead-in; minimum speech 300 ms; a forced split every `VOICE_MAX_SEGMENT_MS` (default **2500**, range 2000 to 6000) at the quietest point of the last 1 s.
**Lag, defined:** from a word being spoken to its line appearing in the transcript, p95. For the first word of a forced-split segment that is at most the segment length plus transcription and capture, about 2.5 + 0.25 + 0.1 s, which meets the 3 s target; a longer maximum does not (a 6 s maximum gives about 6.5 s). Shorter segments cost some recognition context and add lines; the room test decides the default.
**End of speech to line:** from the worker's voice-detector end to the line being appended to the log (hangover + transcription + the hop through control, a few ms). The 1 s target excludes capture and browser audio processing (30 to 170 ms in the spike) and is stated that way.

### 7.2 Noise gate (phantom text)
Whisper can invent text from silence or noise. Drop a segment on a **signal** test (low energy, Whisper's no-speech score, low average confidence, or a very short segment combined with those). No phrase blocklist: "Thank you." is a common real utterance. **Before the gate is written, check that the chosen `whisper-server` response format returns the no-speech score and the average confidence** (section 16); if not, the gate uses energy and length only. Untested on real rooms: part of the room test.

### 7.3 Speech-to-text adapter
`transcribe(segment) -> { text, durationMs }`; per-call timeout; **retries with exponential backoff, at most 2, base 150 ms, always bounded by the segment's deadline** (the `RetryingModelProvider` pattern; limits recorded in `docs/memory/models-and-providers.md`); a cap on requests in flight and a queue limit protect the GPU. **Lines of one track are delivered in segment order** (per-track FIFO, even when requests finish out of order); only different speakers interleave. A startup warm-up request absorbs the first-call cost (about 0.7 s in the spike's logs). A deterministic normaliser makes numbers, currency and times consistent ("forty-two thousand", "9.30"); the raw text is kept in the index. The adapter has a **contract test suite** that any implementation (fake, local Whisper, a later cloud one) must pass. New error classes are named for the error taxonomy (`SpeechUnavailableError`, `SpeechTimeoutError`, `SpeechRefusedError`).

### 7.4 Failure and refusal
- **Failed or empty segment:** marked `stt_failed` or `empty` in the index; the facilitator gets an alert; **no placeholder line and no invented text** goes to the log.
- **Refused line:** the engine refuses a line when paused, between scenes, for a role not in the scene or after the end (`session-engine.ts:265-277`). The segment is indexed as `refused:<code>`; the audio follows normal retention.
- **Speaker notice:** in both cases the speaker alone gets a private, ephemeral `voice_notice { code }`, a new server message sent to that role's socket only; the web server's stream hub forwards it as a named event (`onFrame` today drops unknown server frames, `stream-hub.ts:222`) and the page announces it in an `aria-live` region. It is never in the log and never shown to others. The console's speaking indicator uses the facilitator hub the same way.

### 7.5 Turn-taking and the consumers of lines
- Today every recorded player line schedules an NPC round, with at most one more waiting (`session-host.ts:406-427`). The host only sees finished lines, so the worker sends **`speech_activity` edges** (`active` true or false per role); the host keeps **one debounce timer on an injected clock** and schedules the round only after `TURN_END_MS` (default **800**) with no active speech on any human track, measured from the last speech frame. New speech resets it. A text line cancels the pending timer and schedules at once. Pause and end clear it. A running round is not interrupted (part B). The "at most one waiting" rule stays.
- **Game Master cadence.** The Game Master judges after every 3 new utterances (`agents/gm-config.ts:5`). Voice segments split at pauses and every 2.5 s, so it would judge two to three times as often, mid-thought, and a true `gm_detects` ends the scene. So the cadence counts **voice turns** (a turn = the lines up to a `TURN_END_MS` pause), not segments. The Game Master is ticked about once a second and counts every utterance (`game-master.ts:81,95-96`; restore uses the same count, `session-host.ts:315`), so: a closed voice turn counts as one, no evaluation runs while a turn is open, and restore applies the same count (after a restart, consecutive voice lines count as one turn).
- **AI-player bots** react to every line (`services/control/src/bots/bot.ts:288-299`); they too wake once per voice turn. Bots never see `channel` today (`bot-frames.ts:10`) and their hold flag belongs to prompt reservations, so they take the runtime's `voice_turn` message and a separate hold flag.
- The Game Master's 40-line window covers less conversation per line; recorded in the threat model's existing residual-risk note (US-0019). Tests for all three.

### 7.6 Pause, resume, end, seat changes
While paused the worker ignores the tracks (no transcription, no recording), matching the engine. Resume restores both. A removed or reissued seat's LiveKit participant is removed (`removeParticipant`; LiveKit tokens cannot be revoked, section 9). At session end the worker flushes open segments, then closes.

### 7.7 Capacity and health
Finals are never dropped; partials (A3) stop first when the queue grows. Capacity figures are from the spike's two-speaker runs; **4 talkers on the small model and 8 speakers are extrapolated, not measured** and are covered by a 4-to-8 talker load check in the room test.

### 7.8 Live partial transcripts (A3)
Facilitator socket only, never in the log, about every 700 ms on talking tracks only, skipping a tick while the previous request runs.

## 8. The audio store and the audit log (A2)

- **Directory:** `<audio root>/<logIdentity>/<role>/`, keyed by the log's 32-hex identity, **not the session id** (a terminal runtime defaults to `SESSION_ID=local` and rotates ended logs aside; control can start fresh on an old id). Directories `0700`, files `0600`, created exclusively without following symlinks (the join-code file pattern). **Segment ids are generated by the server, match `FILE_SAFE_ID_PATTERN`, and are validated before any path join.**
- **Format:** 16 kHz mono WAV (about 115 MB per speaker-hour; about 0.9 GB for 8 speakers over an hour); Opus is a backlog item.
- **Index:** one small index file per role: segment id, `participantId`, `startMs` and `endMs` (wall-clock milliseconds from an injected clock), status (`transcribed | empty | stt_failed | refused:<code>`), the log `seq` once the runtime answers, raw text, stage timings. Audio that never became a line is still replayable and expirable.
- **One writer per session directory**, enforced with a lock file (the `SessionLock` pattern). Replay may read at any time; delete and the sweep skip a directory whose worker is live (or go through it); the sweep never touches a session with a live worker. Writes happen in the worker; delete and expiry in the control service.
- **Write order:** audio file, then index entry, then (separately, by control) the `seq` back-fill; a crash leaves at most an orphan file, which the sweep removes.
- **Disk:** recording stops when free space falls below `AUDIO_MIN_FREE_MB` (default 2048), **before the log is at risk** (the audio sits on the same volume and a full disk halts the session by the log's fail-stop rule). The facilitator is alerted; the transcript continues. A write error stops recording the same way.
- **Retention.** The sweep runs **in the control service** (runtimes are per session and exit), at start-up and hourly. The clock starts at session end, or at the last recorded activity plus 24 hours when the session never ended; file times are the backstop. Anything older than `AUDIO_MAX_RETENTION_DAYS` (default 30) is deleted and recorded in the audit log. Because the sweep needs the application, the notice wording is "deleted automatically the first time the application runs after 30 days".
- **Deletion:** the facilitator deletes a session's audio, one role's, or **one participant's** (an index entry carries `participantId`, so after a reissue one role can hold two people's audio and a participant's request deletes only theirs). Deleting audio never changes the transcript; a deleted segment shows as "audio deleted".
- **Audit log (mandatory).** `<logIdentity>.audio-audit.jsonl` beside the audio, append-only, written only by the control service under its own lock, owner-only. Events: `audio.played { role, segment, by }` (the fact only, no content; **required**, PRODUCT_SPEC ADM-04 (Must) and ARCHITECTURE section 8 require an audit of who heard recordings), `audio.deleted { scope, reason: facilitator | expired | participant_request, by }`, `voice.opted_in`, `voice.opted_out`, `voice.recording_stopped { reason }`. The session log and `LOG_FORMAT` are unchanged, and the review log's seal of the session log (`logSha256`) is untouched.
- **Access:** replay only through the control service behind facilitator login (`no-store`, range requests), every replay audited. Participants, the evaluator and the AI characters never receive audio.

## 9. Security

- **LiveKit hardening.** Never `--dev` keys. `pnpm voice:up` generates a real key and secret into `.env` (never committed, never logged). **The grant:** time to live at most 10 minutes; `canSubscribe: false`, `canPublishData: false`, `canUpdateOwnMetadata: false`, `canPublishSources: [microphone]`; room names unguessable; identity = role id plus a **seat generation**, so a reissue gets a new identity; removal through LiveKit's `removeParticipant` (a JWT cannot be revoked); the worker subscribes only to current holders. In part B only NPC bot tracks become subscribable.
- **No network listener** for the worker (section 4); the worker reaches Whisper on loopback. **`whisper-server` 1.9.5 has no authentication option** (read from `--help`; its binary also shows CORS header strings and a `/load` endpoint, inferred from strings and not run). Hardening: loopback bind, a random port and an unguessable `--request-path` chosen by `voice:up`, never `--convert`, and a threat-model entry for a same-host browser or process reaching it.
- **Secrets.** The LiveKit key and secret and any DNS token live only in `.env`, are redacted like the model keys, are added to `.env.example`, and reach a child only through `CHILD_ENV_ALLOWLIST` where needed. The LiveKit container gets only its own keys, not `env_file: ../../.env` (the compose pattern).
- **Endpoints.** Replay and delete are facilitator-only, rate-limited and throttled on failures like the existing console routes.
- **Network (access mode A).** LiveKit signalling is `wss` behind the same certificate (a Caddy route). The pilot hostname must resolve to the laptop's private LAN address; some routers refuse such public DNS answers (DNS-rebinding protection), so the runbook lists it. LiveKit's `node_ip` must be the host's LAN address under Docker Desktop (the spike's TCP result was same-machine only). The web server must be **loopback-only behind Caddy with `TRUST_PROXY`**, or LAN clients can bypass the proxy and spoof `X-Forwarded-For` to dodge the per-address throttles (THREAT_MODEL, "Client address, TRUST_PROXY").
- **Threat model.** A new section covers the audio directory, the token path, the worker channels, the replay endpoint, the audit log and the retention job.
- **Dependencies.** Native and provider libraries are added only inside `packages/adapters` or `services/speech`, pinned exactly and recorded in `findings.md` (AGENTS.md section 19).

## 10. Interface

**Participant.** The microphone is never live on page load. "Join with voice" asks for browser permission after the voice opt-in; the text box stays beside it. The lobby **mic check** (A1b) shows a level meter, asks the person to speak, and gives headset guidance. A mute button really stops publishing and the worker also ignores the track. Mic state is always visible in words and an icon (never colour alone), operable by keyboard; `voice_notice` messages are announced in an `aria-live` region. The live transcript already shows everyone's lines, so a deaf or hard-of-hearing participant has the same information as text. Optional push-to-talk (A3) for shared rooms.

**Facilitator console.** A1b: a speaking indicator per seat and alerts for speech-server or worker problems. A2: audio status, replay, delete (session, role, participant). A3: live partials and "mute this participant".

## 11. Operations

- `pnpm voice:up` starts the native Whisper server, then the compose services (LiveKit, the certificate proxy); `pnpm voice:check` reports Whisper health, LiveKit reachability, the certificate and its days to expiry, the hostname's resolution, and the free disk against `AUDIO_MIN_FREE_MB`.
- **Hostname and certificate.** Participants open `https://<pilot hostname>` on the LAN. Two ways to a trusted certificate: an **owner-supplied certificate** (simple path), or Caddy issuing one automatically through a DNS challenge (needs a DNS provider token, another secret; certificates last 90 days and a laptop that is off misses renewals, so `voice:check` warns). Needs a domain: tied to US-0048.
- Docker Desktop on macOS routed WebRTC media over TCP only in the spike (UDP never connected) and the native LiveKit binary failed to connect (probably the macOS firewall, not diagnosed). The runbook records both and the TCP fallback; a real LAN check is part of the room test.
- **Settings** (added to `docs/memory/models-and-providers.md`, `.env.example` and, where a child needs them, `CHILD_ENV_ALLOWLIST`): `VOICE_ENABLED` (0), `VOICE_HANGOVER_MS` (500), `TURN_END_MS` (800), `VOICE_MAX_SEGMENT_MS` (2500), `STT_URL`, `STT_MODEL`, `AUDIO_MAX_RETENTION_DAYS` (30), `AUDIO_MIN_FREE_MB` (2048), `LIVEKIT_URL`, and the secrets above in `.env` only.

## 12. Slices, proposed stories and acceptance direction

Story ids are assigned when the plan files them (next free US-0070 at the time of writing; not reserved). Each slice is dark behind `VOICE_ENABLED` until the release gate.

- **A1a (proposed US-0070): the pipeline on file ingest, with the runtime half of the voice choice.** Moved here from A1b (contradiction C1: the runtime decides whether a seat records from the voice record, so without it every voice line would be refused and the demo would show nothing, and a control-forked runtime loads its notice only from `<repo>/consent`, `main.ts:118`): the voice record file, `voice_opt_in` and `voice_opt_out` in the runtime, the refusals, and a draft `consent/notice-v3.md`. Also: `services/speech` skeleton, the worker IPC and parent-channel messages (with drift tests), the segmenter, noise gate, speech-to-text adapter with its contract tests and the local Whisper client, the normaliser, voice lines through the new host method, per-track FIFO, `speech_activity` and the turn-taking timer, the Game Master and bot cadence by voice turn, refusals and the failure paths, `pnpm demo --voice` on file ingest and a fake adapter.
- **A1b (proposed US-0071): LiveKit and the web consent flow.** The LiveKit `AudioIngest` and token adapter, the control token route, the grant, seat generations and `removeParticipant`, the final consent notice v3 wording, the web consent route and lobby, the lobby mic check, mute, `voice_notice`, the console speaking indicator, worker supervision and Whisper health polling.
- **A1c (proposed US-0072): operations.** `pnpm voice:up` and `voice:check`, the compose services and certificate path, loopback-only web server behind the proxy, the runbook, threat-model section, `.env.example`, ROLLBACK, ARCHITECTURE deviation notes.
- **A2 (proposed US-0073): audio retention.** The audio store, index, lock, disk guard, the sweep in control, replay, delete (session, role, participant), the audit log, the console additions.
- **A3 (proposed US-0074): facilitator voice tools.** Live partials, mute participant, push-to-talk option, capacity switch-off.
- **Release gate:** voice is enabled for a pilot only when A1a to A2 are complete, the room test passes, and legal and HR have signed off the notice (section 14, item 7).
- **Acceptance direction (made precise in the plan):** end of speech to line (worker voice-detector end to log append) at or below 1 s at p95 with a 500 ms hangover; word-to-line lag at or below 3 s at p95 on the room test; fewer than 2% of segments attributed to a person who did not speak them (room test, measured with different, labelled lines per person); a text-only seat: no token issued, no LiveKit subscription, no file written, no index entry (a test with an unconsented published track proves it); retention, delete, the cap and the disk guard proven with fake clocks and a fake disk; a worker crash leaves the session running and the worker restarts with bounded backoff; an opt-out stops recording at once.

## 13. Testing

- Pipeline tests use the file-fed `AudioIngest`, a fake `SpeechToText` and fake clocks: no real-time sleeps and no absolute time assertions (AGENTS.md section 8). Segmenter tests use deterministic synthetic signals.
- `pnpm demo --voice` runs the pipeline in CI with file ingest and the fake adapter; a real Whisper run is an opt-in live check like the live model runs.
- Linux container run for the filesystem, lock and process tests (the audio store, worker supervision), per the AGENTS.md recipe.
- Security tests: no token without consent; a player token cannot subscribe; the replay endpoint refuses non-facilitators and audits every replay; permissions of the audio directory and files; a path never leaves the session directory; a segment id with separators is refused; consent is not inherited across a reissue, a rebind or a restart; a runtime refuses a `voice_line` for an AI role or a non-holder.
- **Room test (owner-run, before the pilot):** two or more real people with laptop microphones, with and without headsets, **each reading different, labelled lines** (identical scripts cannot show misattribution); measurement points are the worker's voice-detector end and the log append; Whisper and a generating local model running at once (GPU contention); a 4-to-8 talker load check (synthetic extra tracks are fine); the phantom-text rate in a quiet and a noisy room. About 30 minutes of two people's time plus a script I prepare.
- Drift tests for the new parent-channel messages and `voice_notice`; a test that a `voice`-related field never reaches a player frame (the link is only in the index).

## 14. Risks and open items

1. **Same-room cross-talk** (the largest): each microphone hears the others, so a line can be logged against the wrong person. Mitigations: headsets, the mic check, browser echo and noise processing on (about 70 ms), optional push-to-talk, and the room test. Later: suppress a segment when a louder matching signal is on another track.
2. **Phantom text** from noise (7.2): untested on real rooms.
3. **GPU contention** between Whisper and the local NPC model (the spike ran Whisper alone). My notes record a first token of 32 to 95 s for a local reasoning model earlier in the project; that figure is old and not re-measured. The NPC latency targets need a fast model (matters most for part B).
4. **UDP and firewall** on a real LAN (Docker fell back to TCP; the native LiveKit binary failed on this Mac); DNS-rebinding protection on routers.
5. **A domain and a certificate** are prerequisites (US-0048); renewals on a laptop.
6. **Accuracy on real accents and rooms** is unmeasured; the spike's word error rate (about 0.4 to 2.5%) is a best case from synthetic voices, and the large model was not more accurate than the small one on that data.
7. **Legal and HR sign-off** on voice recording and the notice wording is open in the product spec.
8. **Disk use** about 0.9 GB per hour for 8 speakers in WAV, guarded by `AUDIO_MIN_FREE_MB`.
9. **Browser coverage:** the spike used Chromium only; Safari and mobile browsers are untested.
10. **Bystander privacy** in shared rooms (notice wording; headsets).
11. **Out-of-order lines** up to about the segment length plus transcription time (section 5).
12. **Worker, Whisper and LiveKit are three new moving parts** that can each fail; the failure paths and the "voice unavailable" fallback to text are specified, and the facilitator can always continue by text.

**Verify when the plan is written** (read-only checks, not decisions): that `whisper-server` returns the no-speech score and average confidence and whether it has any authentication; how an older runtime treats the new parent-channel messages (it should ignore or refuse them cleanly); the web consent route, lobby, roster and readiness fields for the voice state; Safari support for the microphone and the LiveKit client; whether `lint:sdk` can be extended to the LiveKit packages without touching other rules.

## 15. Rollback

Turn voice off with `VOICE_ENABLED=0`; the text path is untouched. There is **no change to the log format or the consent file**, so any earlier build still reads every log and consent record; an earlier build ignores the voice record, the audio directories and the audit log (plain files that can be deleted by hand). Rolling back control while a worker runs stops voice for that session. Notes for `docs/ROLLBACK.md` are written with each slice.

## 16. Decisions and deviations for the owner to confirm

1. **Participant access to their own audio.** PRODUCT_SPEC section 10 says participants can view their own data; notice v3 says only the facilitator hears the audio. Part A follows the notice (facilitator only); a participant who wants their audio asks the facilitator. Confirm or change.
2. **REC-07 facilitator correction of speaker attribution** (a Must row) is deferred out of part A, together with re-transcription and the `utterance.revised` event, because correcting a line touches the evaluator's quote check and the amend flow. Recorded as a deviation; a follow-up story is proposed.
3. The audio audit log (D7) and the mandatory `audio.played` (ADM-04) are no longer optional.

4. **Slicing (C1).** Recommended and adopted in Draft 3: the runtime half of the voice choice moves into A1a. The alternative is a test-only gate in A1a with no voice line reaching a real session before A1b.

**Open questions from the planning pass (recommended defaults in parentheses; confirm or change):** (1) speaker notice for an **empty** segment (no: only failures and refusals); (2) a line in flight during a **reconnect** is refused as `not_holder` because a seat's holder is released when its socket closes (accept); (3) `TURN_END_MS` range (300 to 3000); (4) whisper-server hardening level (the section 9 list); (5) meaning of `STT_MODEL` (a label plus the model file `voice:up` starts with); (6) **normaliser rules** for numbers, currency and times, which affect evaluator quotes because quotes must match the logged text (conservative: digits for numbers, no rewriting of words); (7) the GPU in-flight cap per worker or global (global, held by control); (8) the audio-store lock (copy the `SessionLock` pattern into `services/speech`; control cannot import it); (9) legal and HR sign-off on notice v3, and a domain and certificate (US-0048).

**Owner answers (2026-11-08):** item 1 (own audio, facilitator only) per the reply "see above", read by the agent as "keep what is written above"; item 2 (REC-07 correction deferred) ok; item 4 (slicing, runtime half of the voice choice in A1a) ok; the smaller defaults above (empty segment: no notice; reconnect: `not_holder`; `TURN_END_MS` 300 to 3000; whisper-server hardening; global GPU cap; `SessionLock` copied into `services/speech`; `STT_MODEL` as label plus file) agreed as recommended. **Still open:** the normaliser rules (section 7.3; the owner asked for an explanation). The legal, HR, domain and certificate items moved to the go-live checklist in `docs/memory/backlog-and-decisions.md`.

## Appendix A: spike results (2026-11-08, throwaway, not in the repository)

Setup: Apple M5 Pro (64 GB), LiveKit 1.13.11 in Docker (`--dev`), two headless Chromium publishers fed WAV files (macOS `say` voices alice and bob, 8 business sentences, 16-sentence 95 s clips and a 76 s overlapping pair), a Node listener (`@livekit/rtc-node` 1.2.1) reading each track as 16 kHz mono, an energy voice detector (the spike used a 15 s maximum segment), and a resident `whisper-server` (whisper.cpp on Metal). 14 runs, 219 segments (141 on the large model, 78 on the small).

| Measure | small.en | large-v3-turbo-q5_0 |
| --- | --- | --- |
| STT per segment, p50 / p95 | 130 / 153 ms | 229 / 252 ms |
| End of speech to text at 500 ms hangover, p50 / p95 | 630 / 654 ms | 730 / 752 ms |
| Same at 300 ms / 800 ms hangover (p95) | 446 / 1009 ms | 570 / 1085 ms |
| Word error rate (clean synthetic speech) | 0.4 to 2.5% | 0.8 to 2.5% |
| Partials every 700 ms, p95 (measured) | 2 talkers: 233 ms (35% GPU busy) | 1 talker: 237 ms (26%); 2 talkers: 439 ms (73%) |

Attribution: 0 wrong out of 112 two-speaker segments, including simultaneous speech (digitally separate fake devices only). Capture plus transport about 30 to 100 ms raw, plus about 70 ms from browser echo and noise processing. CPU: Whisper about 1%, both Chromium pages 5 to 13%, listener 4 to 6%, LiveKit 2 to 4% (average). Findings: 300 ms hangover split sentences at commas; 800 ms merged sentences and is over the 1 s target (hence the 600 ms cap); 500 ms matched the sentences exactly. Media connected over TCP 7881 only; the native `brew` LiveKit binary failed to connect (not diagnosed). **Not measured:** real voices, noisy rooms, acoustic cross-talk, GPU load from a generating LLM, packet loss or a real network, Safari or mobile browsers, direct GPU utilisation, more than two talkers, shorter forced-split segments, the first-call warm-up cost as a separate figure.

The probe scripts are in the session's scratch directory and are not committed; the numbers above are the record.
