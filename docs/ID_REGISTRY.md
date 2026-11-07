# ID Registry

| **Sequence** | **Next Available ID** | **Last Assigned** |
| ------------ | --------------------- | ----------------- |
| EPIC         | EPIC-0010             | EPIC-0009         |
| US           | US-0069               | US-0068           |
| TASK         | TASK-0105             | TASK-0104         |
| AC           | AC-0392               | AC-0391           |
| TC           | TC-0154               | TC-0153           |
| BUG          | BUG-0035              | BUG-0034          |
| L            | L-0036                | L-0035            |

Reserved blocks (2026-10-06): AC-0130..AC-0139 and TASK-0040..TASK-0042 US-0025; AC-0140..AC-0149 and TASK-0043..TASK-0045 US-0017; AC-0150..AC-0159 and TASK-0046..TASK-0048 US-0016; AC-0160..AC-0169 and TASK-0049..TASK-0051 US-0018. Free below the blocks: AC-0127..AC-0129 and TASK-0035..TASK-0039. Next/Last point past the reserved blocks; an id in a block that its story does not use stays unused (ids are never reassigned).

Reserved blocks (2026-10-07): AC-0170..AC-0179, TASK-0052..TASK-0054 and TC-0013..TC-0016 US-0013; TC-0008..TC-0012 US-0034. Ids in a block that its story does not use stay unused.

Reserved blocks (2026-10-07, later): TC-0017..TC-0019 US-0023; TC-0020..TC-0022 US-0019; TC-0023..TC-0024 US-0020. Ids in a block that its story does not use stay unused.

Reserved blocks (2026-10-07, calibration): AC-0180..AC-0197, TASK-0055..TASK-0059 and TC-0025..TC-0039 US-0035..US-0039. Ids in a block that its story does not use stay unused.

Reserved blocks (2026-10-23, moderation): US-0041..US-0044, TASK-0066..TASK-0069, AC-0209..AC-0234 (US-0041 AC-0209..AC-0216, US-0042 AC-0217..AC-0222, US-0043 AC-0223..AC-0228, US-0044 AC-0229..AC-0234) and TC-0049..TC-0056 (two per story, filed when each story moves to In Progress). Filed so far: TC-0049, TC-0050 (US-0041), TC-0051, TC-0052 (US-0042) TC-0053, TC-0054 (US-0043) and TC-0055, TC-0056 (US-0044). Ids in a block that its story does not use stay unused.

Reserved blocks (2026-10-26, brand and multi-client backlog): EPIC-0007, EPIC-0008; US-0045..US-0051; TASK-0070..TASK-0079; AC-0235..AC-0265 (US-0045 AC-0235..AC-0238, US-0046 AC-0239..AC-0242, US-0047 AC-0243..AC-0247, US-0048 AC-0248..AC-0250, US-0049 AC-0251..AC-0255, US-0050 AC-0256..AC-0260, US-0051 AC-0261..AC-0265). All Planned; test cases are filed when each story moves to In Progress. Ids in a block that its story does not use stay unused.

Reserved blocks (2026-10-27, EPIC-0002 web client): US-0052..US-0065; TASK-0080..TASK-0093; AC-0266..AC-0340. Slice 2a: US-0052..US-0056 and US-0065; slice 2b: US-0057..US-0061; slice 2c: US-0062..US-0064. All Planned; test cases are filed when each story moves to In Progress. Ids in a block that its story does not use stay unused.

