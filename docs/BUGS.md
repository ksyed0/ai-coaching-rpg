# Bugs

```
BUG-0001: Heartbeat tests use 30 ms periods and can fail on a loaded CI runner; heartbeatMs of 0 or less is not guarded
Severity: Low
Related Story: US-0009
Related Task: TASK-0009
Status: Fixed (8c18795)
Fix Branch: bugfix/BUG-0001-heartbeat-test-timing
Lesson Encoded: No
```

A healthy client whose pong is delayed by more than one period is terminated, and a slow join can be killed before `joined`. Use periods of 100-150 ms in the tests. Separately, `heartbeatMs: 0`, a negative value or NaN makes `setInterval(0)` terminate sockets almost at once; production never passes the option, but it should be validated. Fixed: `startServer` now rejects a `heartbeatMs` that is not a finite number greater than 0 and at most 2147483647 (the setInterval limit) with a clear error before opening a port, and the heartbeat tests use a 150 ms period.

```
BUG-0002: Connection failures on a custom Anthropic endpoint are reported as "redirects are refused"
Severity: Low
Related Story: US-0014
Related Task: TASK-0014
Status: Fixed (the classification was corrected in 2d2e31b under US-0022; regression test 6401b13)
Fix Branch: bugfix/BUG-0002-anthropic-endpoint-errors
Lesson Encoded: No
```

With `ANTHROPIC_BASE_URL` set, the redirect-refusing fetch wrapper maps every non-abort failure (ECONNREFUSED, DNS errors, redirects) to one generic message, which hides the real cause. Distinguish a refused redirect from other connection errors while still never echoing URLs or keys. Verified in code on 2026-10-06: the redirect-refusing fetch wrapper rewrites only a fetch "unexpected redirect" cause, and every other failure (ECONNREFUSED, DNS, reset, TLS) reaches the classifier as a connection error. A loopback test with the real SDK now asserts that a refused connection reads `anthropic request failed: connection error` and never mentions a redirect.

```
BUG-0003: Demo check F-23 (dead client dropped) reports a timing-dependent figure against a very lenient limit
Severity: Low
Related Story: US-0021
Related Task: TASK-0021
Status: Fixed (2b59b4a)
Fix Branch: bugfix/BUG-0003-demo-heartbeat-evidence
Lesson Encoded: No
```

F-23 reports "dropped after ~2 heartbeat periods (limit 25)" in a fast run and "~0 heartbeat periods (limit 25)" in a paced run. The figure changes with pacing, and a heartbeat that took 20 periods would still pass. The server terminates a silent socket after at most 2 periods, so the limit should be about 3, measured from the moment the client stops answering pings, not from the start of the check. Fixed: F-23 now counts the pings the silent client received and never answered (1 expected, at most 2), requires the drop within 3 heartbeat periods of the first unanswered ping, and prints no timing-dependent figure; the judging function is unit tested.

```
BUG-0004: An AI character writes lines for the other participants, and multi-line replies show a literal marker in the Markdown transcript
Severity: Medium
Related Story: US-0026
Related Task: TASK-0026
Status: Fixed (2546513 and the follow-up fix commit on feature/EPIC-0006-US-0026-reasoning-model-empty-replies)
Fix Branch: feature/EPIC-0006-US-0026-reasoning-model-empty-replies
Lesson Encoded: No
```

Two defects found in a real run with a small local model (raptor-v0.5-8b). A: Helena Brandt (cfo) produced one reply of `[account_manager]: The fixed fee is 45k ... [client_sponsor]: The module is not in scope; we will not pay for it. [account_manager]: Then the total cost is 45k, and I'll send you a formal quote with the date.` (three speakers, two of them invented). Cause: the NPC prompt shows other speakers as `[role_id]: text` and merges consecutive turns with a newline, and small models continue that pattern. B: `sanitizeText` turns every newline into ` ⏎ ` for terminal safety, and the Markdown transcript reused that text, so a multi-line reply showed a literal ⏎ inside one paragraph. Fix A: the system prompt now says to reply with only the character's own words and never to begin with a `[...]` tag or the character's own name; a pure `cleanNpcReply` strips the character's own leading tag or name, then cuts the reply at the first line or sentence that begins with a `[role_id]:` tag (look-alike brackets, fullwidth letters and invisible characters included), keeping only the text before it. When text was cut, one facilitator alert says so (never quoting the removed text), and a reply left empty takes the existing fallback path. The reply is assembled in full before it is cleaned and recorded, so nothing is streamed to players first. Fix B: the Markdown transcript splits dialogue at its newlines (LF, CRLF, U+2028, U+2029) before sanitizing and renders each line as its own bold span, escaped by the same `safeMd` rules, joined by a Markdown hard break; the terminal keeps the marker. A review follow-up also made the cleanup recognise other roles by id and character name (with or without brackets, quotes, no space after a sentence end, CJK sentence ends, astral invisible characters), keep legitimate `[A]:` or `[1]:` list labels, strip only the character's own id or name, remove a leading `<think>` block, and treat a punctuation-only reply as empty.

```
BUG-0005: Pausing a session does not stop the scene clock: on /resume every overdue timed inject fires at once and the time box can end the scene immediately
Severity: Medium
Related Story: US-0004
Related Task: TASK-0004
Status: Fixed (see git log for BUG-0005)
Fix Branch: chore/BUG-0005-pause-freezes-scene-clock
Lesson Encoded: No
```

`SessionEngine.doTick` returned early while paused, but the elapsed time it used afterwards was `clock.now() - enteredAt`, so the time spent paused counted against the scene. After a long pause, `/resume` fired every timed inject that had come due and could end the scene on its time box at the next tick. Decision by the product owner: pause freezes the scene time box and the inject clock; `/resume` continues with the remaining time. Fixed: the reducer records `pausedSince` (the timestamp of the pause event) and accumulates `currentScene.pausedMs` per scene on resume, and the exported pure function `activeElapsedMs(state, now)` (`now - enteredAt - pausedMs - open pause`) feeds the inject schedule and the exit check. The value is derived only from recorded event timestamps, so a replay of the log (US-0018) computes the same remaining time. A second pause or resume is ignored, a scene entered while paused starts frozen with a fresh clock, and a pending facilitator advance waits for resume. Unit tests cover the reducer and the engine (pending injects with a running time box, exact remaining time, repeated pause/resume, pause before the first inject, a pending advance, a fresh clock for the next scene, replay equality). Notes: the 'scene entered while paused' and 'session ended while paused' paths in the reducer are defensive and not reachable through the engine today (a scene only changes in `tick`, which does nothing while paused). A Game Master verdict recorded during a pause can still end the scene right after resume; that is known, legitimate and out of scope. The evaluator's 'Scene N, HH:MM:SS' times are wall-clock time since the session start (pauses included), not active scene time.

