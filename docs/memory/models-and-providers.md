# Models and providers

## Providers (`packages/adapters/src/model`)
- `MODEL_PROVIDER`: `mock` (default, scripted), `anthropic`, `openrouter`, `local` (any OpenAI-compatible server; `LOCAL_BASE_URL`). OpenRouter and local use fetch + SSE with no SDK, `redirect: "error"`, key redaction. Provider SDKs may only be imported inside `packages/adapters` (`pnpm lint:sdk`).
- Configuration is read from `.env` at the repository root; real environment variables win, except that an EMPTY real `FACILITATOR_TOKEN` is treated as unset.
- Errors are typed (`ModelProviderError`: kind, transient, status, retryAfterMs). `RetryingModelProvider` retries only before the first chunk. A reasoning model that spends its budget thinking gives the retryable kind `reasoning_budget`; reasoning text is never shown.

## Environment variables (defaults)
| Variable | Default | Notes |
| --- | --- | --- |
| `NPC_MODEL`, `GM_MODEL`, `EVAL_MODEL` | `claude-sonnet-5.5`; `EVAL_MODEL` falls back to `NPC_MODEL` | `--player-model` picks the player-bot model |
| `NPC_FIRST_TOKEN_TIMEOUT_MS` / `NPC_REPLY_TIMEOUT_MS` | 10000 / 20000 | local `.env` uses 120000 / 240000 for slow local models |
| `NPC_MAX_TOKENS`, `GM_MAX_TOKENS`, `EVAL_MAX_TOKENS` | 600, 400, 3000 | a bigger budget needs a longer first-token timeout (thinking happens before the first word) |
| `NPC_TEMPERATURE`, `PLAYER_TEMPERATURE`, `GM_TEMPERATURE`, `EVAL_TEMPERATURE` | 0.8, 0.9, 0.2, 0.2 | sent only when set |
| `MODEL_MAX_RETRIES`, `MODEL_RETRY_BASE_MS` | 2, 500 | worst case per Game Master evaluation: 2 x (1 + retries) requests inside `GM_TIMEOUT_MS` |
| `GM_TIMEOUT_MS`, `GM_REASK`, `GM_EVERY_N_UTTERANCES`, `GM_TRACE_FILE` | max(reply timeout, 60 s), on, 3, off | trace file must not be a `*.jsonl` in the sessions dir |
| `GM_TRANSCRIPT_WINDOW` | 40 (10..500, >= `GM_EVERY_N_UTTERANCES`) | US-0019: least number of latest scene lines in a Game Master prompt; widened to every line since the last answered prompt of that condition (cap 500, alert beyond), plus the first 2 scene lines and each AI character's last 2 with the line before each; `{"omitted": n}` markers in place |
| `GM_AUTO_RELEASE` | 0 | US-0034: 1 lets the Game Master release an earned fact itself |
| `EVAL_TIMEOUT_MS`, `EVAL_TRANSCRIPT_CHARS` | 180000 | evaluator calls, one per player plus one for the group |
| `FACILITATOR_TOKEN`, `RUNTIME_HOST`, `ALLOWED_ORIGINS`, `TRUST_PROXY`, `WS_*` | token unset (server open, loud warning) | see `docs/THREAT_MODEL.md` |
| `SESSION_START`, `SESSION_LOCK_STALE_MS` | `resume`, 30000 (10000 to 600000) | `fresh` moves the old log aside |
| `CONSENT_NOTICE_VERSION` | `v2` | runtime reads `consent/notice-<v>.md`; does not start without it; v2 (default since slice 2b-3a) names AI player seats, v1 stays as the record; bump = new file + new value + restart (THREAT_MODEL "Consent notice versions") |
| Web app (`apps/web`, read by `next start`/`next dev`, NOT from the root `.env`): `RUNTIME_URL`, `PUBLIC_ORIGIN`, `COOKIE_KEYS` | required | `COOKIE_KEYS=id:base64key,...` newest first, 32-byte keys |
| `COOKIE_MAX_AGE_HOURS`, `WEB_MAX_STREAMS`, `WEB_MAX_STREAMS_PER_SESSION`, `WEB_MAX_STREAMS_PER_ADDRESS` | 12, 200, 64, 16 | the runtime behind the web app needs `TRUST_PROXY=1`, loopback bind |

