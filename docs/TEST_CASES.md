# Test Cases

Test cases are added as stories move to In Progress. Unit and simulation tests live beside the code; this file tracks manual and acceptance tests.

## US-0033: per-role player join codes

TC-0001: Join codes are issued per player role and shown once
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0120
Type: Functional
Preconditions: No session log for the session id (or `./run.sh --dev --fresh`).
Steps:
  1. Start the server.
  2. Read its output, `data/sessions/<id>.jsonl` and `data/sessions/<id>.codes.json`.
Expected Result: One `PLAYER JOIN CODES` block with one `XXXX-XXXX-XXXX` code per player role; no code in any log line, in the session log or in the codes file (hashes only, mode 0600).
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: main.test.ts `test_bootstrap_issues_codes_...`, demo F-24 and F-28.

TC-0002: A player joins with their role's code
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0120
Type: Functional
Preconditions: A running server with its join codes.
Steps:
  1. `pnpm play --role delivery_lead --name A`.
  2. Type delivery_lead's code at the hidden prompt (try lower case, spaces, O for 0).
Expected Result: Joined with delivery_lead's brief; the code is never echoed.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.join-codes.test.ts, join-codes.test.ts (Crockford folding), demo F-01.

TC-0003: Missing, wrong or misdirected codes get one generic refusal
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0121
Type: Negative
Preconditions: A running server; delivery_lead held by a connected player.
Steps:
  1. Join delivery_lead with no code, with a wrong code and with tech_lead's code.
  2. Join `client_sponsor` and `no_such_role` with a valid code.
  3. Send a code containing a non-ASCII look-alike (the long s).
Expected Result: Every attempt gets the same `unauthorized`, the connection closes (1008) and the client says to check the join code; a free and a taken role answer alike.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.join-codes.test.ts, join-codes.test.ts, demo F-02.

TC-0004: Refused joins count against the per-address limits
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0121
Type: Edge Case
Preconditions: A running server reached from one address.
Steps:
  1. Send six wrong codes from one address within a minute.
  2. Open a new connection from that address, then from another address.
