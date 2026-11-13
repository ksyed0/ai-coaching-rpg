# Voice runbook (pre-production)

How to start, check and stop the voice infrastructure on the pilot laptop, what to do when something fails, and the owner-run room test. EPIC-0003 voice part A, slice A1c (US-0072). Plan: `docs/superpowers/plans/2026-11-09-voice-a1c-operations.md`.

> **Voice is pre-production.** It stays off until `VOICE_ENABLED=1` and `CONSENT_NOTICE_VERSION=v3`, and then only for the owner and colleagues who agree to be recorded. Nobody else uses it before slice A2 (audio retention). The consent notice v3 keeps its draft marker; compliance work (legal, HR) is deferred while the project is pre-production.

> **Status of this runbook.** Every command below is covered by tests that use stand-in programs. None of it has been run against a real Docker engine, LiveKit, Caddy or whisper-server yet. Section 11 is the owner checklist for that first real run.

No example in this runbook shows a secret. `<hostname>`, `<dir>` and `<file>` are placeholders. Never paste a key, the `STT_URL` path or a `.env` line into a chat, a ticket or a log.

## 1. What runs where

| Piece                                                                             | How it runs                                                                                       | Listens on                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| whisper-server (whisper.cpp 1.9.5, speech to text)                                | Natively, on Metal; started and stopped by `pnpm voice:up` / `pnpm voice:down`                    | `127.0.0.1:<STT port>` only, behind a random request path                                                   |
| LiveKit (media server, `livekit/livekit-server:v1.13.11`)                         | Docker Compose project `scenecoach-voice` on the local Docker engine (Docker Desktop or OrbStack) | API `127.0.0.1:7880`; media TCP 7881 and UDP 7882 on the node address                                       |
| Caddy (TLS proxy, `caddy:2.11.9`, `lan` mode only)                                | The same Compose project                                                                          | `https://<hostname>` (443) for the web app, `https://<hostname>:7443` for LiveKit signalling (`/rtc*` only) |
| Control service (`pnpm control`) and the web app (`pnpm --filter @acr/web start`) | Started by you; `voice:up` prints the exact settings                                              | `127.0.0.1` only                                                                                            |

```
 participant browser ──https://<hostname>──▶ Caddy ──▶ web app (127.0.0.1:3000) ──▶ control ──▶ runtime
                      ──wss://<hostname>:7443/rtc──▶ Caddy ──▶ LiveKit (7880) ◀── speech worker (child of control)
                      ──media TCP 7881 / UDP 7882──▶ LiveKit                       speech worker ──▶ whisper-server (127.0.0.1)
```

whisper-server's standard output is discarded because it may print what people said. Its standard error goes to the private `whisper.log` in `VOICE_STATE_DIR`.

There are two modes:

- **`VOICE_ACCESS=local`** (the default): one machine only, `http://localhost:3000`, LiveKit at `ws://127.0.0.1:7880`, nothing on the LAN, no Caddy.
- **`VOICE_ACCESS=lan`**: a real hostname (`VOICE_HOSTNAME`) and certificate, Caddy in front, the LiveKit node address on the LAN. The two-person room test needs `lan`.

## 2. Before the first start

