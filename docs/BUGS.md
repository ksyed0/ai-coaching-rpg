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