## Voice input, slice A1a (EPIC-0003, US-0070; off by default)
Speech-to-text sits behind `SpeechToText` (`packages/adapters/src/speech`: `transcribe`, `health`, `warmUp`). Implementations: `WhisperHttpSpeechToText` (whisper.cpp `whisper-server`, POST `<STT_URL>/inference`, `response_format=verbose_json`, `temperature=0.0`, 16 kHz mono 16-bit WAV, body read capped at 256 KiB, `redirect: "manual"`, health `GET <STT_URL>/health` with a 2 s abort) and `FakeSpeechToText` (scripted; the demo and tests). `LimitedSpeechToText` wraps the Whisper client in the worker: at most **2** calls in flight **per worker** (one worker per voice session, so not yet the global cap the owner agreed; moving it to control is an A1b task), FIFO queue (nothing dropped; an item past its deadline fails without a call; a warning line at 16 queued), every call aborted at its deadline (segment deadline **5 s**, `STT_DEADLINE_MS`), transient errors retried at most **2** times after **150** then **300** ms and never past the deadline, a refusal never retried. **Cold start** (owner preference 2026-11-08): while no answer has come since the start, after `STT_IDLE_COLD_MS` without a call, or while another cold call is pending, a call's deadline is `max(segment deadline, now + STT_COLD_TIMEOUT_MS)`; warm-up runs under the cold deadline. Errors (named for the taxonomy): `SpeechUnavailableError` (network, 5xx; transient), `SpeechTimeoutError` (deadline or abort; transient), `SpeechRefusedError` (4xx, a non-2xx below 500, an unreadable or oversized answer; not transient); messages are fixed sentences and keep no cause. Every implementation passes `speechToTextContract`. Not verified: a real whisper-server's JSON (F1, the opt-in `STT_LIVE=1` test), its speed under a generating local model, and real voices.

| Variable | Default | Range and notes |
| --- | --- | --- |
| `VOICE_ENABLED` (runtime) | 0 | exactly 0 or 1 (`true` is refused); with 1 the runtime needs `CONTROL_MANAGED=1` and `CONSENT_NOTICE_VERSION` v3 or later (v3 is a DRAFT, not for participants); in `CHILD_ENV_ALLOWLIST` |
| `TURN_END_MS` (runtime) | 800 | 300 to 3000 ms after the last speech frame before the NPC round, Game Master and AI players react; read only with `VOICE_ENABLED=1` (a stray value never stops a text-only session); in `CHILD_ENV_ALLOWLIST` |
| `VOICE_HANGOVER_MS` (worker) | 500 | 300 to 600 |
| `VOICE_MAX_SEGMENT_MS` (worker) | 2500 | 2000 to 6000; forced split at the quietest frame of the last 1 s |
| `STT_PROVIDER` (worker) | `whisper` | `whisper` or `fake` |
| `STT_URL` (worker) | none (required for `whisper`) | `http://127.0.0.1:<port>[/<path>]` or `http://[::1]:<port>[/<path>]` only |
| `STT_COLD_TIMEOUT_MS` (worker) | 30000 | 1000 to 300000 |
| `STT_IDLE_COLD_MS` (worker) | 600000 | 1000 to 86400000 |
| `STT_MODEL` (worker) | unset | since A1b validated at the worker's start (1 to 64 characters, every `.`-separated part a safe id, e.g. `small.en`, `large-v3-turbo-q5_0`) but otherwise unread; what it selects is A1c (`pnpm voice:up`) |
| `STT_FAKE_SCRIPT` (worker) | none (required for `fake`) | absolute path of `{"<roleId>": ["line", ...]}`; calls logged to `<file>.calls.jsonl` (role and number only) |
| `SPEECH_INGEST` (worker and control) | `file` | `file` or `livekit` (A1b); control refuses to start with `livekit` and no LiveKit keys, and issues voice tokens only with `livekit` |
| `SPEECH_INGEST_DIR` (worker) | none (required for `file` only) | absolute directory of `<roleId>.wav` (16 kHz mono 16-bit, at most 100 MiB) |
| `SPEECH_INGEST_ROLES` (worker) | set by control | the session's player roles; never copied from the parent environment |

