# Voice test execution checklist (owner-run)

Purpose: one place to run, tick and record every voice check that the agents could not run (no real room, microphone, browser or recorded session in CI). It follows `docs/VOICE_RUNBOOK.md` sections 9 to 11 and the test cases in `docs/TEST_CASES.md`; where they differ, the runbook and the test case win. Nothing here replaces them.

Covers: US-0070 to US-0075 and US-0090, US-0091 (EPIC-0003). Test cases: **TC-0204, TC-0218, TC-0232, TC-0242, TC-0320, TC-0321, TC-0332** (all Not Run) plus the room-test timing runs (a) to (e).

Not covered: US-0092 (live partial transcripts) is deferred and has nothing to test. The room-test numbers below are what decides whether it is ever resumed.

---

## 0. Before you start

- [ ] **People agree to be recorded.** Only people who agree take part. At least two people and two devices (US-0090 needs two voice participants).
- [ ] **Time set aside:** about 30 minutes of two people's time for the room test, plus the checks around it.
- [ ] **Approvals ready.** Items marked **approval** in the runbook need your yes before they run: using the real `.env`, the first image downloads, running whisper-server by hand, recording audio, editing an `ended.json`.
- [ ] **Back up `.env` first** if you use the real one: `cp -p .env <private backup outside the repository>`.
- [ ] **Mode:** `lan` for the room test (`local` serves one machine only); hostname and certificate in place; the two-device address check (runbook section 5) done.
- [ ] **Accounts:** a facilitator account (not the shared secret) for the console, and the control service token for the API checks.
- [ ] **Read first:** `docs/THREAT_MODEL.md` "Voice audio review panel, slice A2b-2" (needed for TC-0320).
- [ ] **Browsers:** desktop Chrome, Safari and Firefox at least (TC-0321).
- [ ] **A place to record results:** `progress.md` and the go-live checklist in `docs/memory/backlog-and-decisions.md`.

## 1. Order of work

Run in this order; later items depend on earlier ones.

1. Real stack and outage (TC-0204, runbook section 11 items 1 to 8)
2. Room test with timing (runbook section 9, item 9 and runs a to e)
3. Audio retention (TC-0218, item 10)
4. Replay and delete (TC-0232, then TC-0242)
5. Console review panel (TC-0320, then TC-0321)
6. Facilitator mute (TC-0332, item 11)
7. Clean-up (item 12)

TC-0320 and TC-0332 are written to run after TC-0242.

---

## 2. Real stack: TC-0204 (runbook section 11, items 1 to 8)

Result for each line: **P** pass, **F** fail (raise a defect), **N** not run.

| # | Check | Expected | Result | Notes |
|---|---|---|---|---|
| 1 | Which `.env` | Worktree `.env`, or the real one only with approval and after the backup | [ ] | |
| 2 | First `pnpm voice:up` (**approval** for downloads) | Pulls exactly two digest-pinned images: `livekit/livekit-server:v1.13.11` (about 37 MiB) and `caddy:2.11.9` (about 22 MiB, `lan` only); no model download; no key printed | [ ] | |
| 3 | `local` mode: `pnpm voice:up`, `pnpm voice:check`; record every line | whisper-server `/health` while loading and whether `--request-path` prefixes it; its CORS answer; LiveKit's answer on `GET /`; whether LiveKit accepts the key check's admin token | [ ] | |
| 4 | Say a known phrase ("the blue teapot is on the second shelf") | In neither `whisper.log` nor whisper-server's stdout (stdout needs a 10 s foreground run, **approval**) | [ ] | |
| 5 | A1b live checks against this LiveKit (subshell command in runbook item 5; never `set -x`) | Pass | [ ] | |
| 6 | Outage: with one person joined by voice, `docker compose -p scenecoach-voice stop livekit`, wait about 20 s, `start livekit` | Worker exits 3 and the check gets no answer; exactly one `livekit_lost` and one `livekit_recovered`; worker restarts without spending the restart budget; the page shows voice failed, then the person is heard after pressing "Join with voice"; seat clean-up logs one line every 20 s during the outage | [ ] | |
| 7 | `lan` mode: `voice:up`, `voice:check`, two-device address check | Passes, or the fallback is recorded | [ ] | |
| 8 | Caddy log filter: in `lan` mode with one participant joined, stop LiveKit so `/rtc` reconnects get 502; `docker compose -p scenecoach-voice logs caddy` | No `access_token`, `join_request` or `sid` value, no INFO lines; Caddy bound 443 under `no-new-privileges`; (optional) `cap_drop: [ALL]` and `read_only: true` tried once in a scratch copy of `voice.yml` | [ ] | |

