# EPIC-0003 voice, part A: voice into the transcript — design

> Status: DRAFT for owner review (2026-11-08). Epic: EPIC-0003 (Planned, MVP). Brainstormed with the owner on 2026-11-08; every decision in section 2 was taken by the owner in that session. No story ids are reserved yet; the proposed stories (section 12) are filed when the plan is written.
> Product basis: `docs/PRODUCT_SPEC.md` (RUN-01, RUN-02, REC-07, the latency row, the 2026-10-01 decision that the MVP is voice-enabled); `docs/ARCHITECTURE.md` sections 3 and 4.

## 1. Purpose and scope

The product is text-only today: every `utterance` event comes from a typed line or an AI character's reply. EPIC-0003 adds voice. It is too large for one design, so it is split:

| Part | What | Status |
| --- | --- | --- |
| **A (this spec)** | Voice **into the transcript**: a participant speaks, the runtime transcribes it per participant, the line enters the log as an ordinary `utterance` with `channel: "voice"`. Audio is retained for facilitator replay. AI characters still answer in text. | this spec |
| B | Voice **out**: text-to-speech for AI characters, interruption, masking latency | later |
| C | Latency instrumentation as a product feature, remote participants (tunnels, TURN) | later (remote access is a backlog item, section 3) |

Part A is **not** voice chat between participants. In the pilot's single room people hear each other directly; the runtime only listens.

**Success looks like:** in a real room, with two or more people on laptop microphones and headsets, what each person says appears under their name in the transcript within the latency targets, the Game Master, evaluator and reports treat it exactly like typed lines, text-only participants are unaffected, and audio is kept, replayable by the facilitator, and deleted on schedule or on request.

## 2. Decisions (owner, 2026-11-08)

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Spike first, then part A. The spike ran and answered yes (appendix A). | Latency was unmeasured. |
| D2 | **LiveKit rooms** (ARCHITECTURE section 3), built behind an `AudioIngest` interface with a file-fed implementation. | Part B needs outbound tracks and mixing; the seam gives deterministic tests. |
| D3 | **Speech-to-text is local-first behind an adapter.** Default: Whisper on the host. A cloud provider is a later drop-in. | "Runs on a laptop, nothing leaves the machine"; no speech keys exist. |
| D4 | **Audio is retained** (not transcript-only), until the facilitator deletes it, with a hard cap `AUDIO_MAX_RETENTION_DAYS` (default 30). | Owner choice B/C: replay and correction value. |
| D5 | **Access mode: everyone on one LAN with a real hostname and certificate.** Remote participants (tunnel plus TURN, or hosted LiveKit) are a backlog item. | Mic needs a secure context; avoids a third party hearing audio. |
| D6 | Part A ships as slices A1 to A3 (section 12), dark behind `VOICE_ENABLED`; voice goes live only when A1, A2 and the mic check are done. | Size; privacy wording must be complete before any participant sees voice. |

## 3. Non-goals