The worker's environment is exactly `SPEECH_ENV_ALLOWLIST` (`services/control/src/voice/speech-env.ts`): `PATH`, `VOICE_HANGOVER_MS`, `VOICE_MAX_SEGMENT_MS`, `STT_URL`, `STT_MODEL`, `STT_PROVIDER`, `STT_FAKE_SCRIPT`, `STT_COLD_TIMEOUT_MS`, `STT_IDLE_COLD_MS`, `SPEECH_INGEST`, `SPEECH_INGEST_DIR`, the `NODE_` prefix, plus `SPEECH_INGEST_ROLES` and, set from control's own values and never the parent environment, `SPEECH_LOG_IDENTITY` (32 lower-case hex; the worker refuses anything else), `SPEECH_SESSIONS_DIR` (absolute; for the disk guard), and `AUDIO_DIR` and `AUDIO_MIN_FREE_MB` from control's parsed config (US-0073 ruling R10: an inherited value is overridden, so the default `<CONTROL_DATA_DIR>/audio` that control audits and sweeps is the one the worker records into); all four are set only when the session has a valid log identity; the worker records audio only when `AUDIO_DIR`, `SPEECH_LOG_IDENTITY` and `SPEECH_SESSIONS_DIR` are all present; never `HOME`, `LAUNCHER_TOKEN`, `FACILITATOR_SECRET`, a provider key or `LIVEKIT_*`. `CHILD_ENV_ALLOWLIST` (runtime) gained only `VOICE_ENABLED` and `TURN_END_MS`; the worker settings never reach a runtime. Fixed in code, not settings: the segmenter's -45 dBFS threshold, 20 ms frames, 200 ms lead-in, 300 ms minimum speech; the noise gate's -50 dBFS, no-speech 0.6, log-probability -1.0, short segment 400 ms; control's 10 s line timeout (`VOICE_LINE_TIMEOUT_MS`) and 256 pending lines (`MAX_PENDING_LINES`); the runtime's 10 s per role and code between speaker notices and 30 s per code between alerts, at most 8 alerts kept before the start (one per code), and the 12 s no-news backstop of a speaking track (`VOICE_ACTIVITY_STALE_MS`).

## Voice in the browser and LiveKit, slice A1b (EPIC-0003, US-0071; off by default)
Who reads what (verified against `apps/web/src/server/config.ts` `liveKitOrigin`, `services/control/src/voice/livekit-config.ts` `parseLiveKitConfig`, `services/speech/src/config.ts`):

| Variable | Read by | Default | Range and notes |
| --- | --- | --- | --- |
| `LIVEKIT_URL` | web app only | unset | `wss://<host>[:port]` (any host), or `ws://127.0.0.1:<port>` / `ws://[::1]:<port>` with an explicit port; no path, query, fragment or credentials (`localhost` refused). Checked even with `VOICE_ENABLED=0`: an invalid value fails the config load of every API route. Unset: no voice transport (token route 503, voice option disabled). A valid value opens `microphone=(self)` and the LiveKit `connect-src` on `/session/<id>` whatever `VOICE_ENABLED` says |
| `LIVEKIT_API_KEY` | control only | unset | 1 to 256 printable characters, no space; both key and secret or neither; never `--dev` keys |
| `LIVEKIT_API_SECRET` | control only | unset | 32 to 512 printable characters, no space; a secret |
| `LIVEKIT_HOST` | control only | `http://127.0.0.1:7880` | `http://127.0.0.1:<port>` or `http://[::1]:<port>`, no path, user, query or fragment; set without the keys is an error. The worker's signalling URL `ws://<host>:<port>` is derived from it and sent over IPC |

The LiveKit settings are checked whenever they are set, even with `VOICE_ENABLED=0` (a bad one stops control's start, naming variables only). Tokens are issued only with the keys AND `SPEECH_INGEST=livekit` (`voiceTokensWanted`). The keys never reach a runtime (`CHILD_ENV_ALLOWLIST`), a speech worker (`SPEECH_ENV_ALLOWLIST`, which also keeps `RUST_LOG` and `LIVEKIT_DEBUG_LOG_ROOM_EVENTS` out) or the web app; the worker gets a fresh 600 s token per seat room over IPC. A LiveKit worker needs a glibc host (rtc-node's native binding has no musl build).