Overall TC-0204 status: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 3. Room test with timing (runbook section 9, item 9)

**Preparation**
- [ ] Delete or move any old `<CONTROL_LOG_DIR>/voice-timing.log`.
- [ ] `.env`: `VOICE_TIMING_LOG=1` (exactly 0 or 1).
- [ ] `pnpm voice:up` and `pnpm voice:check`; warm Whisper and the local NPC model; keep timeouts generous.
- [ ] Start control and keep its output: `pnpm control 2>&1 | tee <private file>`.
- [ ] Script written: twelve different short business lines per person (P1-01 to P1-12, P2-01 to P2-12), read in a fixed order, some overlapping.

**Runs.** For each, record lines spoken, lines appended, lines under the wrong name, phantom lines (text nobody said), and p50 and p95 of both timings from `pnpm voice:timings <CONTROL_LOG_DIR>/voice-timing.log`.

| Run | Setup | Spoken | Appended | Wrong name | Phantom | end_to_append p50 / p95 (ms) | start_to_append p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|
| a | Two people, headsets, quiet room | | | | | | |
| b | Without headsets | | | | | | |
| c | Noisy room (phantom-text rate) | | | | | | |
| d | With a generating local model running (GPU contention, AI-character reply loop) | | | | | | |
| e | 4 to 8 talkers (synthetic A1b tracks are fine; the 8-connection cap applies with collapsed addresses) | | | | | | |

**Targets**
- [ ] `end_to_append_ms` p95 at most 1000 ms at a 500 ms hangover.
- [ ] `start_to_append_ms` p95 at most 3000 ms.
- [ ] Fewer than 2% of segments under the wrong person.
- [ ] Phantom text rare in a quiet room (and recorded for the noisy run).

If a target is missed, change one of `VOICE_HANGOVER_MS` (300 to 600), `VOICE_MAX_SEGMENT_MS` (2000 to 6000), the model (`STT_MODEL`, `STT_MODEL_FILE`) or headsets, and repeat.

**Afterwards:** `VOICE_TIMING_LOG=0`, restart control, move or delete `voice-timing.log`.

**For the parked US-0092:** note the end_to_append and start_to_append figures and say in one line whether the delay to a finished line hurt a live session. That sentence is the trigger to resume or leave it deferred.

## 4. Audio retention: TC-0218 (item 10, **approval** to record)

- [ ] One person joined by voice says two sentences; end the session.
- [ ] `ls -lR` in `AUDIO_DIR`: identity and role folders 0700; index and WAV files 0600; one WAV per kept segment.
- [ ] `ended.json` exists.
- [ ] `<logIdentity>.audio-audit.jsonl` holds an opt-in line and no text; only ids and labels.
- [ ] Restart control during a second session: the first session's audio is untouched.
- [ ] **Throwaway session folder only, with approval:** set `endedAtMs` in its `ended.json` more than `AUDIO_MAX_RETENTION_DAYS` days back, restart control: the sweep deletes it and audits it once.
- [ ] Read the notice wording against the opt-out behaviour; confirm the opt-out sentence and the audit-failure and future-time rulings.

TC-0218: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 5. Replay: TC-0232

Needs a recorded session and the control service token.
- [ ] After the session: `GET /sessions/<id>/audio`, then `GET /sessions/<id>/audio/<role>/<segment>` with `x-service-token` and `X-Acr-By: <name>-console`; play the file.
- [ ] The listing never shows transcript text.
- [ ] `<logIdentity>.audio-audit.jsonl` has exactly one `audio.played` line per successful replay and none for the listing.
- [ ] Make the audit file unwritable once: `503 audit_unavailable` and no audio sent.

TC-0232: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 6. Delete: TC-0242