Text-to-speech and interruption (part B); remote participants and TURN; Teams or Zoom; voice enrolment or any biometric matching (attribution is by track only); cloud speech-to-text (the adapter allows it later); audio compression (Opus; WAV first); facilitator correction of a mis-heard line and re-transcription (deferred out of A2 because it touches the evaluator's quote check and the amend flow; backlog); audio in any report, export or evaluator input.

## 4. Architecture

```
browser (https/wss) --mic track--> LiveKit server --per-track--> speech worker --final lines--> runtime (session host, log)
   ^ text box always available                          |  VAD, STT calls, audio store             |
                                                        +-- local Whisper server (host, GPU)       +--> console (facilitator socket)
```

- **Speech worker (new process, `services/speech`).** Joins the LiveKit room as a server participant, subscribes to each human track separately, segments speech, calls the speech-to-text adapter, writes audio, and sends each final line to the runtime over a local authenticated channel (loopback, shared secret in `.env`, never logged). Native LiveKit code lives here so a native fault costs voice for a moment, not the session: the runtime is the single writer of the event log with fail-stop rules and must not share a process with it. The control service supervises the worker the way it supervises runtimes. Provider libraries stay inside `packages/adapters` (`pnpm lint:sdk`).
- **Runtime.** Accepts a voice line only from the speech worker, for a seated human role whose seat consented to voice, records it with `channel: "voice"`, and schedules the NPC round (section 7.5). Everything downstream (Game Master, evaluator, reports, replay, `viewFor`) is unchanged.
- **Web server (BFF).** Mints per-seat LiveKit tokens after the consent gate (section 9) and carries the facilitator's replay and delete calls. The browser never talks to the speech worker.
- **Local Whisper server.** A native host process (whisper.cpp on Metal). It cannot run in Docker on macOS (no GPU), so `pnpm voice:up` starts it beside the compose services (LiveKit, the certificate proxy).
- **Interfaces, one job each:** `AudioIngest` (audio frames tagged with a seat identity; implementations: LiveKit, file-fed), `SpeechToText` (segment in, text out; default local Whisper HTTP), `Segmenter` (voice detection and cutting), `AudioStore` (write, index, replay, delete, expire), `VoiceGate` (consent, pause, mute). Each is testable alone.

## 5. Events and the log

- **A1.** `utterance` is unchanged except `channel: "voice"` (the `Channel` type already allows it, `packages/events/src/events.ts:2`) and an optional facilitator-only link `voice: { segment, startMs, endMs }`. The player view is default-deny, so players get the text and never the link. No new log format is needed while no new event type ships.
- **A2.** New facilitator-only events `audio.deleted` (`{ role | session, reason: facilitator | expired | participant_request, by }`) and `audio.played` (`{ role, segment, by }`; the fact only, no content; optional, see section 14, item 4) require **log format 4**. A build that predates it must refuse a format-4 log; this refusal is verified when the plan is written (section 13) and stated in `docs/ROLLBACK.md`.
- Ordering: the sequence number follows when transcription finished (the engine rule). Segments of different speakers can therefore appear up to about 6.5 s out of speech order (the forced-split length plus transcription time). This is a documented limitation with a test that shows the bound; `startMs` lets replay show true order.

## 6. Consent and privacy

- **Notice v3** (a new `consent/notice-v3.md`, `CONSENT_NOTICE_VERSION=v3`) says: voice is converted to text live; the audio is recorded and kept until the facilitator deletes it and in any case no longer than 30 days; only the facilitator can hear it; the participant can ask for deletion; deletion applies to the session folder on the host computer, **not to backups** (the runbook tells the host to exclude the audio directory from backups); use a headset in a private place, because other people nearby may be recorded (bystanders did not consent); and the choice **take part with voice** or **take part by text only**.
- **Per-seat choice.** The consent record gains `recording: "yes" | "text_only"`. Its strict shape (`entries, scenarioSha256, sessionId, v`) means a new record version with older versions refused. A token is issued only for `"yes"`. A text-only participant has the same session in every other respect.
- Voice is off unless `VOICE_ENABLED=1`, and the runtime refuses to start voice without notice v3.
- Audio is voice data. No voice profile, no speaker matching, no use for anything but facilitator replay. Attribution comes only from the track identity.

## 7. The live pipeline (speech worker)

### 7.1 Segmenter (per track)
Energy-based voice detection; hangover `VOICE_HANGOVER_MS` (default 500, 300 to 800); 200 ms lead-in; minimum speech 300 ms; a forced split every `VOICE_MAX_SEGMENT_MS` (default 6000) at the quietest point of the last 1.5 s, so the 3 s transcript-lag target holds for long speech. The spike used a 15 s maximum and clean synthetic speech; both change here.

### 7.2 Noise gate (phantom text)
Whisper can invent text from silence or noise. Drop a segment on a **signal** test (low energy, Whisper's no-speech score, low average confidence, or a very short segment combined with those). There is **no phrase blocklist**: "Thank you." is a common real utterance. Passing text is kept as is. This is untested on real rooms and is part of the room test (section 14).

### 7.3 Speech-to-text adapter
`transcribe(segment) -> { text, durationMs }`; per-call timeout and one bounded retry (the `RetryingModelProvider` pattern); a cap on requests in flight and a queue limit protect the GPU; a startup warm-up request absorbs the 0.7 s first-call cost. A deterministic normaliser makes numbers, currency and times consistent ("forty-two thousand", "9.30"); the raw text is kept in the audio index.

### 7.4 Failure
A failed or empty segment is marked `stt_failed` or `empty` in the audio index; the facilitator gets an alert; **no placeholder line and no invented text** goes to the log. The speaker alone gets a private, ephemeral message "that wasn't picked up, you can type it" (never in the log, invisible to others; a small addition to the player socket's allowlist, to verify at plan time).

### 7.5 Turn-taking (in the session host)
Today every recorded player line schedules an NPC round, with at most one more waiting (`services/runtime/src/host/session-host.ts:406`). Speech arrives as several segments per thought, so a voice line schedules its round only after `TURN_END_MS` (default 800) with no speech on any human track, measured from the last speech frame; new speech resets the wait. Text lines keep immediate behaviour. A running round is not interrupted (part B). The "at most one waiting" rule stays.

### 7.6 Pause, resume, end, removal
While a session is paused the worker ignores the tracks (no transcription, no recording), matching how the engine refuses lines when paused. Resume restores both. A removed seat's track is unsubscribed and its token revoked. At session end the worker flushes open segments, then closes.

### 7.7 Capacity and health
Finals are never dropped; live partials (A3) stop first when the queue grows and switch off beyond 2 talkers on the large model or 4 on the small model (spike, appendix A). The speech server's health is part of readiness: if it is down the session can start as text-only with a visible "voice unavailable" notice.

### 7.8 Live partial transcripts (A3)
Facilitator socket only, never in the log, about every 700 ms on talking tracks only, skipping a tick while the previous request runs.

## 8. The audio store (A2)

- **Layout:** one file per segment, under a directory per session and role next to the session log; directories `0700`, files `0600`, created exclusively without following symlinks (the pattern of the join-code file). 16 kHz mono WAV (about 115 MB per speaker-hour; about 0.9 GB for 8 speakers over an hour); Opus is a backlog item.
- **Index:** a small index file per role (segment id, start and end, status `transcribed | empty | stt_failed`, raw text, stage timings), so audio that never became a transcript line is still replayable and expirable. The event log stays lean.
- **Write order:** audio file first, then the index entry, then the log event; a crash leaves at most an orphan file, which the sweep removes.
- **Disk full:** recording stops, the facilitator is alerted in the console, the session and the transcript continue. This is the opposite of the log's fail-stop rule on purpose: audio is secondary to the log, and stopping recording is the privacy-safe direction.
- **Retention:** the clock starts at session end, or at the last recorded activity plus 24 hours when the session never ended; file times are the backstop. A sweep runs at start-up and hourly and deletes anything older than `AUDIO_MAX_RETENTION_DAYS` (default 30), logging `audio.deleted`.
- **Deletion:** the facilitator deletes a session's audio or one role's at any time; a participant's request is carried out by the facilitator for that role; deleting audio never changes the transcript, and a deleted segment shows as "audio deleted".
- **Access:** replay only through the control service behind facilitator login (`no-store`, range requests). Participants, the evaluator and the AI characters never receive audio.

## 9. Security

- **LiveKit hardening.** Never `--dev` keys. `pnpm voice:up` generates a real key and secret into `.env` (never committed, never logged). Tokens are short-lived, room names unguessable, identity is the seat. **Players get publish-only tokens**: no subscribe permission, so one player cannot listen to another's track; in part B only NPC bot tracks become subscribable.
- **Local channels.** Worker to runtime and runtime to Whisper are loopback-only with a shared secret; the Whisper server binds `127.0.0.1`.
- **Secrets.** LiveKit key and secret, the worker secret and any DNS token live only in `.env` and are redacted like the model keys.
- **Endpoints.** Replay and delete are facilitator-only, rate-limited, throttled on failures like the existing console routes. A threat-model section covers the audio directory, the token path, the replay endpoint and the retention job.
- **Dependency rule.** Native and provider libraries are added only inside `packages/adapters` or `services/speech`, pinned exactly and recorded in `findings.md` (AGENTS.md section 19).

## 10. Interface

**Participant.** The microphone is never live on page load. "Join with voice" asks for browser permission; the text box stays beside it. A lobby mic check (A1) shows a level meter, asks the person to speak, and gives headset guidance. A mute button really stops publishing and the worker also ignores the track. Mic state is always visible in words and an icon (never colour alone) and operable by keyboard. The live transcript already shows everyone's lines, so a deaf or hard-of-hearing participant has the same information as text. Optional per-participant push-to-talk (A3) for shared rooms.

**Facilitator console.** A1: a speaking indicator per seat and alerts for speech-server or worker problems. A2: audio status, replay, delete session or role. A3: live partial transcripts and "mute this participant".

## 11. Operations

- `pnpm voice:up` starts the native Whisper server, then the compose services (LiveKit, the certificate proxy); `pnpm voice:check` reports Whisper health, LiveKit reachability, the certificate and days until it expires, and the room check's pre-flight items.
- **Hostname and certificate.** Participants open `https://<pilot hostname>` on the LAN. Two ways to get a trusted certificate: an **owner-supplied certificate** (simple path) or Caddy issuing one automatically through a DNS challenge (needs a DNS provider token, another secret; certificates last 90 days and a laptop that is off misses renewals, so `voice:check` warns). Needs a domain: tied to US-0048.
- Docker Desktop on macOS routes WebRTC media over TCP (the spike's UDP never connected) and the native LiveKit binary was blocked, probably by the macOS firewall. The runbook documents both and the TCP fallback; a real LAN check is part of the room test.
- **Settings** (added to `docs/memory/models-and-providers.md`): `VOICE_ENABLED` (0), `VOICE_HANGOVER_MS` (500), `TURN_END_MS` (800), `VOICE_MAX_SEGMENT_MS` (6000), `STT_URL`, `STT_MODEL`, `AUDIO_MAX_RETENTION_DAYS` (30), `LIVEKIT_URL`, plus the secrets above in `.env` only.

## 12. Slices, proposed stories and acceptance direction

Story ids are assigned when the plan files them (next free US-0070 at the time of writing; not reserved).

- **A1 (proposed US-0070): the pipeline.** Speech worker, LiveKit tokens and per-seat consent v3 gate, segmenter, noise gate, local Whisper adapter, normaliser, voice `utterance`, turn-taking, "not picked up" notice, lobby mic check, `pnpm voice:up`/`check`, `pnpm demo --voice`. Dark behind `VOICE_ENABLED`.
- **A2 (proposed US-0071): audio retention.** Audio store and index, retention clock and sweep, replay and delete in the console, `audio.deleted` and `audio.played`, log format 4, consent wording for retention, disk-full behaviour.
- **A3 (proposed US-0072): facilitator voice tools.** Live partials, mute participant, push-to-talk option, capacity switch-off.
- **Release gate:** voice is enabled for a pilot only when A1, A2 and the mic check are complete, the room test passes, and legal and HR have signed off the notice (section 14).
- **Acceptance direction (made precise in the plan):** end of speech to final text at or below 1 s at p95 and transcript lag under 3 s on the room test; fewer than 2% of segments containing another speaker's words as their main content in the room test; a text-only seat has an identical experience; retention, delete and the cap are proven by tests with fake clocks; a speech-worker crash leaves the session running; an unconsented seat can never obtain a token.

## 13. Testing

- Pipeline tests use the file-fed `AudioIngest`, a fake `SpeechToText`, and fake clocks: no real-time sleeps and no absolute time assertions (AGENTS.md section 8). Segmenter tests use deterministic synthetic signals.
- `pnpm demo --voice` runs the pipeline in CI with file ingest and the fake adapter; a real Whisper run is an opt-in live check like the live model runs.
- Linux container run for the filesystem, lock and process tests (the audio store, the worker supervision), per the AGENTS.md recipe.
- Security tests: no token without consent; a player token cannot subscribe; the replay endpoint refuses non-facilitators; permissions of the audio directory and files; a path never leaves the session directory.
- **Room test (owner-run, before the pilot):** two or more real people with laptop microphones, with and without headsets, reading the same script; plus Whisper and a generating local model running at once (GPU contention); measuring the section 12 numbers and the phantom-text rate in a quiet and a noisy room. About 15 minutes of two people's time.

## 14. Risks and open items

1. **Same-room cross-talk** (the largest): each microphone hears the others, so a line can be logged against the wrong person. Mitigations: headsets, the mic check, browser echo and noise processing on (about 70 ms), optional push-to-talk, and the room test. Later: suppress a segment when a louder matching signal is on another track.
2. **Phantom text** from noise (section 7.2): untested on real rooms.
3. **GPU contention** between Whisper and the local NPC model (the spike ran Whisper alone). My notes record a first token of 32 to 95 s for a local reasoning model earlier in the project; that figure is old and not re-measured. The NPC latency targets need a fast model (matters most for part B).
4. **Replay audit (`audio.played`)** is my addition, not an owner request, and is deliberately unlike the evaluator docs (viewing a report is not audited). It is the easiest item to cut.
5. **UDP and firewall** on a real LAN (Docker fell back to TCP; the native LiveKit binary failed on this Mac).
6. **A domain and a certificate** are prerequisites (US-0048); renewals on a laptop.
7. **Legal and HR sign-off** on voice recording and the notice wording is open in the product spec.
8. **Accuracy on real accents and rooms** is unmeasured; the spike's word error rate (about 0.4 to 2.5%) is a best case from synthetic voices, and the large model was not more accurate than the small one on that data.
9. **Disk use** about 0.9 GB per hour for 8 speakers in WAV.
10. **Browser coverage:** the spike used Chromium only; Safari and mobile browsers are untested.
11. **Bystander privacy** in shared rooms (notice wording; headsets).
12. **Out-of-order lines** up to about 6.5 s (section 5).

**Verify when the plan is written** (read-only checks, not decisions): that an older build refuses a format-4 log; the consent record version bump and how older records are refused; the player socket allowlist for the private "not picked up" message; how control supervises child processes so the worker can follow the same pattern; how the evaluator verifies quotes against the transcript (so a later revision story can be scoped); Safari support for the microphone and LiveKit client.

## 15. Rollback

Before A2: turn voice off with `VOICE_ENABLED=0`; the text path is untouched. After A2: a build before log format 4 refuses format-4 logs, and a build before consent v3 cannot read v3 consent records; the audio directory is plain files that can be deleted by hand. Notes for `docs/ROLLBACK.md` are written with each slice.

## Appendix A: spike results (2026-11-08, throwaway, not in the repository)

Setup: Apple M5 Pro (64 GB), LiveKit 1.13.11 in Docker (`--dev`), two headless Chromium publishers fed WAV files (macOS `say` voices alice and bob, 8 business sentences, 16-sentence 95 s clips and a 76 s overlapping pair), a Node listener (`@livekit/rtc-node` 1.2.1) reading each track as 16 kHz mono, an energy voice detector, and a resident `whisper-server` (whisper.cpp on Metal). 14 runs, 219 segments (141 on the large model, 78 on the small).

| Measure | small.en | large-v3-turbo-q5_0 |
| --- | --- | --- |
| STT per segment, p50 / p95 | 130 / 153 ms | 229 / 252 ms |
| End of speech to text at 500 ms hangover, p50 / p95 | 630 / 654 ms | 730 / 752 ms |
| Same at 300 ms / 800 ms hangover (p95) | 446 / 1009 ms | 570 / 1085 ms |
| Word error rate (clean synthetic speech) | 0.4 to 2.5% | 0.8 to 2.5% |
| Capacity with partials every 700 ms, p95 | 2 talkers: 233 ms (35% GPU busy) | 1 talker: 237 ms (26%); 2 talkers: 439 ms (73%) |

Attribution: 0 wrong out of 112 two-speaker segments, including simultaneous speech (digitally separate fake devices only; real shared-room acoustics not measured). Capture plus transport about 30 to 100 ms raw, plus about 70 ms from browser echo and noise processing. CPU: Whisper about 1%, both Chromium pages 5 to 13%, listener 4 to 6%, LiveKit 2 to 4% (average). Findings: 300 ms hangover split sentences at commas; 800 ms merged sentences; 500 ms matched the sentences exactly. Media connected over TCP 7881 only (Docker Desktop UDP never connected; the native `brew` LiveKit binary failed to connect, probably the macOS firewall, and was not diagnosed). Not measured: real voices, noisy rooms, acoustic cross-talk, GPU load from a generating LLM, packet loss or a real network, Safari or mobile browsers, direct GPU utilisation.

The probe scripts are in the session's scratch directory and are not committed; the numbers above are the record.