Constants (code only, not settings): `VOICE_TOKEN_TTL_S` 600 (adapters `livekit/token.ts`); `MAX_IDENTITY_CHARS` 128; `SEATS_WAIT_MS` 1000, `MAX_WAITERS_PER_ROLE` 4, `SWEEP_INTERVAL_MS` 20 000, `SWEEP_RETRY_MS` 2000 (control `voice/tokens.ts`); `RESTART_TRIES` 5, `RESTART_BASE_MS` 500 (500, 1000, 2000, 4000, 8000), `RESTART_STABLE_MS` 60 000 (`voice/restart.ts`); `STT_GLOBAL_IN_FLIGHT` 2 across all sessions, lease `STT_COLD_TIMEOUT_MS` + `STT_LEASE_MARGIN_MS` 5000 (`voice/stt-slots.ts`); `STT_HEALTH_POLL_MS` 5000, `STT_HEALTH_CONFIRM` 2 (speech `health.ts`); `LIVEKIT_JOIN_WAIT_MS` 10 000 (speech `worker.ts`), `JOIN_RETRY_MS` 1000, `JOIN_ATTEMPTS` 3, `MAX_TRACK_RESTARTS` 5 (`ingest/livekit-ingest.ts`), `SUBSCRIBE_WAIT_MS` 10 000 (`ingest/livekit-room.ts`); BFF `VOICE_SEND_WAIT_MS` 2000 (`stream-hub.ts`) and `VOICE_TOKEN_THROTTLE` 20 per 60 s, 60 s block (`handlers.ts`). Cold-start contention: with the global budget of 2, one session's cold call (up to `STT_COLD_TIMEOUT_MS`) holds a slot that other sessions wait for. Known consequence of the budget: a LiveKit outage of about 16 s (five restarts of a worker that exits 3, then the sixth exit) turns voice off for the rest of the session (A1c follow-up proposed).

## Voice operations, slice A1c (EPIC-0003, US-0072; `docs/VOICE_RUNBOOK.md`)
Read by `services/voice-ops` only (from the root `.env` merged UNDER the real environment, as control reads it), except `VOICE_TIMING_LOG` (control). Verified against `services/voice-ops/src/settings.ts` and `services/control/src/main.ts`:

| Variable | Read by | Default | Range and notes |
| --- | --- | --- | --- |
| `VOICE_ACCESS` | voice-ops | `local` | `local` or `lan` |
| `VOICE_STATE_DIR` | voice-ops | `<HOME>/.scenecoach/voice` | absolute, outside the repository (by `realpath`), 0700 |
| `STT_MODEL_FILE` | voice-ops | `<HOME>/.scenecoach/models/ggml-<STT_MODEL>.bin` | absolute; at least 1 MB; never downloaded |
| `VOICE_WEB_PORT` | voice-ops | 3000 | 1024 to 65535 |
| `VOICE_HOSTNAME` | voice-ops (`lan`) | unset (required) | a DNS name of two or more labels, not `localhost` or an address |
| `VOICE_NODE_IP` | voice-ops (`lan`) | from the interfaces | a private IPv4 of this machine |
| `VOICE_HTTPS_PORT`, `VOICE_LIVEKIT_TLS_PORT` | voice-ops (`lan`) | 443, 7443 | 1 to 65535, different |
| `VOICE_TLS_MODE` | voice-ops (`lan`) | `files` | `files` (with `VOICE_TLS_CERT_FILE`, `VOICE_TLS_KEY_FILE`, absolute) or `dns` (with `VOICE_DNS_PROVIDER`; refused by `voice:up` in A1c: plan Task 13 skipped) |
| `AUDIO_MIN_FREE_MB` | voice-ops (`voice:check`), control and the speech worker (US-0073) | 2048 | 512 to 1 000 000; invalid stops control and the worker |
| `AUDIO_DIR` | voice-ops (`voice:check`), control and the speech worker (US-0073) | `<CONTROL_DATA_DIR>/audio` | absolute; control's config refuses a relative path (variable named, never the value) |
| `AUDIO_MAX_RETENTION_DAYS` | control only (US-0073) | 30 | 1 to 30, whole number; the sweep (a later A2a task) deletes older recordings. Not in the worker's environment |
| `LIVEKIT_HOST` | control and voice-ops | `http://127.0.0.1:7880` | `voice:up` requires exactly the default (voice.yml publishes the API there) |
| `VOICE_TIMING_LOG` | control only | 0 | exactly 0 or 1; anything else stops control. 1 appends `<CONTROL_LOG_DIR>/voice-timing.log` |

