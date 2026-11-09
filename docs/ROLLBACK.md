# Rollback plan

AGENTS.md section 20: every deployment has a rollback plan written before it starts. Nothing in this repository is deployed to a shared environment yet (the runtime runs on the operator's machine, from `./run.sh` or Docker Compose); this file records what a rollback has to handle, release by release, so the plan exists before the first deployment.

The sections from slice 2a to BUG-0023 ship in release 0.1.0 (tag `v0.1.0`, 2026-11-05), the first tagged release; the sections from slice 2c-1 on ship in release 0.2.0 (tag `v0.2.0`, 2026-11-06), whose deploy order and rollback are summarised in [Release 0.2.0](#release-020-deploy-order-and-rollback) at the end. To go back to 0.1.0, redeploy tag `v0.1.0`; to go back to an earlier state, check out the commit a section names. The sections after the Release 0.2.0 summary ship in release 0.2.1 (tag `v0.2.1`, 2026-11-08), summarised in [Release 0.2.1](#release-021-deploy-order-and-rollback) at the end. Anything added after that summary is unreleased and says so in its header.

## EPIC-0002 slice 2a: participant web client (US-0052 to US-0056, US-0065)

```
Release: 0.1.0 (develop, after the slice 2a pull requests #53 to #57 and the US-0065 pull request are merged)
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
- **New runtime setting:** `CONSENT_NOTICE_VERSION` (default `v1` in slice 2a; the default is `v2` since slice 2b-3a, see that section) and the `consent/` directory, which the new runtime needs at start. An older runtime ignores both.
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
Release: 0.1.0 (the stacked branches feature/EPIC-0002-US-0057-facilitator-login, ...-US-0058-launcher-control-service and ...-US-0059-readiness, after their pull requests are merged)
Date: not deployed
Rollback trigger: the control service or the console misbehaves (sessions cannot be created or resumed, a runtime is orphaned, players cannot join through the launcher lookup, a code reissue locks a player out), or the web app must go back to single-runtime mode for any other reason.
```

### What changes on disk and in the log

- **No log-format change.** Slice 2b-1 writes `LOG_FORMAT` 2, exactly as slice 2a, and reads formats 0 to 2. Nothing in 2b-1 makes an older runtime that reads format 2 refuse a log. (Log format 3 arrived with slice 2b-3a, which records AI roles; its rollback note is the section "EPIC-0002 slice 2b-3a" below.)
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
Release: 0.1.0 (feature/EPIC-0002-US-0059-player-copies, then feature/EPIC-0002-US-0059-runtime-protocol and ...-remove-participant, each merged by its pull request)
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

## EPIC-0002 slice 2b-3a: AI roles in the log and the lobby (US-0060)

```
Release: 0.1.0 (feature/EPIC-0002-US-0060-ai-role-record, then ...-ai-role-gate and ...-ai-role-labels, each merged by its pull request)
Date: not deployed
Rollback trigger: a session with AI roles cannot resume, the AI-role file blocks a lobby from opening, or the runtime must go back to a build from before this slice.
```

### What changes on disk and in the log

- **Log format 3, only for a session with AI roles.** The runtime now reads formats 0 to 3. It writes format 3 only when `session.started` records `aiRoles` (in scenario role order); every other session still gets format 2, so a rollback is unaffected for them. A newer format (4 and above) is refused with `log_format`.
- **A build from before this slice refuses a format-3 log** with `log_format` (it reads up to format 2). No build of slice 2b-3a can produce a format-3 log: nothing over HTTP sets AI roles until slice 2b-3b (ruling A1), so rolling back from 3a to an older build leaves nothing it cannot read. Rolling back from 2b-3b to 3a resumes format-3 logs (3a reads them); rolling back from 2b-3b to a build before 3a leaves any session started with AI roles unresumable (finish or abandon it first).
- **New file `<id>.ai-roles.json`** beside the seat files (mode `0600`, same writer and reader checks as the codes, credentials and consent files). It holds the lobby's AI roles across a managed restart and is removed with the other lobby files when they are discarded. After the start the log is the record and the file is only rewritten from it. An older build ignores the file.
- **Consent notice default v2 (PR 3).** The runtime now serves `consent/notice-v2.md` unless `CONSENT_NOTICE_VERSION` says otherwise. A build from before this slice, and the builds of PR 1 and PR 2 of this slice, serve notice v1 again: a lobby open across the rollback keeps its seats, but the consents recorded under v2 are dropped when the consent file is read (the store keeps only entries under the current version), so every human agrees again; a started session keeps every consent in its consent file whatever version it was given under (R15, including a participant who took a seat over after a reissue) and seeds a role with no file entry from its log (R14), so its players rejoin without agreeing again. Setting `CONSENT_NOTICE_VERSION=v1` on this build is the same switch without redeploying. Nothing else in PR 3 touches disk or the log: the player page labels and the `ai_filled` event are rebuilt from the log's `aiRoles` and need no migration, and an older web app treats close code 4004 as a dropped connection.
- **Projections.** `aiRoles` in the state, in the console state and in the player copies are rebuilt from the log; there is nothing to migrate.

### Steps

1. Redeploy the previous runtime, control service and web app (no data migration).
2. Before rolling back past this slice, list the sessions under the control service's `sessions/` directory whose first log line says `"logFormat":3`. None can exist from a 3a build; from a 2b-3b build, end them or keep the 3b/3a build until they are done.
3. **Smoke test:** `pnpm demo --fast` passes its 29 checks; `pnpm demo --web` passes W-01 to W-08.

### Rolling forward again
Redeploy slice 2b-3a. If a build from before 3a has run a lobby meanwhile, move that lobby's `<id>.ai-roles.json` aside first: the older build does not maintain it, so it could name a role whose seat now holds a human credential. Lobby files without an AI-role file read as "no AI roles" and the file is written when the runtime next opens the session; logs of format 0 to 2 resume as before.

## EPIC-0002 slice 2b-3b: reachable AI seats (US-0060)

```
Release: 0.1.0 (feature/EPIC-0002-US-0060-bot-engine, then ...-ai-seats-reachable and ...-ai-toggle-prompt, each merged by its pull request; no release is tagged before slice 2b-3c). PR 3 adds the toggle, Prompt AI player and the AI players panel
Date: not deployed
Rollback trigger: AI players misbehave or exhaust the model budget, a session with AI roles cannot start or resume, or the control service must go back to a build without a bot host.
```

### What changes on disk and in the log

- **New directory `<CONTROL_DATA_DIR>/intents/`** (mode `0700`, files `0600`): the facilitator-only intent log, one `<sessionId>.<roleId>.jsonl` per AI role (at most 256 KiB each; a role's file is deleted when it goes back to human, a session's files on a whole-session reissue or a failed create; an ended session keeps them). An older control service ignores the directory. Delete it by hand when the sessions are gone.
- **Join codes of AI roles are not on disk.** They live only in the control service's memory, so a restart of the control service reissues each AI role once (a post-start reissue skips the consent rebind). Nothing to migrate.
- **No log-format change.** The log stays format 3 for a session with AI roles (3a); the runtime reads formats 0 to 3.
- **New event content (PR 3): `facilitator.command` with `command: "prompt_ai"`** in the session log of a session where the facilitator used Prompt AI player (no hint, no free text). A 3a runtime that resumes such a log keeps the event type (`facilitator.command` is a known type, the log reader checks the type only) and its reducers fall through unknown commands without a change of state, so the event is folded as a no-op; the AI player's own lines are ordinary utterances. That is from reading the 3a reducers (`packages/events` `state.ts`, `player-view.ts`), not from running a 3a binary. A 3a runtime does not count the command in `ready.aiCalls`, so its rebuilt budget counts the utterances only. A build from before 3a never sees it: it refuses a format-3 log with `log_format` before reading an event.
- **Reservations are not on disk.** A prompt reservation (a 32-hex token, valid `RESERVATION_TTL_MS` = 15 s, ruling: the hub waits 10 s for a command ack) lives in the control service's memory; a restart or a rollback of the control service drops it and nothing needs cleaning. The `RESERVATION_TTL` is a constant in `bots/bot-host.ts`, not a setting, so a rollback needs no environment change.
### Rolling back to 3a

- **Format-3 logs stay readable.** A 3a runtime reads and resumes them.
- **A 3a control service has no bot host.** The AI seats of a running session stay empty (no bot joins), so a lobby with AI roles cannot start (the start gate waits for the bots) until the roles are switched back to human; a started session with AI roles resumes but its AI players say nothing. Switch the roles back to human (or end the sessions) before the rollback if you can. A 3a web app has no AI routes, labels or readiness split; a 3a runtime's `ready` has no `aiCalls`, so the budget starts again.
- **A web app rolled back to PR 2 or 3a** facing a log that contains `prompt_ai`: its console copy `switch` returns undefined for the unknown command, so the console stream drops that event (harmless; from reading the code, not from running it). Roll the web app back with the control service.
- **A 3b PR 2 web app** has no toggle, panel or prompt route: AI roles set through the API stay set and keep their bots; a control service of PR 2 has no reserve, run or release routes, so the prompt of a PR 3 web app could not work against it (roll the web app back with the control service).
- **3b and 3c roll back together** (they are released together; before 3c the evaluator could score an AI seat individually).
- Rolling back past 3a is as described for slice 2b-3a.

### Steps

1. Redeploy the previous control service, runtime and web app (no data migration).
2. Before the rollback, list the sessions with AI roles (the first log line says `"logFormat":3`) and switch their roles back to human before the start, or end them.
3. **Smoke test:** `pnpm demo --fast` passes its 29 checks; `pnpm demo --web` passes W-01 to W-08.

### Rolling forward again
Redeploy slice 2b-3b. The `intents/` directory, if it was kept, is read again; stale files of sessions that no longer exist are harmless.

## EPIC-0002 slice 2b-3c PR 1: the group-score option (US-0061)

```
Release: 0.1.0 (feature/EPIC-0002-US-0061-group-score-option; PR 2, feature/EPIC-0002-US-0061-ai-evaluator, follows; no release is tagged before PR 2)
Date: not deployed
Rollback trigger: the option misbehaves in the console, a lobby with AI roles cannot open or resume, or the runtime must go back to a 3b build.
```

### What changes on disk and in the log

- **New field `includeInGroup` in `session.started`**, written (true or false) only when the session has AI roles. The log stays format 3; a session without AI roles is byte for byte as before (format 2).
- **The AI-role file** `<id>.ai-roles.json` stays version 1 while the option is on, which is the 3b shape. It becomes version 2 (`includeInGroup: false`) only while the option is off.
- **IPC and control API.** `set_ai_roles` and `ready` gain optional option fields; `PUT /sessions/:id/ai-roles` takes an optional `includeInGroup` and answers it. Nothing to migrate.

### Rolling back to 3b

- **A log with `includeInGroup` is read by a 3b runtime.** Verified by reading restore (`session-engine.ts` `doRestore` on `develop` before this slice), not by running a 3b binary: it reads `session.started` by its known fields, validates `aiRoles` and ignores the extra key, so a started session resumes. The option is then lost to that build, which is harmless because no 3b code reads it.
- **Risk R3 (accepted by the owner, 2026-11-04): with the option OFF, a rolled-back 3b build refuses that lobby.** Its AI-role file is version 2, which the 3b reader does not know, so the lobby fails to open with "cannot use the AI-role file" until you move `<id>.ai-roles.json` aside. Moving it aside makes that lobby's AI roles human again (the build then has no AI-role record for it). The same refusal hits a lobby whose AI roles were all switched back to human after the option was unticked: its file is also version 2 (empty `roles`, `includeInGroup: false`), although the lobby then has no AI player and the checkbox is hidden. A lobby with the option on has a version 1 file and is read normally. A started session is not affected, because after the start its record is the log.
- **After the start the read-only line is not the log.** "AI players in group scores: on/off" comes from the control service's memory. After a timed-out option set that the runtime did apply, that memory can stay stale until a runtime restart sends `ready` from the log. The console now keeps the value its own last change posted, so only a change made elsewhere can leave the line stale.
- **Before the rollback,** list the lobbies whose option is off (the file says `"v":2`, including a lobby with no AI roles left) and either switch their AI roles back to human, tick the option on, or plan to move the file aside.
- **3b and 3c roll back together.** They are released together (before 3c the evaluator could score an AI seat individually), so if the AI seats are the reason for the rollback, roll back 3b as described in the 3b section above as well; 3b alone is a safe target only for the AI-role file reading above.

### Steps

1. Redeploy the previous control service, runtime and web app (no data migration).
2. Handle the lobbies with the option off as above.
3. **Smoke test:** `pnpm demo --fast` passes its 29 checks; `pnpm demo --web` passes W-01 to W-08.

### Rolling forward again
Redeploy this slice. A version 1 file reads as option on; a version 2 file that survived reads as off; logs without the field mean on.

## EPIC-0002 slice 2b-3c PR 2: the AI-aware evaluator (US-0061)

```
Release: 0.1.0 (feature/EPIC-0002-US-0061-ai-evaluator, merged by its pull request; 3b and 3c can now be released together, the owner decides when)
Date: not deployed
Rollback trigger: the evaluator refuses a log it should read, a report is wrongly labelled, or a session with AI players is scored as if they were human.
```

### What changes on disk and in the log

- **Nothing in the log and nothing in the seat files.** PR 2 only reads `session.started` (`aiRoles`, `includeInGroup`) and changes what `pnpm evaluate`, the review tool and `pnpm calibration draft --excerpt` do with it. No format bump, no migration.
- **Reports written by PR 2 for a session with AI players** have an `ai_players` block in `group.json`, `ai: true` on AI quotes, an extra note, an AI row in `index.md` and the stamp note. Reports for a session without AI roles are byte-identical to the build before 3c, so rolling back changes nothing for them. Reports already written stay as written; re-run `pnpm evaluate` to produce new ones.

### Rolling back to 3b

- **A 3c rollback rolls back 3b: the AI seats.** An evaluator from before 3c does not know AI players: it would score an AI role like a human (a model call, a personal report, the AI line quoted as the player's own). So if 3c is rolled back, do not leave 3b's AI seats reachable. Roll back 3b as described in its section above as well (release 3b and 3c together, roll them back together), or at least do not run `pnpm evaluate` on a session with AI roles until the evaluator is back.
- **Risk R3 restated (accepted by the owner, 2026-11-04):** with the option OFF, a rolled-back 3b build refuses that lobby ("cannot use the AI-role file") until you move `<id>.ai-roles.json` aside, which makes its AI roles human again. A lobby with the option on has a version 1 file and is read normally; a started session is not affected. See the PR 1 section above.
- **Not checked by running an older build.** That an older review tool loads a PR 2 draft with `ai_players` was not tested; regenerate the drafts with the older evaluator instead of moderating the PR 2 ones.

### Steps

1. Redeploy the previous runtime (the evaluator ships with it); no data migration.
2. If AI seats were the reason, roll back 3b too (above) and handle the lobbies with the option off.
3. **Smoke test:** `pnpm demo --fast` passes its 29 checks; `pnpm demo --showcase --fast --evaluate` passes all its checks (S-16 reads the reports back).

### Rolling forward again
Redeploy this slice. Re-run `pnpm evaluate` for the sessions with AI players whose reports were written by the older evaluator.

## EPIC-0002 slice 2c-1: participant report access (US-0062)

```
Release: 0.2.0 (feature/EPIC-0002-US-0062-report-access, PR 1; feature/EPIC-0002-US-0062-report-pages, PR 2; merged by their pull requests)
Date: not deployed
Rollback trigger: a participant link opens someone else's report or a revoked link still opens, the control service refuses to start on the new setting, the console panel breaks an ended session's page, or the report routes must go for any other reason.
```

### What changes on disk and in settings

- **One new file:** `<CONTROL_DATA_DIR>/report-access.json` (mode 0600; salted hashes of the links, no token), created on the first issue. **Older builds ignore it:** nothing before this slice reads or lists the control data directory for it, and it sits outside every review folder, so the review tool and `pnpm moderate` are not affected. Leaving it in place is safe; deleting it makes every issued link stop working (the holders see "This link no longer works").
- **One new setting:** `REPORT_ACCESS_DAYS` (a whole number 1 to 365, default 90; an invalid value stops the control service at start naming the variable). An older control service does not read it and does not complain about it being set.
- **New routes:** the control service gains `/sessions/:id/report-links...`, `/report-access/exchange` and `/sessions/:id/reports/:credentialId`; the web app gains `/report`, `/report/enter`, `/api/v1/report` and `/api/v1/report/enter` and the console `report-links` routes. **Older builds have no `/report` routes:** a link already given to a participant opens a "not found" page, and the console shows no Participant reports panel. Nothing else in a session depends on them.
- **No change to the log, the review folders or any report.** The reader is read-only (`@acr/runtime/reports`); the new runtime export is an addition. The cookie `__Host-scenecoach-report` is new; a rolled-back web app ignores it and it expires by itself (or clear it by hand).

### Rolling back

1. Redeploy the previous web app and control service together (the control service's routes and the web app's go as a pair); no data migration.
2. **Links already issued:** they stop working with the rollback (no `/report` page). Tell participants who were sent a link. If the rollback is because a link may have leaked, do not wait for the rollback: revoke it in the console (it takes effect at once), or move `report-access.json` aside to end every link.
3. **Smoke test:** the console opens an ended session without the panel; `pnpm demo --web` passes W-01 to W-08.

### Rolling forward again
Redeploy this slice. Put `report-access.json` back if it was moved aside (links not yet expired work again); otherwise reissue the links in the console.

## BUG-0023: whispers kept in the player snapshot and labelled Private

```
Release: 0.1.0 (fix/bug-0023-whisper-private-label-and-reload, merged by its pull request).
Date: not deployed
Rollback trigger: a player or the console shows a whisper that is not theirs, or a join snapshot is rejected or breaks a client.
```

### What changes on disk and in the log

- **Nothing.** The log format and every event are unchanged: the per-role whisper lists are folded from the `facilitator.command` events already in the log, so a restore rebuilds the same lists (tested). No file, setting or environment variable is added.
- **New additive wire content.** A player's `joined.state` carries `whispers` (a list of `{ seq, sceneId, text }`, the player's own, at most 50), the facilitator's `joined.state` carries `whispers` as a record keyed by role (the BFF replaces it with `{}` before the console page), and a `reset` frame's injects entries may carry `private: true`.

### Rolling back

- **An older web app against a newer runtime** ignores the extra snapshot key (`initPlayerView` reads named keys; the console state is copied key by key from its own list), so it behaves as before the fix: a whisper is an unlabelled update and a reload loses it. That is from reading the older code, not from running an older build.
- **A newer web app against an older runtime** gets no `whispers` in the snapshot (the seed treats a missing or malformed list as none): a live whisper is still labelled Private, a reload loses it again.
- **Nothing is lost on disk either way,** and there is no migration to reverse.

### Steps

1. Redeploy the previous runtime and web app (no data migration).
2. **Smoke test:** `pnpm demo --fast` passes its checks; `pnpm demo --web` passes W-01 to W-08; send a whisper from the console and confirm only the addressed player's page shows it.

### Rolling forward again
Redeploy this fix. Nothing to restore.

## US-0063: review schema `acr.review/2` and participant ratings (slice 2c-2)

```
Release: 0.2.0 (feature/EPIC-0002-US-0063-participant-report, PR 1 and PR 2)
Date: not deployed
Rollback trigger: a participant write lands under the wrong role, the control service refuses to start, `moderate` cannot read a review it opened, or the write routes must go for any other reason.
```

### What changes on disk and in the log

- **A new review schema.** `moderate open` now writes `acr.review/2`, and a participant's rating or response is an event with the actor kind `participant_session`. **A build that does not know `acr.review/2` cannot read any `/2` review:** `moderate`, `export` and the report reader all refuse it, so every `/2` review becomes unreadable (the folder is not damaged). `/1` reviews are unchanged and a new build still reads them.
- **New routes.** The control service gains `PUT /sessions/:id/reports/:credentialId/self-ratings` and `POST .../responses`. An older control service answers 404 to both. Nothing else depends on them in PR 1 (the browser is PR 2).

### Rolling back

1. **Roll back only before any `/2` review is opened.** Check first: `grep -l '"acr.review/2"' <reports dir>/*/review.jsonl` finds none.
2. **If a `/2` review is already open,** restore the reviews from a backup taken before the first `moderate open` of this build, or keep the new build and take the write routes off with a code change (revert the `participantWrites` wiring in the control service's `main.ts` and redeploy; there is no switch or flag for it). Do not edit `review.jsonl` by hand: it is hash-chained.
3. Redeploy the previous control service and runtime together; no data migration. **Smoke test:** `pnpm moderate status` reads every review folder.

### Rolling forward again
Redeploy this slice. A review opened by the older build is `/1` and answers old-schema to web writes; the facilitator takes the rating in the terminal, or re-runs `moderate open` for a new review.

## US-0064: evaluate and review from the console (slice 2c-3 part A)

```
Release: 0.2.0 (feature/EPIC-0002-US-0064-report-moderation-web, PR A)
Date: not deployed
Rollback trigger: an evaluate started from the console spends when it should not (a second run, a run nobody confirmed), a console edit lands in the wrong review or under the wrong name, the Report panel breaks an ended session's page, or the report routes must go for any other reason.
```

### What changes on disk and in settings

- **No schema change.** Reviews are still `acr.review/2`; a console write is an ordinary facilitator event whose `by` is `<name>-console`. `pnpm moderate` reads and continues a review opened or edited from the console, and a build without the console routes reads it too.
- **Evaluate writes what `pnpm evaluate --out "$CONTROL_DATA_DIR/reports"` writes:** a `<session id>` folder (or `<id>-N`) under `<CONTROL_DATA_DIR>/reports`, which control then opens with the typed name. Nothing else is written there.
- **One new file:** `<CONTROL_DATA_DIR>/report-jobs.json` (mode 0600, written atomically): per session the job state, start time, folder name and model-call count, never a key. Older builds ignore it. Deleting it while no evaluate runs loses only the panel's "failed" and "model calls" lines; the drafts and reviews are untouched.
- **One new setting:** `REPORT_EVALUATE_MARGIN_MS` (0 to 3600000, default 120000; `.env.example`). An older control service does not read it.
- **New routes:** control `/sessions/:id/report...` (overview, evaluate, cancel, open, subject view, edit, accept, comment, edit-summary) and the web app's `/api/v1/console/sessions/:id/report...`. The console's "No reports are ready" sentence now points to the Report panel.

### Removing an orphan report folder by hand

The Report panel says "A report folder for this session is damaged" when a folder for the session has an incomplete draft set (or drafts that do not load) and no review: what a hard kill during the evaluator's brief write can leave. Control never reuses, deletes or evaluates beside it: Evaluate is not offered until it is gone, and a start sent anyway is refused (`orphan`, the same sentence) before anything runs.

1. Make sure no evaluate is running for that session (the panel does not say "Evaluating…"); if one is, Cancel it or wait.
2. Find the folder: `ls "$CONTROL_DATA_DIR/reports" | grep '^<session id>'` lists `<session id>` and any `<session id>-N`. The orphan is the one **without** a `review.jsonl`. **Never remove a folder that has a `review.jsonl`**: that is a review (it is hash-chained and may hold released reports and participants' ratings).
3. Move it out of the reports directory rather than deleting it, for example `mkdir -p "$CONTROL_DATA_DIR/orphans" && mv "$CONTROL_DATA_DIR/reports/<folder>" "$CONTROL_DATA_DIR/orphans/"`. Delete the moved copy later, once nobody needs it.
4. Reload the console page: the panel offers Evaluate again (no restart is needed; the overview is read per request).

### Rolling back

1. **Wait for, or cancel, any evaluate that is running** (stopping the control service kills the child: the run is lost, already-spent model calls are not refunded, and a kill during the write can leave an orphan folder; see above).
2. Redeploy the previous web app and control service together; no data migration. **A build without these routes** has no Report panel (the console shows the participant links panel only, and the old "evaluate and moderate in the terminal" sentence again); the BFF and control answer 404 to the report routes. Reviews opened or edited from the console stay valid and are continued with `pnpm moderate` in `$CONTROL_DATA_DIR/reports/<session id>` (the `-console` names stay in their history). A draft that evaluate wrote but did not open is opened with `pnpm moderate open`. `report-jobs.json` and `REPORT_EVALUATE_MARGIN_MS` are ignored.
3. **Smoke test:** the console opens an ended session without the Report panel; `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads a review opened from the console.

### Rolling forward again
Redeploy this slice. The panel reads the reviews and drafts on disk as they are (one opened in the terminal shows as in review); `report-jobs.json` is picked up again, a job it records as running reads as interrupted.

## US-0064: release, amend, withdraw, resolve and export from the console (slice 2c-3 part B)

```
Release: 0.2.0 (feature/EPIC-0002-US-0064-report-release-web, PR B, stacked on PR A)
Date: not deployed
Rollback trigger: a console release, amend or withdraw changes a subject nobody named, a release ignores the gate, a resolve shows the wrong reason to a participant, an export is served without its event or writes to the server's disk, or the part B routes must go for any other reason.
```

### What changes on disk and in settings

- **No schema change and no new file or setting.** Release, amend, withdraw and resolve are the same `acr.review/2` events `pnpm moderate` writes, with `by` `<name>-console`. An export appends one `report.exported` event (destination `console-download`) to `review.jsonl` and writes no file anywhere on the server.
- **New routes:** control `POST /sessions/:id/report/release`, `.../resolve`, `.../export`, `.../subjects/:subject/amend` and `.../withdraw`, and the same five under the web app's `/api/v1/console/sessions/:id/report`.
- **Deploy order: control before web.** Part A's last fix made `scoreByHand` a required field of control's overview and subject answers, and the web app fails closed (the panel says the report could not be read) when it is missing. Deploy or restart the control service first, then the web app; roll back in the opposite order (web first).

### Rolling back part B

1. Redeploy the web app and control service of PR A (web first, then control); no data migration. The Report panel stays (evaluate, open, edit, accept, comment), without the release bar, the row actions, the dialogs, the dispute panel or the export menu; the part B routes answer 404.
2. **Everything part B did in the browser is still possible in the terminal:** `pnpm moderate release|amend|withdraw|resolve|export <dir> ...` in `$CONTROL_DATA_DIR/reports/<session id>` (see README). Events written from the console, `report.exported` with `console-download` included, stay valid: the `-console` actors remain ordinary facilitator actors, and the terminal reads and continues the review.
3. **Smoke test:** `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads a review released from the console; a participant's link still opens the released report (the participant pages are slice 2c-1 and 2c-2, not part B).

### Rolling forward again
Redeploy this slice (control first). The panel reads the review on disk as it is, including releases, amendments and withdrawals made in the terminal meanwhile.

## US-0060: AI-role report-link guarantees (slice 2c-4 PR 1)

```
Release: 0.2.0 (feature/EPIC-0002-US-0060-ai-role-guarantees, PR #113)
Date: not deployed
Rollback trigger: the guard refuses a human role's link, issue or reissue answers 503 for a session whose log and scenario are intact, the link list marks the wrong role "AI player", or the change must go for any other reason.
```

### What changes on disk and in settings

- **No schema change, no new file and no new setting.** The guard reads the session log and the scenario that already exist. Nothing is written.
- **One optional field on the wire:** control's `GET /sessions/:id/report-links` rows may carry `ai: true`; the web server's launcher client, the console BFF's link handler and `parseReportLinks` pass it on only when exactly `true`. A missing flag means "not AI".
- **New refusal:** issue and reissue answer 409 "AI players do not get report links." for an AI role, and 503 "reports cannot be read" when the session log or its scenario cannot be read or is inconsistent.
- **Deploy order: control before web, as for slice 2c-3.** The new `aiRoles` dependency of the control service is required in code, but it is wired in `main.ts`, so a deployed control service always has it.

### Rolling back

1. **Control alone is safe to roll back.** Because `ai` is optional, the new web app keeps working against the older control service: the link list shows Issue or Reissue for every role (no "AI player" label) and the guard is gone, so an AI role listed in a hand-edited review could be issued a link again. Evaluate and release do not list AI roles as subjects, so this only matters for a hand-edited review.
2. **Web alone is safe to roll back too:** the older web app ignores the `ai` flag it does not know, and the control guard still refuses. The older web app's `KNOWN_CONFLICTS` lacks the new sentence and its panel still shows Issue and Reissue for an AI role, so a refusal reads "That action is not possible right now."; the rollback is still safe.
3. To roll back both, redeploy web first, then control (the opposite of the deploy order). No data migration.
4. **Smoke test:** open the console of an ended session with an AI player and a released report: the AI role gets no link (the guard's sentence on a direct issue), a human role is issued one and its link opens the report.

### Rolling forward again

Redeploy control first, then web. A scenario folder that was edited or removed while this slice was out of service makes issue answer 503 for the sessions it belongs to (see THREAT_MODEL "AI roles in the credential path"); restore the folder.

## US-0066: Summary editor, web link id and console fixes (slice 2c-4 PR 2)

```
Release: 0.2.0 (feature/EPIC-0002-US-0066-close-out-polish, PR #115)
Date: not deployed
Rollback trigger: a summary saved from the console lands on the wrong subject or drops entries, `pnpm moderate status` shows more than the 8-character link id, the release dialog offers a subject it should block, or the change must go for any other reason.
```

### What changes on disk and in settings

- **No schema change, no new file, no new setting and no new route.** The Summary editor uses the existing edit-summary route of slice 2c-3 part A; what it writes is the same `acr.review/2` event `pnpm moderate edit-summary` writes, with `by` `<name>-console`. The `via` link id is computed when the review is read and printed by `pnpm moderate status`; it is not written to disk and not sent over the moderation read wire.
- **The rest is console behaviour only:** Withdraw on an amending row, a subject with no status row treated as blocked in the release dialog, and a whitespace-only note no longer blocking the self-rating form.

### Rolling back

1. Redeploy the web app of slice 2c-4 PR 1 (and, for `moderate status`, the runtime package of PR 1); no data migration. The Report panel loses **Edit the summary** (a summary is still edited with `pnpm moderate edit-summary` in the terminal) and the console fixes. Summaries saved from the console stay valid and are read by every `acr.review/2` build.
2. The control service is not changed by this PR, so it does not need to move.
3. **Smoke test:** open an ended session's Report panel and a draft subject (no Edit the summary button); `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads the review.

### Rolling forward again
Redeploy this slice. Summaries edited in the terminal meanwhile are shown pre-filled in the editor as they are.

## Release 0.2.0: deploy order and rollback

```
Release: 0.2.0 (tag `v0.2.0`, from release/0.2.0; slices 2c-1 to 2c-4, PRs #102 to #115 into develop)
Date: not deployed
Rollback trigger: any trigger of the sections from slice 2c-1 on, or the release must go back to 0.1.0 for any other reason.
```

- **Deploy order: the control service before the web app.** Since slice 2c-3 part A the web app fails closed when control's overview or subject answer lacks `scoreByHand`, so a 0.2.0 web app needs a 0.2.0 control service. Deploy or restart control first, check it answers, then deploy the web app. **Roll back in the reverse order: the web app first, then the control service.**
- **Control alone back to slice 2c-3 is safe:** the `ai` flag on control's report-link list is optional, and a 0.2.0 web app treats a missing flag as "not AI" (see [slice 2c-4 PR 1](#us-0060-ai-role-report-link-guarantees-slice-2c-4-pr-1)); only the AI-role link guard is lost.
- **Going back to 0.1.0 makes every `acr.review/2` review unreadable.** 0.2.0's `moderate open` writes `acr.review/2` (see [US-0063](#us-0063-review-schema-acrreview2-and-participant-ratings-slice-2c-2)); a 0.1.0 build refuses any `/2` review in `moderate`, `export` and the report reader (the folders are not damaged). Before rolling back to 0.1.0, check `grep -l '"acr.review/2"' "$CONTROL_DATA_DIR"/reports/*/review.jsonl`; if it finds any, restore the reviews from a backup taken before the first `moderate open` of 0.2.0, or stay on 0.2.0 and roll back only the part that misbehaves. Do not edit `review.jsonl` by hand: it is hash-chained.
- **Report links issued under 0.2.0 stop working on 0.1.0** (it has no `/report` routes); tell the participants who were sent one. `report-access.json`, `report-jobs.json`, `REPORT_ACCESS_DAYS` and `REPORT_EVALUATE_MARGIN_MS` are ignored by 0.1.0 and can be left in place.
- **Smoke test after a deploy:** the console opens an ended session with its Report panel and Participant reports panel; `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads a review; a released report opens through its link. **After a rollback to 0.1.0:** the console opens an ended session without either panel, and `pnpm demo --web` passes W-01 to W-08.

## BUG-0025, BUG-0029, BUG-0030: report cookie unsealed first, resend dedupe, per-link response cap

```
Release: 0.2.1 (bugfix/BUG-0025-throttle-resend-link-cap, PR #122)
Date: not deployed
Rollback trigger: a valid participant is refused or throttled on `/report`, a participant who has sent fewer than 25 responses through a link is told the link is at its limit, a new response is silently not stored, or the change must go for any other reason.
```

### What changes on disk and in settings

- **No schema change, no new file, no new setting and no data migration.** The review log keeps the same events; the per-link cap of 25 responses and the resend dedupe are checked when a response is written, never by the fold, so every log stays readable by every `acr.review/2` build, before and after this change.
- **One new closed wire code: `link_full`** (409, control to the web app, and the web app to the page), with one fixed sentence (`REPORT_SENTENCES.linkFull`). The BFF's cookie order (unseal first) and its separate failure table are in-memory behaviour of the web app only.

### Rolling back

- **Deploy order: the control service before the web app; roll back the web app first, then the control service.** An older web app against this control service does not know `link_full`: for a link at its cap it answers "unavailable, try again" instead of the notice. Nothing is written in that case; only the message is wrong.
- **Rolling the control service back removes the cap and the wider dedupe** (back to 50 responses per role, dedupe against the last response only). Responses written meanwhile stay valid and readable; nothing on disk needs undoing.
- **Rolling the web app back** restores the old throttle order: a valid cookie from an address blocked by forged cookies waits again, and failed cookies share the enter table again.
- **Smoke test:** a released report opens through its link; a response is sent and shows; `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads the review.

### Rolling forward again
Redeploy this change, control first. A link that already holds 25 or more responses is at its cap at once; the facilitator's reissue gives a fresh link.

## US-0068: "AI player, not scored" rows in the console report list

```
Release: unreleased (feature/EPIC-0002-US-0068-ai-player-row)
Date: not deployed
Rollback trigger: the Report panel fails to show or shows wrong rows for a session with AI players, or the change must go for any other reason.
```

### What changes on disk and in settings

- **Nothing on disk, no new setting, no migration.** The control service adds an OPTIONAL field `aiRoles` to the `in_review` moderation overview, read from the session log on each overview read; nothing is written. No wire version, review schema or existing field changes.

### Rolling back

- **Deploy order: the control service before the web app; roll back the web app first, then the control service.** Either order is safe, because the field is optional on both sides.
- **Control alone rolled back:** the overview no longer carries `aiRoles`, so the console shows no AI rows; everything else is unchanged.
- **Web app alone rolled back:** its strict overview parser ignores the unknown field; the list is as before (no AI rows).
- **Smoke test:** the console opens an ended session's Report panel in review; for a session with an AI player, a row for that role reads "AI player" and "not scored (no report is written for an AI player)" and has no buttons.

### Rolling forward again
Redeploy, control first. The rows appear on the next overview read; nothing is cached.

## Release 0.2.1: deploy order and rollback

```
Release: 0.2.1 (tag `v0.2.1`, from release/0.2.1; bug-fix PRs #119 to #123 into develop)
Date: not deployed
Rollback trigger: any trigger of the BUG-0025, BUG-0029, BUG-0030 section, or the release must go back to 0.2.0 for any other reason.
```

- **Deploy order: the control service before the web app.** 0.2.1 control answers a new closed code, `link_full` (409), for a link that has sent 25 responses. Roll back in the reverse order: the web app first, then control.
- **Going back to 0.2.0 is safe.** There is no schema change, no new file, no new setting and no data migration; every review log stays readable. An older web app shows "try again" for a link at its cap (nothing is written). Rolling control back restores the per-role cap of 50 and the narrower resend dedupe; responses written meanwhile stay valid.
- **The other fixes are web-app or test only** (Report panel read ordering and retry, the export menu, the self-rating form draft, shared report sentences, test hygiene) and need no data step to roll back.
- **Smoke test after a deploy or a rollback:** a released report opens through its link; a response is sent and shows; the console opens an ended session's Report panel; `pnpm moderate status "$CONTROL_DATA_DIR/reports/<session id>"` reads the review.

## US-0070: voice pipeline on file ingest (EPIC-0003 voice slice A1a)

```
Release: unreleased (feature/EPIC-0003-US-0070-voice-pipeline)
Date: not deployed
Rollback trigger: a text-only session behaves differently from the build before (start, lines, AI characters, Game Master, AI players, restart or end), a voice setting stops a session that should start, or the change must go for any other reason.
```

### What changes on disk and in settings

- **No change to the session log format, `LOG_FORMAT`, any event or the consent file.** A voice line is the existing `utterance` with `channel: "voice"`; demo check V-08 pins that a voice session's `session.started.logFormat` equals a session's without voice. Every log and consent record stays readable by an earlier build.
- **New, ignorable files.** `<SESSION_DATA_DIR>/<sessionId>.voice.json` (the voice record, 0600, only written while `VOICE_ENABLED=1`) and `<CONTROL_LOG_DIR>/<sessionId>.speech.log` (the speech worker's output, fixed lines only). An earlier build ignores both; they can be deleted by hand. `consent/notice-v3.md` is a DRAFT notice that nothing uses unless `CONSENT_NOTICE_VERSION=v3` is set.
- **New settings, all off or inert by default:** `VOICE_ENABLED` (0) and `TURN_END_MS` (800) reach control-managed runtimes; `VOICE_HANGOVER_MS`, `VOICE_MAX_SEGMENT_MS`, `STT_*`, `SPEECH_INGEST`, `SPEECH_INGEST_DIR` reach only the speech worker (`.env.example`, "voice input"). `TURN_END_MS` is read only with `VOICE_ENABLED=1`, so a stray value never stops a text-only session; `VOICE_ENABLED` itself must be exactly 0 or 1 (anything else, `true` included, refuses the start).
- **New package `services/speech`** (the worker, forked by control only when a runtime reports `ready.voice`). No new third-party dependency.

### Rolling back

- **Turn voice off first: `VOICE_ENABLED=0`** (or unset) in the control service's environment, then restart the affected sessions. With voice off the runtime never reads or writes the voice record, sends no voice message, and control forks no worker; the text path is the one of the build before.
- **Deploy order:** the control service and the runtime ship from one checkout, so there is no skew between them. The web app is not touched in A1a, so no web deploy is needed in either direction.
- **Rolling back the code:** stop the control service (its speech workers exit when their IPC channel closes; a worker that hangs is force-killed after `CONTROL_GRACE_MS`), deploy the earlier build, start it. An earlier runtime drops an unknown parent message without answering (pinned by `parent-channel.test.ts`), and an earlier control service never sends one.
- **Keep `CONSENT_NOTICE_VERSION` unset or `v2`** on any build: v3 is a draft, and a rolled-back build with v3 set would show participants the draft text.
- **Smoke test after a rollback:** `pnpm demo --fast` (29 checks) and `pnpm demo --fast --security --resume` (42) pass; a console session starts, takes typed lines and ends.

### Rolling forward again

Redeploy; voice stays off until `VOICE_ENABLED=1` is set, which in A1a only the offline demo does. `pnpm demo --voice` (V-01 to V-08, about 25 s, offline, no secrets) is the check, and it runs in the CI Demo Run job.

## US-0071: LiveKit and the web consent flow (EPIC-0003 voice slice A1b)

```
Release: unreleased (feature/EPIC-0003-US-0071-voice-livekit-consent)
Date: not deployed
Rollback trigger: a text-only session or page behaves differently from the build before (join, consent, lines, the console, headers), a LiveKit setting stops the control service or the web app, a voice page records or keeps a microphone it should not, or the change must go for any other reason.
```

### What changes on disk and in settings

- **No change to the session log format, `LOG_FORMAT`, any event, the consent file or the voice record's format.** `consent/notice-v3.md` is unchanged (its draft marker stays). Mute is in memory only and never written. The voice record (`<sessionId>.voice.json`) is the A1a file, ignorable by an earlier build; it can be deleted by hand.
- **New web routes and settings.** The web app gains `POST /api/v1/voice` and `POST /api/v1/voice/token` and reads `LIVEKIT_URL` (the LiveKit server's public origin: `wss://<host>[:port]`, or `ws://127.0.0.1:<port>` / `ws://[::1]:<port>` for local development). Without it the session page offers no voice and the token route answers 503; **an invalid value stops the web app's API routes** (its config check refuses it), so unset it rather than leaving a bad one. With it, `/session/<id>` (only) sends `microphone=(self)` and allows the LiveKit origin in `connect-src`.
- **New control settings, optional:** `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (both or neither; the secret at least 32 characters) and `LIVEKIT_HOST` (default `http://127.0.0.1:7880`, loopback `http:` only). They are checked whenever they are set, **even with `VOICE_ENABLED=0`**: a bad value stops the control service's start, with the variable names only. `SPEECH_INGEST=livekit` needs the key and the secret (control refuses to start otherwise). Tokens are issued only with the keys AND `SPEECH_INGEST=livekit`. The keys never reach a runtime, a speech worker or the web app.
- **Internal messages only.** `voice_availability`, `voice_seats.voiceChosen`/`open`, the worker's LiveKit, slot and health messages, `livekit_join_refused` and the new alert codes (`worker_restarting`, `voice_off`, `stt_recovered`) are IPC between processes of one checkout (control, runtime, speech worker), so there is no skew between them. The runtime player protocol gains `voice_mute`, `muted` in the `voice` answer and `joined.voice`, and the `voice_available` notice code (docs/MIGRATION_LOG.md is the place a future client looks); the BFF forwards `joined.voice` and a named `voice_notice` SSE event.
- **New dependencies:** `livekit-server-sdk` 2.19.2 (`packages/adapters`, reachable only through `@acr/adapters/livekit`), `@livekit/rtc-node` 1.2.1 (`services/speech`, native), `livekit-client` 2.23.0 (`apps/web`, loaded lazily by the first "Join with voice"); `packages/adapters` also gains a workspace link to `@acr/events` (`findings.md`).
- **The Alpine runtime image is unaffected.** It installs `@acr/runtime` and its workspace packages only, so it gets `livekit-server-sdk` (pure JavaScript, never loaded there: the root `@acr/adapters` index does not import it) and never `@livekit/rtc-node`, whose native binding is glibc only. Only the speech worker loads rtc-node, so a LiveKit worker must run on a glibc host (the pilot laptop); the image was not rebuilt for this slice.

### Rolling back

- **Turn voice off first: `VOICE_ENABLED=0`** (or unset) in the control service's environment, then restart the affected sessions. With voice off no token is issued (the runtime reports no voice seats), no worker is forked and the page shows no voice choice; the text path is the one of the build before. To take LiveKit out completely, also unset `LIVEKIT_URL` in the web app and `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_HOST` in the control service, and set `SPEECH_INGEST=file` (or unset it).
- **What happens to the rooms.** Control deletes every seat room at the session end. Rooms of sessions that were running when control stopped are not deleted (their names were in its memory); a connected browser leaves when its stream drops, and LiveKit removes an empty room after its own timeout. A LiveKit server started only for this slice can simply be stopped.
- **Deploy order: the control service before the web app.** The web app's voice routes call control's new `POST /sessions/:id/voice-token`; an old web app with a new control service is safe because the routes are additive (it never calls them and its static header rule still blocks the microphone). A new web app with an old control service answers the token route 503 `voice_unavailable` (the page says "Voice is not available right now. Use the text box.") and keeps the text path. To roll back, deploy the earlier web app first, then the earlier control service and runtime.
- **Rolling back the code:** stop the control service (its speech workers exit when their IPC channel closes; a hung one is force-killed), deploy the earlier build, start it. An earlier runtime drops an unknown parent message without answering, and an earlier control service never sends one.
- **Keep `CONSENT_NOTICE_VERSION` unset or `v2`** on any build used with outside participants: v3 still carries its draft marker and describes audio retention that A2 builds.
- **Smoke test after a rollback:** `pnpm demo --fast` (29 checks), `pnpm demo --fast --security --resume` (42) and `pnpm demo --web` (8) pass; a console session starts, takes typed lines and ends; `/session/<id>` answers `microphone=()`.

### Rolling forward again

Redeploy control, then the web app; voice stays off until `VOICE_ENABLED=1`, LiveKit keys with `SPEECH_INGEST=livekit` in control and `LIVEKIT_URL` in the web app are all set. Checks: `pnpm demo --voice` (8 of 8, file ingest, offline), `pnpm --filter @acr/web exec playwright test voice-lobby` (no LiveKit server needed), and with a throwaway LiveKit server the opt-in live checks (docs/memory/demo-and-testing.md, "Voice live checks").
