# ID Registry

| **Sequence** | **Next Available ID** | **Last Assigned** |
| ------------ | --------------------- | ----------------- |
| EPIC         | EPIC-0009             | EPIC-0008         |
| US           | US-0066               | US-0065           |
| TASK         | TASK-0099             | TASK-0098         |
| AC           | AC-0360               | AC-0359           |
| TC           | TC-0103               | TC-0102           |
| BUG          | BUG-0020              | BUG-0019          |
| L            | L-0032                | L-0031            |

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
