# Rollback plan

AGENTS.md section 20: every deployment has a rollback plan written before it starts. Nothing in this repository is deployed to a shared environment yet (the runtime runs on the operator's machine, from `./run.sh` or Docker Compose); this file records what a rollback has to handle, release by release, so the plan exists before the first deployment.

## EPIC-0002 slice 2a: participant web client (US-0052 to US-0056, US-0065)

```
Release: unreleased (develop, after the slice 2a pull requests #53 to #57 and the US-0065 pull request are merged)
Date: not deployed
Rollback trigger: the web client or the new runtime misbehaves in a session (players cannot join or rejoin, the start gate
blocks a session that should start, a leak of facilitator-only data to a player stream), or the runtime must go back to a
version before slice 2a for any other reason.
```

### What changes on disk and in the log

- **Log format 2.** The runtime now writes `LOG_FORMAT` 2: `session.started` gains `consents`, `names` and `logIdentity`. It still reads logs of formats 0, 1 and 2.
- **An older runtime refuses format 2.** A runtime from before slice 2a reads formats up to 1 and refuses to resume a log of format 2 with `the log has format 2, newer than this version reads (1); upgrade, or start fresh` (`RestoreError` `log_format`). It does not modify the log.
- **An older evaluator still reads format 2.** `pnpm evaluate` before slice 2a (`evaluator/log-reader.ts`) has no format check and replays the log through the reducer, which ignores the new `session.started` fields, so it scores a format 2 log as before (checked by reading the code at `d9c0e69`, not by running it). It does not use the new `names` and `consents` fields.
- **New files beside each session log:** `data/sessions/<id>.credentials.json` (salted credential hashes, typed display names, the log identity) and `<id>.consent.json` (who consented, under which notice version, when), both mode `0600`. An older runtime does not read, write or remove them.
- **New runtime setting:** `CONSENT_NOTICE_VERSION` (default `v1`) and the `consent/` directory, which the new runtime needs at start. An older runtime ignores both.
- **The web app** (`apps/web`) is a separate process (`next start`) with its own settings (`RUNTIME_URL`, `PUBLIC_ORIGIN`, `COOKIE_KEYS`, `COOKIE_MAX_AGE_HOURS`, `WEB_MAX_STREAMS*`). It keeps no data of its own; participants' cookies hold their seats.

### Steps

1. **Stop the web app** (`next start`, or its container). Participants' pages show Reconnecting and then stop; their cookies become useless once the runtime is rolled back.
2. **Decide what happens to a session in progress.**
   - Best: let it finish on the new runtime and roll back afterwards.
   - Otherwise the older runtime cannot resume it (format 2). Start it with `SESSION_START=fresh` (`./run.sh --fresh`): the format 2 log is moved aside as `<id>.<UTC time>.jsonl`, never deleted, and a new session starts with new join codes. The old session cannot be continued on the older version. Whether an older runtime rotates an ENDED format 2 log by itself was not tested: use `SESSION_START=fresh` for that case too.
3. **Redeploy the previous version:** check out the last commit before slice 2a on the machine (or the previous image) and start the runtime as before. No database migration exists; nothing else to reverse.
4. **Remove the seat files** of the sessions that ran on slice 2a when they are no longer needed: `data/sessions/<id>.credentials.json` and `<id>.consent.json` hold typed display names (personal data) and an older runtime never cleans them up. Keep the moved-aside logs only as long as you need them; they hold the names and consents too (`session.started`).
5. **Smoke test the restored version:** `pnpm demo --fast` passes its 29 checks; start the server, note the join codes, join one player with `pnpm play` and start a session from the facilitator terminal.
6. **Notify** the facilitators who planned web sessions: participants join from the terminal again until the web client is restored.

### Rolling forward again

A slice 2a runtime reads the logs an older runtime wrote (formats 0 and 1). A session started on the older runtime has no `consents` field in `session.started`, so after the upgrade its rejoins are not checked for consent (grandfathered) and its seats need no consent to start, since it has already started. A session not yet started on the older runtime has an empty log, so the upgrade issues new codes and every player joins and consents again.

### Post-rollback

- Log the incident in `progress.md` with the timeline, root cause and resolution.
- Open a `bugfix/*` branch for the root cause before deploying again, and add a post-mortem entry to `docs/LESSONS.md`.

## EPIC-0002 slice 2b-1: facilitator console and control service (US-0057 to US-0059)

```
Release: unreleased (the stacked branches feature/EPIC-0002-US-0057-facilitator-login, ...-US-0058-launcher-control-service and ...-US-0059-readiness, after their pull requests are merged)
Date: not deployed
Rollback trigger: the control service or the console misbehaves (sessions cannot be created or resumed, a runtime is orphaned, players cannot join through the launcher lookup, a code reissue locks a player out), or the web app must go back to single-runtime mode for any other reason.
```

### What changes on disk and in the log

- **No log-format change.** Slice 2b-1 writes `LOG_FORMAT` 2, exactly as slice 2a, and reads formats 0 to 2. Nothing in 2b-1 makes an older runtime that reads format 2 refuse a log. (Log format 3 belongs to slice 2b-3, when sessions record AI roles; its rollback note will be added then.)
- **New service and directory.** `services/control` keeps `<CONTROL_DATA_DIR>/sessions.json` (session id, scenario id, status; mode `0600`), `<CONTROL_DATA_DIR>/sessions/` (each session's own log, codes, seat and consent files, written by the runtime) and per-session child logs (`CONTROL_LOG_DIR`, default `<CONTROL_DATA_DIR>/child-logs`; no codes or tokens are written to them). The control service never stores join codes.
- **Data directories stay compatible with a terminal-started runtime, with one exception.** A runtime started from the terminal with `SESSION_DATA_DIR` pointed at a session directory reads the same log, codes, seat and consent files. The exception is `CONTROL_MANAGED=1`: only a managed runtime keeps the lobby files (codes, seats, consent) when it restarts on an empty log. A runtime started without it discards them and issues new codes on an empty log, as before, and moves an ended log aside instead of refusing it.
- **Facilitator-only alerts.** A reissue after the start appends facilitator-only alerts about the consent rebind. They are ordinary events that an older runtime ignores.
- **New settings** (all optional, all ignored by a runtime started from the terminal): web app `FACILITATOR_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN`; control service `CONTROL_PORT`, `CONTROL_DATA_DIR`, `MAX_SESSIONS`, `SCENARIOS_DIR`, `CONTROL_LOG_DIR`, `CONTROL_GRACE_MS`, `CONTROL_READY_TIMEOUT_MS`. The control service sets `CONTROL_MANAGED`, `SESSION_DATA_DIR` and `NO_DOTENV` on its children; `SESSION_DATA_DIR` may also be set by hand to continue a session from the terminal (step 3).

### Steps

1. **Disable the console.** Unset `FACILITATOR_SECRET`, `LAUNCHER_URL` and `LAUNCHER_TOKEN` in the web app's environment and restart `next start`. With `LAUNCHER_URL` unset the web app is in single-runtime mode again (`RUNTIME_URL`, as in slice 2a) and `/console` shows "The console is not set up on this server."
2. **Stop the control service** (SIGINT or SIGTERM: it stops its runtimes and exits). If it was killed instead, its runtimes see the IPC channel close and exit by themselves (a hard-exit backstop follows a hung stop), so none is left holding a session lock; check with `ps` and for a leftover session lock file before starting anything on the same data directory.
3. **Decide what happens to the sessions that ran under the control service.** Their logs, codes, seats and consent are in `<CONTROL_DATA_DIR>/sessions/`. To continue one from the terminal, start a runtime with `SESSION_DATA_DIR` set to that directory and the same `SESSION_ID` and `SCENARIO_DIR`; it resumes from the log. A session that has not started (an empty log) loses its lobby files on that start, since the runtime is not managed, and gets new codes, so players join and consent again. An ended session is moved aside as usual.
   **Clearing a session that is stopped or no longer wanted** (while the control service stays in use): stop the control service; in `<CONTROL_DATA_DIR>/sessions.json` set the entry's `status` to `"ended"` or remove the entry; delete the session's `<id>.*` files in `<CONTROL_DATA_DIR>/sessions/`; start the control service again. Until slice 2b-2 adds end/remove, `MAX_SESSIONS` counts every non-ended session, stopped ones included.
4. **Redeploy the previous web app and runtime** if needed. No database and no log migration exists; nothing else to reverse. Delete `<CONTROL_DATA_DIR>` only when no session in it is still wanted: it holds the sessions' display names and consents.
5. **Smoke test:** `pnpm demo --fast` passes its 29 checks and a terminal-started runtime with `pnpm play` still works; `pnpm demo --web` covers single-runtime mode.
6. **Notify** the facilitators: sessions are started from the terminal again until the console is restored. Players who joined through the launcher keep their cookies (`__Host-scenecoach`); they need new codes if a session is started afresh.

### Rolling forward again

Set the console variables again and start `pnpm control` on the same `CONTROL_DATA_DIR`: it resumes every non-ended session paused from its log and keeps a lobby's codes, seats and consent. Run one control service per data directory.

### Post-rollback

- Log the incident in `progress.md` with the timeline, root cause and resolution.
- Open a `bugfix/*` branch for the root cause before deploying again, and add a post-mortem entry to `docs/LESSONS.md`.

## EPIC-0002 slice 2b-2a: runtime protocol for the live console (US-0059)

```
Release: unreleased (feature/EPIC-0002-US-0059-player-copies, then feature/EPIC-0002-US-0059-runtime-protocol and ...-remove-participant, each merged by its pull request)
Date: not deployed
Rollback trigger: players see something they should not, `end_now` misbehaves, or the control service mishandles an `ended` that follows `ready`.
```

### What changes on disk and in the log

- **No log-format change, on purpose.** Slice 2b-2a still writes `LOG_FORMAT` 2. Raising it would make every older build refuse every new log, so a rollback could not even resume a session. New facts are ordinary events or fields that an older build ignores: `by` on `facilitator.command`, `message` on `session.ended`, the reason `facilitator_end` on `scene.exited` and `session.ended`.
- **One real hazard: a log cut between the `end_now` appends.** `end_now` appends `scene.exited` (`facilitator_end`), then a facilitator-only alert, then `session.ended`. A build from slice 2b-2a repairs a log cut after the first two (the restore appends `session.ended`). A build from before this slice does not know `facilitator_end`: resumed on such a log it treats the exited scene as an ordinary exit, **enters the next scene (or ends with `script_complete` after the last) and so revives a session the facilitator had ended**. This needs a crash or kill in the few milliseconds between the appends AND a rollback before the next start; if a session was being ended when the runtime died, do not resume it with an older build: read the log's last events first (the raw `<id>.jsonl` in the session's data directory) and, if they end with `scene.exited` reason `facilitator_end`, treat the session as ended (set its status to `ended` in `sessions.json`, or move the log aside).
- **Talk time and the allowlisted copies are projections**, rebuilt from the log; there is nothing to migrate.

### Steps

1. Redeploy the previous runtime, control service and web app (no data migration).
2. Check any session that was being ended around the time of the rollback (hazard above).
3. **Smoke test:** `pnpm demo --fast` passes its 29 checks; `pnpm demo --web` passes W-01 to W-08.
4. **Notify** facilitators that "end now" and the words-spoken table are not available on the older build, and that closing messages are not shown.

### Rolling forward again

Nothing to repair: the newer build reads logs written by the older one, and a `facilitator_end` cut left by the hazard above is repaired on restore.