Expected Result: The address gets HTTP 429 for a minute (the facilitator's handshake from that address too); another address connects.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.join-codes.test.ts `test_join_repeated_wrong_codes_...`. Players sharing an address (NAT, Docker Desktop) share this limit.

TC-0005: The facilitator token, join codes and reconnect token stay separate
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0122
Type: Functional
Preconditions: A server with `FACILITATOR_TOKEN` set and a connected delivery_lead.
Steps:
  1. Join as facilitator without a code; with a join code as the token.
  2. Join delivery_lead with the token as its code.
  3. Join delivery_lead with its code while its player is connected.
  4. Rejoin delivery_lead with the live connection's reconnect token and no code.
Expected Result: Step 1 joins with the token and is refused with a code; step 2 is `unauthorized`; step 3 is `role_taken`; step 4 joins.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.join-codes.test.ts, demo F-22.

TC-0006: Join codes across a restart
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0122
Type: Regression
Preconditions: A started session (the facilitator typed `/start`).
Steps:
  1. Kill the server and start it again.
  2. Rejoin with the old codes; try a join without a code.
  3. Start with `./run.sh --fresh`; try the old codes.
  4. Restart before `/start`; move `<id>.codes.json` aside and restart; corrupt it and restart a started session.
Expected Result: After the restart of the started session no codes are printed (a line says they still apply), the old codes work and a codeless join is refused; every other start prints new codes and the old ones are refused; a corrupt codes file stops the start without changing anything.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: main.resume.test.ts (including a real SIGKILL), main.test.ts, session-store.test.ts, demo F-37, F-40, F-41.

TC-0007: A start that fails before showing the codes withdraws them
Related Story: US-0033
Related Task: TASK-0033
Related AC: AC-0120
Type: Negative
Preconditions: The server's port is taken (or the model key is missing).
Steps:
  1. Start the server; it fails.
  2. Free the port (or set the key) and start again.
Expected Result: The failed start shows no codes and leaves no codes file; the next start shows new codes, so nobody is locked out by unseen codes.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: main.test.ts `test_bootstrap_listen_fails_...`, `test_bootstrap_missing_api_key_...`, `..._withdraws_reissued_codes_...`, `..._display_that_throws_...`.

## US-0013: replay-from-seq on rejoin

TC-0013: A player who drops out rejoins with --last-seq and receives the inject and whisper it missed
Related Story: US-0013
Related Task: TASK-0052
Related AC: AC-0039
Type: Functional
Preconditions: A running server and session; delivery_lead, tech_lead and the facilitator connected with the terminal client.
Steps:
  1. Kill delivery_lead's client (close the terminal); note the `--last-seq <n>` it printed (or, if killed hard, the seq of the last event it showed).
  2. As facilitator, `/whisper delivery_lead psst` and `/whisper tech_lead only-for-tech`; let a timed inject or an `/inject` reach delivery_lead; say a line as tech_lead.
  3. Run `pnpm play --role delivery_lead --name A --last-seq <n>` with the role's join code.
Expected Result: The client shows the history up to seq n, `(catching up: N missed events follow)`, then exactly the missed lines, the inject and `psst` in order, then live events; never `only-for-tech`, an alert, Game Master text or NPC goals. Without `--last-seq` it shows only the history, as before.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.replay.test.ts, session-host-replay.test.ts (every role x every seq equals the live view), cli tests, demo F-22 and F-25.

TC-0014: Replay never crosses roles or reveals facilitator-only data
Related Story: US-0013
Related Task: TASK-0052
Related AC: AC-0170
Type: Negative
Preconditions: A session with whispers to two different roles, a released hidden fact, a Game Master decision and a facilitator alert.
Steps:
  1. Rejoin each player role with `--last-seq 0`.
  2. Search each client's output (or the raw frames) for the other role's whisper, the hidden fact, the Game Master reasoning, the alert text and other participants' names.
Expected Result: Nothing found; each player sees only its scenes, its injects, pause and resume and its own whispers. The facilitator rejoining with `--last-seq 0` sees everything retained.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: session-host-replay.test.ts `test_replay_never_gives_a_player_another_roles_whisper_or_facilitator_only_data`, ws-server.replay.test.ts, demo F-18, F-22, F-37.

TC-0015: A malformed, out-of-range or unauthorised lastSeq gets nothing extra
Related Story: US-0013
Related Task: TASK-0052
Related AC: AC-0173
Type: Negative
Preconditions: A running server with join codes and a facilitator token.
Steps:
  1. Send `join` with `lastSeq` -1, 1.5, "7", null and 1e999 (raw JSON).
  2. Send a correctly authorised `join` with `lastSeq` one past the last event, then the same join without it on the same connection.
  3. Send `join` with `lastSeq: 0` and a wrong code, an AI role, an unknown session; `join_facilitator` with a wrong token and `lastSeq: 0`.
  4. Rejoin from seq 0 a session of more than 1000 events visible to the role (or with a smaller retained window in a test build).
Expected Result: 1: `bad_message`, the connection stays open. 2: `bad_message` and no role claimed, then the join succeeds. 3: exactly one `unauthorized` frame and a 1008 close, nothing else (the session length is not revealed). 4: `replay.complete` is false with 0 events and the client says earlier injects and whispers are not shown; the server does no work beyond its caps.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: ws-server.replay.test.ts (bad values, beyond head, refusals, the window), session-host-replay.test.ts (caps), recent-events.test.ts, demo F-02 and F-20.

TC-0016: Rejoining with the last seq after a server restart, as a player and as the facilitator
Related Story: US-0013
Related Task: TASK-0054
Related AC: AC-0175
Type: Functional
Preconditions: A running session with a player and the facilitator connected.
Steps:
  1. Note each client's last seq; stop the server (Ctrl-C or kill) and start it again (`SESSION_START=resume`).
  2. Rejoin the player with its join code and `--last-seq <n>`, and the facilitator with its token and `--last-seq <m>`.
  3. Rejoin a second player that was not in the current scene with `--last-seq 0`.
Expected Result: The player is replayed what it missed before the crash, then that the session came back paused (no restart alert); the facilitator also gets the restart alert; the second player gets only its own scenes. Seqs continue from before the restart. After `SESSION_START=fresh` the old seq is refused as `bad_message` and a rejoin without `--last-seq` works.
Actual Result:
Status: [ ] Not Run
Defect Raised: None
Notes: Automated: session-host-replay.test.ts (restart), session-engine-replay.test.ts (window rebuilt by restore; an event on disk that no client saw), demo F-34 and F-37 (`pnpm demo --fast --resume`).

Demo against a running server (no TC id; covered by runner.test.ts): `JOIN_CODES=delivery_lead=<code>,tech_lead=<code>,account_manager=<code> pnpm demo --url ws://localhost:8080 --fast` passes the external checks and prints no code.