1. **The speech model.** `STT_MODEL` is the label (default `small.en`). `STT_MODEL_FILE` is the absolute path of a whisper.cpp ggml model file; the default is `<HOME>/.scenecoach/models/ggml-<STT_MODEL>.bin`. Get the file yourself and keep it outside the repository. `pnpm voice:up` never downloads one and refuses to start without it. The spike used `ggml-small.en` (faster) and `large-v3-turbo-q5_0`.
2. **whisper-server** on `PATH` (`brew install whisper-cpp` gives 1.9.5).
3. **A local Docker engine** (Docker Desktop or OrbStack) with Compose 2.24.0 or newer. `DOCKER_HOST` must be unset or `unix://`; a remote engine is refused.
4. **`.env`** created by `./run.sh` first. `voice:up` never creates `.env`: a new one would make `run.sh` skip the facilitator token. It must be a regular file, mode 0600 (`chmod 600 .env`), not tracked by git. `voice:up` adds `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and `STT_URL` only when they are absent, in one appended block, and never changes an existing byte. Do not export these three names in your shell: `voice:up` refuses to start ("unset LIVEKIT_API_KEY in this shell: voice:up and control must read it from .env").
5. **`LIVEKIT_HOST`** must be unset or exactly `http://127.0.0.1:7880` for `voice:up` (`voice.yml` publishes LiveKit's API there); any other value exits 2.
6. **`VOICE_STATE_DIR`** (default `<HOME>/.scenecoach/voice`): absolute, outside the repository, mode 0700, owned by you. `voice:up` creates it.
7. **For `lan` mode only**, set `VOICE_ACCESS=lan`, `VOICE_HOSTNAME=<hostname>` (US-0048), optionally `VOICE_NODE_IP=<private IPv4 of this laptop>`, and the certificate:
   - **Owner-supplied files** (`VOICE_TLS_MODE=files`, the default and the only path in A1c): `VOICE_TLS_CERT_FILE=<absolute path>` and `VOICE_TLS_KEY_FILE=<absolute path>`. Run `chmod 600 <key file>` on the key.
   - **The DNS-challenge path is not available** (plan Task 13 was skipped: no DNS provider has been named). With `VOICE_TLS_MODE=dns` and no valid `VOICE_DNS_PROVIDER`, the settings check exits 2 with "VOICE_DNS_PROVIDER is required with VOICE_TLS_MODE=dns (1 to 64 lower-case letters, digits or -)". Only with a valid provider name does `voice:up` reach its refusal: "VOICE_TLS_MODE=dns is not available yet: use VOICE_TLS_MODE=files with your own certificate (docs/VOICE_RUNBOOK.md)".
   - Ports: `VOICE_HTTPS_PORT` (default 443) and `VOICE_LIVEKIT_TLS_PORT` (default 7443) must differ. `VOICE_WEB_PORT` (default 3000) is the web app's loopback port.

## 3. Start, check, stop

```
pnpm voice:up
```

`voice:up` starts whisper-server, waits until it is healthy (up to 120 s while the model loads), warms it, then starts LiveKit and, in `lan` mode, Caddy, and waits for them. The first run pulls the two images. It ends with the next steps, for example:

```
voice:up: next: set SPEECH_INGEST=livekit in .env for the control service
voice:up: next: start the web app with PUBLIC_ORIGIN=https://<hostname> and LIVEKIT_URL=wss://<hostname>:7443 (pnpm --filter @acr/web start)
voice:up: Voice stays off until VOICE_ENABLED=1 and CONSENT_NOTICE_VERSION=v3 (pre-production only; docs/VOICE_RUNBOOK.md)
```

In `local` mode the web line says `PUBLIC_ORIGIN=http://localhost:3000 and LIVEKIT_URL=ws://127.0.0.1:7880`.

How `voice:up` behaves:

- **Refusals.** Every refusal check runs before anything is written or started.
- **Failure or Ctrl-C.** A failure or Ctrl-C rolls back what that run started. After Ctrl-C the last line says whether the rollback completed; after a failure, any part that could not be undone is named with "run pnpm voice:down".
- **A second run** says "already running" when everything is up. If something is missing, it says "repairing: starting what is not running" and starts only that.
- **Changed settings.** A changed setting (the node address after a DHCP change, ports, mode) is refused: run `pnpm voice:down`, then `pnpm voice:up`.

Then, in separate terminals:

```
pnpm control                       # reads .env: SPEECH_INGEST=livekit, the LiveKit keys and STT_URL
PUBLIC_ORIGIN=<as printed> LIVEKIT_URL=<as printed> pnpm --filter @acr/web start
```

The web app reads its own environment (or `apps/web/.env.local`), not the root `.env`. `pnpm --filter @acr/web start` listens on 127.0.0.1 only.

```
pnpm voice:check
```

`voice:check` prints one `OK`, `WARN`, `FAIL` or `SKIP` line per check, then `voice:check: <n> ok, <n> warn, <n> fail, <n> skip`. It exits 0 when nothing fails, 1 when something fails and 2 for bad settings. It never prints a secret. The checks:

