# EPIC-0003 voice A1b: LiveKit and the web consent flow — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Story: proposed **US-0071** (EPIC-0003, High, L), filed in Task 0 from `docs/ID_REGISTRY.md` (the number is a proposal, not reserved: if the registry has moved, every `US-0071` below shifts with it). Branch: `feature/EPIC-0003-US-0071-voice-livekit-consent`, cut from `origin/develop` after this plan's docs PR has merged (A1a is on `develop` since PR #130, squash commit 76a61c0). TDD per task: write the failing test, run it and see it fail for the stated reason, then the code.

**Goal:** A participant in the browser chooses "take part with voice", checks the microphone in the lobby, joins a LiveKit room with a short-lived microphone-only token, can mute, and hears (reads) private voice notices; the speech worker subscribes only to current recording holders, restarts with bounded backoff, polls Whisper health and shares one speech-to-text budget across sessions; the facilitator sees who speaks and fixed voice alerts. Still dark behind `VOICE_ENABLED=0`.

**Architecture:** Control mints LiveKit tokens through a new adapter in `packages/adapters/src/livekit` and serves them on `POST /sessions/:id/voice-token` (service token); the BFF calls it for the cookie's own seat and returns only the token, its expiry and the public `wss` URL. Control derives each seat's LiveKit identity from the runtime's `voice_seats` (role plus a seat generation = an HMAC of the holder's participant id under a per-session key held in memory) and removes stale identities from the room. The worker gets its own token over IPC (`livekit_join`), joins with auto-subscribe off and subscribes only to identities that are recording holders in the last `voice_state`. The runtime adds "started" and "not muted" to `recording`, a `voice_mute` player message, a facilitator-only `voice`/`speaking` roster field and `voice_unavailable` notices. The web app forwards `joined.voice`, relays `voice_opt_in`/`voice_opt_out`/`voice_mute`, forwards `voice_notice` as a named event, and renders the voice choice, mic check, mute and the console's speaking indicator.