```
BUG-0006: Several tests assert wall-clock bounds or depend on the shared temp directory and fail under load, on slower machines and under coverage
Severity: Medium
Related Story: US-0021
Related Task: TASK-0021
Status: Fixed (see git log for BUG-0006)
Fix Branch: chore/session-close-2026-10-07
Lesson Encoded: Yes (L-0002)
```

Found by the session-close coverage check (`pnpm test:coverage`, run twice on the owner's Mac): four tests in `services/runtime` failed although all pass in CI. `npc-reply.test.ts` "handles very long input in linear time" took 13.5 s against a 5 s bound (and `npc-agent.silence.test.ts` "is linear on abusive input" 3.3 s against 3 s), `runner.test.ts` "aborts a hung run ... (watchdog)" compares the list of `acr-demo-*` directories in the shared `/tmp` and trips on any concurrent demo run, `security-room.test.ts` hit vitest's 5 s default, and `ws-server.security.test.ts` "idle TCP sockets from one address are capped" and `main.resume.test.ts` "survives a REAL crash (SIGKILL ...)" depend on real timers. Absolute elapsed-time assertions are not a valid way to test linear time (coverage instrumentation alone makes the code several times slower): assert the scaling between two input sizes, or count operations, and keep only a very generous absolute cap. Tests that count temp directories must use a private TMPDIR. Real-timer tests must use injected clocks or hooks, or explicit generous timeouts.

```
BUG-0007: A demo run aborted by its watchdog or an interrupt could leave its temp directory behind and keep running after it reported
Severity: Medium
Related Story: US-0021
Related Task: TASK-0021
Status: Fixed (see git log for BUG-0007)
Fix Branch: bugfix/BUG-0007-watchdog-test-temp-dir
Lesson Encoded: Yes (L-0014)
```

Seen as an intermittent failure of `runner.test.ts` "aborts a hung run ... (watchdog)" under coverage or load (three agents, once each, passing on rerun): an extra `acr-demo-*` directory in the test's private TMPDIR. Cause, in the product: `runDemo` raced the run against the watchdog and, when the watchdog won, aborted, ran the cleanups registered so far and returned without waiting for the run. If the abort landed while the temp directory was being made (`makeTempRoot`: `mkdtemp`, then a recursive copy of the scenario), the directory existed but was not registered yet; it was registered later, after the run had closed, and removed fire-and-forget, so it was still there when `runDemo` returned, and the run went on into `startMockSystem`, which could recreate `<root>/data` after that removal and leave the directory for good. Under coverage the start-up takes longer than the test's 100 ms watchdog, so the abort fell into that gap. Reproduced with real watchdogs of 1 to 20 ms (60 runs: the directory still present right after `runDemo` returned in 36, and 300 ms later in 3; a permanent leftover was not observed) and deterministically with an injected watchdog fired between `mkdtemp` and registration (10 of 10 failing). Fixed: the temp directories (`makeTempRoot`, `makeTempDataDir`) are handed to the run's cleanups the moment they exist, check the abort signal after each step and remove themselves when aborted or when filling them fails; the runner checks the signal after each start-up step; after the watchdog or an interrupt `runDemo` waits for the run to unwind, bounded by `ABORT_GRACE_MS` (5 s), before it cleans up and reports, so a run that ignores the abort is still abandoned and never hangs the process; the Game Master trace file is registered for closing before anything else starts. The exit code and the WATCHDOG and INTERRUPTED entries are unchanged. Tests: the runner's timers are injectable (`setTimer`) and a test hook runs right after the temp directory is created (`afterTempCreated`), so the watchdog tests fire the watchdog by hand instead of using 1, 100 or 400 ms real timers; new tests abort in the gap (default and showcase runs) and abandon a run that ignores the abort after the grace.

```
BUG-0008: tests/unit/atomic-write.test.js flakes under full plan:test load (passes when run alone)
Severity: Low
Related Story: US-0037
Related Task: TASK-0057
Status: Fixed (cause identified, not reproduced locally)
Fix Branch: fix/bugs-0008-0012-0013
Lesson Encoded: No
```

Seen twice on 2026-10-08 during the US-0037 session close: the file failed in a full `npm run plan:test` run and passed on its own and on rerun. The concurrency tests use real file locks and a shared `tests/.tmp-atomic` directory and are probably sensitive to machine load (compare BUG-0006 and BUG-0007). Not investigated yet: capture the failing assertion on the next occurrence, then inject clocks or hooks instead of relying on timing (L-0002).

Update (2026-10-31): the likely cause is two test files (`file-lock.test.js` after every test, `atomic-write.test.js` after all) deleting the shared `.locks` directory while another jest worker holds a lock in it, which lets a second holder in and loses a write. Both files now release only their own lock and never remove `LOCK_DIR`. The flake was not reproducible here (9 full runs passed before and after), so this is a fix for an identified hazard, not a verified cure: reopen if it recurs.

```
BUG-0009: Web E2E "no horizontal scroll at 400 px" does not see its own say line in the transcript on the first CI run
Severity: Medium
Related Story: US-0065
Related Task: TASK-0085
Status: Fixed (7ebdfc5; root-caused 2026-10-30)
Fix Branch: feature/EPIC-0002-US-0059-readiness (hardening: feature/EPIC-0002-US-0065-web-e2e, 5537920)
Lesson Encoded: Yes (L-0031)
```

First CI run of the Web E2E job (run 40716795094, head 81148e0, pinned Chromium 1248): axe.spec.ts "no horizontal scroll at 400 px" failed in the `say()` helper. After a 190-character unbroken word was sent, the transcript never showed it (0 matches for 20 s). The spec passed 15 of 15 locally under repeat and under CPU load (Chromium 1243). Hypotheses under investigation: the say is sent before the scene is running or the stream is live, the long word is split across text nodes so the exact-text locator cannot match, or state shared between specs (one stack, one address, one join throttle). Not yet reproduced.

Update 2026-10-28: not reproduced locally (passed every run, including 20 repeats under CPU load). The 400 px spec now waits until every player page shows "Play the scene", and the `say()` helper waits for a settled box, requires the BFF to answer 200 to `POST /api/v1/say`, and on failure reports the status or the page's notice text, so a repeat in CI names its cause. One plausible mechanism, unproven: the runtime refuses the line after the BFF's 300 ms send window (the documented gap that a send has no correlated reply), so the page never shows it.

Root cause (2026-10-30): the hardened helper made it name itself. PR #60's Web E2E (run 41136384182) failed the first spec, axe.spec.ts "no serious or critical Axe violations", with `POST /api/v1/say answered 409: not_started` although the facilitator had seen `session.started` and every page showed "Play the scene" with an enabled say box. `SessionEngine.doStart` broadcasts each opening event as soon as it is written (`session.started`, `npc.updated` per character, `scene.entered`, then the opening inject and its `npc.updated`, each an awaited log append), while `SessionHost.start` sets `started = true` only after the whole start resolves. The page enables its say box on `scene.entered`; a say that reaches the runtime before the inject is written meets `if (!this.started) throw HostError("not_started")`. The same code is on `develop` (pre-existing; PR #60 did not cause it). Proven by a deterministic unit test (a log held after `scene.entered`) that fails with `not_started` before the fix, and at E2E level by delaying the start after `scene.entered` (see the CI fix report). Fixed in 7ebdfc5: `onPlayerUtterance` waits for the start in flight and refuses only when that start fails.

```
BUG-0010: Web E2E Axe check reports a serious color-contrast violation on a /join button in one CI run and not in another
Severity: Medium
Related Story: US-0065
Related Task: TASK-0085
Status: Fixed (5537920)
Fix Branch: feature/EPIC-0002-US-0065-web-e2e
Lesson Encoded: No
```

Second CI run (run 40717328008, head ec335ef): axe.spec.ts "no serious or critical Axe violations" failed on `/join (refused) (light)` with one `color-contrast` violation on a `button`, after 2.3 s; the same check passed in the first run and locally. The result depends on timing, so Axe is probably measuring the button during a CSS transition or in a pending or disabled state, or a real state has too little contrast. To be settled: reproduce under load, check every button state against 4.5:1, and make the spec wait for a settled page.

Root cause (found 2026-10-28): `.btn` has a 0.12 s `background-color` transition. The Axe spec switched the colour scheme with `emulateMedia` and scanned at once, so the button background was half-way between the dark and light accent while the text colour had already switched. No settled state has a contrast problem, so the CSS is unchanged. Reproduced with the transition slowed to 3 s (failed every time). Fixed: `checkBothSchemes` waits until `document.getAnimations()` has nothing running or pending before scanning. Lesson L-0024.

```
BUG-0011: CodeQL "incomplete string escaping" alert on a regex built in the web runtime handler test
Severity: Low
Related Story: US-0056
Related Task: TASK-0084
Status: Fixed (b451052)
Fix Branch: feature/EPIC-0002-US-0056-participant-web-app
Lesson Encoded: No
```

`cookieOf` in apps/web/src/server/__tests__/handlers.runtime.test.ts escaped the cookie name with a hand-written `replace` before building a RegExp, which CodeQL flagged as not escaping backslashes (high severity, failed the CodeQL check on the stacked PRs). Fixed by reading the Set-Cookie value with `startsWith` and `indexOf`, with no regular expression.

```
BUG-0012: apps/web handlers.test.ts "consent gives consent; withdrawing and leaving also clear the cookie" fails about one run in three
Severity: Medium
Related Story: US-0056
Related Task: TASK-0084
Status: Fixed
Fix Branch: fix/bugs-0008-0012-0013
Lesson Encoded: No
```

`apps/web/src/server/__tests__/handlers.test.ts`, test "consent gives consent; withdrawing and leaving also clear the cookie" is flaky. It fails about one run in three on the pre-branch baseline too (the slice 2b-1 branches only inherited it), and was seen by Tasks 2, 3 and 13 to 16; run alone it failed consistently in Task 16. It receives `withdraw_consent` where it expects `leave`, an ordering race between the requests the test sends over the participant's stream. Not fixed yet: find out whether the test or the hub's ordering is wrong before changing either, and make the test wait for the specific frame after each trigger (L-0023).

Update (2026-10-30, Task 12 fix round): the full `pnpm test:coverage` in the node:22 container passes this test (apps/web 37 files, 488 tests, as root and as the node user, one run each). It passes in node:22; it fails locally on macOS. Status stays Open until the cause is found.

Update (2026-10-31): root cause found. The fake runtime in the test is a real WebSocket server, and the test fires the hub's 300 ms wait by hand, so the hub answered as soon as it had SENT the frame while the frame could still be in flight to the fake: `rt.received.at(-1)` was read too early (it saw `consent` instead of `withdraw_consent`). The four such assertions now use `vi.waitFor`. 15 of 15 runs pass on the macOS host (about 40% failed before). It was a test race, not a hub ordering bug.

```
BUG-0013: runtime secure-json-file sweep test fails on macOS (case-insensitive file system)
Severity: Low
Related Story: US-0053
Related Task: TASK-0081
Status: Fixed
Fix Branch: fix/bugs-0008-0012-0013
Lesson Encoded: No
```

`services/runtime/src/engine/__tests__/secure-json-file.test.ts`, test `test_sweepSecureTemps_removes_only_matching_temp_files` creates `f.json.0123456789ab.tmp` (a file the sweep must remove) and `f.json.0123456789AB.tmp` (an upper-case look-alike it must keep). On macOS' default case-insensitive file system both names are the same file, so the sweep removes it and the "kept" file is missing: `expected ['f.json', ...4] to deeply equal ['f.json', ...5]`. Passes in the node:22 container (Linux, as root and as `node`), so CI is unaffected; seen locally from Task 5 of slice 2b-1 and again at its close. Fix later by using a name that differs by more than case (for example a 13th character) or by skipping the case-only look-alike when the file system folds case.

Update (2026-10-30, Task 12 fix round): passes in node:22 (Linux, case-sensitive; secure-json-file.test.ts, as root and as the node user); it fails only on the macOS default file system.

Update (2026-10-31): the upper-case look-alike is now `f.json.0123456789AC.tmp`, which differs from the temp names by more than case, so it is a distinct file on a case-insensitive file system too.

```
BUG-0014: CodeQL js/file-system-race alerts in the control service tests (stat a path, then read the same path)
Severity: Low
Related Story: US-0058
Related Task: TASK-0087
Status: Fixed (15bfed8)
Fix Branch: feature/EPIC-0002-US-0059-readiness
Lesson Encoded: No (L-0003 and L-0017 already state the rule)
```

PR #60's CodeQL check failed with three high alerts (25, 26, 27), "The file may have changed since it was checked.", in `services/control/src/__tests__/session-list.test.ts:52`, `spawn.test.ts:146` and `supervisor.real.test.ts:103`: each test `statSync`-ed a file for its mode and then `readFileSync`-ed the same path. Fixed by `read-once.ts` (`readOnce` opens the file once with `O_NOFOLLOW` and returns mode, inode and text from that descriptor; `dirMode` fstat's a directory descriptor); the other stat or exists checks on the branch's files (`supervisor.create.test.ts`, the runtime's `main.managed.test.ts` helper and the runtime's `.env` read in `main.ts`) were changed the same way.

```
BUG-0015: A start that fails after session.started was written cannot be retried (log_not_empty)
Severity: Medium
Related Story: US-0059
Related Task: TASK-0094
Status: Fixed
Fix Branch: fix/bug-0015-interrupted-start
Lesson Encoded: No
```

`SessionHost.start()` sets `started` only after `engine.start` succeeds, so a failed start "can be retried". But `engine.start` refuses a log that already has events (`log_not_empty`, `session-engine.ts:167`). If the start fails AFTER `session.started` (or the opening scene events) were appended, for example a provider error while the opening scene is produced, the log is no longer empty, the engine is not idle, and every retry answers `already_started` or `log_not_empty`: the session is wedged until it is restarted with `SESSION_START=resume`. Pre-existing (found while reviewing slice 2b-1; unrelated to the readiness race of BUG-0009). Needs a design decision first: either the host treats a log that begins with `session.started` as started (resume in place), or a failed start rolls the engine back to idle and truncates the log. Found by the slice 2b-1 whole-branch review; no test reproduces it yet. Reproduced by a test that makes the second append refuse (the log's `closed` code, which does not fail-stop).

**Fix (design: resume in place).** The log is append-only and subscribers may already have seen `session.started`, so rolling back by truncating would retract an event and write to a disk that just failed. Instead the engine runs the opening (NPC states, first scene, opening inject) as a list of steps and drops each only after its append succeeds; a second `start` finishes the remaining steps (`SessionEngine.startIncomplete`). The host skips the readiness gate on that retry (the log already records who started) and keeps seats, consents, reissue and leave frozen between the attempts; the facilitator `command` auto-start now keys on `hasStarted`. A fail-stop (`log_failed`) still ends the attempt for good and the restart resumes from the log, unchanged. M-9 second half: the BFF start waiter now ends only on codes a start can produce (`START_ERRORS`), so a stray `not_started` or `forbidden` frame no longer reads as a refused start.

```
BUG-0016: A resume whose repair ends the session never tells the control service and never revokes credentials
Severity: Medium
Related Story: US-0059
Related Task: TASK-0095
Status: Fixed
Fix Branch: feature/EPIC-0002-US-0059-runtime-protocol
Lesson Encoded: No
```

`markResumed` runs inside `openSession`, before `main.ts` subscribes to the engine and before `SessionHost` exists. When the restore repair ends the session (today the `script_complete` repair: the log was cut after the last scene's exit), the `session.ended` event is appended with nobody listening, so the `ended` IPC message to the control service is never sent and the credentials are never revoked (the host's own `session.ended` subscriber also does not exist yet). The control service keeps listing the session as running and the player codes and reconnect tokens stay valid. Pre-existing; found while planning `end_now`, whose `facilitator_end` repair would hit the same path.

**Fix.** After `ready` is sent, `main.ts` checks `host.engine.state.status === "ended"` once; if so it sends `ended` at once (through the same once-only flag the live subscriber uses, so a live end and this path never both send) and calls `host.endSeats()`; a failing revoke is reported as a warning, not thrown. A running resume is unchanged. Tests: `main.parent.test.ts` (a repaired-to-ended resume sends `ready` then `ended` and the credential registry is latched and empty; a normal resume sends `ready` only).

**Fixed in** `f8d21bc` (the runtime sends `ended` after `ready` and revokes the seats) and `5fdc9f2` (the control service keeps an `ended` that arrives right after `ready`); the branch is squashed on merge, so these hashes are for the branch history only.

**Follow-up (review).** The control service's `awaitReady` stopped listening once `ready` settled and the live handler was installed only afterwards, so an `ended` sent right after `ready` was dropped and the list kept the session "running". `awaitReady` now records an `ended` seen after `ready` and `goLive` applies it through the idempotent `onEnded` (both callers: create, and the shared start path used by restart/resume and reissue-all). A standalone (no control service) resume repaired to ended now also revokes the seats. Tests: `supervisor.lifecycle.test.ts` (ready+ended burst, create and restart), `main.parent.test.ts` (persisted end mark, a throwing revoke is warned, standalone).


```
BUG-0017: The player stream hub stalls on a reset larger than 256 KiB
Severity: Low
Related Story: US-0059
Related Task: TASK-0096
Status: Fixed
Fix Branch: fix/bug-0017-0018-hub-reset-and-silence-test
Lesson Encoded: No
```

Found in the final review of slice 2b-2b1. The console hub (`facilitator-hub.ts`) was fixed so that a reset frame over 256 KiB no longer stalls the stream; the player `StreamHub` shares the older behaviour and still stalls (the browser is dropped as slow) on a reset that large. No scenario today produces a player reset that big. Fix: apply the console hub's handling to the player hub and add the same test.

Fixed: `StreamHub.open` now wraps its opening writes (retry, joined, reset) in `SseWriter.beginOpening()` / `endOpening()`, as `FacilitatorHub` does, so the opening frames are not counted towards `maxPendingBytes` (nothing drains `out` until `open` returns). The cap still applies in full from the first frame after the opening, so a reader that genuinely stalls is still dropped with `reconnecting` and per-client memory stays bounded. Tests in `stream-hub.test.ts`: a reset over 256 KiB through the real `sseBody` is delivered in order with the stream open, and a stall after the opening still ends the stream. Both failed before the change. The web suite and the two stream-hub files pass on the host and in the node:22 container as root and as `node`.

```
BUG-0018: npc-agent.silence.test.ts fails under heavy load
Severity: Low
Related Story: US-0032
Related Task: None
Status: Fixed (hardening; original failure not reproduced)
Fix Branch: fix/bug-0017-0018-hub-reset-and-silence-test
Lesson Encoded: No
```

`services/runtime/src/agents/__tests__/npc-agent.silence.test.ts` ("is linear on abusive input") has an absolute elapsed-time bound that a loaded machine can exceed; it was seen once in the slice 2b-2b1 work and passed in both close-out coverage runs. It is the same pattern as the 2026-10 coverage-check failures recorded in `docs/LESSONS.md`. Fix: assert the scaling between two input sizes (or count operations) and keep only a generous absolute cap.

Fixed: the test already asserted scaling, not elapsed time: BUG-0006's fix (a2fd11f) moved it to `expectLinear` (8x the input must cost under 30x, best of runs, 60 s hang cap only), so the absolute bound described above was gone before this bug was filed and no product code is involved. The failing assertion was never captured, so the cause is unconfirmed; the likeliest exposure is timing noise in the best-of-3 samples, and the test now takes the best of 7 runs per size. This is hardening for a suspected hazard, not a verified cure: reopen if it recurs, and capture the ratio and message. Verified: 20 runs under 8 CPU burners passed (ratio 6.0 to 15.5 before the change, 6.7 to 11.6 after, limit 30), one run under `--coverage` passed (ratio 8.4), and a deliberately quadratic workload still fails `expectLinear` (ratio 85).

```
BUG-0019: A facilitator whisper never reached a web player's screen
Severity: Medium
Related Story: US-0059
Related Task: TASK-0097
Status: Fixed (feature/EPIC-0002-US-0059-console-controls)
Fix Branch: feature/EPIC-0002-US-0059-console-controls
Lesson Encoded: No
```

Found by the first end-to-end run of the console controls. The runtime delivers a whisper (a `facilitator.command` with `command: "whisper"`) only to the addressed role's stream, and the console confirmed "Whisper sent.", but the shared player reducer `applyPlayerEvent` (`packages/events/src/player-view.ts`) ignored every `facilitator.command` except pause and resume, so no web player could see one. The terminal player was not affected.

**Fix.** A whisper is added to the player's updates (`view.injects`, shown under "Updates") as plain text, with the scene it arrived in; the player sees the text only (no sender name, `by`, ref or ack). Tests: `packages/events/src/__tests__/player-view.test.ts` (a whisper is shown with the updates and changes nothing else) and the e2e `apps/web/e2e/console-controls.spec.ts` "pause, whisper and resume" (the addressed player sees it once, the other two never do, and no player page contains the facilitator's name).

**Limits (fixed by BUG-0023).** A full page reload used to lose the whisper (it was not in the join snapshot, as with injects) and it appeared as an ordinary update with no "private" label. Owner decision (2026-11-03): a whisper gets a "private" label and survives a reload. Both are fixed by BUG-0023; injects are still not in the join snapshot.

```
BUG-0020: The bot socket test "a second open after close() never overlaps" failed once under full-suite load
Severity: Low
Related Story: US-0060
Related Task: TASK-0099
Status: Fixed (4551682 on feature/EPIC-0002-US-0060-ai-seats-reachable, squashed into #83)
Fix Branch: feature/EPIC-0002-US-0060-ai-seats-reachable
Lesson Encoded: No
```

`services/control/src/__tests__/bots/bot-socket.test.ts` (added in slice 2b-3b PR 1) failed once in a full control-suite run with `maxLive` 0 where 1 was expected, and passed three times alone. Root cause, confirmed by logging under load: a race in the test's measurement, not in `BotSocket`. The server-side live-socket counters `live` and `maxLive` were module-level and reset in `beforeEach`, and the previous test ("peer never answers the close") terminates its sockets in `afterEach`, so that socket's server-side `close` event could arrive after the next test's reset, run `live--` on the new counter (live -1) and leave `maxLive` at 0 when the next connection brought it back to 0. Fixed: each test gets its own counters that its handlers capture, so a stale event only touches its own test's counters. Verified: with a 1 ms delay on the stale close bookkeeping the old version failed 5 of 5 runs and the fixed one passed 10 of 10; 70 of 70 runs passed under 8 CPU burners (plain, shuffled and threaded) and 19 of 19 in the node:22 container as root and as `node`. The other bot tests count sockets on in-process fakes and do not have the pattern.

```
BUG-0021: After a control-service restart a lobby's AI roles can come back as human with no notice
Severity: Medium
Related Story: US-0060
Related Task: TASK-0099
Status: Fixed (bb00195, de2f3b1 and 915472e on fix/bug-0021-ai-roles-after-control-restart)
Fix Branch: fix/bug-0021-ai-roles-after-control-restart
Lesson Encoded: No
```

Found by the whole-branch reviews of slice 2b-3b PR 2 (known gap M-1). `reissueAll`, `restart` and `resumeAll` capture the session's AI roles in memory (`aiRolesOf`) before a launch that issues fresh codes, and re-send them with `set_ai_roles` when the log is empty, because fresh codes remove `<id>.ai-roles.json`. After a control-service restart nothing is in memory, so `resumeAll` and `restart` capture an empty set: if the launch issued fresh codes (the codes file is missing or does not match), the runtime drops the lobby's AI-role file and the roles come back as human, silently. Needs a lost or mismatched codes file in an empty lobby plus a control restart; the facilitator has to reissue the codes anyway and the console shows the roles as human, so no human can end up in an AI seat and no AI line is unlabelled. Fix (proposed): before a launch, note whether `<id>.ai-roles.json` exists while `<id>.codes.json` is missing, and log a fixed line or flag it on the session info so the console tells the facilitator the AI roles were reset; or have the runtime's `ready` report the dropped set. Test: a new Supervisor over a data dir with an AI-role file and no codes file.

**Slice 2b-3b PR 3 note:** the AI toggle is now on screen, so a facilitator can reach this gap without the API (set AI roles on a lobby, restart the control service so that fresh codes are issued). PR 3 changes nothing here and the bug stays open.

Fixed: the runtime now reports what it dropped. In a managed empty-log start, `openSession` reads `<id>.ai-roles.json` before `settleCodes`/`settleSeats` can remove it (through the same bind-checked, size-capped, no-follow reader as every AI-role read, but without requiring the credentials to match, which is safe because the seats are always replaced when it reports; a corrupt, wrongly bound, oversized, symlinked or unreadable file means nothing to report, never an error), and when the seats were replaced it returns the roles as `aiRolesReset`; `bootstrap` sends them as the optional `aiRolesReset` field of `ready` (absent when empty, `.max(MAX_CODES)`, in both schema copies, pinned in `protocol.drift.test.ts`). In the control supervisor `afterCodedLaunch` (also called when the ready carries `aiRolesReset` but no codes, i.e. codes kept and seats replaced) uses `ready.aiRolesReset` as the set to restore when no set is captured in memory (the in-memory set wins); it re-sends `set_ai_roles` for an empty log only, hands AI codes to the bots through the existing attach and returns human codes only. A refused or failed re-send follows the existing rule (`conflict`, no codes, nothing opened, `resumeAll` logs a fixed line), so an `ai_notice` refusal leaves the roles human and the bot host unconfigured. A started log never re-sends. The report is one-shot: if the re-send fails, or the control service dies before the reply, the AI-role file is already empty and the roles stay human (the safe direction; the facilitator sets them again). Verified: new tests in `session-store.ai-roles.test.ts`, `main.ai-roles.test.ts`, `supervisor.bots.integration.test.ts` (new Supervisor over the data dir with the real BotHost), `protocol.drift.test.ts`; reverting either half makes them fail; runtime 4005 and control 399 tests pass, and the new filesystem/process tests pass in the node:22 container as root and as `node`.

```
BUG-0022: Keyboard focus falls to the page body after End session, a connection drop under a dialog or a 409 on Remove
Severity: Medium
Related Story: US-0059
Related Task: TASK-0097
Status: Fixed
Fix Branch: fix/bug-0022-console-focus-fallback
Lesson Encoded: No
```

Found in slice 2b-2b2 (listed among its open items in `progress.md` Session 16). A confirmation dialog returns focus to the control that opened it. After a successful End session the `ended` final unmounts the controls and the button that opened the dialog, and when the connection drops while a dialog is open or a Remove answers 409 the opener is detached or disabled, so focus falls to the body: a keyboard or screen-reader user loses their place and nothing announces the new state. Owner decision (2026-11-03): move focus to the final banner (made focusable with `tabIndex={-1}`) after End session, and to the connection or error message that appears in the other two cases. Fix: a small console change with unit tests for each case and an Axe/keyboard check in `apps/web/e2e/console-controls.spec.ts`. **Slice 2b-3b PR 3 note (not a fix):** the AI toggle's switch confirmations use the same dialog; `Readiness` puts focus back on the switch by a data attribute after a switch, and the AI players panel puts it back on Prompt AI player only when focus is on the page or the button. None of the three cases above is changed, and the bug stays open (superseded by the fix below).

Fixed: `ConfirmDialog` now gives focus back to its opener only while the opener is in the document, shown and not disabled (`aria-disabled` still counts as focusable), and only when focus is on the page or was inside the closed dialog (a user who moved focus elsewhere keeps it). Otherwise it calls the new optional `fallbackFocus` prop; `focusFallback(...names)` finds the first `data-focus-fallback="<name>"` element that has text. The targets are `tabIndex={-1}` text elements already in their live regions, so no new landmark, heading or announcement: the ended final banner in `SessionConsole` (`final`), the reconnecting message in `LiveView` (`connection`) and the always-mounted `role="alert"` error line in `Readiness` (`error`). The console controls' dialog tries `final` then `connection`; `Readiness`' dialogs try `error`. `SessionConsole` also moves focus that fell to the page to the banner when the `ended` final arrives after the dialog has already closed. Verified by `ConfirmDialogFocus.test.tsx`, `SessionConsoleFocus.test.tsx` and two new `Readiness` 409 tests (removing the fallback fails five of them), the whole `@acr/web` suite, `pnpm -r --if-present typecheck`, and `console-controls.spec.ts` (End session leaves the final banner focused), `console-flow.spec.ts` and `axe.spec.ts` in Chromium. Coverage limits: only the End session case is covered by e2e; the connection-drop and 409-on-Remove cases are unit-tested only. Of the original Axe/keyboard plan, the keyboard check (focus on the banner after End session) was done; no new Axe check was added, the existing Axe specs (with each dialog open) still pass and the targets add no landmark or heading.

```
BUG-0023: A facilitator whisper has no "private" label and is lost on a page reload
Severity: Medium
Related Story: US-0059
Related Task: TASK-0097
Status: Fixed (fix/bug-0023-whisper-private-label-and-reload)
Fix Branch: fix/bug-0023-whisper-private-label-and-reload
Lesson Encoded: No
```

The remaining limits of BUG-0019. The player reducer now shows a whisper under "Updates", but it is not in the join snapshot (as with injects), so a full page reload loses it, and it reads like an ordinary update with no "private" label. Owner decision (2026-11-03): a whisper gets a "private" label and survives a reload. Fix: carry the addressed role's whispers in the player snapshot (allowlisted copy, the addressed role only; the leak scan must still show no other role, no `by` and no ref receives one), keep the scene it arrived in, label it "Private" in `Transcript`/`Updates` as text, and cover it in `packages/events` player-view tests, the player-copies allowlist test and the `console-controls.spec.ts` e2e (reload keeps it for the addressed player only).

**Fixed:** the state fold (`packages/events/src/state.ts`) keeps the last 50 whispers per addressed role as `{ seq, sceneId, text }` (`sceneId` only when the addressee takes part in the current scene, else null); nothing else of the command is kept, so there is no `by`, ref, ack or addressee list. `PLAYER_SNAPSHOT` (`services/runtime/src/host/player-copies.ts`) copies a role's own list into its join snapshot, so the snapshot of every other role, the AI seat's, a late joiner's and every roster frame carry nothing of it; a missing entry is still a compile error, and the console state (`CONSOLE_STATE`) lists the key as empty because the console has the whispers as events. `initPlayerView` turns the snapshot's whispers into private updates (`injects[].private`), so a reload shows each once (the replay's copy has the same seq and is dropped). The player page labels a whisper with a "Private" pill (`BriefPanel`; text, with a screen-reader colon), and the terminal prints past whispers as `[whisper] ...` in the joined history. The log format is unchanged (the fold is derived from the log; a restore rebuilds the same lists). Tests: `state.test.ts` (fold, cap, `__proto__` role, `reduceReplay`), `player-view.test.ts` (seed, order, dedupe, malformed), `player-copies.test.ts` (own list only, three keys, no `by`), `ws-server.whispers.test.ts` (real sockets: the addressee's rejoin holds it, no other inbox or roster frame does, control and bidi characters unchanged), `session-engine-restore.test.ts`, `render.test.ts`, the web unit tests for the label and the reload, and the e2e `console-controls.spec.ts` "pause, whisper and resume" (Private label, reload keeps it once, the other two never see it, also after their own reload).

**Who holds a whisper.** The same participant rejoining or reloading (same reconnect token or credential) keeps their whispers. A replacement participant (the seat reissued after the start) does not inherit the old holder's: the state fold sets a per-role floor (`whisperFloor`) from the fixed-prefix alert a post-start reissue appends ("consent for <role> will be rebound after a code reissue by ..."), and the host also records the log's last seq in memory at the reissue itself; the player snapshot keeps only whispers above the floor, so a restart (state rebuilt from the log) gives the same answer. A whisper sent after the replacement joined is delivered live and kept. Players of OTHER roles never get a role's whispers, late joiners included. The floor is read from the alert text: if that alert's append fails (reported) only the in-memory floor protects the replacement until a restart. Tests: `ws-server.whispers.test.ts` (whisper, reissue, new participant: none, also after a restart; own rejoin keeps; a later whisper kept), `state.test.ts`. The demo restore audit (`demo/resume.ts`) now compares `whispers` and `whisperFloor`.

```
BUG-0024: The stream hubs drop a reconnecting client whose replay follows a large opening frame
Severity: Low
Related Story: US-0059
Related Task: TASK-0096
Status: Fixed
Fix Branch: fix/bug-0017-0018-hub-reset-and-silence-test
Lesson Encoded: No
```

Found in the review of the BUG-0017 fix. Both hubs ended the opening window (`SseWriter.endOpening`) before registering `conn.onFrame`, but the first `onFrame` flushes the replay queued in the connection synchronously, before anything can drain `out`. A complete replay can be up to 256 KiB of event JSON (`MAX_REPLAY_BYTES`, services/runtime/src/host/session-host.ts) plus about 30 bytes of SSE framing for each of up to 1,000 events, so after a joined frame already over the 64 KiB high-water mark the total passed the 256 KiB stall cap and the browser was dropped as slow on reconnect, and again on every retry. Affects `StreamHub` and `FacilitatorHub`.

Fixed: both hubs now call `endOpening` right after the first `onFrame` registration, so the replay flush belongs to the opening; the cap applies from the first frame after it. Memory stays bounded: the exempt part is the joined frame (and reset) plus a replay the runtime caps at 256 KiB, written once per stream, and a reader that stalls afterwards is still dropped at the 256 KiB cap. A test per hub (a queued replay past the cap is delivered in order, then a stall ends the stream with `reconnecting`) fails without the change; `FakeConn` now flushes queued frames on the first `onFrame`, like `RuntimeConnection`.

```
BUG-0025: Forged-cookie read failures share the enter throttle table, so a saturated table reaches valid reads
Severity: Low
Related Story: US-0062
Related Task: TASK-0100
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Found in the final review of slice 2c-1 PR 2. `GET /api/v1/report` counts reads that fail before control (no, forged, expired or wrong-purpose cookie) in `reportEnterThrottle` under `*report-read-fail`, the same table that `POST /api/v1/report/enter` uses. When that table is full of blocked addresses (about 10 000), `blockedForMs` answers 429 for every address without an entry, valid readers and valid enters included. Forged GETs have no Origin check and no body, so they fill it more cheaply than enter POSTs. Practical only with a spoofable `X-Forwarded-For` or a botnet, and the threat model's general fail-closed sentence covers it without saying it now reaches valid reads. Fix: give read failures their own throttle instance (one line in `routes.ts`) and say so in `docs/THREAT_MODEL.md`.

```
BUG-0026: `ws-server.roster.test.ts` (a superseded connection gets no roster frame) is flaky in full runtime runs
Severity: Low
Related Story: US-0062
Related Task: TASK-0100
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Seen once in a full `@acr/runtime` run and once in five isolated runs during slice 2c-1, with no changed file touching it. It looks like a timing assumption in the test, but it has not been run against `develop` to confirm that it is not caused by this slice. Not related to US-0062 itself; filed there because it was found while closing the slice. Fix: reproduce with `vitest run --repeat` on `develop`, then replace the timing assumption with an event wait (see BUG-0020 for the same class).

```
BUG-0027: The conflict sentences are copied between the control service and the web server with no test that they stay equal
Severity: Low
Related Story: US-0062
Related Task: TASK-0100
Status: Fixed (e637b95)
Fix Branch: bugfix/BUG-0034-participant-path
Lesson Encoded: No
```

`KNOWN_CONFLICTS` in `apps/web/src/server/report-handlers.ts` repeats the fixed sentences of `services/control/src/reports.ts` and `report-access.ts`, because the web package must not import the control service or the runtime. If control rewords one, the console silently falls back to its generic sentence. Fix: a test that reads the sentences from both sources (a small shared constants file under `packages/events` is the allowed route) and fails when they differ.

Fixed: the sentences are defined once as `REPORT_SENTENCES` in `packages/events/src/report-sentences.ts` and imported by the control service (`reports.ts`, `report-access.ts`, `api.ts`, `moderation-routes.ts`), the BFF (`KNOWN_CONFLICTS`, `report-handlers.ts`) and the console (`console-api.ts`, `messages.ts`). There were more copies than the entry said (the control `CONFLICT` sentence, the 503 "report is unavailable" sentence in three more places, and the console's refusal table). One test, `apps/web/src/lib/__tests__/report-sentences.test.ts`, checks the words, the BFF's known conflicts, the console constants and that no consumer declares the words again as a literal. The e2e spec keeps its own literals as an independent check. The words did not change.

```
BUG-0028: Slice 2c-1 test and cleanup gaps: seeded e2e folders, thin Axe coverage, dead console branches
Severity: Low
Related Story: US-0062
Related Task: TASK-0100
Status: Open (parts 2 and 4 fixed on bugfix/BUG-0034-participant-path; parts 1 and 3 remain)
Fix Branch: none yet
Lesson Encoded: No
```

Left open by the slice 2c-1 reviews, none blocking. (1) The Playwright test seeds its review folders with the runtime's `moderate` functions (`services/control/src/__tests__/seed-report-folders.ts`, which also reaches into runtime test fixtures and seeds `alice` and `bob`, not the session's seated roles) instead of running a real `evaluate`; so the "human role in the same review" of `report-ai-role.spec.ts` is `bob`, a fixture role that is not a seat. Remaining: move the seeder under `services/runtime/src/__tests__` and have it take the session's player roles. (2) Done (839925f): the throttled and not-released states of `/report` were already covered by Axe (since #106); `/report/enter` (opening, throttled, retry and refused) is now covered in `apps/web/e2e/axe.spec.ts`. (3) Remaining: `ReportLinksPanel` keeps a "Revoked" branch that can never show, because control lists only live credentials (`revokedAt === undefined` and not expired), so `link.revoked` is always false; drop it, and `revoked` from `linkDto`, which is internal to the web app. "Link expired" can still show, at the expiry instant or with clock skew between the control and web hosts (the BFF recomputes `active` with its own clock), so keep it, and add a test for it and for the AI-row variant. (4) Done (17d7955): the `ReportView` retry had no unmount guard (harmless in React 19, which no longer warns); it now uses a `mounted` ref, with a test that counts state updates after unmount.
```
BUG-0029: A response resent after a BFF timeout is stored twice when another response landed in between
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). `POST /api/v1/report/responses` has no idempotency key. A plain resend is already safe: `addResponse` (services/runtime/src/participant/write.ts) ignores a response identical to the subject's LAST one (same criterion, text and dispute flag; answered `wrote: 0`). What is left: if the BFF times out after control has recorded response A, and another response B is recorded for the same role before A is resent (a second tab, or the participant sending something else first), the resend of A no longer matches the last response and A is stored twice. A resend with edited text is stored as a new response too, beside the original the participant believed lost. The cap of 50 responses is per role (LIMITS.responses on the subject), not per credential. Harmless to the scores (a response is a note, not a rating) but noisy in the report and the export. Fix: a client-generated key on the request that control stores with the event and checks before appending. This is a wire change (an optional field first, then required), so it needs its own slice and the usual control-before-web deploy order.

```
BUG-0030: A forwarded report link can use up its owner's 50 response slots, and a response is not redacted
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). A report link is a bearer credential. Anyone who holds a forwarded link can post responses as its owner until the owner's 50 response slots are gone, and the owner cannot add one. There is also no redaction of a response after it is filed (the facilitator can resolve a dispute, not remove the text). This is a design decision, not a code slip: options are a lower cap per sitting, a facilitator "hide this response" event, or a per-link write cap with a notice. Revoking and reissuing the link already stops the abuse for future writes. Decide with the owner before building; record the choice in `docs/THREAT_MODEL.md`.