- whisper-server: healthy, or still loading its model; whether it answers cross-origin requests.
- LiveKit: whether it answers, and whether control's keys are LiveKit's. The key check sends a 60 s `ListRooms` token to `127.0.0.1:7880` only.
- Docker.
- The node address: FAIL "the node address changed since voice:up".
- In `lan` mode: the certificate (present, the hostname, days to expiry; WARN under 21 days) and its key (mode 0600); DNS (the hostname must point to this laptop's private address; a DNS-rebinding hint); the TLS route; the web app through the proxy; and a WARN when this Node cannot read the system certificate store (Node before 22.15: a certificate trusted only by this machine's keychain then fails the TLS route check).
- The web app on loopback, and not on any LAN address.
- Free disk against `AUDIO_MIN_FREE_MB` (default 2048).
- The ports.
- The Time Machine exclusion of the state and audio folders.
- Versions.
- A WARN for any managed name exported in the shell.
- The secure-context reminder, for example "voice:check: participants open https://<hostname>; a plain http:// LAN address cannot use the microphone" (in `local` mode: "only this machine's browser can use the microphone: http://localhost:3000").

```
pnpm voice:down
```

`voice:down` stops whisper-server (only the process `voice:up` started: a reused process id is left alone), runs `docker compose down` for the project and removes `livekit.env`, `whisper.log`, `public/`, `tmp/` and `state.json`. It keeps `caddy-data/` and `caddy-config/` (Caddy's data). If it says it could not identify whisper-server, run it again.

## 4. The microphone needs a secure context

Browsers give the microphone only to `https://` pages or to `http://localhost` on the same machine. On the LAN use `https://<hostname>`. A plain `http://<LAN address>` page cannot use the microphone (the page says so).

## 5. Network

- **DNS.** The hostname must resolve to the laptop's private LAN address. Some routers drop public DNS answers that point to a private address (DNS-rebinding protection). The symptom is that devices cannot resolve the hostname; `voice:check` says "has no IPv4 (A) answer" with the hint. To fix it, allow the hostname in the router, or add a local DNS entry for it. A public address, or an AAAA record that is not this laptop, fails the check.
- **macOS firewall.** Allow the Docker engine's (Docker Desktop's or OrbStack's) incoming connections. In the spike, a native `brew` LiveKit could not be reached from another device. That was probably the firewall and was never diagnosed, which is why LiveKit runs in Docker.
- **Media.** TCP 7881 worked in the spike; UDP 7882 is unproven on a real LAN. `node_ip` is the LAN address in `lan` mode.
- **The two-device address check (run once, before the room test; owner checklist item 7).** From device A, type five wrong join codes for one role. Then device B joins the same role with the right code.
  - **If B joins,** client addresses survive the container proxy.
  - **If B is blocked,** every client shares one address behind the proxy, and the caps of section 8 apply to the whole session. Use the manual fallback below for the room test.
- **Manual fallback, not automated by A1c.** Run Caddy from Homebrew with the same `deploy/compose/Caddyfile`, with the upstreams changed from `host.docker.internal` and `livekit` to `127.0.0.1:<VOICE_WEB_PORT>` and `127.0.0.1:7880`. The Caddyfile reads `VOICE_HOSTNAME`, `VOICE_HTTPS_PORT`, `VOICE_LIVEKIT_TLS_PORT` and `VOICE_WEB_UPSTREAM` (set it to `127.0.0.1:<VOICE_WEB_PORT>`) from Caddy's environment, and expects the certificate and key at `/certs/cert.pem` and `/certs/key.pem`: change those two `tls` paths to your files (and the LiveKit upstream `livekit:7880` to `127.0.0.1:7880`). The cost: it is not digest-pinned, macOS asks a firewall question, and you keep it updated. A `VOICE_PROXY` setting is out of scope.
- **Who can read the keys.** `livekit.env` in the state directory is private to you. But anyone who can use the Docker socket can see `LIVEKIT_KEYS` through `docker inspect` or `docker compose config` (without `--quiet`). `voice-ops` itself only ever runs `config --quiet`.

## 6. Headsets and the same room

Cross-talk is the largest risk (spec section 14, item 1): a second person's voice reaches the first person's microphone and is transcribed under the wrong name. To reduce it:

- use headsets;
- run the lobby's microphone check;
- mute when not speaking;
- keep seats apart.

Push-to-talk comes with slice A3.

## 7. Backups

Exclude the audio folder (`AUDIO_DIR`, written by the speech worker since slice A2a; default `<CONTROL_DATA_DIR>/audio`) and `VOICE_STATE_DIR` from Time Machine and any other backup. The owner runs:

```
tmutil addexclusion <dir>
```

`voice:check` reports whether each folder is excluded. Deleting a recording never reaches a backup, which is what the consent notice v3 says.

### Where the audio lives, how long, and the disk floor

- **Where.** `<AUDIO_DIR>/<logIdentity>/<role>/<segment>.wav` (16 kHz mono WAV), an `index.jsonl` per role and `<logIdentity>/ended.json`. Beside the folders: `<logIdentity>.store.lock`, `<logIdentity>.audio-audit.jsonl` (ids and labels only, never text) and `<logIdentity>.audio-audit.lock`. Everything is private to the user running the control service (folders 0700, files 0600). The index lines of accepted lines hold the transcript text, so treat the folder like the session log. Each identity folder also holds `session.json` (`{ "v": 1, "sessionId": ... }`, 0600), which tells the control service which session the folder belongs to. Since slice A2b-1a the control service can list and replay the audio (next bullet), and since A2b-1b the facilitator can delete it (the bullet after).
- **What is kept.** A WAV is written only after the runtime has answered the line: for an accepted line, an empty or failed transcription, and a line refused only for timing (`paused`, `not_in_scene`). Nothing is written for any other refusal, for a line that gets no answer in time, or for a participant who opted out while the line waited. Audio recorded before someone opts out stays until it expires or the facilitator deletes it (section 7, "Delete").
- **How long.** The control service's sweep runs at start-up and then hourly, even with `VOICE_ENABLED=0`, and deletes a session's folder `AUDIO_MAX_RETENTION_DAYS` (1 to 30, default 30) after the session ended (the time in `ended.json`; with no marker, 24 hours after the last recorded segment). It skips a session whose speech worker is still running (the store lock) and writes one `audio.deleted` line to the audit file before removing a folder. The audit file is not deleted with the audio.
- **Replay, and how it is audited (A2b-1a; control API only, no console screen yet).** Two routes on the control service, both behind the service token (`x-service-token`) and both needing the header `X-Acr-By: <name>-console` (the facilitator's console name; at most 56 characters before `-console`): `GET /sessions/<id>/audio` lists a session's segments (metadata only, never the transcript text) and `GET /sessions/<id>/audio/<role>/<segment>` returns one WAV whole (a `Range` header is ignored). **Every replay is audited before any audio is sent:** one `audio.played` line (`role`, `segment`, `by`, time; no text, no audio) is appended to `<AUDIO_DIR>/<logIdentity>.audio-audit.jsonl`, the same file as the opt-in, opt-out, recording-stop and deletion lines. A replay that fails leaves no line; a replay whose listener disconnects while the file is being sent still leaves its line. The listing is not audited. The routes work whatever `VOICE_ENABLED` is. A session that was restarted can have several folders; the routes cover all of them and the audit line goes to the file of the folder that held the segment. Not yet run against a real setup.
- **Delete, and how it is audited (A2b-1b; control API only, no console screen yet).** `DELETE /sessions/<id>/audio` on the control service, behind the service token (`x-service-token`), with a JSON body `{ "scope": ..., "reason": ..., "by": "<name>-console" }` sent with `Content-Type: application/json` (without it the answer is `400`; at most 4096 bytes; `by` is the facilitator's console name and is required in the body; an `X-Acr-By` header, when sent, must be the same value). `scope` is exactly one of `{ "kind": "session" }` (everything the session recorded), `{ "kind": "role", "role": "<role id>" }` or `{ "kind": "participant", "participant": "<participant id>" }` (that participant's segments in every role and every folder of the session). `reason` is `facilitator` (the facilitator's own decision) or `participant_request` (a participant asked: use this so the audit file holds proof; it writes one `audio.deleted` line with `segments: 0` even when that participant has nothing left to delete). **The session must not be live:** end or restart the session first (the next section). Every delete is audited **before** anything is removed: one `audio.deleted` line (scope, reason, `by`, number of segments, an operation id; no text, no audio, no path) per audio folder goes to the same `<AUDIO_DIR>/<logIdentity>.audio-audit.jsonl` as the replay lines. Then the segments are marked deleted in the index (they answer `410` at once) and the WAV files are removed. **A deleted segment never plays again, and the transcript in the session log is unchanged.** The listing keeps showing the segment with `audio: deleted`; the folder, `index.jsonl` and `session.json` stay until the session expires. A delete that was interrupted after the marks is finished by the next hourly sweep. The routes work whatever `VOICE_ENABLED` is. Not yet run against a real setup.
  Example (`<port>` is the control service's loopback port, `<token>` its service token):

  ```
  curl -sS -X DELETE "http://127.0.0.1:<port>/sessions/<id>/audio" \
    -H "x-service-token: <token>" -H "Content-Type: application/json" \
    -d '{"scope":{"kind":"role","role":"<role id>"},"reason":"facilitator","by":"<name>-console"}'
  ```
- **The disk floor.** The worker stops recording when free space on the audio volume or on the sessions volume is not above `AUDIO_MIN_FREE_MB` (default 2048) plus the next file. `voice:check` reports free space for the audio folder and the state folder against the same floor; it does not look at the sessions volume.

## 8. When something fails

- **Whisper down or loading.** `voice:check` says "does not answer" or "is loading its model". Local models unload after idling, so warm Whisper and the local NPC model before a session. Start `pnpm voice:up` early.
- **A LiveKit outage** (the container restarted or stopped):
  - When the speech worker exits because it lost LiveKit and control's check of `http://127.0.0.1:7880/` gets no answer within 2 s, the exit does not count toward the five restarts. Voice shows as unavailable; pages say "Voice is not available right now. Use the text box." without flapping.
  - The facilitator gets ONE alert: "Voice input lost the LiveKit media server. It reconnects when the server answers; participants can continue by text." It also closes an open voice turn, up to 2 s after the stop, because it waits for the check.
  - Control checks again 2, 4, 8 and 16 s after the previous answer, then every 30 s, with no limit and nothing running meanwhile.
  - When LiveKit answers, the facilitator gets ONE notice: "The LiveKit media server answers again; voice input is restarting. Participants who lost voice press Join with voice again." A new speech worker starts.
  - **Participants press "Join with voice" again: the page does not rejoin by itself** (automatic rejoin is A3).
  - Known log noise while LiveKit is down: each seat room's periodic clean-up logs a failed call every 20 s (a follow-up; no fault).
- **A LiveKit that keeps dying right after each recovery.** A loss within 60 s of a recovery counts as a fault. After five such cycles voice is off for the session ("Voice input is off for this session after repeated faults.").
- **A stale LiveKit alert while LiveKit flaps faster than every 30 s.** The runtime raises each alert code at most once every 30 s, so a `livekit_lost` or `livekit_recovered` within 30 s of the previous one of the same code is dropped. The console can then show an out-of-date LiveKit message. Trust the voice availability on the pages, which is never rate limited.
- **The facilitator console shows "Recording stopped: the disk is nearly full. The transcript continues." (`disk_low`).** Recording stopped for that session's speech worker and does not restart in the same speech worker, even when space returns (a respawned worker checks the disk guard again); voice input and the transcript carry on. Free space on the audio volume and on the volume of `SESSION_DATA_DIR` (the guard watches both; `pnpm voice:check` reports the audio folder and the state folder only, not the sessions folder), then end the session: the next session's worker checks again. Each stop is a `voice.recording_stopped` line in the audit file. Audio already written stays and expires normally.
- **The console shows "Recording stopped: audio could not be saved. The transcript continues." (`write_error`).** The audio folder could not be written (a permission, a link or a foreign owner in its place, a full or read-only volume, or the store lock was lost). Check that `AUDIO_DIR` is a real folder owned by the user running control and not writable by others, then end the session; a new worker tries again. Voice input and the transcript carry on.
- **A replay answers `503` with `audit_unavailable`.** Nothing was played: the control service could not write the `audio.played` line (a full or read-only volume, a lock held through three tries, the audit file is not a regular file of this user, or `AUDIO_DIR` is not a private folder). Fix the cause (free space, `AUDIO_DIR` owned by the user running control and `chmod 700`, the audit file not a folder or link) and replay again. The service log says "audit append failed" without a path or identity. This is deliberate: audio is never sent without its audit line.
- **A replay answers `503` with `busy`.** More than 8 replays are running at once; the answer carries `Retry-After: 1`. Try again in a moment. (The listing is not counted.)
- **A delete answers `409` with `session_live`.** Nothing was changed. The session still has a voice host entry (a speech worker, a restart in progress, a lost media server) or its speech worker still holds the audio lock. **End or restart the session first, then delete.** This includes a session whose speech runtime crashed without the session ending: it stays "live" for the delete until it is ended or restarted. The body lists any folders that were finished before the live signal appeared; a repeat call does only the rest. A live session with no audio at all is also `409`, not `404`.
- **A delete answers `503` with a partial body.** The body is `{ deleted, gone, identities: [{ identity, deleted, state }], pending: [{ identity, reason }] }`: `identities` are the audio folders (the same 32-character names the listing shows) that are done, `pending` the ones that are not. **A retry is safe:** segments already marked are skipped, so the second call only does the rest, and a `facilitator` retry writes no second audit line for a folder already done. The code is the worst reason present: `store_unsafe` (`AUDIO_DIR` is not a private folder, a folder was swapped for a link while the delete ran, or a folder, index or lock file is a link, belongs to another user, or is over 64 MiB, or the index could not be written: nothing was marked or removed for that folder; fix the folder's ownership or the link, then retry; the `Retry-After` header is not sent), `audit_unavailable` (the audit line could not be written, so nothing was marked or removed for that folder; fix the audit file or the volume as for a replay, then retry; no `Retry-After`) or `busy` (the retention sweep or another delete is working on that folder, an internal lock error is also reported as `busy`, or more than 4 deletes are running; the answer carries `Retry-After: 1`; retry in a moment). `gone` lists folders that stopped belonging to the session while the delete ran (the sweep moved them); that is not an error. A `200` with `deleted: 0` means there was nothing left to delete.
- **A delete answers `400` or `413`.** `400`: the body is not exactly `scope`, `reason` and `by` (one scope kind only, a file-safe role, `reason` one of the two words, `by` in the `<name>-console` form), or `X-Acr-By` differs from `by`; nothing was written. `413`: the body is over 4096 bytes. `404`: a bad session id, or the session has no audio.
- **A replay or a delete answers `503` with `store_unsafe`.** An index file could not be trusted (a link, another user's file, over 64 MiB or unreadable), so the control service stopped instead of trying another folder's copy. Nothing is played or deleted for it. Check ownership and links under `AUDIO_DIR/<folder>/<role>/index.jsonl`; no `Retry-After` is sent.
- **A replay answers `404` for a segment the listing shows.** The listing's `available` only says the WAV opens as a regular file; a replay also needs the file to be 44 to 524288 bytes, to have one link, and to have an index line that is not marked deleted. Also `404` for every session while `AUDIO_DIR` can be written by its group or by others (`chmod 700` it: the routes, like the sweep, refuse such a folder). Other answers: `400` for a missing or malformed `X-Acr-By`, `401` for no or a wrong service token, `410` for a segment marked deleted (see the delete bullet in section 7).
- **Audio from before slice A2b-1a is not found by its session.** Folders recorded before the marker existed have no `session.json`; the control service finds them through the first line of the session's log (`<SESSION_DATA_DIR>/<id>.jsonl`) and only when that folder has no marker. If the log is missing or does not name the folder, the audio is only reachable by the sweep.
- **Older audio can be hidden from the listing after the upgrade.** The session-log fallback is asked only when NO marker matched. If one session has a folder recorded before the upgrade (no `session.json`) and a newer marked folder, only the marked folder is listed and played; the older audio stays on disk until the sweep removes it.
- **The first replay's audit write can change the audio folder's mode.** The audit write checks `AUDIO_DIR` first and repairs a 0750 folder to 0700 (the sweep does the same).
- **A voice session is slow to start after the control service restarts.** The previous speech worker may still hold the session's store lock for up to about 35 seconds; the new worker waits for it before it reports ready. Nothing to do.
- **Audio is still there after 30 days.** The sweep only deletes a session whose lock it can take and whose end time is at least `AUDIO_MAX_RETENTION_DAYS` old. A session that never recorded an end is judged by its last segment plus 24 hours. A folder whose recorded times lie in the future never expires (a known limit). The service log says "audio sweep could not remove a folder" when a removal fails; the next run retries it.
- **Voice off after repeated faults.** Voice stays off for that session; start a new session.
- **The certificate expires soon.** `voice:check` warns under 21 days. Renew the files, then run `pnpm voice:down` and `pnpm voice:up`.
- **"the node address changed since voice:up".** Run `pnpm voice:down`, then `pnpm voice:up`.
- **`whisper.log` grows.** It holds whisper-server's stderr only and is not rotated. Check its size with `ls -l <VOICE_STATE_DIR>`. `pnpm voice:down` removes it.
- **"another voice:up or voice:down is running".** If none is, remove the file `lock` in `VOICE_STATE_DIR`.
- **The proxy shares one address for everyone** (the two-device check failed). The whole session then has:
  - at most 8 participant runtime connections (a reconnect that overlaps its old connection gets 503);
  - at most 16 page streams in total by default (`WEB_MAX_STREAMS_PER_ADDRESS`);
  - shared throttles: five wrong codes for a role from anyone block that role for everyone for 60 s.

  Use the manual Caddy fallback of section 5.

## 9. OWNER-RUN ROOM TEST

This follows spec section 13. It takes about 30 minutes of two people's time, and only people who agree to be recorded take part. Use `lan` mode (`local` serves one machine only), and run it after the two-device address check of section 5.

**Preparation**

1. **Clear the timing record.** Delete or move `<CONTROL_LOG_DIR>/voice-timing.log` from any earlier run. Lines are appended, never rotated, and the file stops growing at 1 MiB.
2. **Turn the timing record on** in `.env`: `VOICE_TIMING_LOG=1`. It must be exactly 0 or 1; anything else stops the control service.
3. **Warm up.** Run `pnpm voice:up` and `pnpm voice:check`, then warm Whisper and the local NPC model. Keep the timeouts generous.
4. **Start control and keep its output** in a private file:

   ```
   pnpm control 2>&1 | tee <private file>
   ```

5. **Write the script.** Each person gets twelve different short business lines, labelled P1-01 to P1-12 and P2-01 to P2-12, written for the test. Read them in a fixed order; some lines overlap.

**Measurement points:** the speech worker's voice-detector end of each segment (`endMs`) and the moment the session log appended the line (control's ack). After each run:

```
pnpm voice:timings <CONTROL_LOG_DIR>/voice-timing.log
```

**Runs**

- (a) Two people with headsets in a quiet room.
- (b) Without headsets.
- (c) A noisy room (background talk or music), to measure the phantom-text rate.
- (d) With a generating local model at the same time (GPU contention: start an AI-character reply loop).
- (e) A 4-to-8 talker load. Extra synthetic tracks from the A1b live publisher are fine; with collapsed addresses the 8-connection cap of section 8 applies.

For each run, record: lines spoken, lines appended, lines under the wrong name, phantom lines (text nobody said), and p50/p95 of both timings.

**Afterwards:** set `VOICE_TIMING_LOG=0` again, restart control, and move `voice-timing.log` to a private place (or delete it).

## 10. Reading the results

`pnpm voice:timings <file>` prints three lines: one per number, each with count, p50, p95 and max against its target, then the reading guide:

- **`end_to_append_ms`** runs from the voice detector's end of the segment to the log append. That end **includes the hangover** (`VOICE_HANGOVER_MS`, default 500 ms of silence after the last word), so the spoken word ended about `VOICE_HANGOVER_MS` earlier. Target: p95 at most 1000 ms at a 500 ms hangover.
- **`start_to_append_ms`** runs from the segment's first frame (the 200 ms lead-in before the first word) to the log append. It approximates first word to line. Target: p95 at most 3000 ms.

The exit codes are 0 with a summary, 1 when the file holds no timing line, and 2 for a usage or file problem.

The other targets:

- under 2% of segments under the wrong person;
- phantom text rare in a quiet room, and recorded for the noisy run.

If a target is missed, change one of `VOICE_HANGOVER_MS` (300 to 600), `VOICE_MAX_SEGMENT_MS` (2000 to 6000), the model (`STT_MODEL`, `STT_MODEL_FILE`) or headsets, and repeat the run.

Record the outcome in `progress.md` and in the go-live checklist (`docs/memory/backlog-and-decisions.md`).

## 11. Owner checklist: the first real run (owner-approved; not in CI)

Run on the pilot laptop, in this order. Ask before each item marked **approval**. Record every result in `progress.md`, and fix whatever the run disproves before the PR merges.

1. **Which `.env`.** The default is a worktree's own `.env` (created by `./run.sh` there). Use the real `.env` **only with approval**, and only after `cp -p .env <private backup outside the repository>`. `voice:up` then appends three generated lines to it.
2. **Downloads (approval).** The first `pnpm voice:up` pulls exactly two digest-pinned images: `livekit/livekit-server:v1.13.11` (about 37 MiB) and `caddy:2.11.9` (about 22 MiB, `lan` mode only). It never downloads a model. No command prints a key.
3. **`local` mode.** Run `pnpm voice:up`, then `pnpm voice:check`, and record every line. This is the first observation of:
   - whisper-server's `/health` while loading, and whether `--request-path` prefixes `/health`;
   - whisper-server's CORS answer;
   - what LiveKit 1.13.11 answers on `GET /` (the outage check accepts any HTTP answer);
   - whether LiveKit accepts the key check's admin token.
4. **Transcripts in whisper-server's streams.** Say one known phrase (for example "the blue teapot is on the second shelf") and confirm it is in neither `whisper.log` nor whisper-server's stdout. To see stdout, run whisper-server by hand in the foreground for 10 s with the same arguments, with approval.
5. **The A1b opt-in live checks** against this LiveKit, with the keys read in a subshell that prints nothing:

   ```
   ( set -a; . ./.env; set +a; LIVEKIT_LIVE_KEY="$LIVEKIT_API_KEY" LIVEKIT_LIVE_SECRET="$LIVEKIT_API_SECRET" LIVEKIT_LIVE_URL=ws://127.0.0.1:7880 LIVEKIT_LIVE_HOST=http://127.0.0.1:7880 VOICE_LIVE=1 pnpm --filter @acr/speech exec vitest run src/__tests__/livekit.live.test.ts )
   ```

   Never use `set -x`. Sourcing is safe only for plain `NAME=value` lines.

6. **A real outage (10 to 60 s).** During a session with one person joined by voice:

   ```
   docker compose -p scenecoach-voice stop livekit
   # wait about 20 s
   docker compose -p scenecoach-voice start livekit
   ```

   Record that:
   - the worker exits 3 and the check gets no answer;
   - exactly one `livekit_lost` and one `livekit_recovered` alert appear;
   - the worker restarts without spending the restart budget;
   - the person's page shows voice failed, and after pressing "Join with voice" again they are heard;
   - the seat clean-up logs one line every 20 s during the outage.

7. **`lan` mode** once the hostname and certificate exist: `pnpm voice:up`, `pnpm voice:check`, then **the two-device address check** of section 5.
8. **Caddy's log filter and the container hardening** (before the clean-up). In `lan` mode with one participant joined by voice, stop LiveKit so the participant's reconnects to `/rtc` get 502. Then read:

   ```
   docker compose -p scenecoach-voice logs caddy
   ```

   It must hold no `access_token`, `join_request` or `sid` value, and no INFO lines. Also:
   - confirm that Caddy bound 443 under `no-new-privileges`;
   - try `cap_drop: [ALL]` and `read_only: true` on LiveKit once, in a scratch copy of `voice.yml`.

9. **Real timing numbers.** One short room-test run (section 9) with `VOICE_TIMING_LOG=1`, read with `pnpm voice:timings`.
10. **Audio (A2a).** With one person joined by voice and the owner's approval to record: say two sentences, end the session, then in `AUDIO_DIR` check with `ls -lR` that the identity folder, the role folder and the index and WAV files are 0700 and 0600, that `ended.json` exists, and that `<logIdentity>.audio-audit.jsonl` holds an opt-in line and no text. Restart the control service during a second session and confirm the first session's audio is untouched. On a throwaway session folder only (with approval), set `endedAtMs` in its `ended.json` more than `AUDIO_MAX_RETENTION_DAYS` days back, restart control and confirm the folder is removed and the audit file gains exactly one `audio.deleted` line. Read the notice wording against the opt-out behaviour (audio recorded before an opt-out stays until expiry). Record the results (TC-0218).
11. **Clean-up.**
    - Run `pnpm voice:down`.
    - Run `docker compose -p scenecoach-voice ps -a`; it must show nothing.
    - Confirm the state directory holds no `livekit.env`.
    - Set `VOICE_TIMING_LOG=0`.
    - Decide whether the generated `.env` lines stay; if not, restore the backup of item 1.