Assigned 2026-10-28 (EPIC-0002 slice 2a, filed with the slice's documentation): TC-0057..TC-0076 (US-0052 TC-0057, TC-0058; US-0053 TC-0059..TC-0061; US-0054 TC-0062..TC-0064; US-0055 TC-0065..TC-0067; US-0056 TC-0068..TC-0071; US-0065 TC-0072..TC-0076).

Assigned 2026-10-30 (EPIC-0002 slice 2b-1, filed with the slice's plan): AC-0341..AC-0350 (US-0058: managed mode, IPC messages, parent disconnect, reissue order, reissue consent, control service lifecycle, child environment, cookie and login, dual-mode lookup, launcher-mode E2E); TC-0077..TC-0086 (one per new AC, in order); TASK-0094 (US-0059 readiness work).

Assigned 2026-11-01 (EPIC-0002 slice 2b-2a, PR 1): AC-0351 (US-0059: allowlisted player copies); TC-0087 (AC-0351); TASK-0095 (US-0059 runtime protocol, three PRs). Later PRs of the slice assign their own as they file them: TC for `by` (AC-0312), talk time (AC-0311), `end_now` (AC-0313) and remove (AC-0314), and BUG-0016 (assigned by Task 4b, 2026-11-01).

Assigned 2026-11-01 (EPIC-0002 slice 2b-2a, PR 2): TC-0088 (`by`, AC-0312), TC-0089 (talk time, AC-0311), TC-0090 (`end_now`, AC-0313). BUG-0016 was assigned by Task 4b. 

Assigned 2026-11-01 (EPIC-0002 slice 2b-2a, PR 3): TC-0091 (remove a participant before the start, AC-0314). Slice 2b-2a is complete; the next TC is TC-0092.

Assigned 2026-11-01 (slice 2b-2b1, PR 1): AC-0352 (US-0059: console connection budget); TC-0092 (AC-0352); TASK-0096 (US-0059 facilitator channel and read-only live view, three PRs).

Assigned 2026-11-01 (slice 2b-2b1, PR 2): AC-0353 (US-0059: console stream); TC-0093 (AC-0353). No new TASK: the work is under TASK-0096.

Assigned 2026-11-01 (slice 2b-2b1, PR 3): TC-0094 (the read-only live view, AC-0311). No new AC and no new TASK: the work is under TASK-0096. Slice 2b-2b1 is complete; the next TC is TC-0095.

Assigned 2026-11-01 (slice 2b-2b1, PR 3, final review): BUG-0017 (player StreamHub reset stall over 256 KiB) and BUG-0018 (npc-agent.silence.test.ts load flake).

Assigned 2026-11-02 (slice 2b-2b2, PR 1): AC-0354 (US-0059: command and end_now ref, ack and error with the ref, no auto-start with a ref); TC-0095 (AC-0354); TASK-0097 (US-0059 facilitator command route, controls and confirmations, three PRs).

Assigned 2026-11-02 (slice 2b-2b2, PR 2): AC-0355 (US-0059: the console command route), AC-0356 (US-0059: injects and characters on the console stream, hidden-fact text on request); TC-0096 (AC-0355), TC-0097 (AC-0356). No new TASK: the work is under TASK-0097.

Assigned 2026-11-02 (slice 2b-2b2, PRs 1 to 3): AC-0354 (ref and ack), AC-0355 (command route), AC-0356 (characters and facts) and AC-0357 (stale scene on confirm); TC-0095 (AC-0354), TC-0096 (AC-0355), TC-0097 (AC-0356), TC-0098 (controls, AC-0311, AC-0312, AC-0314, AC-0315, AC-0357) and TC-0099 (Axe on the controls, AC-0316); TASK-0097 (US-0059 facilitator command route, controls and confirmations, three PRs); BUG-0019 (a whisper never reached a web player). The slice assigned AC-0354..AC-0356 and TC-0095..TC-0097 in its earlier PRs.

Assigned 2026-11-03 (slice 2b-3a, PR 1): AC-0358 (US-0060: session.started records aiRoles, log format 3, and the lobby's AI-role file); TC-0100 (AC-0358); TASK-0098 (US-0060 AI-role state, start gate, marking, consent notice v2 and log format 3, three PRs). Later PRs of the slice file their own.

Assigned 2026-11-03 (slice 2b-3a, PR 2): AC-0359 (US-0060: the control service sets AI roles over the private IPC channel before the start); TC-0101 (AC-0359) and TC-0102 (AC-0320 runtime part: the gate and the marking). No new TASK: the work is under TASK-0098 (next free stays TASK-0099).

Assigned 2026-11-03 (slice 2b-3a, PR 3): AC-0360 (US-0060: the default consent notice is v2 and a started session whose players consented under v1 keeps every consenting participant, rebound seats included, after a restart on v2); TC-0103 (AC-0360) and TC-0104 (AC-0321, player part: roster, transcript, reserved name, ai_filled). No new TASK: the work closes TASK-0098 (next free stays TASK-0099).

Assigned 2026-11-03 (slice 2b-3b, PR 1): AC-0361 (US-0060: the live AI player's turn rules, skips, stale-reply drops and shared budget); TC-0105 (AC-0319: the shared players/ module) and TC-0106 (AC-0361: the turn policy, the runtime limits, bot_alert and ready.aiCalls, the control bot plumbing, the bot and the bot host); TASK-0099 (US-0060 live AI players, toggle and Prompt AI player, three PRs). Later PRs of the slice file their own (expected AC-0362, TC-0107).

Assigned 2026-11-04 (slice 2b-3b, PR 2): AC-0362 (US-0060: AI codes in control-service memory only, the reissue refusal, the notice gate, the rejoin of the bots after a runtime or control-service restart and the shared budget); TC-0107 (AC-0362), TC-0108 (AC-0320: the console readiness split) and TC-0109 (AC-0321: the labels and the facilitator-only intent log). No new TASK: the work is under TASK-0099 (next free stays TASK-0100).

Assigned 2026-11-04 (slice 2b-3b, after PR 2): BUG-0020 (the bot socket overlap test flake, fixed), BUG-0021 (a lobby's AI roles can come back as human after a control-service restart, open), BUG-0022 (keyboard focus falls to the body after End session, a connection drop under a dialog or a 409 on Remove, open) and BUG-0023 (a whisper has no "private" label and is lost on reload, open). BUG-0022 and BUG-0023 record the two owner decisions of 2026-11-03.

Assigned 2026-11-04 (slice 2b-3b, PR 3): AC-0363 (US-0060: the facilitator can prompt an AI player with an optional private hint; reserve, logged command, run; the hint only to the model and the intent log); TC-0110 (AC-0317), TC-0111 (AC-0318), TC-0112 (AC-0363) and TC-0113 (AC-0316: Axe on the toggle, the confirmations and the AI players panel). No new TASK: the work closes TASK-0099 (next free stays TASK-0100). Slice 2b-3b is complete; the next AC is AC-0364 and the next TC is TC-0114.

Assigned 2026-11-04 (bug fixes after slice 2b-3b): BUG-0024 (the stream hubs drop a reconnecting client whose replay follows a large opening frame; found in the review of the BUG-0017 fix and fixed with it).

Assigned 2026-11-04 (slice 2b-3c, PR 1): TC-0114 (AC-0323). No new AC or TASK: the work is under TASK-0090 (next free AC stays AC-0364, next free TASK stays TASK-0100). PR 2 files its own (expected AC-0364 and TC-0115 onwards).

Assigned 2026-11-05 (slice 2b-3c, PR 2): AC-0364 (US-0061: for a session without AI roles the evaluator's requests and reports are byte-identical to the build before the slice, and a log written before the option existed is scored with the option on); TC-0115 (AC-0324), TC-0116 (AC-0325), TC-0117 (AC-0326: the independent review record and its fixes), TC-0118 (AC-0322, evaluator part), TC-0119 (AC-0321, reports and exports) and TC-0120 (AC-0364). No new TASK: the work closes TASK-0090. Slice 2b-3c is complete; the next AC is AC-0365 and the next TC is TC-0121.

Assigned 2026-11-05 (slice 2c-1, PR 1): AC-0365 (US-0062: the reader of released reports is read-only and follows a re-run folder) and AC-0366 (US-0062: a revoke or reissue ends reads at once, even for a holder of a live cookie, and a wrong-session read does not touch the credential); TC-0121 (AC-0327: the credential store), TC-0122 (AC-0329, AC-0330, AC-0366: the report service and its API) and TC-0123 (AC-0365: the runtime reader and the import boundary). TASK-0091 is reused (no new TASK; next free stays TASK-0100).

Assigned 2026-11-05 (slice 2c-1, PR 2): AC-0367 (US-0062: opening a report link keeps the token out of logs, referrer and the address bar; no-script fallback) and AC-0368 (US-0062: forged cross-site enter refused before the throttle, a blocked address gets 429 with Retry-After while a refused token stays the neutral 404, no-store and no-referrer, no credential id in the console DTO); TC-0124 (AC-0330, AC-0367, AC-0368: BFF routes and pages), TC-0125 (AC-0327, AC-0328, AC-0368: console panel) and TC-0126 (end to end and Axe). TASK-0100 (TASK-0092 was already taken by US-0063). Slice 2c-1 is complete; the next AC is AC-0369, the next TC is TC-0127 and the next TASK is TASK-0101.

Assigned 2026-11-05 (slice 2c-1 close): BUG-0025 (forged-cookie read failures share the enter throttle table), BUG-0026 (`ws-server.roster.test.ts` flake), BUG-0027 (conflict sentences duplicated between control and web) and BUG-0028 (slice 2c-1 test and cleanup gaps), all open. L-0032 and L-0033 were added at the same close.

Assigned 2026-11-06 (slice 2c-2, PR 1): AC-0369 (US-0063: capacity bounds), AC-0370 (US-0063: no write attempt begins after a revoke or reissue has returned), AC-0371 (US-0063: rating progress in `moderate status` and the console) and AC-0372 (US-0063: old-schema refusal); TC-0127 (AC-0331, AC-0335: fold and forging), TC-0128 (AC-0332: blind read), TC-0129 (AC-0333: lock and retry), TC-0130 (AC-0334: text and export), TC-0131 (AC-0369, AC-0370: capacity and revoke) and TC-0132 (AC-0371, AC-0372: progress and old schema). TASK-0092 is reused (no new TASK; next free stays TASK-0101). The next AC is AC-0373, the next TC is TC-0133.

Assigned 2026-11-06 (slice 2c-2, PR 2): TC-0133 (AC-0331 to AC-0335, AC-0370 to AC-0372: end to end and Axe for ratings and responses) and TC-0134 (AC-0332 to AC-0335, AC-0371: page and console cases: SelfRatingForm, ComparisonTable, ResponsesList, ResponseForm, ReportLinksPanel and the BFF write routes); TASK-0101 (US-0063: browser, PR 2). No new AC. Slice 2c-2 is complete; the next AC is AC-0373, the next TC is TC-0135, the next TASK is TASK-0102, the next BUG is BUG-0029 and the next L is L-0034.

Assigned 2026-11-06 (slice 2c-3, PR A, US-0064): AC-0373 (no evaluate over a draft or review, no orphan reuse), AC-0374 (the model spend is confirmed, a stale confirmation refused), AC-0375 (release takes an explicit list; empty or `all` refused), AC-0376 (export is a `POST` that records first, nothing written to disk), AC-0377 (resolve a dispute in the browser) and AC-0378 (a stale edit keeps the typed text), in the order of spec section 9; AC-0375 to AC-0377 are part B. TC-0135 (AC-0336, AC-0339: run summary and call bound), TC-0136 (AC-0337, AC-0378: moderation library), TC-0137 (AC-0336, AC-0373, AC-0374: evaluate job), TC-0138 (AC-0337, AC-0373, AC-0378: moderation service and control routes), TC-0139 (AC-0336, AC-0337, AC-0339, AC-0374, AC-0378: console panel and BFF routes) and TC-0140 (AC-0336, AC-0337, AC-0339, AC-0373, AC-0378: end to end and Axe). TASK-0093 (part A) is reused; TASK-0102 is new (US-0064 part B, release and close-out). The next AC is AC-0379, the next TC is TC-0141, the next TASK is TASK-0103.

Assigned 2026-11-06 (slice 2c-3, PR B, US-0064): TC-0141 (AC-0337, AC-0375 to AC-0377: the part B moderation library), TC-0142 (AC-0337, AC-0375 to AC-0377: the moderation service and the part B control routes), TC-0143 (AC-0337, AC-0338, AC-0375 to AC-0377: the console release bar, dialogs, dispute panel and export menu, and the BFF part B routes) and TC-0144 (AC-0337, AC-0338, AC-0340, AC-0375 to AC-0377: end to end and Axe). No new AC (AC-0375 to AC-0377 were filed by PR A) and no new TASK (TASK-0102 was filed by PR A). Slice 2c-3 is complete; the next AC is AC-0379, the next TC is TC-0145, the next TASK is TASK-0103, the next BUG is BUG-0029 and the next L is L-0034.

Reserved blocks (2026-11-06, slice 2c-4): US-0066 (EPIC-0002 close-out polish); TASK-0103 (US-0060, PR 1) and TASK-0104 (US-0066, PR 2); AC-0379..AC-0381 under US-0060 and AC-0382..AC-0384 under US-0066; TC-0145..TC-0152 (TC-0145, TC-0146 AC-0379; TC-0147 AC-0380; TC-0148, TC-0149 AC-0381; TC-0150 AC-0382; TC-0151 AC-0383; TC-0152 AC-0384), filed when each task is built. Ids in a block that its story does not use stay unused. No new BUG or L ids are reserved.

Reserved blocks (2026-11-06, multilingual backlog): EPIC-0009; US-0067; AC-0385..AC-0388 (all under US-0067). All Planned; test cases are filed when the story moves to In Progress. Ids in a block that its story does not use stay unused.

Reserved blocks (2026-11-06, AI player row follow-up): US-0068; AC-0389..AC-0391 (all under US-0068). Planned; test cases are filed when the story moves to In Progress. Ids in a block that its story does not use stay unused.