**Tech Stack:** TypeScript, pnpm workspaces, Node 22, zod 4 strict schemas, Vitest (jsdom for components), Playwright 1.64 with Chromium fake media devices, Axe. New dependencies (exact pins): `livekit-server-sdk` 2.19.2 (`packages/adapters`), `@livekit/rtc-node` 1.2.1 (`services/speech`), `livekit-client` 2.23.0 (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-11-08-voice-part-a-design.md` (Draft 3, owner answers in section 16). **Master plan:** `docs/superpowers/plans/2026-11-08-voice-part-a-overview.md` (cross-slice interfaces, settings, C1 to C11). **Previous slice:** `docs/superpowers/plans/2026-11-08-voice-a1a-pipeline.md`. Where this plan differs from the overview or the outline, "Resolved Facts" and "Contradictions" below give the exact change; the spec is not edited by this plan.

**Verified against:** `develop` at 76a61c0 (A1a merged). Every `file:line` below is from that tree. No LiveKit server, no browser and no test was run for this plan; `npm view` was run read-only for the three packages.

---

## Resolved Facts (read first)

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| R1 | Does the BFF forward `joined.voice` to the page today? | **No.** `playerJoined` picks roleId, brief, privateFacts, consent, scenes, state, logIdentity, replay only; `voice` is dropped. The BFF's mirror type has no `voice` either, and the page's parser does not read it. | `apps/web/src/server/stream-hub.ts:73-75`; `apps/web/src/server/wire.ts:40-60`; `apps/web/src/lib/use-session.ts:103-121`; runtime sends it at `services/runtime/src/host/ws-server.ts:387-388` |
| R2 | How does the player stream treat `voice`, `voice_notice` and other unknown frames? | Dropped silently: `onFrame` forwards `event`, peer `roster` and `error` only; the comment says anything else is not forwarded. The page's EventSource listens to a fixed list of named events. | `stream-hub.ts:205-223` (`:222`); `use-session.ts:163-177` |
| R3 | Can the page send `voice_opt_in`/`voice_opt_out` today? | **No route and no hub type.** The hub's `send` throws for any type outside `SEND_ERRORS` (consent, withdraw_consent, leave, say); the BFF routes are join, stream, say, consent, leave. The runtime accepts both messages and answers success with `{type:"voice", state}`, a frame the hub would drop. | `stream-hub.ts:20-32,184-192`; `apps/web/src/server/routes.ts:127-131`; runtime `host/protocol.ts:62-63,90-91`, `ws-server.ts:438-443` |
| R4 | How does a BFF send learn its outcome? | The runtime acks nothing for say/consent/leave: `sendOne` waits `sendWaitMs` (300 ms) for an error frame whose code the type can produce, else resolves `null` (= success). A voice send needs the `voice` frame as its success answer, or a "not confirmed" path. | `stream-hub.ts:34,194-203,216-220`; `handlers.ts:306-324` |
| R5 | How does the BFF reach control, and can the browser ever see LiveKit secrets? | Through `LauncherClient.call(method, path, body, timeout)` over loopback HTTP with `x-service-token`; control checks the token before routing. Control has no voice route. The LiveKit key and secret would live only in control's environment: `CHILD_ENV_ALLOWLIST` and `SPEECH_ENV_ALLOWLIST` already exclude `LIVEKIT_*` (tests exist). The browser can only get what a BFF handler returns: the plan returns `{ token, url, expiresAt }`, nothing else. | `apps/web/src/server/launcher-client.ts:458-470` (class), `:115-121` (timeouts); `services/control/src/api.ts:221-229`; `services/control/src/voice/speech-env.ts:1-12`; `services/control/src/child-env.ts:9-14` |
| R6 | Where can seat generations come from? | Control already receives every holder's `participantId` in `voice_seats` and keeps the latest per session (`Session.seats`). A participant id changes on a reissue (the next person) and a rebind (`claimRebind`), and stays the same across a page reload (it is in the sealed cookie). So `generation = HMAC-SHA256(sessionKey, roleId + "\n" + participantId)`, first 8 hex, with `sessionKey` 32 random bytes created with the VoiceHost's session entry, changes on create, reissue, rebind and every control start, needs no new runtime message, and leaks nothing of the participant id. | `services/control/src/voice/voice-host.ts:31,40-41,103`; `services/runtime/src/host/voice.ts:20-32`; `apps/web/src/server/stream-hub.ts:10` (cookie fields) |
| R7 | Is the seat's holder kept while disconnected? | No: a socket close releases the holder (`host.release`), so `voice_seats` drops the seat; a page reload or a network blip therefore looks like "holder gone" for a moment. Removing the LiveKit participant on every holder loss would kick the browser's room connection on every SSE reconnect. The plan removes an identity only when the role's holder **changes to another participant**, the holder opts out, the role is reissued or removed, voice goes off, or the session ends; a plain disconnect only unsubscribes the worker. | `services/runtime/src/host/ws-server.ts:492-499`; `session-host.ts:292-293` |
| R8 | Does `recording` require the session to have started? | **No (A1a gap).** `buildVoiceSeats` sets `recording` from the voice state only; pause and end are separate flags; `voiceSeats()` is re-sent on `session.started` but a seat that opted in in the lobby already records. With file ingest this was harmless; with LiveKit, lobby speech would be subscribed and transcribed (and stored once A2 lands). A1b adds "started" to `recording` (the runtime refuses those lines `not_started` anyway). | `services/runtime/src/host/voice.ts:20-32`; `session-host.ts:142,463-468`; refusal `session-host.ts:655-656` region (`not_started` first) |
| R9 | What does the worker's ingest know about consent? | Nothing: `AudioIngest` is "start delivering frames / stop"; the gate is applied per frame in `TrackPipeline`. File ingest starts once, at the first `voice_state` with a recording seat. A LiveKit ingest must also follow the gate for **subscriptions** (spec: an unconsented track is never subscribed), so A1b adds an optional `setAllowed(identities)` to `AudioIngest`. | `services/speech/src/ingest/audio-ingest.ts:1-11`; `services/speech/src/worker.ts:65-71,84-93`; `track-pipeline.ts:50-55` |
| R10 | Frame size the pipeline needs | Exactly 20 ms of 16 kHz mono (320 samples); the segmenter refuses other constants. rtc-node's `AudioStream` frame size is not pinned by this repo, so the LiveKit ingest re-frames to 320 samples. | `services/speech/src/segmenter.ts:22-23,50,84`; spike note in spec appendix A |
| R11 | The STT in-flight cap today | One `LimitedSpeechToText` (`maxInFlight` 2) built in each worker's `main.ts`: per worker. | `services/speech/src/main.ts:42-46`; `packages/adapters/src/speech/limited.ts:46-77,132` |
| R12 | Worker restart today | None: `workerExited` sets `workerLost` and raises one `worker_down`; `attach` never spawns again for that session. | `voice-host.ts:33-37,81,201-213` |
| R13 | The short window after a runtime restart (A1a carry-over) | On a runtime exit control answers every pending line `failed`, forgets the seats and tells the worker "nobody records" (`holders: []`); the worker's gate then stops every pipeline and aborts in-flight transcriptions. The only lines lost are those already past the gate when the exit happened, and they name participants whose sockets died with the runtime; a restarted session also comes back **paused**, so the new runtime would refuse them (`not_holder` or `paused`). **Decision: document, no fix** (no buffering across a restart, which could record past a consent change); pin it with a test (Task 9). | `voice-host.ts:115-127,183`; `track-pipeline.ts:105-112`; THREAT_MODEL "Voice input, slice A1a" residual risk; `docs/memory/backlog-and-decisions.md` decision "Resume is automatic but always PAUSED" |
| R14 | Console alerts | The console copy replaces every `facilitator.alert` text with one fixed line per level ("The runtime raised an alert. Details are in the facilitator log."), so A1a's voice alert sentences never reach the console. A1b passes through ONLY the exact voice alert sentences (an allowlist pinned against the runtime's `VOICE_ALERT_SENTENCES` by a test). | `apps/web/src/server/facilitator-copies.ts:47-51,83`; `services/runtime/src/host/session-host.ts:47-51` |
| R15 | Facilitator roster and readiness | Runtime builds both rosters in `buildRoster`; the BFF picks facilitator fields one by one in `entryOf` (used by the session API, readiness and the live view) and peer fields in `peerEntryOf`. Readiness counts "not joined and consented"; voice does not gate the start (voice is optional; spec 6). | `services/runtime/src/host/roster.ts:4-28`; `apps/web/src/server/console-roster.ts:9-17`; `stream-hub.ts:60-65`; `console-sessions.ts:178-187`; `facilitator-hub.ts:94,185-186` |
| R16 | CSP and Permissions-Policy | `Permissions-Policy: camera=(), microphone=(), geolocation=()` is sent on EVERY route twice over: statically (`next.config.ts:9`, source `/:path*`) and per page (`headers.ts:43`). `getUserMedia` is therefore blocked everywhere. CSP `connect-src 'self'` blocks the LiveKit `wss` signalling. A1b: `microphone=(self)` on `/session/*` only, and only when `LIVEKIT_URL` is set; `connect-src 'self' <wss origin> <matching https origin>` on `/session/*` only (livekit-client may fall back to an HTTP validate request on the same host: not verified). The static rule must stop covering `/session/*` or the two headers would conflict (the e2e reads the real response headers). | `apps/web/next.config.ts:5-10,23-25`; `apps/web/src/server/headers.ts:20-50`; `apps/web/src/proxy.ts:6-16` |
| R17 | Secure context | `getUserMedia` needs a secure context: `https://` (the pilot, spec D5) or a loopback origin. The e2e stack serves `http://127.0.0.1:<port>` (a secure context), so the fake microphone works there. A LAN `http://` address is not secure: the page must detect it and say so. | `apps/web/e2e/helpers/start-launcher-stack.ts:228-237`; spec 9 "Network" |
| R18 | Fake microphone in e2e | Playwright config has one Chromium project with an optional `executablePath`; a spec can add `launchOptions.args` (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`, `--use-file-for-fake-audio-capture=<wav>`) and `context.grantPermissions(["microphone"])`. The e2e control service gets an explicit environment, so `VOICE_ENABLED`, fake `LIVEKIT_*` keys, `STT_PROVIDER=fake` and `SPEECH_INGEST=file` can be passed. **Token minting needs no LiveKit server** (a JWT is signed locally), so the e2e reaches "token received, connecting"; the room connection itself cannot succeed without a server, so the e2e drives the failure path ("Voice could not connect. Use the text box.") with `page.routeWebSocket` closing the socket. Publishing, the worker's subscription and `removeParticipant` against a real server are live-only. | `apps/web/playwright.config.ts:1-22`; `start-launcher-stack.ts:57-78` |
| R19 | `lint:sdk` | One list, one allowed directory (`./packages/adapters` pruned); fixture tests in `check-sdk-imports.test.sh`; CI runs both. A second rule can be appended with its own list and its own allowed directory per package without touching lines 8-15. | `scripts/check-sdk-imports.sh:8-29`; `scripts/check-sdk-imports.test.sh:1-25`; `.github/workflows/ci.yml:149-161` |
| R20 | Where LiveKit libraries may run | `@livekit/rtc-node` 1.2.1 depends on `@livekit/rtc-ffi-bindings` 0.13.1, whose optional native packages are darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu and win32-x64-msvc (glibc only: **no musl/Alpine**). The runtime image is `node:22.23.3-alpine` but installs only `@acr/runtime...`, which does not include `services/speech`; the voice worker therefore needs a glibc host (the laptop pilot, spec D8). `livekit-server-sdk` is pure JavaScript (deps `jose`, `@livekit/protocol`, `@bufbuild/protobuf`; engines node >= 19) and lands in `packages/adapters`, so the Alpine runtime image will also install it (size only, never loaded there). | `npm view @livekit/rtc-node@1.2.1 dependencies`; `npm view @livekit/rtc-ffi-bindings@0.13.1 optionalDependencies`; `npm view @livekit/rtc-ffi-bindings-<arch>@0.13.1 os cpu libc`; `deploy/compose/Dockerfile.runtime:3,18` |
| R21 | Notice v3 and a SHA pin | `consent/notice-v3.md` line 1 is the draft marker; its test asserts that line. No notice has a SHA pin test today (the A1a plan's "notice-v1.md SHA test" does not exist). The notice already describes audio retention (A2): fine, because the release gate needs A2 (spec 12). | `consent/notice-v3.md:1,13`; `services/runtime/src/engine/__tests__/consent-notice-v3.test.ts:10-14`; `consent-notice.test.ts:15-60` (no hash) |
| R22 | Voice alert and notice codes on the wire | Parent `voice_alert` codes: `worker_down`, `stt_unavailable`, `stt_failed`; parent `voice_notice` codes: `stt_failed`, `empty` only; the player codes include `voice_unavailable` (defined, never sent). | `services/runtime/src/host/parent-channel.ts:44-45,57-58`; `services/control/src/protocol.ts:43-44,56-57`; `services/runtime/src/host/voice.ts:13-14` |
| R23 | Rate limits | Control has no rate limiting of its own (the BFF is its only caller); BFF throttles are `JoinThrottle` instances keyed by address or credential. The voice token route gets a BFF throttle keyed by the cookie's participant; the "rate-limited like the other routes" of the outline lives in the BFF. | `services/control/src/api.ts:74-238`; `apps/web/src/server/routes.ts:30-70`; `apps/web/src/server/throttle.ts:13-48` |
| R24 | Who knows the LiveKit public URL | The CSP is built per page request in `proxy.ts` from the web app's environment, so the web app must know the public `wss` origin itself; control does not need it. Control needs the LiveKit server API address (for `removeParticipant`, `deleteRoom`) and the worker needs a signalling URL; on the pilot laptop both are loopback. | `apps/web/src/proxy.ts:7-10`; overview "Settings" (`LIVEKIT_URL` read by control: changed, see Contradictions) |
| R25 | Is `STT_MODEL` read? | Allowlisted for the worker, never parsed. A1b validates it (1 to 64 characters, every `.`-separated part an `isSafeId`) so a typo fails at start; its use (the model file `voice:up` starts) stays A1c. | `services/control/src/voice/speech-env.ts:8`; `services/speech/src/config.ts:20-56` |

## Contradictions with the outline, overview or spec (exact changes)

| # | Says | Finding | Change |
| --- | --- | --- | --- |
| K1 | Outline A1b #3: "No token for ... a paused or ended session". | A token only lets the browser publish; the worker subscribes only to recording holders (R9), and `recording` now needs started, not paused, not muted (R8). Refusing during a pause breaks a page reload during a pause, and refusing before the start stops the lobby from connecting early. | Tokens are refused for: voice off, LiveKit not configured, unknown session, ended, not the current holder, holder's choice not `voice`, an AI seat, voice switched off after failed restarts. **Not** refused while paused or before the start; the subscription gate handles both. |
| K2 | Overview "Settings": `LIVEKIT_URL` read by control and returned with the token. | The CSP needs the public origin in the web app (R24). | Web reads `LIVEKIT_URL` (public `wss://`, or `ws://127.0.0.1:<port>` for local development); control reads `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and a new `LIVEKIT_HOST` (default `http://127.0.0.1:7880`, loopback `http:` only, the server API; the worker's signalling URL is derived as `ws://` on the same host and port and sent in `livekit_join`). |
| K3 | Overview section 7: identity `${roleId}.g${generation}`, generation "new on every create, reissue, rebind and control start". | Matches R6, but nothing stores a generation; derive it (R6). The worker's own identity must never parse as a role. | Generation = HMAC (R6). Worker identity `SPEECH.<8 hex>` (upper case and a dot: never `isScenarioId`). |
| K4 | Spec 6 / overview 4: `recording` is `state === "voice" && !muted`. | Lobby audio would be transcribed (R8). | `recording = started && state === "voice" && !muted && !voiceUnavailable`. |
| K5 | Outline A1b #7: "mute ... new player message `voice_mute {muted}` or reuse opt-out: decide at expansion". | Opt-out writes the voice record, is audited (A2) and needs a new opt-in (and v3 consent) to undo. | New strict player message `voice_mute { muted: boolean }`, in memory only, cleared when the holder is released; never written, never audited. |
| K6 | Outline A1b #9: indicator from `speech_activity` "through a facilitator-only roster field". | Agreed; the console also needs the voice state per seat. | Facilitator roster entry gains `voice?: VoiceState` and `speaking?: true` (only with voice enabled); the peers entry gains nothing (Open Question 1). |
| K7 | Outline A1b #11: "Unhealthy → one `stt_unavailable` alert and the participant page shows ...". | The parent `voice_notice` carries one role (R22). | Control sends `voice_alert stt_unavailable`; the runtime, on that alert (and on `voice_off`), sends `voice_notice voice_unavailable` to every recording holder and sets `voiceUnavailable` (recording false) until `voice_alert stt_recovered`. |
| K8 | Overview §2: `VoiceAlertCode` "A1b adds worker_restarting, voice_off". | Recovery also needs a code. | A1b adds `worker_restarting`, `voice_off`, `stt_recovered` (the last at level `info`). |

## Global Constraints

- Every A1a invariant holds: **no change to the session log format**, `LOG_FORMAT`, the consent file or any event; `VOICE_ENABLED` defaults to `0`; **privacy invariant** (audio of a seat that is not the current human holder who chose voice, started, not paused, not ended, not muted is never subscribed, segmented, transcribed or turned into a message), enforced in the worker (subscription and frame gate) and the runtime (refusal table).
- Never log a token, a LiveKit key or secret, a room name, an identity, a participant id, a transcript line, a URL from the environment or a path; log fixed sentences and error names only. Errors returned to the browser are the BFF's own sentences.
- Token grant (spec 9, overview 7), exactly: `ttl` 600 s; `roomJoin: true`, `canPublish: true`, `canPublishSources: ["microphone"]`, `canSubscribe: false`, `canPublishData: false`, `canUpdateOwnMetadata: false`; room `v` + 32 hex per session in control memory; identity `<roleId>.g<8 hex>`. Worker grant: `roomJoin: true`, `canPublish: false`, `canSubscribe: true`, `canPublishData: false`, `canUpdateOwnMetadata: false`, `hidden: true`, identity `SPEECH.<8 hex>`, ttl 600 s.
- The browser receives only `{ token, url, expiresAt }` for its own seat; identity comes only from the sealed cookie (never from a body).
- Constants (code review only): restart backoff 5 tries, base 500 ms, doubling (500, 1000, 2000, 4000, 8000); `STT_HEALTH_POLL_MS` 5000; `STT_GLOBAL_IN_FLIGHT` 2; `VOICE_TOKEN_TTL_S` 600; BFF voice token throttle 20 per 60 s per participant; `VOICE_SEND_WAIT_MS` 2000.
- Strict zod schemas (`strictObject`); parent-channel copies equal (drift test); the worker protocol has one source (`@acr/speech/protocol`); no new regular expression with a letters-digits-underscore class outside `packages/events/src/ids.ts` (US-0020 guard): identities are split on the last `.` and checked with `isScenarioId`.
- Tests: no real-time sleeps, no absolute time assertions, injected `SetTimer`/clocks, private temp directories, `vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 })` for real-process and real-socket tests, generous waits for anything that loads a model; e2e with no retries and explicit limits.
- Accessibility (AGENTS.md §16): microphone never opened on page load; permission requested only after the voice opt-in and a click; state in words and an icon, never colour alone; every control a native `<button>` with a label; `aria-live="polite"` for notices; Axe on every new page state.
- Dependencies (AGENTS.md §19): exact versions, at least two weeks old (all three are: 2026-10-22, 2026-10-22, 2026-10-16), Apache-2.0, a `findings.md` row each, `MEMORY.md` dependency list, `pnpm audit --audit-level=high` clean; `lint:sdk` keeps each where it belongs.
- Coverage at least 80% lines per package; the thin real-library wrappers (`livekit-room.ts` in speech, `livekit-room-browser.ts` in web) are excluded from coverage by name in their `vitest.config.ts` and covered by the opt-in live check.
- Commits: `[TYPE] US-0071: imperative description` (max 72 characters), ending with the attribution line of the session's reminder.

## Review Focus

1. **A published track of a seat that is not recording** (text-only, before the start, paused, muted, a peer's stale identity, an identity that does not parse): never subscribed, no frame, no STT call. [Task 7 `an unconsented published track is never subscribed`, `before the start nothing is subscribed`; Task 3 `recording is false before the start`]
2. **A reissue or rebind while the old browser is still in the room:** the old identity is removed, the new holder gets a new identity, the worker never attributes the old track to the new person. [Task 5 `a new holder for a role removes the old identity`; Task 7 `a track whose generation is not current is ignored`]
3. **A participant who reloads the page or loses the stream for a moment:** not kicked from the room by control, the worker stops listening while the seat has no holder and resumes when the same participant rejoins. [Task 5 `a plain disconnect removes no identity`; Task 7 `a holder that comes back is subscribed again`]
4. **Whisper or the worker failing for long:** bounded restarts, then voice off with ONE alert, pages say "use the text box", typed lines keep working, no alert storm. [Task 8, Task 9]
5. **A page served over plain `http://` on a LAN address, or a browser that refuses the microphone:** the page says why in words and keeps the text box; nothing retries in a loop. [Task 14 `insecure context shows the secure-connection sentence`, `a denied permission shows the denied sentence and stays text only`]

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `scripts/check-sdk-imports.sh`, `check-sdk-imports.test.sh` | Second rule for the three LiveKit packages | 1 |
| `services/speech/src/protocol.ts`, `services/runtime/src/host/parent-channel.ts`, `services/control/src/protocol.ts`, drift tests | New worker messages; new alert codes | 2 |
| `services/runtime/src/host/{voice.ts,session-host.ts,protocol.ts,ws-server.ts,roster.ts}`, `main.ts` | started in `recording`, `voice_mute`, `voice_unavailable`, facilitator roster `voice`/`speaking` | 3 |
| `packages/adapters/src/livekit/{token.ts,room-admin.ts,identity.ts}` | Token minting, `removeParticipant`/`deleteRoom`, identity build and parse | 4 |
| `services/control/src/voice/{tokens.ts,livekit-config.ts}`, `voice-host.ts`, `supervisor.ts`, `api.ts`, `config.ts` | Room, generations, token route, identity removal | 5 |
| `services/control/src/voice/stt-slots.ts`, `services/speech/src/slot-stt.ts`, `services/speech/src/main.ts` | One STT budget across sessions | 6 |
| `services/speech/src/ingest/{livekit-ingest.ts,livekit-room.ts,reframe.ts}`, `config.ts`, `worker.ts` | LiveKit `AudioIngest` behind a room port | 7 |
| `services/control/src/voice/restart.ts`, `voice-host.ts` | Restart with bounded backoff; voice off | 8 |
| `services/speech/src/health.ts`, `worker.ts`, `voice-host.ts` | Whisper health every 5 s; R13 pin | 9 |
| `consent/notice-v3.md`, `consent-notice-v3.test.ts` | Final wording, SHA pin | 10 |
| `apps/web/src/server/{wire.ts,stream-hub.ts,handlers.ts,routes.ts,launcher-client.ts,config.ts}`, `apps/web/src/app/api/v1/voice/route.ts`, `.../voice/token/route.ts` | Player voice routes, hub frames | 11 |
| `apps/web/next.config.ts`, `apps/web/src/server/headers.ts`, `apps/web/src/proxy.ts` | CSP and Permissions-Policy for the session page | 12 |
| `apps/web/src/server/{console-roster.ts,facilitator-copies.ts}` | Console voice fields, voice alert sentences | 13 |
| `apps/web/src/lib/{use-session.ts,messages.ts}`, `components/VoiceChoice.tsx`, `components/VoiceNotices.tsx`, `SessionScreen.tsx` | Lobby choice, state, notices | 14 |
| `apps/web/src/lib/{voice-client.ts,livekit-room-browser.ts,mic-level.ts}`, `components/{MicCheck.tsx,MicButton.tsx}` | Mic check, Join with voice, mute | 15 |
| `apps/web/src/components/console/{VoicePanel.tsx,SpeakingIndicator.tsx}`, `Readiness.tsx`, `LiveView.tsx` | Console indicator and voice column | 16 |
| `apps/web/e2e/voice-lobby.spec.ts`, `e2e/helpers/start-launcher-stack.ts`, `e2e/fixtures/voice.wav` (generated by the spec) | Browser flow, headers, Axe | 17 |
| `services/control/src/__tests__/voice/livekit.live.test.ts` | Opt-in live check (`VOICE_LIVE=1`) | 18 |
| docs | Close-out | 19 |

---

### Task 0: Branch, story, ids and the dependency check

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`.

- [ ] **Step 1:** `git fetch && git switch -c feature/EPIC-0003-US-0071-voice-livekit-consent origin/develop`; confirm this plan is on `origin/develop`.
- [ ] **Step 2:** Take the next free ids from `docs/ID_REGISTRY.md` (expected US-0071, TASK-0107, AC-0405 to AC-0416, TC-0171 to TC-0182; use the registry's actual values). File **US-0071** under EPIC-0003: "As a participant, I want to choose voice in the browser and speak into the session, so that I can take part by voice." (Priority High, Estimate L, In Progress), TASK-0107 (Dev, Agent, this branch), and these ACs, each with a TC in Task 19:
  - AC-a: `lint:sdk` allows `livekit-server-sdk` only in `packages/adapters`, `@livekit/rtc-node` only in `services/speech`, `livekit-client` only in `apps/web`; the provider rule is unchanged.
  - AC-b: a token is issued only to the current human holder whose voice choice is `voice`, with exactly the grant of the Global Constraints; a text-only seat gets no token and its published track is never subscribed.
  - AC-c: a reissue, a rebind, an opt-out, a removal, voice off and the session end remove the stale LiveKit identity; a plain disconnect does not.
  - AC-d: the worker subscribes only to identities of current recording holders (started, not paused, not muted) and feeds 20 ms 16 kHz mono frames.
  - AC-e: one speech-to-text in-flight budget (2) is held by control across all sessions.
  - AC-f: a worker that exits is restarted with bounded backoff (5 tries, base 500 ms, doubling); after that voice is off for the session with one alert, and the session continues by text.
  - AC-g: Whisper health is polled every 5 s; unhealthy gives one alert and "voice unavailable, use the text box" on the pages, healthy again one info alert.
  - AC-h: the participant page offers the voice choice after consent to a notice that names voice; the console roster and readiness show each seat's voice state; a player's frames carry only their own state.
  - AC-i: the microphone is never opened on page load; permission is asked only after the voice opt-in; the mic check shows a level; "Join with voice" publishes; mute stops publishing and recording; the state is shown in words and an icon; keyboard operable; Axe clean.
  - AC-j: `voice_notice` reaches only that player's page, is announced politely, unknown codes are dropped.
  - AC-k: the console shows who is speaking and the voice alerts in their fixed words; neither reaches a player frame.
  - AC-l: notice v3 carries the final wording without the draft line and is pinned by its SHA-256; legal and HR sign-off stays a go-live item.
- [ ] **Step 3:** Run `npm view livekit-server-sdk@2.19.2 version license time.modified`, the same for `@livekit/rtc-node@1.2.1` and `livekit-client@2.23.0`; if a newer stable version is now more than two weeks old, use it only after re-reading its changelog for breaking changes, and record the choice in Task 19's `findings.md` rows. Add an "Assigned 2026-11-.. (EPIC-0003 voice A1b)" line to the registry; run `npx jest tests/unit/id-registry.test.js`. Expected: pass.
- [ ] **Step 4:** Commit `[docs] US-0071: file the voice LiveKit and consent story and ids`.

### Task 1: `lint:sdk` second rule

**Files:** Modify `scripts/check-sdk-imports.sh` (append after line 27; lines 8-15 byte-identical), `scripts/check-sdk-imports.test.sh`.

**Interfaces:** Produces a second loop over three `(package regex, allowed prune path)` pairs: `livekit-server-sdk` → `./packages/adapters`; `@livekit/rtc-node` → `./services/speech`; `livekit-client` → `./apps/web`. Same CODE_RE/JSON_RE shapes, its own `find` prune list (`node_modules`, `dist`, `.superpowers`, `.git`, `coverage`, plus the one allowed path). Failure sentence: `LiveKit package used outside its allowed package`.

- [ ] **Step 1: Write the failing fixtures** (append `run` lines): `livekit-server-in-service` (`services/a/x.ts`, `import { AccessToken } from "livekit-server-sdk";`, 1); `livekit-server-in-adapters` (`packages/adapters/src/x.ts`, 0); `livekit-server-pkgjson-web` (`apps/web/package.json` dependency, 1); `rtc-node-in-speech` (`services/speech/src/x.ts`, 0); `rtc-node-in-control` (`services/control/src/x.ts`, 1); `rtc-node-pkgjson-adapters` (1); `livekit-client-in-web` (`apps/web/src/x.tsx`, 0); `livekit-client-in-control` (1); `livekit-client-dynamic-import-in-runtime` (`services/runtime/src/x.ts`, `await import("livekit-client")`, 1); `livekit-protocol-untouched` (`services/a/x.ts`, `import "@livekit/protocol";`, 0: transitive packages are not listed). Keep every existing line unchanged.
- [ ] **Step 2:** Run `bash scripts/check-sdk-imports.test.sh`. Expected: the new 1-cases print `FAIL`.
- [ ] **Step 3:** Implement; `git diff -U0 scripts/check-sdk-imports.sh` must show additions only below line 27 and the final `ok` line kept.
- [ ] **Step 4:** Run `bash scripts/check-sdk-imports.test.sh` and `pnpm lint:sdk`. Expected: all `ok`, `sdk-imports: ok`.
- [ ] **Step 5:** Commit `[chore] US-0071: lint:sdk rule for the LiveKit packages`.

### Task 2: New messages: worker protocol and parent channel

**Files:** Modify `services/speech/src/protocol.ts`, `services/speech/src/__tests__/protocol.test.ts`, `services/runtime/src/host/parent-channel.ts`, `services/control/src/protocol.ts`, `services/control/src/__tests__/protocol.drift.test.ts`.

**Interfaces:**
- Worker protocol (`@acr/speech/protocol`) adds:
  - control → worker `livekit_join { url: string /* ws: or wss:, max 512 */; token: string /* 1..4096 */; room: string /* "v" + 32 hex, checked as: starts with "v", rest length 32 and isFileSafeId */ }` and `stt_slot_grant { slot: string /* 16 hex via isFileSafeId */ }`.
  - worker → control `stt_health { ok: boolean }`, `stt_slot_request { slot }`, `stt_slot_release { slot }`, `livekit_status { state: "connected" | "failed" | "disconnected" }`.
  - `voice_state` holders change later: Task 5 adds `voiceChosen` (with `voice_seats`), Task 7 adds `generation`; this task leaves the holder shape alone.
- Parent channel, both copies: `VOICE_ALERT_CODES` = `worker_down`, `stt_unavailable`, `stt_failed`, `worker_restarting`, `voice_off`, `stt_recovered`. Nothing else changes on the parent channel (the speaking indicator rides the runtime's own `speech_activity` handling, Task 3).

- [ ] **Step 1: Write the failing tests:** protocol table rows: valid `livekit_join` with `ws://127.0.0.1:7880` and `wss://pilot.example/`; invalid with `http:` url, an 4097-character token, room `v` + 31 hex, room `V` + 32 hex, an extra key; `stt_slot_request` with slot `"../x"` invalid; `livekit_status` with `state: "up"` invalid; `stt_health` with `ok: "yes"` invalid. Drift test: the two `VOICE_ALERT_CODES` lists are equal and contain the three new codes; `voice_alert { code: "voice_off" }` valid, `{ code: "nope" }` invalid (existing row stays).
- [ ] **Step 2:** Run `pnpm --filter @acr/speech exec vitest run src/__tests__/protocol.test.ts` and `pnpm --filter @acr/control exec vitest run src/__tests__/protocol.drift.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Control's `fromWorker` ignores the new worker types for now; the runtime's `voice_alert` handler maps the new codes in Task 3.
- [ ] **Step 4:** Re-run both plus `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: LiveKit, health and slot messages on the voice channels`.

### Task 3: Runtime: started and mute in `recording`, voice unavailable, console voice fields

**Files:** Modify `services/runtime/src/host/voice.ts` (`buildVoiceSeats`), `session-host.ts`, `protocol.ts`, `ws-server.ts`, `roster.ts`, `main.ts`; Create `services/runtime/src/host/__tests__/voice-mute.test.ts`, `__tests__/voice-roster.test.ts`; extend `voice-choice.test.ts`, `ws-voice.test.ts`, `voice-notice.test.ts`.

**Interfaces:**
- `buildVoiceSeats` gains `started: boolean` and `isRecording(roleId): boolean`; `recording = started && stateOf(role) === "voice" && isRecording(role)`.
- `SessionHost.muteVoice(roleId, participantId, muted: boolean): void` (HostError `voice_off`, `forbidden`, `not_joined`; in-memory `voiceMuted: Set<string>`, deleted in `release` and `forgetVoice`; fires `noteVoiceSeats`). `ClientMessage` adds `z.strictObject({ type: z.literal("voice_mute"), muted: z.boolean() })`; success answers `{ type: "voice", state, muted }` (the `voice` server message gains `muted?: boolean`) to the sender only.
- `voiceUnavailable: boolean` on the host: set by parent `voice_alert` `stt_unavailable` or `voice_off`, cleared by `stt_recovered` (never by `voice_off`); while set, `recording` is false for every seat and the host sends `voice_notice voice_unavailable` once to every holder whose state is `voice` (bypassing the per-role 10 s limit only for this code's first send). `voiceAlert` gains `VOICE_ALERT_SENTENCES` for the new codes, fixed: `worker_restarting`: "Voice input is restarting after a fault."; `voice_off`: "Voice input is off for this session after repeated faults. Participants can continue by text."; `stt_recovered` (level `info`): "Voice input is available again."
- Facilitator roster entry gains `voice?: VoiceState` and `speaking?: true`, only when voice is enabled (a text-only session's roster is byte-identical); `PeerRosterEntry` unchanged. `SessionHost.speakingRoles(): ReadonlySet<string>` (roles whose last edge was active and that are recording holders; cleared on pause, end, release, the stale backstop) and `onSpeakingChanged(fn)`; `ws-server.ts` calls `broadcastRoster(sessionId, h, facilitatorOnly)` on it (a new `only: "facilitator"` mode).

- [ ] **Step 1: Write the failing tests:**
  - `voice-choice.test.ts`: `recording is false before the start even for a seat that chose voice` and `true after session.started`; `voice_seats is re-sent at the start with recording true`.
  - `voice-mute.test.ts`: `mute makes recording false at once and unmute restores it`; `mute is refused voice_off, forbidden for an AI seat, not_joined for a non-holder`; `a released holder comes back unmuted`; `mute is never written to the voice record` (file bytes unchanged); `voice_mute with an extra key is bad_message` (ws).
  - `voice-notice.test.ts`: `stt_unavailable sends voice_unavailable to every voice holder once and recording turns false`; `stt_recovered restores recording and appends one info alert`; `voice_off keeps recording false even after stt_recovered`; `the new alert sentences are fixed and contain no code or id`.
  - `voice-roster.test.ts`: `the facilitator roster carries voice and speaking for recording holders`; `the peers roster never carries voice or speaking` (key scan of every peers frame); `a text-only session's facilitator roster has neither key`; `a speaking edge sends a roster to the facilitator socket only`; `pause clears speaking`.
