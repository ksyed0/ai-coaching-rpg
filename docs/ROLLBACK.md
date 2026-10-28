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