```
BUG-0031: Reviews opened before schema `/2` cannot take web writes
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). A review opened before slice 2c-2 carries the schema `acr.review/1`: the schema is written by `moderate open` into the `review.opened` event (services/runtime/src/review/store.ts), not by the evaluator. Control answers `old_schema` for a participant's self-rating or response on it, with the sentence "This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal." (WRITE_OLD_SCHEMA, services/control/src/participant-writes.ts). The ways out today are to take the rating or response in the terminal (facilitator-attested), or to get a `/2` review by opening a new directory: `moderate open` refuses a directory that already holds a review ("a review is already open here"), so this means a re-run of `pnpm evaluate` into a new directory and `moderate open` on it, or `moderate supersede <old> <new>` once a version was released (supersede writes a new `review.opened` with the current schema and carries the moderation). The console offers none of these. Reads still work. Fix: a one-off migration (a `moderate migrate` command that rewrites the review header and replays the log under the new schema), with a test on a fixture of the old folder. Not needed for any review created from now on.

```
BUG-0032: Overview answers can arrive out of order, and a failed first overview read waits for Try again
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). The Report panel (apps/web/src/components/console/report/ReportPanel.tsx) reads the overview when it mounts, again after each of its own writes, and polls it only while the stage is `evaluating`; it does not refresh on focus. Two reads in flight (a write's refresh beside a poll, or two quick writes) can answer in the wrong order, and `load` keeps whichever answers last, so an older overview can replace a newer one until the next read. A failed read is not retried by itself: the panel shows the fixed sentence with a "Try again" button, so a transient 503 needs one click. Fix: tag each read with a sequence number and ignore an answer older than the newest one applied; optionally retry a failed first read once after a short delay.

```
BUG-0033: The export menu has no participant view of the group or index, and no export of an amending subject
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Open
Fix Branch: none yet
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). `ExportMenu` (apps/web/src/components/console/report/ExportMenu.tsx) lists only released subjects (and the index once the group is released); for a player's report it already offers that player's own view, but for the group and the index it offers only the facilitator's view. The export route already accepts `participant:<role>` for every subject (services/control/src/moderation-routes.ts), and the runtime's export gate (`exportGate` and `canView`) allows (1) a participant's view of the group or the index, with peers' results removed, and (2) a participant's export of an AMENDING subject, which is its last released version (a facilitator export of an amending subject is refused as `not_released`). Drafts are never exported. Fix: in `ExportMenu`, offer a participant view of the group and the index (choosing which participant), and list an amending subject for the participant's view only, with a line that says it is the released version; reuse the existing route.

```
BUG-0034: Edits made while a save is in flight are lost when the draft clears
Severity: Low
Related Story: US-0066
Related Task: TASK-0104
Status: Fixed (8ade287)
Fix Branch: bugfix/BUG-0034-participant-path
Lesson Encoded: No
```

Deferred from the slice 2c-4 review (spec section 4.3). In the participant's self-rating form, a save clears the browser draft when it succeeds. If the participant types in a box after pressing Save but before the answer arrives, the newer text is cleared with the draft. Fix: remember what was sent and clear the stored draft only if the form still equals it, or mark the form dirty again on any change during the save, with a component test that types between send and answer. (The console's Summary editor avoids the same race by disabling its boxes while a save is in flight.)

Fixed: the form counts its edits. The newer text stayed on screen, but its stored draft was cleared, it was never sent and the form said "Saved". Now a save that finishes after a newer change keeps the stored draft and says "Your latest changes have not been sent yet. Press Save again to send them." The inputs stay enabled (a disabled box would lose focus). A component test holds the request, edits during the save, releases it and checks the draft and the message. The same PR trims the note sent for a rated criterion (a note of only spaces is now omitted, bcf5172).
