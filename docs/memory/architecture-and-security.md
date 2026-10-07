# Architecture and security conventions

## Shape of the system (monorepo: `packages/events`, `packages/script`, `packages/adapters`, `services/runtime`, `scenarios/`)
- **Event-sourced.** Session state is always a projection of an append-only JSONL log through the pure reducer (`packages/events/src/state.ts`). `reduceReplay` is an in-place twin used only by restore (marked `@internal`); a property test proves it equals `reduce`.
- **Engine** (`services/runtime/src/engine`): mutex-serialised operations; the log is the source of truth. **Host + WebSocket server** (`host/`): default-deny per-role event filtering (`viewFor`, `snapshotFor`, `filterFor`); a new event type is invisible to players until explicitly allowed.
- **Agents** (`agents/`): `NpcAgent` (first-token and total deadlines, canned `fallback_line` marked on the event, repetition guard, `<silent/>` turns), `GameMaster` (evaluates exit conditions every N utterances, one bounded re-ask, `gm.no_verdict`), prompts built by pure functions.
- **Scenario fields for AI characters:** `persona, goals, knowledge, hidden[], guardrails, fallback_line, voice, seniority (1..5), responds_with[], only_you_say[], defer_to[], defers_text`. Role and scene ids may not be `__proto__`, `constructor`, `prototype` or `facilitator`.

## Game Master verdicts (a `true` ends a scene: the dangerous direction)
Each evaluation carries a fresh 16-hex nonce in the SYSTEM prompt only. Only a verdict object with `"id": <nonce>` counts (case and surrounding whitespace tolerated). Quoted text, an echo after the answer, nested objects, duplicate keys, arrays, truncated replies and conflicting verdicts are never accepted. Each model call has its own abort signal linked to the deadline.

## Hidden facts
`release_hidden {roleId, fact (1-based)}` records `facilitator.command` (no text) then the facilitator-only `npc.updated{released}`. A released fact appears only in that character's prompt, in `## What you may now share`. Players, other characters, the Game Master, generated players, the evaluator and every demo output never contain the text (except the owner saying it aloud later). S-06 judges prompts by time against the release seq. US-0034: an optional `earned_when: {<n>: condition}` per fact; the Game Master judges pending ones (characters in the scene, not suggested, not released) after the exit conditions through the same nonce path, its prompt never holds the fact; a true verdict appends the facilitator-only `gm.fact_earned` (no text) once per fact per session (`state.factsEarned`, rebuilt from the log). `GM_AUTO_RELEASE=1` (off by default) adds `autoRelease: true` plus the `npc.updated`; resume repair `gm_release` completes a cut one.

## Session log, resume and fail-stop
- Log format 1: `session.started` carries the format and a SHA-256 of the loaded, schema-validated scenario. Auto-resume comes back PAUSED (`session.resumed`); downtime counts as paused time (`pausedMs`, `activeElapsedMs`; pause freezes the scene clock). Refused on corruption beyond a cut last line, a newer format or a scenario mismatch; `SESSION_START=fresh` moves the old log aside.
- Single-writer lock `<id>.lock` (O_EXCL/O_NOFOLLOW, heartbeat, stale takeover that pins the judged file descriptor). `fdatasync` per append, files 0600, directory 0700, directory fsync.
- **Fail-stop:** after any write, sync or lock failure the log is permanently broken and the engine halts; clients get an unlogged `log_failed` notice; the process exits 1 and a supervisor restarts it (compose `restart: on-failure:5`; `run.sh --dev` does not). An event may be on disk that no client saw: the log is the truth.
- A crash between the appends of one operation is completed on the next resume (tested at every event boundary).

## Evaluator (`services/runtime/src/evaluator`, rubrics in `scenarios/*/rubrics`)
BARS, four levels (1 Not yet demonstrated .. 4 Advanced) plus Not observed. A 3 or 4 needs a verified verbatim quote from that participant's own line (else capped at 2); confidence from distinct lines; learning-objective means with labels; no single overall grade. Reports are DRAFTS held for facilitator review; participants see each other's reports for now (prototype setting; isolation planned). The method text is printed in every report.

## Security conventions (all learned from review or CodeQL on this repo)
- Never stat/lstat/exists a path and then open or read it: open ONCE, `fstat` the descriptor, use `O_EXCL`/`O_NOFOLLOW` (CodeQL `js/file-system-race`, high; flagged six times).
- Never log an environment-derived string (host, path, token, origin): log constants, ports and booleans (CodeQL `js/clear-text-logging`, high).
- `js/file-access-to-http` on `gm-eval --live` (repo-committed labelled cases to the model) is by design; it did not fail the CodeQL check.
- Own-property lookups for any client-supplied id; refuse prototype keys at load.
- Transcript Markdown: every model or participant line goes through `safeMd`; raw text is split on newlines BEFORE sanitising.
- Facilitator token: SHA-256 + `timingSafeEqual`, never logged; a refused connection is closed and its queued frames dropped; per-address failure throttle; open-by-default with a loud warning until a later release (fail-closed). Threat model: `docs/THREAT_MODEL.md`.