- [ ] **Step 2:** Run `pnpm --filter @acr/runtime exec vitest run src/host/__tests__/voice-mute.test.ts src/host/__tests__/voice-roster.test.ts src/host/__tests__/voice-choice.test.ts src/host/__tests__/voice-notice.test.ts src/host/__tests__/ws-voice.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/runtime exec vitest run src/host src/__tests__/main` and `pnpm --filter @acr/control exec vitest run src/__tests__/demo/voice-demo.test.ts` (the demo opts in before the start: V-01 must still pass, file ingest now starts at the start). Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: record only after the start; mute and voice state for the console`.

### Task 4: LiveKit token adapter and room admin

**Files:** Create `packages/adapters/src/livekit/token.ts`, `room-admin.ts`, `identity.ts`, `__tests__/token.test.ts`, `__tests__/identity.test.ts`, `__tests__/room-admin.test.ts`; Modify `packages/adapters/src/index.ts`, `packages/adapters/package.json` (`"livekit-server-sdk": "2.19.2"`), `pnpm-lock.yaml`.

**Interfaces:**
- `identity.ts` (no dependency): `participantIdentity(roleId: string, generation: string): string` (`<roleId>.g<generation>`; throws `RangeError` unless `isScenarioId(roleId)` and generation is 8 lower-case hex checked character by character); `parseParticipantIdentity(identity: string): { roleId: string; generation: string } | null` (split on the LAST `.`, role must be `isScenarioId` and not reserved, the rest `g` + 8 hex); `WORKER_IDENTITY_PREFIX = "SPEECH."`; `workerIdentity(suffix8hex)`.
- `token.ts`: `mintParticipantToken(o: { apiKey: string; apiSecret: string; room: string; identity: string }): Promise<{ token: string; expiresAt: number /* ms */ }>` and `mintWorkerToken(o: { apiKey; apiSecret; room; identity }): Promise<{ token: string; expiresAt: number }>`, both with `ttl` `VOICE_TOKEN_TTL_S` (600) and the grants of the Global Constraints, via `AccessToken` and `addGrant`; injected `now?: () => number`. Errors are `LiveKitTokenError` with a fixed message (never the key, secret, room or identity).
- `room-admin.ts`: `interface RoomAdmin { removeParticipant(room: string, identity: string): Promise<void>; deleteRoom(room: string): Promise<void> }`; `createRoomAdmin(o: { host: URL; apiKey; apiSecret; client?: RoomServiceClientLike }): RoomAdmin` wrapping `RoomServiceClient`; a "not found" answer is success; any other failure throws `LiveKitAdminError` (fixed message, `cause` kept out of `message`).

- [ ] **Step 1: Write the failing tests:**
  - `token.test.ts` (decode the JWT by hand: split, base64url, JSON; verify HS256 with `createHmac("sha256", secret)`): `the participant token expires 600 s after now`; `its video grant is exactly { room, roomJoin: true, canPublish: true, canPublishSources: ["microphone"], canSubscribe: false, canPublishData: false, canUpdateOwnMetadata: false }` (`toEqual` on the whole object, so an extra grant fails); `sub is the identity`; `the signature verifies with the secret and not with another`; `the worker token has canPublish false, canSubscribe true, hidden true, canPublishData false`; `an error never contains the key, the secret, the room or the identity` (force a failure with an empty secret).
  - `identity.test.ts`: `round trip for "tech_lead", "a-b"`; `parse refuses "facilitator.g0000abcd", "__proto__.gdeadbeef", "Tech.g12345678", "a.b.g1234567", "a.G12345678", "a.g1234567z", "SPEECH.deadbeef", "", "a"`; `build refuses a role with a dot`.
  - `room-admin.test.ts` (fake client): `removeParticipant passes room and identity`; `a not-found answer resolves`; `another failure rejects LiveKitAdminError whose message has no room or identity`.
- [ ] **Step 2:** `pnpm install` (adds the pinned package), then `pnpm --filter @acr/adapters exec vitest run src/livekit`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement. In the JWT the claim name for the sources list is whatever `livekit-server-sdk` 2.19.2 emits for `canPublishSources`; the test asserts the decoded `video` object and fixes the exact shape (record it in the commit message if it is not the string form).
- [ ] **Step 4:** Re-run plus `pnpm lint:sdk`, `pnpm audit --audit-level=high`. Expected: PASS, `sdk-imports: ok`, no high advisory.
- [ ] **Step 5:** Commit `[feat] US-0071: LiveKit token adapter with a microphone-only grant`.

### Task 5: Control: room, seat generations, the token route and identity removal

**Files:** Create `services/control/src/voice/tokens.ts`, `voice/livekit-config.ts`, `src/__tests__/voice/tokens.test.ts`, `src/__tests__/voice/livekit-config.test.ts`, `src/__tests__/voice/token-route.test.ts`; Modify `services/control/src/voice/voice-host.ts`, `supervisor.ts` (`VoiceLink`, `reissue` `:763`, `reissueAll` `:822`), `api.ts`, `main.ts`, `config.ts` (no LiveKit field: `livekit-config.ts` reads it), `.env.example` (names only).

**Interfaces:**
- `parseLiveKitConfig(env): { ok: true; cfg: { apiKey: string; apiSecret: string; host: URL; workerUrl: string } | null } | { ok: false; errors: string[] }`: all three of `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (at least 32 characters), `LIVEKIT_HOST` (default `http://127.0.0.1:7880`; `http:` to `127.0.0.1` or `[::1]` only, a port, no path) or none (`null`: LiveKit off, file ingest only); errors name variables only. `workerUrl` = `ws://<host>:<port>`.
- `class VoiceTokens { constructor(o: { cfg; admin: RoomAdmin; mint: typeof mintParticipantToken; mintWorker: typeof mintWorkerToken; random: (n: number) => Buffer; log }) ; openSession(sessionId): void; room(sessionId): string | undefined; issue(sessionId, roleId, participantId, seats: Seats | undefined): Promise<{ token; expiresAt }>; workerJoin(sessionId): Promise<{ url; token; room }>; seatsChanged(sessionId, prev: Seats | undefined, next: Seats): void; roleReissued(sessionId, roleId): void; voiceOff(sessionId): void; endSession(sessionId): void }`:
  - per session: `room` = `"v" + random(16).hex`, `key` = `random(32)`; `generation(roleId, participantId)` = first 8 hex of `HMAC-SHA256(key, roleId + "\n" + participantId)`; an `issued: Map<roleId, identity>` of the last identity handed out.
  - `issue` throws `VoiceTokenRefused` (one code `voice_refused`) unless `seats` lists `{roleId, participantId}` as a holder whose voice state allowed recording-by-choice (the holder entry exists and its `choice` is voice: `voice_seats` gives `recording`, which now also needs started and not muted, so the check uses a new `voiceChosen` field, see below); `voice_unavailable` when LiveKit is off, the session is unknown, ended or voice is off.
  - `seatsChanged`: for each role in `issued`, remove the identity when the role's holder changed to another participant or its choice is no longer voice; a holder that disappeared does NOT remove (R7). `roleReissued` and `voiceOff` remove at once; `endSession` calls `deleteRoom` and forgets the session. Admin failures are logged by error name only and never thrown.
