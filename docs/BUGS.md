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
Status: Fixed (499ba98 on chore/BUG-0005-pause-freezes-scene-clock)
Fix Branch: chore/BUG-0005-pause-freezes-scene-clock
Lesson Encoded: No
```

`SessionEngine.doTick` returned early while paused, but the elapsed time it used afterwards was `clock.now() - enteredAt`, so the time spent paused counted against the scene. After a long pause, `/resume` fired every timed inject that had come due and could end the scene on its time box at the next tick. Decision by the product owner: pause freezes the scene time box and the inject clock; `/resume` continues with the remaining time. Fixed: the reducer records `pausedSince` (the timestamp of the pause event) and accumulates `currentScene.pausedMs` per scene on resume, and the exported pure function `activeElapsedMs(state, now)` (`now - enteredAt - pausedMs - open pause`) feeds the inject schedule and the exit check. The value is derived only from recorded event timestamps, so a replay of the log (US-0018) computes the same remaining time. A second pause or resume is ignored, a scene entered while paused starts frozen with a fresh clock, and a pending facilitator advance waits for resume. Unit tests cover the reducer and the engine (pending injects with a running time box, exact remaining time, repeated pause/resume, pause before the first inject, a pending advance, a fresh clock for the next scene, replay equality).
