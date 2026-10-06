# Bugs

```
BUG-0001: Heartbeat tests use 30 ms periods and can fail on a loaded CI runner; heartbeatMs of 0 or less is not guarded
Severity: Low
Related Story: US-0009
Related Task: TASK-0009
Status: Open
Fix Branch: bugfix/BUG-0001-heartbeat-test-timing
Lesson Encoded: No
```

A healthy client whose pong is delayed by more than one period is terminated, and a slow join can be killed before `joined`. Use periods of 100-150 ms in the tests. Separately, `heartbeatMs: 0`, a negative value or NaN makes `setInterval(0)` terminate sockets almost at once; production never passes the option, but it should be validated.

```
BUG-0002: Connection failures on a custom Anthropic endpoint are reported as "redirects are refused"
Severity: Low
Related Story: US-0014
Related Task: TASK-0014
Status: Open
Fix Branch: bugfix/BUG-0002-anthropic-endpoint-errors
Lesson Encoded: No
```

With `ANTHROPIC_BASE_URL` set, the redirect-refusing fetch wrapper maps every non-abort failure (ECONNREFUSED, DNS errors, redirects) to one generic message, which hides the real cause. Distinguish a refused redirect from other connection errors while still never echoing URLs or keys.

```
BUG-0003: Demo check F-23 (dead client dropped) reports a timing-dependent figure against a very lenient limit
Severity: Low
Related Story: US-0021
Related Task: TASK-0021
Status: Open
Fix Branch: bugfix/BUG-0003-demo-heartbeat-evidence
Lesson Encoded: No
```

F-23 reports "dropped after ~2 heartbeat periods (limit 25)" in a fast run and "~0 heartbeat periods (limit 25)" in a paced run. The figure changes with pacing, and a heartbeat that took 20 periods would still pass. The server terminates a silent socket after at most 2 periods, so the limit should be about 3, measured from the moment the client stops answering pings, not from the start of the check.

```
BUG-0004: An AI character writes lines for the other participants, and multi-line replies show a literal marker in the Markdown transcript
Severity: Medium
Related Story: US-0026
Related Task: TASK-0026
Status: Fixed (2546513 on feature/EPIC-0006-US-0026-reasoning-model-empty-replies)
Fix Branch: feature/EPIC-0006-US-0026-reasoning-model-empty-replies
Lesson Encoded: No
```

Two defects found in a real run with a small local model (raptor-v0.5-8b). A: Helena Brandt (cfo) produced one reply of `[account_manager]: The fixed fee is 45k ... [client_sponsor]: The module is not in scope; we will not pay for it. [account_manager]: Then the total cost is 45k, and I'll send you a formal quote with the date.` (three speakers, two of them invented). Cause: the NPC prompt shows other speakers as `[role_id]: text` and merges consecutive turns with a newline, and small models continue that pattern. B: `sanitizeText` turns every newline into ` ⏎ ` for terminal safety, and the Markdown transcript reused that text, so a multi-line reply showed a literal ⏎ inside one paragraph. Fix A: the system prompt now says to reply with only the character's own words and never to begin with a `[...]` tag or the character's own name; a pure `cleanNpcReply` strips the character's own leading tag or name, then cuts the reply at the first line or sentence that begins with a `[role_id]:` tag (look-alike brackets, fullwidth letters and invisible characters included), keeping only the text before it. When text was cut, one facilitator alert says so (never quoting the removed text), and a reply left empty takes the existing fallback path. The reply is assembled in full before it is cleaned and recorded, so nothing is streamed to players first. Fix B: the Markdown transcript splits dialogue at its newlines (LF, CRLF, U+2028, U+2029) before sanitizing and renders each line as its own bold span, escaped by the same `safeMd` rules, joined by a Markdown hard break; the terminal keeps the marker.