- Runtime → control `voice_seats` holders gain `voiceChosen: boolean` (the seat's state is `voice`, independent of started, pause and mute) in BOTH parent-channel copies and the worker's `voice_state` (Task 2's drift test extended here); the worker ignores it.
- `VoiceHost` owns one `VoiceTokens` (optional: absent when LiveKit is off) and exposes `voiceToken(sessionId, roleId, participantId)`; `attach` calls `openSession` (room and key exist from the runtime's first voice `ready`, kept across a runtime restart), `fromRuntime(voice_seats)` calls `seatsChanged` before storing, `end` calls `endSession`; `pushState` adds each holder's `generation` once LiveKit is on (Task 7).
- `VoiceLink` gains `voiceToken(...)` and `roleReissued(sessionId, roleId)`; `Supervisor.reissue` calls `roleReissued` after a successful reissue (and `reissueAll` for every role); `Supervisor.voiceToken(id, roleId, participantId)` delegates.
- `api.ts`: `POST /sessions/:id/voice-token`, body `z.strictObject({ roleId: RoleIdSchema, participantId: z.string().min(1).max(128) })`; 200 `{ token, expiresAt }`; `ControlErrorCode` gains `voice_refused` (409) and `voice_unavailable` (503) with fixed messages "Voice is not available for this seat." and "Voice is not available right now."; nothing logged but the error name.

- [ ] **Step 1: Write the failing tests:**
  - `livekit-config.test.ts`: `no LiveKit variables gives null`; `a key without a secret is an error naming both`; `a 31-character secret is refused`; `LIVEKIT_HOST https, a LAN address, a path, user info are refused`; `errors never contain the secret`.
  - `tokens.test.ts` (fake admin and minters, seeded `random`): `the room is v plus 32 hex and differs per session`; `issue gives a token only to the holder whose voiceChosen is true`; refusals `another participant`, `voiceChosen false`, `an AI seat (absent from holders)`, `unknown session`, `ended`, `LiveKit off` each with the right code; `the identity is role.g plus 8 hex and stays the same for the same participant`; `a new participant for the role gets a different generation` (rebind); **`a new holder for a role removes the old identity`**; **`a plain disconnect removes no identity`** (holder disappears from seats); `an opt-out (voiceChosen false) removes it`; `roleReissued removes it at once`; `a control restart (new VoiceTokens) gives a different generation for the same participant`; `endSession deletes the room`; `an admin failure is logged by name and never thrown`; `nothing logged contains the room, an identity, a participant id or a token` (capture `log`).
  - `token-route.test.ts` (createApi with a fake supervisor): `POST voice-token without the service token is 401 and calls nothing`; `a body with an extra key is 400`; `a role id with a dot is 404 before anything is called`; `200 carries only token and expiresAt`; `voice_refused is 409 with the fixed message`; `voice_unavailable is 503`.
  - Drift: `voice_seats` holder with `voiceChosen` valid, without it invalid (both copies), and the worker's `voice_state` accepts it; `buildVoiceSeats` test: `voiceChosen is true for a voice seat before the start while recording is false`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/voice src/__tests__/protocol.drift.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (runtime side of `voiceChosen` in `buildVoiceSeats` too).
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/control test` and `pnpm --filter @acr/runtime exec vitest run src/host`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: voice tokens with seat generations and identity removal`.

### Task 6: One speech-to-text budget across sessions

**Files:** Create `services/control/src/voice/stt-slots.ts`, `src/__tests__/voice/stt-slots.test.ts`, `services/speech/src/slot-stt.ts`, `services/speech/src/__tests__/slot-stt.test.ts`; Modify `voice-host.ts`, `services/speech/src/main.ts`, `services/speech/src/worker.ts` (route `stt_slot_grant`).

**Interfaces:**
- `class SttSlots { constructor(o: { max: number /* STT_GLOBAL_IN_FLIGHT 2 */ }); request(owner: string /* session id */, slot: string, grant: () => void): void; release(owner, slot): void; releaseAll(owner): void; get inUse(): number; get waiting(): number }` — FIFO across owners; a release of an unknown slot is a no-op; a request with a slot id already held or waiting is ignored; at most 64 waiting per owner (beyond: ignored, the worker's own deadline fails the segment).
- `class SlotSpeechToText implements SpeechToText { constructor(inner: SpeechToText, o: { request(slot): void; release(slot): void; newSlot(): string }) ; granted(slot): void }` — `transcribe` and `warmUp` request a slot, wait for `granted` (or the caller's abort signal, which sends `release` for a waiting slot), run `inner`, release in `finally`; `health` takes no slot.
- Worker `main.ts`: Whisper kind becomes `LimitedSpeechToText(SlotSpeechToText(WhisperHttp))` (the limiter keeps its own per-worker cap and deadlines; the slot wait counts against the segment deadline). The fake kind takes no slot.
- `VoiceHost`: one `SttSlots` for all sessions; routes `stt_slot_request`/`stt_slot_release` and sends `stt_slot_grant`; `releaseAll(sessionId)` on worker exit and session end.

- [ ] **Step 1: Write the failing tests:**
  - `stt-slots.test.ts`: `two sessions each asking twice get two grants in total, the third waits`; `FIFO across sessions`; `release grants the next waiter`; `releaseAll of a dead worker frees its slots and drops its waiters`; `a duplicate request is ignored`; `the 65th waiting request of one owner is ignored`.
  - `slot-stt.test.ts` (fake inner, manual grants): `transcribe waits for the grant before calling inner`; `release is sent after success and after failure`; `an abort while waiting sends release and rejects SpeechTimeoutError without calling inner`; `health takes no slot`; `speechToTextContract("slot(fake)", ...)` with an auto-granting control.
  - `voice-host.test.ts`: `with two voice sessions at most 2 transcriptions run at once across both` (two fake workers asking 2 each: exactly 2 `stt_slot_grant` sent until a release); `a worker exit releases its slots`.
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/voice/stt-slots.test.ts src/__tests__/voice/voice-host.test.ts` and `pnpm --filter @acr/speech exec vitest run src/__tests__/slot-stt.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus both packages' full suites. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: one speech-to-text budget held by control`.

### Task 7: The LiveKit `AudioIngest`

**Files:** Create `services/speech/src/ingest/livekit-ingest.ts`, `ingest/livekit-room.ts` (the only file that imports `@livekit/rtc-node`), `ingest/reframe.ts`, `src/__tests__/livekit-ingest.test.ts`, `__tests__/reframe.test.ts`, `__tests__/fake-room.ts`; Modify `services/speech/src/ingest/audio-ingest.ts` (optional `setAllowed`), `config.ts` (`SPEECH_INGEST=livekit`, `STT_MODEL` check), `worker.ts`, `main.ts`, `services/speech/package.json` (`"@livekit/rtc-node": "1.2.1"`), `services/speech/vitest.config.ts` (exclude `src/ingest/livekit-room.ts` from coverage), `pnpm-lock.yaml`.

**Interfaces:**
- `AudioIngest` gains `setAllowed?(allowed: ReadonlyMap<string /* roleId */, string /* generation */>): void` — file ingest ignores it.
- `interface RoomPort { connect(url: string, token: string): Promise<void>; onTrack(fn: (t: { identity: string; trackSid: string }) => void): void; onTrackGone(fn: (t: { identity: string; trackSid: string }) => void): void; onDisconnected(fn: () => void): void; subscribe(trackSid: string): void; unsubscribe(trackSid: string): void; frames(trackSid: string, sampleRate: 16000, channels: 1): AsyncIterable<Int16Array>; disconnect(): Promise<void> }` in `livekit-room.ts`, implemented with rtc-node (`autoSubscribe: false`, `RemoteTrackPublication.setSubscribed`, `AudioStream` with `sampleRate: 16000, numChannels: 1`), and a fake in `__tests__/fake-room.ts` that records `subscribe`/`unsubscribe` calls.
- `class Reframer { constructor(samples: 320); push(chunk: Int16Array): Int16Array[] }` — exact 320-sample frames, carries the remainder.
- `class LiveKitIngest implements AudioIngest { constructor(o: { room: RoomPort; connect: () => Promise<{ url: string; token: string }>; setTimer; onStatus: (s: "connected" | "failed" | "disconnected") => void }) }` — `start` connects (once the first `livekit_join` has arrived), tracks published tracks by identity, and subscribes a track only when `parseParticipantIdentity(identity)` gives a role whose generation equals `allowed.get(role)`; `setAllowed` unsubscribes every track no longer allowed at once and subscribes newly allowed published ones; frames go through a `Reframer` to `onFrame(roleId, frame)`; a disconnect reports `disconnected` and makes `start` resolve (the worker then exits 3 so control restarts it, Task 8).
- The worker computes `allowed` from each `voice_state` (holders with `recording: true`) and the generations, which control sends with the state: `voice_state` holders gain `generation?: string` (8 hex, present when LiveKit is on) — control fills it from `VoiceTokens.generation`. Added to the worker protocol and its test here.
- `parseWorkerConfig`: `SPEECH_INGEST=livekit` needs no directory; `STT_MODEL` optional, 1 to 64 characters, every `.`-separated part `isSafeId`, else an error naming the variable.

- [ ] **Step 1: Write the failing tests:**
  - `reframe.test.ts`: `160 + 160 samples give one frame`; `500 samples give one frame and keep 180`; `no sample is lost or duplicated over 10 000 random chunk sizes`.
  - `livekit-ingest.test.ts` (fake room, manual timers): **`an unconsented published track is never subscribed`** (published identities `alice.g11111111` allowed and `bob.g22222222` not: `subscribe` called only for alice's track, and no frame for bob even when the fake pushes frames); **`before the start nothing is subscribed`** (allowed empty); `setAllowed without a role unsubscribes its track at once`; **`a track whose generation is not current is ignored`** (`alice.g99999999` while allowed has `alice.g11111111`); **`a holder that comes back is subscribed again`**; `an identity that does not parse (SPEECH.deadbeef, Tech.g12345678, a.b) is never subscribed`; `frames reach onFrame as 320-sample frames tagged with the role`; `a disconnect reports disconnected and start resolves`; `a failed connect reports failed and start rejects with a fixed sentence`.
  - `worker.test.ts`: `with livekit ingest the worker waits for livekit_join before connecting`; `voice_state with generations drives setAllowed`.
  - `config.test.ts`: `SPEECH_INGEST=livekit needs no dir`; `STT_MODEL small.en and large-v3-turbo-q5_0 pass; "a b", "../m", 65 characters fail`.
- [ ] **Step 2:** `pnpm install`, then `pnpm --filter @acr/speech exec vitest run`. Expected: FAIL.
- [ ] **Step 3:** Implement; `main.ts` builds the real `RoomPort` only for `SPEECH_INGEST=livekit` (dynamic import of `livekit-room.ts`, so file-ingest runs never load the native module) and exits 3 when the ingest ends by `disconnected` or `failed`.
- [ ] **Step 4:** Re-run plus `pnpm lint:sdk` and `pnpm --filter @acr/speech exec vitest run --coverage`. Expected: PASS, coverage at least 80% lines with `livekit-room.ts` excluded.
- [ ] **Step 5:** Commit `[feat] US-0071: LiveKit audio ingest that subscribes only to recording holders`.

### Task 8: Worker restart with bounded backoff

**Files:** Create `services/control/src/voice/restart.ts`, `src/__tests__/voice/restart.test.ts`; Modify `voice-host.ts` (`workerExited` `:201-213`, `attach` `:77-96`), `src/__tests__/voice/voice-host.test.ts`, `supervisor.voice.test.ts`.

**Interfaces:**
- `RESTART_TRIES = 5`, `RESTART_BASE_MS = 500`; `restartDelay(attempt: 1..5): number` = `500 * 2^(attempt - 1)`.
- `VoiceHost` replaces `workerLost` with `restarts: number` and `voiceOff: boolean` per session: an unexpected exit (not `stopping`, not ended, not closed) while the runtime is up schedules a respawn after `restartDelay(restarts + 1)` on the injected `SetTimer` and sends `voice_alert worker_restarting` on the first restart only; each respawn re-sends `livekit_join` (a fresh worker token, same room) after `worker_ready`, then the current `voice_state`; after the 5th restart's worker also exits, `voiceOff = true`: `voice_alert voice_off` once, `VoiceTokens.voiceOff(sessionId)`, every later token request `voice_unavailable`, no more spawns. The count is per session for the life of the control process (Open Question 3). No restart once the session ended or control is closing; a pending restart timer is cancelled by `end` and `shutdown`. Pending lines and slots of the dead worker are released (Task 6).
- Segment ids: unchanged (random 16 hex); a test pins that a line from the new worker with an id the old worker used while pending is answered normally (the old pending entry was cleared at exit).

- [ ] **Step 1: Write the failing tests** (fake spawn counting calls, manual `SetTimer` recording delays): `the delays are 500, 1000, 2000, 4000, 8000`; `the first restart alerts worker_restarting once, later ones do not`; `after the 5th restarted worker exits: one voice_off alert, no 6th spawn, tokens refused voice_unavailable`; `a restarted worker gets livekit_join after worker_ready and then the current voice_state`; `no restart after end; end cancels a pending restart`; `shutdown cancels a pending restart`; `a worker that never says worker_ready and exits counts as a try`; `the session keeps running throughout` (supervisor status `running`); `pending lines of the dead worker are not answered to the new one`.
  - `supervisor.voice.test.ts`: `a killed worker is restarted and voice lines flow again` (fake runtime child).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/voice`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/control test`; demo V-07 now expects a restart: update the check to "the session keeps running, one `worker_down` or `worker_restarting` alert, a typed line is recorded" (`pnpm demo --voice` 8 of 8). Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: restart the speech worker with bounded backoff`.

### Task 9: Whisper health polling, and the restart window pinned

**Files:** Create `services/speech/src/health.ts`, `src/__tests__/health.test.ts`; Modify `services/speech/src/worker.ts`, `main.ts`, `services/control/src/voice/voice-host.ts`, `src/__tests__/voice/voice-host.test.ts`.

**Interfaces:**
- `STT_HEALTH_POLL_MS = 5000`; `class HealthPoller { constructor(o: { stt: SpeechToText; setTimer; send: (m: WorkerMessage) => void }); start(): void; stop(): void }` — calls `stt.health()` every 5 s (the next poll is armed only after the previous one settled, so a slow health call never stacks), sends `stt_health { ok }` only when the value changes; the poller starts from the warm-up result that `worker_ready` reported, so a failed warm-up followed by a healthy poll sends `ok: true` (recovery). Fake STT: no poller.
- `VoiceHost`: `stt_health false` → `voice_alert stt_unavailable` (the runtime then tells the voice holders, Task 3); `true` after a `false` → `voice_alert stt_recovered`. The runtime's 30 s alert limit and the change-only rule keep it to one alert per change.
- R13 is pinned, not changed.

- [ ] **Step 1: Write the failing tests:** `health.test.ts` (manual timers, scripted health answers): `polls every 5000 ms`; `true, true, false, false, true sends false then true only`; `a health call that hangs delays the next poll instead of stacking`; `stop cancels the timer`. `voice-host.test.ts`: `stt_health false gives one stt_unavailable alert`; `false, true gives stt_recovered`; **`a line sent between a runtime exit and the next ready is refused failed and gives no notice`** and **`the runtime exit sends the worker an empty voice_state before any later line is relayed`** (R13).
- [ ] **Step 2:** Run `pnpm --filter @acr/speech exec vitest run src/__tests__/health.test.ts` and `pnpm --filter @acr/control exec vitest run src/__tests__/voice/voice-host.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus both suites. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: poll Whisper health and tell speakers when voice is down`.

### Task 10: Final notice v3 and its SHA pin

**Files:** Modify `consent/notice-v3.md`, `services/runtime/src/engine/__tests__/consent-notice-v3.test.ts`.

- [ ] **Step 1:** The owner reviews the wording of `consent/notice-v3.md` (it already covers spec 6). Apply the owner's edits, then remove line 1 (the draft marker) and the blank line after it. Do not proceed to Step 2 without the owner's "wording approved" in chat; legal and HR sign-off stays on the go-live checklist (`docs/memory/backlog-and-decisions.md`), not a build gate.
- [ ] **Step 2: Write the failing test:** replace the draft assertion with `the first line is the notice title, not the draft marker` and add `the file's SHA-256 is pinned` (`createHash("sha256")` of the raw bytes equals the constant `NOTICE_V3_SHA256` declared in the test, with a comment: "changing the notice needs a new version file, v4, never an edit of v3"). Keep the phrase checks.
- [ ] **Step 3:** Run `pnpm --filter @acr/runtime exec vitest run src/engine/__tests__/consent-notice-v3.test.ts` before setting the constant. Expected: FAIL; then set the constant to the computed hash and re-run. Expected: PASS.
- [ ] **Step 4:** Run `pnpm --filter @acr/runtime test` (the voice-config refusal still names "v3 or later"; nothing else changes). Expected: PASS.
- [ ] **Step 5:** Commit `[docs] US-0071: final consent notice v3 wording, pinned by its hash`.

### Task 11: BFF player routes: voice choice, mute, token and hub frames

**Files:** Modify `apps/web/src/server/wire.ts`, `stream-hub.ts`, `handlers.ts`, `routes.ts`, `launcher-client.ts`, `config.ts`; Create `apps/web/src/app/api/v1/voice/route.ts`, `apps/web/src/app/api/v1/voice/token/route.ts`, `src/server/__tests__/voice-handlers.test.ts`; extend `stream-hub.test.ts`, `hub.runtime.test.ts`, `launcher-client.test.ts`, `config.test.ts`, `wire.test.ts`.

**Interfaces:**
- `wire.ts`: `ClientMessage` adds `voice_opt_in {noticeVersion}`, `voice_opt_out`, `voice_mute {muted}`; `JoinedFrame.voice?: { state: VoiceState }`; `ServerMessage` adds `{ type: "voice"; state: "voice" | "text_only"; muted?: boolean }` and `{ type: "voice_notice"; code: string }`; `VoiceState = "none" | "voice" | "text_only" | "off"`; `FacilitatorRosterEntry` adds `voice?: VoiceState; speaking?: true`.
- `stream-hub.ts`: `playerJoined` adds `voice` only when `j.voice?.state` is one of the four values (picked, never spread); `SEND_ERRORS` adds the three voice types with codes `voice_off`, `forbidden`, `not_joined`, `consent_version`, `voice_notice_required`, `failed`, `bad_message`, `bad_json`, `rate_limited`, `internal`; for a voice type the waiter also accepts a `voice` frame as its answer and waits `VOICE_SEND_WAIT_MS` (2000); `onFrame` writes `sse("voice_notice", { code })` only for the seven `VOICE_NOTICE_CODES` (a local copy, pinned by `hub.runtime.test.ts` against the runtime's list), drops other codes and drops a stray `voice` frame.
- `handlers.ts`: `handleVoice` (`POST /api/v1/voice`): body exactly one of `{ choice: "voice", noticeVersion }`, `{ choice: "text_only" }`, `{ mute: boolean }` (any other key or a `participantId`/`roleId` key is 400); relays through the hub; 200 `{ state, muted? }` from the `voice` frame, a `null` answer is 504 `unconfirmed` "Your choice was not confirmed. Reload the page to see it."; codes map to BFF sentences (`voice_notice_required`: "Voice needs the current consent notice, which you did not agree to before the start. You can take part by text."; `voice_off`: "Voice is not available in this session."; `consent_version`: as for consent; others as `SEND_ANSWERS`).
- `handleVoiceToken` (`POST /api/v1/voice/token`, no body): Origin and Fetch-Site checks as `relay`; identity from the cookie only; needs `deps.launcher` and `config.livekitUrl`, else 503 `voice_unavailable`; throttle `voiceTokenThrottle` (20 per 60 s keyed by a digest of session, role and participant; 429 with Retry-After); calls `launcher.voiceToken(sessionId, roleId, participantId)` (`LauncherClient.voiceToken`, POST `/sessions/:id/voice-token`, `timeoutMs` default 5 s, reasons `voice_refused`/`voice_unavailable` added to `LauncherReason`); answers `{ token, url: config.livekitUrl, expiresAt }` with `Cache-Control: no-store`; `voice_refused` → 409 "Voice is not available for your seat. Choose voice first, or use the text box."; nothing logged but error names.
- `config.ts`: optional `LIVEKIT_URL` → `livekitUrl?: string` (`wss:` anywhere, or `ws:` only to `127.0.0.1`/`[::1]`; no path, query or user info; error names the variable only).

- [ ] **Step 1: Write the failing tests:**
  - `stream-hub.test.ts`: `joined.voice is forwarded with its state only` (an extra nested key is dropped); `a joined without voice has no voice key`; `voice_notice with a known code becomes a voice_notice event`; `an unknown code is dropped`; `a voice frame without a pending send is dropped`; `voice_opt_in resolves with the voice frame`; `voice_mute times out after 2000 ms to null` (manual timer); `send still refuses an unknown type`.
  - `voice-handlers.test.ts`: `a body with participantId is 400 and nothing is sent`; `choice voice relays voice_opt_in with the notice version`; `voice_notice_required maps to the fixed sentence`; `no answer is 504 unconfirmed`; `token: no cookie is 401`; `token without launcher or LIVEKIT_URL is 503 and calls nothing`; `token answers token, url and expiresAt only, with no-store`; `the 21st token request in 60 s is 429 with Retry-After`; `a cross-site Origin is 403`; `nothing logged contains the token`.
  - `launcher-client.test.ts`: `voiceToken posts roleId and participantId with the service token`; `voice_refused and voice_unavailable become LauncherError reasons`; `a malformed answer is unavailable`.
  - `config.test.ts`: `LIVEKIT_URL wss://pilot.example passes; ws://127.0.0.1:7880 passes; ws://192.168.1.2:7880, https://x, wss://x/path, wss://u:p@x fail`.
  - `hub.runtime.test.ts` (real runtime child with `VOICE_ENABLED=1`, `CONTROL_MANAGED=1`, notice v3): `opt in through the hub answers state voice`; `mute answers muted true`; `the BFF's voice notice codes equal the runtime's VOICE_NOTICE_CODES`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/web test` and `pnpm -r typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: voice choice, mute and token routes in the web server`.

### Task 12: Headers: microphone and LiveKit on the session page only

**Files:** Modify `apps/web/next.config.ts`, `apps/web/src/server/headers.ts`, `apps/web/src/proxy.ts`, `src/server/__tests__/headers.test.ts`.

**Interfaces:** `contentSecurityPolicy(nonce, o: { dev; https; livekit?: string /* the LIVEKIT_URL origin, only for /session pages */ })` adds to `connect-src` the `wss:`/`ws:` origin and the matching `https:`/`http:` origin; `pageHeaders(pathname, csp, o: { microphone: boolean })` sends `microphone=(self)` instead of `microphone=()` only when `o.microphone` (proxy passes `pathname` under `/session/` and `LIVEKIT_URL` set). `next.config.ts` keeps its static Permissions-Policy for every path except `/session/:path*` (two `headers()` rules; the static rule's `source` excludes `session`).

- [ ] **Step 1: Write the failing tests:** `a session page with LIVEKIT_URL gets microphone=(self) and connect-src with the wss and https origins`; `a session page without LIVEKIT_URL keeps microphone=()`; `the console, join and report pages keep microphone=() and connect-src 'self'`; `the static header rules do not cover /session/x` (call `config.headers()` and check the sources); `camera=() and geolocation=() stay everywhere`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/headers.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run; the response-header truth (one Permissions-Policy header on `/session/x`) is asserted in Task 17. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: allow the microphone and LiveKit on the session page only`.

### Task 13: Console copies: voice fields and voice alert sentences

**Files:** Modify `apps/web/src/server/console-roster.ts`, `facilitator-copies.ts`, `src/server/__tests__/facilitator-copies.test.ts`, `console-sessions.test.ts`, `stream-hub.test.ts`.

**Interfaces:** `entryOf` adds `voice` only when it is one of the four states and `speaking: true` only when exactly `true`; `peerEntryOf` unchanged. `facilitator-copies.ts` gains `VOICE_ALERT_SENTENCES_COPY: readonly string[]` (the six fixed runtime sentences); a `facilitator.alert` whose `message` equals one of them exactly is copied with that message, every other alert keeps the per-level fixed line.

- [ ] **Step 1: Write the failing tests:** `entryOf keeps voice and speaking and drops voice: "loud" and speaking: 1`; `a peer entry never gains voice or speaking even if the runtime sent them`; `each voice alert sentence passes through exactly`; `a sentence with one extra character is replaced by the fixed line`; `the copy list equals the runtime's VOICE_ALERT_SENTENCES values` (import by relative path from `services/runtime/src/host/session-host.ts`, as the `.runtime` tests reach `main.ts`); readiness: `voice does not change missing or ready`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/server/__tests__/facilitator-copies.test.ts src/server/__tests__/console-sessions.test.ts src/server/__tests__/stream-hub.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: voice state and voice alerts in the console copies`.

### Task 14: Participant page: voice choice, voice state and notices

**Files:** Modify `apps/web/src/lib/use-session.ts`, `apps/web/src/lib/messages.ts`, `apps/web/src/components/SessionScreen.tsx`; Create `apps/web/src/components/VoiceChoice.tsx`, `components/VoiceNotices.tsx`, `src/components/__tests__/VoiceChoice.test.tsx`, `__tests__/VoiceNotices.test.tsx`; extend `src/lib/__tests__/use-session.test.ts`.

**Interfaces:**
- `Joined.voice?: VoiceState` (parsed only from the four values); `SessionUi.voice: { state: VoiceState; muted: boolean } | null`, `SessionUi.voiceNotice: { code: string; n: number } | null`; actions `voice` (from a route answer) and `voice_notice` (from the named event, known codes only); `useSession` returns `chooseVoice(choice)`, `setMuted(muted)`.
- `MESSAGES` adds (exact copy): `voiceChoiceTitle` "How do you want to take part?"; `voiceWith` "Take part with voice"; `voiceText` "Take part by text only"; `voiceInsecure` "Voice needs a secure connection to this page. Use the text box."; `voiceNoticeRequired` (as Task 11); notices: `stt_failed` "Your last spoken line could not be turned into text. Please say it again or type it."; `empty` "We did not catch that. Please say it again or type it."; `paused` "The scene is paused; what you said was not recorded."; `not_in_scene` "You are not in this scene, so what you said was not recorded."; `ended` "The session has ended; what you said was not recorded."; `not_recording` "Voice is off for your seat; what you said was not recorded."; `voice_unavailable` "Voice is unavailable right now. Use the text box."
- `VoiceChoice` (shown in the lobby and in the scene when `joined.voice` exists, the seat is not `off`, and consent is given): a `fieldset` with two radio buttons and a "Save choice" button; states "Voice: on", "Voice: off (text only)", "Voice: not chosen" in words with an icon (`aria-hidden`); when `window.isSecureContext` is false or `navigator.mediaDevices` is missing, the voice option is disabled with `voiceInsecure`.
- `VoiceNotices`: one `<p role="status" aria-live="polite">` that shows the latest notice sentence; the same code twice in a row is re-announced (keyed by `n`).

- [ ] **Step 1: Write the failing tests:** `use-session.test.ts`: `joined.voice "voice" is parsed; "loud" is dropped`; `a voice_notice event with a known code sets voiceNotice; an unknown code is ignored`; `chooseVoice posts {choice, noticeVersion} and applies the answer`. `VoiceChoice.test.tsx`: `not shown when voice is absent or off or consent not given`; **`insecure context shows the secure-connection sentence`** and the voice radio is disabled; `the state is in words, the icon is aria-hidden`; `keyboard: Tab reaches the radios and the button, Space selects, Enter saves`; `voice_notice_required shows its sentence and the state stays text only`. `VoiceNotices.test.tsx`: `the region is polite`; `each code shows its sentence`; `a repeated code is announced again`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/__tests__/VoiceChoice.test.tsx src/components/__tests__/VoiceNotices.test.tsx src/lib/__tests__/use-session.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement; no `getUserMedia` call anywhere in these components.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: voice choice and private voice notices on the participant page`.

### Task 15: Mic check, "Join with voice" and mute

**Files:** Create `apps/web/src/lib/voice-client.ts`, `lib/livekit-room-browser.ts` (the only file that imports `livekit-client`), `lib/mic-level.ts`, `components/MicCheck.tsx`, `components/MicButton.tsx`, tests `src/lib/__tests__/voice-client.test.ts`, `mic-level.test.ts`, `src/components/__tests__/MicCheck.test.tsx`, `MicButton.test.tsx`; Modify `SessionScreen.tsx`, `apps/web/package.json` (`"livekit-client": "2.23.0"`), `apps/web/vitest.config.ts` (exclude `livekit-room-browser.ts` from coverage), `pnpm-lock.yaml`.

**Interfaces:**
- `interface BrowserRoom { connect(url: string, token: string): Promise<void>; enableMicrophone(): Promise<void>; disableMicrophone(): Promise<void>; disconnect(): Promise<void>; onDisconnected(fn: () => void): void }` implemented in `livekit-room-browser.ts` with `Room` and `localParticipant.setMicrophoneEnabled(true|false, { echoCancellation: true, noiseSuppression: true, autoGainControl: true })` (mute unpublishes: `setMicrophoneEnabled(false)`; whether 2.23.0 unpublishes or only mutes the track by default is NOT verified: the live check records it, and the wrapper calls `unpublishTrack` explicitly if it only mutes).
- `class VoiceClient { constructor(o: { room: () => BrowserRoom; fetchToken: () => Promise<{ ok: true; token: string; url: string } | { ok: false; message: string }>; postMute: (muted: boolean) => Promise<ActionResult> }); join(): Promise<ActionResult>; mute(): Promise<ActionResult>; unmute(): Promise<ActionResult>; leave(): Promise<void>; get state(): "idle" | "connecting" | "live" | "muted" | "failed" }` — `join` fetches a token, connects, enables the microphone; a connect failure gives `failed` with "Voice could not connect. Use the text box." and no retry loop (the person can press Join again); `mute` disables the microphone FIRST, then posts `{mute: true}` (a failed post keeps the local mute and shows the error); `unmute` posts first, then enables.
- `micLevel(stream: MediaStream, onLevel: (dbfs: number) => void): () => void` in `mic-level.ts` (AudioContext analyser, about 10 updates a second through `requestAnimationFrame`, injectable for tests).
- `MicCheck` (lobby, after `voice` is the saved choice): button "Check my microphone" → `getUserMedia({ audio: true })` (the first and only place that asks for permission) → a `<meter>` labelled "Microphone level" plus words "Hearing you" / "Too quiet" / "No sound yet", headset guidance text; "Stop the check" releases the tracks; a `NotAllowedError` shows "The browser did not allow the microphone. You can take part by text, or allow the microphone and try again."
- `MicButton` (scene and lobby when the choice is voice): "Join with voice", then "Mute" / "Unmute" (`aria-pressed`), state in words ("Microphone on" / "Microphone muted" / "Voice not connected") with an icon; "Stop using voice" opts out (Task 14's `chooseVoice("text_only")`) and leaves the room.

- [ ] **Step 1: Write the failing tests** (jsdom, fake `navigator.mediaDevices`, fake `BrowserRoom`, manual animation frames):
  - `MicCheck.test.tsx`: **`no getUserMedia call on render`**; `getUserMedia is called only after the click`; `the meter and the words follow the level`; **`a denied permission shows the denied sentence and stays text only`**; `stop releases every track`; Axe-like checks with `@testing-library` roles (`meter` has a name).
  - `voice-client.test.ts`: `join fetches the token, connects with url and token, then enables the microphone`; `a connect failure is failed with the fixed sentence and does not retry`; **`mute disables the microphone before posting`**; `unmute posts before enabling`; `a failed mute post keeps the microphone off`; `leave disconnects`; `a room disconnect moves to failed with the sentence`.
  - `MicButton.test.tsx`: `aria-pressed follows mute`; `state shown in words with an aria-hidden icon`; `keyboard operable`; `Stop using voice opts out and leaves`.
  - `mic-level.test.ts`: `silence gives -Infinity mapped to the floor`; `a full-scale tone gives about 0 dBFS`; `the returned stop disconnects the analyser`.
- [ ] **Step 2:** `pnpm install`, then `pnpm --filter @acr/web exec vitest run src/lib/__tests__/voice-client.test.ts src/lib/__tests__/mic-level.test.ts src/components/__tests__/MicCheck.test.tsx src/components/__tests__/MicButton.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. `SessionScreen` creates the `VoiceClient` lazily on the first "Join with voice" (the `livekit-client` chunk is loaded by a dynamic `import()` then, not on page load).
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/web test`, `pnpm --filter @acr/web exec next build --webpack`, `pnpm lint:sdk`, `pnpm audit --audit-level=high`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: mic check, join with voice and mute`.

### Task 16: Console speaking indicator and the voice column

**Files:** Create `apps/web/src/components/console/VoicePanel.tsx`, `console/SpeakingIndicator.tsx`, tests `src/components/console/__tests__/VoicePanel.test.tsx`; Modify `components/console/LiveView.tsx`, `components/console/Readiness.tsx` (a "Voice" column next to "Consented", `:512`, shown only when an entry carries `voice`), `src/lib/use-console-stream.ts` (keeps the picked fields).

**Interfaces:** `VoicePanel({ roster })` renders one row per human seat with `voice`: name or role label, "Voice on" / "Text only" / "Not chosen" / "Voice off", and `SpeakingIndicator({ speaking })`: "Speaking" with an icon, or "Quiet"; rendered only when at least one entry has `voice`. Alerts already show through the timeline (Task 13).

- [ ] **Step 1: Write the failing tests:** `the panel is absent in a text-only session`; `speaking shows the word Speaking and an aria-hidden icon`; `an AI seat is not listed`; `Readiness shows the voice column only with voice entries`; `the speaking state change is announced politely once, not on every roster`.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec vitest run src/components/console`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run plus `pnpm --filter @acr/web test`. Expected: PASS.
- [ ] **Step 5:** Commit `[feat] US-0071: speaking indicator and voice state in the console`.

### Task 17: End to end: the browser flow, headers and Axe

**Files:** Create `apps/web/e2e/voice-lobby.spec.ts`; Modify `apps/web/e2e/helpers/start-launcher-stack.ts` (option `voice?: true`: control env `VOICE_ENABLED=1`, `CONSENT_NOTICE_VERSION=v3`, `STT_PROVIDER=fake`, `STT_FAKE_SCRIPT` and an empty `SPEECH_INGEST_DIR` in the temp tree, `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` random per stack, `LIVEKIT_HOST=http://127.0.0.1:<closed port>`; web env `LIVEKIT_URL=ws://127.0.0.1:<closed port>`).

**Interfaces:** the spec uses `test.use({ launchOptions: { executablePath, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-audio-capture=<tmp>/voice.wav"] } })` (the WAV, 2 s of a 440 Hz tone at -12 dBFS, is written by the spec with `encodeWav` from `@acr/adapters`) and `context.grantPermissions(["microphone"])`; LiveKit's signalling socket is answered by `page.routeWebSocket(/127\.0\.0\.1:\d+\/rtc/, (ws) => ws.close())`.

- [ ] **Step 1: Write the failing tests** (each with an explicit 120 s limit, no retries):
  - `the session page response has one Permissions-Policy header with microphone=(self) and a CSP whose connect-src names the LiveKit origin`; `the console page keeps microphone=()`.
  - `on load no microphone is requested` (`page.evaluate` wraps `navigator.mediaDevices.getUserMedia` in an init script that counts calls: 0 after load and after consent).
  - `after consent to v3 the voice choice is offered; choosing voice shows Voice: on`.
  - `the mic check shows a level from the fake device and the words Hearing you`.
  - `Join with voice fetches a token (the request answers 200 with token, url and expiresAt only) and, with LiveKit unreachable, shows Voice could not connect and keeps the text box usable` (a typed line is still recorded).
  - `a second participant's page never shows the first participant's voice state` (DOM and SSE frames of the second page: no `voice` in roster frames).
  - `the console readiness shows the voice column with Voice on for the first seat`.
  - Axe (serious or critical = 0) on: the lobby with the voice choice, the mic check running, the scene with MicButton.
- [ ] **Step 2:** Run `pnpm --filter @acr/web exec next build --webpack && pnpm --filter @acr/web exec playwright test voice-lobby --trace off`. Expected: FAIL before the stack option exists.
- [ ] **Step 3:** Implement the helper option.
- [ ] **Step 4:** Re-run, then the whole e2e suite once (`playwright test --trace off`). Expected: PASS (set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when the pinned Chromium is missing).
- [ ] **Step 5:** Commit `[test] US-0071: browser voice lobby flow with a fake microphone`.

### Task 18: Opt-in live check against a real LiveKit server

**Files:** Create `services/control/src/__tests__/voice/livekit.live.test.ts` (`describe.skipIf(process.env.VOICE_LIVE !== "1")`), a short "Live check" paragraph in `docs/memory/demo-and-testing.md`.

**Interfaces:** reads `LIVEKIT_HOST`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` from the environment (a local `livekit-server --dev` is acceptable for this check only, never for a pilot); uses `@acr/speech`'s `RoomPort` (through a test-only import of `services/speech/src/ingest/livekit-room.ts` by relative path) as a stand-in publisher and the worker as the subscriber.

- [ ] **Step 1: Write the test:** `a participant token can publish a microphone track and cannot subscribe` (the server refuses a subscribe); `the worker subscribes only to the allowed identity`; `removeParticipant drops the publisher within 10 s` (`vi.waitFor`, generous); `frames arrive as 320-sample 16 kHz frames`; records in its output whether `setMicrophoneEnabled(false)` unpublished (cross-check for Task 15).
- [ ] **Step 2:** Run `pnpm --filter @acr/control exec vitest run src/__tests__/voice/livekit.live.test.ts`. Expected: SKIPPED (no `VOICE_LIVE`).
- [ ] **Step 3:** Commit `[test] US-0071: opt-in live check against a LiveKit server`. The owner (or an agent with the owner's go-ahead) runs it with `VOICE_LIVE=1` before the room test; the result goes into `progress.md`.

### Task 19: Documents, gates, review and the PR

**Files:** Modify `docs/TEST_CASES.md`, `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`, `docs/THREAT_MODEL.md`, `docs/ROLLBACK.md`, `docs/ARCHITECTURE.md`, `docs/memory/models-and-providers.md`, `docs/memory/architecture-and-security.md`, `docs/memory/demo-and-testing.md`, `docs/memory/backlog-and-decisions.md`, `.env.example`, `CHANGELOG.md`, `MEMORY.md` (fact 26 or a new fact; the dependency list), `progress.md`, `findings.md`.

- [ ] **Step 1: Test cases.** One TC per AC of Task 0 (AC-a to AC-l) with the test names of the tasks, plus edge TCs: the subscription gate (Review Focus 1), identity removal versus a plain disconnect (2, 3), restart then voice off (4), insecure context and denied permission (5), headers (Task 12), and a "Browser matrix" note: Chromium tested; Safari, Firefox and mobile browsers untested (F21).
- [ ] **Step 2: Threat model.** New section "Voice in the browser and LiveKit, slice A1b (US-0071)": the token path (control only, service token, BFF throttle, cookie identity, 600 s, microphone only, no subscribe, no data), why removal and not revocation (a JWT cannot be revoked; a connected participant keeps its connection past the TTL until removed), seat generations (HMAC, per-session key in memory, lost on restart by design), the worker's hidden identity and subscription gate, unguessable room names, LiveKit keys in control's environment only, the CSP and Permissions-Policy change limited to `/session/*`, the global STT budget (a stuck worker holds at most its slots until its deadlines release them), restart limits, R13 (documented, not fixed), `voice_mute` in memory only, and the residual risks (same-room cross-talk; LiveKit `--dev` keys must never be used; the room survives a control restart until its empty timeout).
- [ ] **Step 3: Rollback** (`docs/ROLLBACK.md`, "US-0071"): `VOICE_ENABLED=0` and unset `LIVEKIT_URL` turn the browser path off; no log, consent or voice-record format change (`voiceChosen` and `generation` are new IPC fields between processes of one checkout, no skew); notice v3's hash is pinned, so a rolled-back build shows the draft text only if `CONSENT_NOTICE_VERSION=v3` is set: keep it unset when rolling back.
- [ ] **Step 4: Architecture, settings, memory.** ARCHITECTURE: the token route and the subscription gate. `docs/memory/models-and-providers.md` and `.env.example`: `LIVEKIT_URL` (web), `LIVEKIT_HOST`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (control, placeholders only), `SPEECH_INGEST=livekit`, `STT_MODEL` validation, the constants (restart, health, global budget, token TTL). `findings.md`: one row each for `livekit-server-sdk` 2.19.2 (Apache-2.0, released 2026-10-22), `@livekit/rtc-node` 1.2.1 (Apache-2.0, 2026-10-22; native bindings for darwin-arm64/x64, linux-x64/arm64 glibc, win32-x64; no musl), `livekit-client` 2.23.0 (Apache-2.0, 2026-10-16), and the `pnpm audit` result. MEMORY: the dependency section and a short A1b entry. backlog-and-decisions: the decisions taken (K1 to K8, the R13 decision, the Open Questions' answers).
- [ ] **Step 5: Changelog and progress.** `CHANGELOG.md` `[Unreleased]` Added: "Voice in the browser behind `VOICE_ENABLED` (off by default; not for participants until the release gate): voice choice, microphone check, mute, LiveKit tokens, console speaking indicator." `progress.md`: the session entry with the gate results.
- [ ] **Step 6: Gates** (record each; never claim one that was not run):
  - `pnpm -r typecheck` clean; `pnpm test:coverage` twice, once under load (`for i in 1 2 3 4 5 6 7 8; do yes > /dev/null & done` ... `kill %1 ... %8`), every package at least 80% lines.
  - `pnpm lint:sdk` and `bash scripts/check-sdk-imports.test.sh` ok; `npx eslint .` 0 errors; `pnpm audit --audit-level=high` clean.
  - `pnpm --filter @acr/web exec next build --webpack`; Playwright `voice-lobby axe participant-flow console-flow --trace off` pass.
  - Linux container run (AGENTS.md §8, `git archive` tree, root and `--user node`): `services/control/src/__tests__/voice/*.test.ts` (restart, slots, tokens, voice-host, voice.real), `services/speech/src/__tests__/main.process.test.ts`, `livekit-ingest.test.ts`, `services/control/src/__tests__/demo/voice-demo.test.ts`; also `pnpm install --frozen-lockfile` in the container proves rtc-node's linux-x64 binary resolves (record the architecture).
  - `npx jest tests/unit/id-registry.test.js`; `pnpm --filter @acr/runtime exec vitest run src/__tests__/id-rules.files.test.ts`.
  - `pnpm demo --voice` 8 of 8 and `pnpm demo --fast` 29, `--fast --security --resume` 42, `--showcase --fast` 14, `pnpm demo --web` 8 (a text-only session is unchanged).
  - `npm run plan:generate`.
- [ ] **Step 7: Independent review.** A fresh reviewer on the most capable model gets the diff (excluding `docs/plan-status.*`) and the spec, not this plan's conclusions, with probes requested for: the subscription gate (a published track of a non-holder, before the start, muted, a stale generation), token grant and route refusals, identity removal versus disconnects, the global STT budget under a dying worker, restart limits and timers, the CSP and Permissions-Policy scope, `voice_notice` leaks, and the page's microphone timing. Fix Critical and Important findings test-first; file Minor ones as BUGs.
- [ ] **Step 8:** Commit `[docs] US-0071: close out the LiveKit and consent slice`, push, open the PR into `develop` (title in the commit format, body references US-0071 and ends with the Claude Code line), wait for green CI. US-0071 stays In Progress until merged; tick each AC with its test names.

---

## Open Questions (owner; recommended default in parentheses, used by the tasks above)

1. **Peers and voice.** Should other players see that a seat speaks by voice (for example "voice" beside a name)? (No: peers see nothing about voice; the transcript already shows every line. Spec 6: "A player's own frame carries only their own choice".)
2. **Tokens while paused or before the start (K1).** (Issue them; the worker does not subscribe until the session has started and is not paused. Refusing would force a reconnect after every pause.)
3. **Restart budget.** 5 restarts per session for the life of the control process, or 5 consecutive failures with the count reset after a worker has run for some time? (5 per session: bounded and simple; a session that loses its worker five times has a real fault.)
4. **Mute after a reconnect.** A released holder comes back unmuted in the runtime; the page has unpublished anyway after a reload. (Accept; the microphone is only live after "Join with voice".)
5. **Notice v3 wording.** Task 10 needs the owner's "wording approved"; legal and HR sign-off stays on the go-live checklist. (Approve the current text with any edits you want; the hash pins whatever is approved.)
6. **`LIVEKIT_URL` for local development** (`ws://127.0.0.1:<port>`) is accepted by the web config; the pilot needs `wss://`. (Accept loopback `ws:` only.)
7. **`STT_MODEL`.** Validated in A1b, used only from A1c (`voice:up`). (Accept.)
8. **The voice token throttle** (20 per 60 s per participant). (Accept; a page needs one per join and one per reconnect.)

## Not verified by this plan

- No LiveKit server, browser, worker or test was run. The LiveKit APIs named above (`AccessToken`, `addGrant`, `RoomServiceClient.removeParticipant`/`deleteRoom`, rtc-node `Room` with `autoSubscribe: false`, `setSubscribed`, `AudioStream` at 16 kHz mono, livekit-client `Room` and `setMicrophoneEnabled`) are from the packages' public documentation as known, not read from the installed sources; Tasks 4, 7, 15 and 18 confirm them, and Task 4 fixes the exact JWT claim shape of `canPublishSources`.
- Whether `setMicrophoneEnabled(false)` in livekit-client 2.23.0 unpublishes or only mutes (Task 15 handles both; Task 18 records it).
- Whether livekit-client needs an `https:` request to the LiveKit host besides `wss:` (R16 allows both on `/session/*` only).
- Whether two Permissions-Policy headers would be merged or conflict (avoided by Task 12; asserted on real responses in Task 17).
- rtc-node's frame size, its behaviour after the 10-minute token TTL on a long connection (LiveKit refreshes tokens of connected participants: not observed here), and its macOS firewall behaviour (spec 11 notes the native LiveKit binary failed in the spike).
- Safari, Firefox and mobile browsers (F21); a real LAN (UDP versus TCP, DNS rebinding).
- `npm view` was read-only metadata: versions, licences, release dates and the native binary list (R20). No package was installed or downloaded.