`voice:up` adds `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `STT_URL` to `.env` when absent and refuses when the real environment sets any of them. Constants (code, not settings): `WHISPER_READY_WAIT_MS` 120 000, `WHISPER_WARM_TIMEOUT_MS` 120 000, `WHISPER_STOP_GRACE_MS` 5000, `LIVEKIT_READY_WAIT_MS` 60 000, `COMPOSE_UP_TIMEOUT_MS` 600 000, `COMPOSE_WAIT_TIMEOUT_S` 60, `CERT_WARN_DAYS` 21, `ADMIN_TOKEN_TTL_S` 60, the STT port range 20000..32767, `MIN_STT_PATH_CHARS` 16; control's `LIVEKIT_PROBE_TIMEOUT_MS` 2000 (watchdog 2x), `LIVEKIT_RETRY_BASE_MS` 2000, `LIVEKIT_RETRY_MAX_MS` 30 000 (2, 4, 8, 16 s after the previous answer, then every 30 s, no cap), `TIMING_LOG_MAX_BYTES` 1 MiB; `voice:timings`' `TIMINGS_MAX_BYTES` 4 MiB.

## The local endpoint (owner's Mac: Apple M5 Pro, 64 GB)
Osaurus at `http://127.0.0.1:1337/v1`. Models served on 2026-10-06: `foundation`, `gemma-4-31b-it-qat-mxfp4`, `nemotron-3-nano-omni-30b-a3b-jangtq4`, `qwen3.8-27b-mxfp8`, `raptor-v0.5-8b-a1b-jang_6m`.
- **gemma-4-31b-it-qat-mxfp4: use this.** About 18 GB. Full showcase about 400 to 650 s, with the evaluator about 1100 to 1300 s. In role, specific, progresses a negotiation, 0 fallbacks, copies the Game Master nonce every time.
- raptor-v0.5-8b: fast (about 0.6 s warm) but repetitive and self-echoing even with the anti-repeat prompt. Dropped from testing.
- qwen3.8-27b-mxfp8: a reasoning model. 117 s cold and about 20 s warm for 20 tokens; empty replies (budget spent thinking) and first-token timeouts. Needs very long timeouts.
- nemotron-3-nano-omni: fluent but the characters echo each other and the Game Master ran out of reasoning budget.
- foundation: longer replies, 1 fallback, the CFO talks about "the CFO" in the third person.
- Free OpenRouter Nemotron: about 40% overload errors; the retry layer gave 0 of 20 fallbacks (single run).
- Candidate second models (surveyed on Hugging Face 2026-10-06, not yet downloaded): Ministral-3-14B-Instruct-2512 (non-reasoning, Mistral family), gpt-oss-20b MXFP4 (reasoning, fast), Qwen3.6-35B-A3B 4-bit (thinking on by default; `chat_template_kwargs.enable_thinking=false` is not sent by our provider yet), Nemotron-3.5-Lightning-30B-A3B. A different family from Gemma is wanted as an independent Game Master and evaluator.

- **Second judge for calibration (added 2026-10-07 by the owner): `holo3-35b-a3b-jangtq4`** (OsaurusAI/Holo3-35B-A3B-JANGTQ4, an agent-tuned model; its usability as a judge is unknown until the baseline run measures it). Use it as `pnpm calibrate --judge second,holo3-35b-a3b-jangtq4,http://127.0.0.1:1337/v1`; the primary judge stays Gemma (`EVAL_MODEL=gemma-4-31b-it-qat-mxfp4`).

## Cost
`docs/AI_COST_LOG.md` is appended by the Stop hook with running totals per snapshot: do not sum rows; take the latest row per session.

- Drafting model for calibration probes: `claude-sonnet-5-5` (a Claude model, a different family from the Gemma primary judge and the Holo3 second judge). The draft CLI supports only OpenAI-compatible drafters, so the 19 Friday drafts were produced through the real draft pipeline with a replay shim; the owner declined copying `ANTHROPIC_API_KEY` into `LOCAL_API_KEY`. The second judge is `holo3-35b-a3b-jangtq4` at `http://127.0.0.1:1337/v1`.

| Web app, launcher mode (read by `next start`, not the root `.env`): `FACILITATOR_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN` | unset (console disabled, single-runtime mode) | `LAUNCHER_URL` set requires `LAUNCHER_TOKEN` (32+ chars) for player routes too; the console also needs `FACILITATOR_SECRET` (16+ chars) |
| Control service (`pnpm control`, reads the root `.env`): `CONTROL_PORT`, `CONTROL_DATA_DIR`, `MAX_SESSIONS`, `SCENARIOS_DIR`, `CONTROL_LOG_DIR`, `CONTROL_GRACE_MS`, `CONTROL_READY_TIMEOUT_MS` | 8787, required (absolute), 10, `scenarios/`, `<data>/child-logs`, 30000, 30000 | also needs `LAUNCHER_TOKEN`; `CONTROL_MANAGED`, `SESSION_DATA_DIR`, `NO_DOTENV` are set by it on each runtime, never by users |