Needs a recorded session, ended, and the service token.
- [ ] While the session is live: `DELETE /sessions/<id>/audio` with `x-service-token`, `Content-Type: application/json`, body `{ "scope": { "kind": "session" }, "reason": "facilitator", "by": "<name>-console" }`: `409 session_live`, every segment still plays.
- [ ] End the session. Delete one role (`{ "kind": "role", "role": "<role id>" }`), then one participant with `"reason": "participant_request"`, then the rest with the session scope. After each, list and replay a deleted segment: the listing says `deleted`, replay answers `410`.
- [ ] Audit file: one `audio.deleted` line per folder per call (scope, reason, `by`, segments, op; no text, no path), written before the files went.
- [ ] WAV files gone; `index.jsonl` holds the `deleted` lines; the session log is unchanged.
- [ ] Audit file unwritable once: `503 audit_unavailable` and the audio still plays.

TC-0242: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 7. Console review panel: TC-0320 and TC-0321

Needs a recorded, ended session with at least two voice participants, a facilitator account, voice on.

**TC-0320**
- [ ] Open the ended session: the Recordings panel lists each seat's clips with the transcript line beside each ("No transcript" for a clip without one), and the text is the person's own line.
- [ ] Play three clips one after another, and double-click one. Audit file: one `audio.played` line per fetch, with the account's `<name>-console` name, no text, no path.
- [ ] Delete one seat's audio with "Participant asked": the confirmation shows count, minutes and seconds and "cannot be undone". Then delete all the rest. After each: the panel, the `audio.deleted` lines (reason, scope, by, op), WAVs gone, session log unchanged.
- [ ] Audit file unwritable once, try a delete: the panel says some recordings could not be deleted, shows Retry, does not mark the clips deleted. Restore the file and retry.
- [ ] Sign in once with the shared secret: the panel asks for an account and lists nothing.
- [ ] The panel matches the audit file line for line; nothing is shown as deleted that is still playable.

TC-0320: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

**TC-0321** (repeat per browser)

| Browser | Heard | No CSP error (`media-src`, blob URL) | One play request per press | Second Play stops the first | Reload: not served from cache | Result |
|---|---|---|---|---|---|---|
| Chrome | [ ] | [ ] | [ ] | [ ] | [ ] | |
| Safari | [ ] | [ ] | [ ] | [ ] | [ ] | |
| Firefox | [ ] | [ ] | [ ] | [ ] | [ ] | |

If a browser blocks the clip, the fix is `media-src` in `apps/web/src/server/headers.ts`.

TC-0321: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 8. Facilitator mute: TC-0332 (item 11, **approval** to record)

Two people, two real browsers, `pnpm voice:up`, both joined by voice in a live session. Tell the room first: a mute stops what a seat says from becoming game input; it does not silence the person.

- [ ] Console: press Mute on one seat. The button reads Unmute and the seat shows "Muted by facilitator".
- [ ] Muted person's page: "The facilitator has muted your microphone", and its own unmute button is off.
- [ ] Other person's page: "The <role> microphone has been muted by the facilitator", by role, no name.
- [ ] Speak as the muted person, then as the other: the muted speech makes no transcript line and no WAV; the other person's speech does.
- [ ] Refresh the muted person's page and rejoin while muted: the mute holds.
- [ ] Press Unmute and speak again: recording restores, and both pages say so ("You can speak again" on the muted page).
- [ ] Session log: two `mute_seat` lines with the facilitator's sign-in name in `by`; no participant's stream carried it. Audio folder: nothing for the muted stretch.

TC-0332: [ ] Pass  [ ] Fail  Date: ________  Defect: ________

## 9. Clean-up (item 12)

- [ ] `VOICE_TIMING_LOG=0`, control restarted; `voice-timing.log` moved or deleted.
- [ ] Throwaway session folders removed; test recordings deleted if the people asked.
- [ ] `pnpm voice:down` leaves nothing running.
- [ ] `.env` restored from the backup if it was changed.

## 10. Record the outcome

- [ ] Each TC's Status, Actual Result and Defect Raised updated in `docs/TEST_CASES.md`; `npm run plan:generate`.
- [ ] Summary in `progress.md` and in the go-live checklist (`docs/memory/backlog-and-decisions.md`).
- [ ] Any failure filed as a BUG in `docs/BUGS.md` and fixed before the voice features go live.
- [ ] Decision recorded on US-0092 (live partial transcripts): resume or stay deferred.

| TC | Status | Date | By | Defect |
|---|---|---|---|---|
| TC-0204 | | | | |
| TC-0218 | | | | |
| TC-0232 | | | | |
| TC-0242 | | | | |
| TC-0320 | | | | |
| TC-0321 | | | | |
| TC-0332 | | | | |
