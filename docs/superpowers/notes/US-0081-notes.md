# US-0081 notes: AI players prompt the quiet human; the Game Master needs a human line

Integration notes for whoever merges this story into `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`, `progress.md`, `MEMORY.md` and `docs/THREAT_MODEL.md`. None of those files was edited on this branch.

Ids used: AC-0470 to AC-0479, TC-0250 to TC-0259 (all ten of each). Task: TASK-0121.

## Why

Owner feedback from a live demo with two AI players and one human:

- the AI players kept speaking on quiet-time nudges and answered each other for five minutes with no human line;
- the Game Master then judged the scene's exit condition met from that AI-only dialogue and ended the scene;
- an AI player spoke first and called the human "Alex", a name it invented (participant names are never sent to models).

Owner decisions:

1. When humans are quiet, an AI player prompts the human.
2. The Game Master does not judge or end a scene on exit conditions until the scene has at least one human line.
3. Participants are addressed by role title only, never by an invented name.

## What changed (behaviour)

- **Nudge target.** A nudge prompts one human seat. The seat is chosen from the human player seats that are in the current scene and that the peers roster shows ready. The seat that has spoken least in the scene wins. A tie goes to the seat that has been silent longest (a seat that never spoke counts as the longest), then to scenario role order. The prompt names the seat by its role title (for example "Account manager"), asks for one short question that moves the scene toward its goal, and forbids first names and any name the model was not given. With no such seat in the scene, there is no nudge. See `pickNudgeTarget` and `nudgeIntent` in `services/runtime/src/players/`.
- **No AI chains.** Only one AI player of a session nudges at a time. The control service's `NudgeFloor`, one per session in `BotHost`, is claimed before the model call. Once a nudge is said, no further nudge from any AI player of the session fires until a human line arrives in the scene. A new scene or a reset opens the floor again. A nudge that is skipped or dropped frees the floor, and the other bots re-arm. Replies are unchanged: an AI player still replies only to lines that are not from an AI player (a human or an AI character), so an AI player's nudge never starts another AI player's reply.
- **Rejoin (conservative).** After a reconnect the policy cannot tell whether the last AI line was a nudge. In the replayed history of the current scene, an AI player's line after the last human line keeps the floor closed. In that case, after a control-service restart, the bots wait for a human line before they nudge.
- **Addressing rule.** One sentence, `ADDRESS_RULE`, is now in every live AI player prompt and in every AI character prompt (in the stable prefix, so the cache breakpoint is still identical on every turn):
  > Address the other participants only by the role title or the name this prompt lists for them; never use a first name or any other name you were not given.

  The live AI player prompt drops the old advice "by first name if you know it" (it now uses `LIVE_SPEAKER_RULE`) and gains a `## Who is in this scene` roster. A player seat is listed by its role title, with ", an AI player" for an AI seat. An AI character is listed by the public name and title from the scenario. The AI character prompt gains `## Players in this scene` (role titles and speaker tags; ", an AI player" for an AI seat). No participant display name is in either roster.
- **Game Master gate.** In a session with at least one human player seat (a player role that is not in `session.started.aiRoles`), the Game Master requests and applies no exit-condition verdict for a scene until a human seat has spoken in that scene. Lines from AI players, AI characters and the facilitator do not count. **`earned_when` checks are behind the same gate**: they run in the same evaluation round, after the exit conditions. Lines that are held back are not marked as evaluated, so the first human line is judged at once if the cadence is already due. `finalEvaluation` is gated too. `time_box_elapsed` and `facilitator_advance` are unchanged. A session where every player seat is AI is not gated (otherwise no scene could ever be judged). A session without AI roles is gated as well, but every player seat there is human, so ordinary sessions and the scripted demo players are judged as before. All four demo checkers pass with unchanged counts.
- **Facilitator alert (optional item, built because it was cheap).** When the gate holds back an evaluation that would otherwise have run, one `facilitator.alert` at level `info` is appended per scene, with the fixed text `GM_HUMAN_LINE_ALERT`: "GM: this scene is not judged yet: the Game Master waits until a human player has spoken in it". Players never receive `facilitator.alert`, which stays facilitator-only. The once-per-scene memory is in-process, so a runtime restart may repeat the alert once.

No wire or log-format change: no new event type, no new field on any frame, `LOG_FORMAT` unchanged. The bot frame parser is unchanged. `AI_PLAYER_NUDGE_MS` still defaults to 90000, and no configuration default changed.

**Golden and byte-identical tests:** none was re-recorded. The demo's simulated-trainee prompt (`buildPlayerRequest`, pinned byte for byte in `live.test.ts` "demo prompt unchanged") is deliberately left unchanged, and it keeps `NO_ROLE_ID_RULE`. That bot is a scripted stand-in for a human trainee in the demo, not a live AI player seat. The evaluator golden test is unaffected. The S-06 and S-15 prompt audits pass: the NPC stable prefix is still the same for every call, and the rosters hold role ids and titles only.

## Files

- `services/runtime/src/players/turn-policy.ts`: `line.human`, the `nudged` event and the closed-floor rule (`nudgeSpent`).
- `services/runtime/src/players/nudge.ts` (new): `pickNudgeTarget`.
- `services/runtime/src/players/prompt.ts`: `roleTitle`, `RosterEntry`, `liveRoster`, `LIVE_SPEAKER_RULE`, `nudgeIntent`, the roster section and `target` in `buildLiveRequest`.
- `services/runtime/src/players/live.ts`: passes `target`.
- `services/runtime/src/players/index.ts`: exports.
- `services/runtime/src/agents/npc-prompt.ts`: `ADDRESS_RULE`, `playersSection`.
- `services/runtime/src/agents/game-master.ts`: `humanLineGateOpen`, `GM_HUMAN_LINE_ALERT`, the gate in `tick` and `finalEvaluation`.
- `services/control/src/bots/nudge-floor.ts` (new): `NudgeFloor`.
- `services/control/src/bots/bot.ts`: scene participants and speakers, ready humans, the nudge target, floor claim, release and spoke, the roster in the view.
- `services/control/src/bots/bot-host.ts`: one `NudgeFloor` per session.
- Tests: `players/__tests__/turn-policy.test.ts`, `players/__tests__/nudge.test.ts`, `players/__tests__/live.test.ts`, `agents/__tests__/npc-prompt.prefix.test.ts`, `agents/__tests__/game-master.human-gate.test.ts`, `control/src/__tests__/bots/bot-host.nudge.test.ts`, `control/src/__tests__/bots/nudge-floor.test.ts`.

## Acceptance criteria (for US-0081 in RELEASE_PLAN.md)

- [x] AC-0470: A nudge addresses the human seat in the current scene that has spoken least (ties: silent longest, then scenario role order), by its role title, with one short question toward the scene goal. The nudge prompt names the target's role title and forbids inventing names.
- [x] AC-0471: Only one AI player of a session nudges at a time. After a said nudge, no further nudge from any AI player fires until a human line arrives in the scene. A new scene opens the floor again; a skipped or dropped nudge frees it.
- [x] AC-0472: Every live AI player prompt and every AI character prompt carries the one addressing sentence (`ADDRESS_RULE`) and a roster of role titles. The live prompt no longer advises using first names. No participant name is in any prompt.
- [x] AC-0473: There is no nudge when no ready human seat is in the scene. An AI player does not reply to another AI player's nudge (two AI players and one silent human produce exactly one nudge, then silence).
- [x] AC-0474: In a session with at least one human seat, the Game Master requests and applies no exit-condition verdict for a scene until that scene has an utterance from a human player seat (not an AI player, AI character or the facilitator). The first human line is judged at once if the cadence is due.
- [x] AC-0475: `earned_when` checks are behind the same gate.
- [x] AC-0476: Time box and facilitator advance exits are unchanged. A session with no human seat is not gated. A session without AI roles judges player lines as before. `pnpm demo --fast` (29), `--showcase --fast` (14) and `--fast --security --resume` (42) pass with unchanged counts.
- [x] AC-0477: While the gate holds back an evaluation, the facilitator gets one info alert per scene, and players never see it.
- [x] AC-0478: No wire or log-format change. `AI_PLAYER_NUDGE_MS` still defaults to 90000. The demo's simulated-trainee prompt is byte-identical.
- [x] AC-0479: After a rejoin, an AI player line after the last human line in the replayed scene keeps the nudge floor closed (conservative).

## Test cases (for TEST_CASES.md; Related Story US-0081, Related Task TASK-0121)

**TC-0250: The nudge prompts the quietest human seat by role title** (AC-0470, Functional)
- Steps: (1) Start the friday-escalation scenario with `tech_lead` as an AI player and humans `delivery_lead` and `account_manager`, both ready. (2) Have `delivery_lead` speak once and let the AI player reply. (3) Wait one nudge interval.
- Expected: the nudge request's system text holds `nudgeIntent("Account manager")` and not `nudgeIntent("Delivery lead")`. Ties go to the seat silent longest, then scenario order (`nudge.test.ts`).
- Automated: `bot-host.nudge.test.ts` "the nudge targets the human who spoke least", "the nudge addresses the human by role title and forbids names"; `nudge.test.ts`; `live.test.ts` addressing.

**TC-0251: One nudge until a human speaks** (AC-0471, Functional)
- Steps: (1) Use two AI players and one human. (2) Wait one nudge interval. (3) Wait twenty more intervals. (4) Have the human speak, let the replies run, then wait two intervals.
- Expected: after step 2 exactly one AI line; after step 3 still one, with exactly one model call; after step 4 the replies and then exactly one more nudge.
- Automated: `bot-host.nudge.test.ts` (first and third cases), `turn-policy.test.ts` "one nudge until a human speaks", `nudge-floor.test.ts`.

**TC-0252: Prompts address by role title only** (AC-0472, Functional)
- Steps: build a live AI player request and an AI character request for a scene with a human and an AI player seat.
- Expected: both hold `ADDRESS_RULE`. The live prompt has `## Who is in this scene` and no "by first name". The AI character prompt has `## Players in this scene` after `## Current scene`, the AI seat is marked, and no participant name appears. The NPC stable prefix holds the rule.
- Automated: `live.test.ts` "buildLiveRequest addressing (US-0081)", `npc-prompt.prefix.test.ts` "test_npc_prompt_addresses_players_by_role_title".

**TC-0253: No nudge without a human seat in the scene; no AI-to-AI reply** (AC-0473, Negative)
- Steps: (1) Scene participants are two AI players and an AI character; the human is connected but not in the scene; wait twenty nudge intervals. (2) In the usual room, wait for the nudge and then ten settle times.
- Expected: (1) no model call. (2) No reply-intent request after the AI nudge.
- Automated: `bot-host.nudge.test.ts` "no nudge when no human seat is in the scene", "ai players do not answer each others nudge".

**TC-0254: The Game Master does not judge AI-only dialogue** (AC-0474, Functional)
- Steps: (1) Start friday-escalation with `delivery_lead` and `tech_lead` as AI players; GM cadence 2; the model answers true. (2) Twelve AI lines with ticks. (3) A line from `account_manager`, then a tick.
- Expected: after step 2 no model call, no verdict, same scene, and `finalEvaluation` false. After step 3 one call at once, and the scene ends on the true verdict.
- Automated: `game-master.human-gate.test.ts` (first two cases).

**TC-0255: earned_when is behind the same gate** (AC-0475, Functional)
- Steps: in the minimal fixture with an `earned_when` on the AI character, give three AI character lines with ticks, then one host (human) line.
- Expected: no exit or fact check before the human line, then one exit check and one fact check.
- Automated: `game-master.human-gate.test.ts` "ai character lines alone judge no earned_when and no exit".

**TC-0256: Unchanged exits and ungated sessions** (AC-0476, Regression)
- Steps: (1) Run a gated scene past its time box. (2) Run a session whose every player seat is AI. (3) Run a session without AI roles. (4) Run `pnpm -s demo --fast`, `pnpm -s demo --showcase --fast` and `pnpm -s demo --fast --security --resume`.
- Expected: (1) the time box ends the scene. (2) and (3) are judged on the cadence as before. (4) 29, 14 and 42 checks pass.
- Automated: `game-master.human-gate.test.ts`; demos run by hand on this branch.

**TC-0257: One facilitator alert per held scene** (AC-0477, Functional)
- Steps: give eight AI-only lines with ticks in a gated scene; separately, a human line first.
- Expected: exactly one `facilitator.alert` at level `info` with `GM_HUMAN_LINE_ALERT` in the first case, none in the second.
- Automated: `game-master.human-gate.test.ts` (third and fourth cases).

**TC-0258: No wire, log or default change** (AC-0478, Regression)
- Steps: run the bot-frame real test, the settings test, the demo prompt byte-identity test and the full runtime and control suites.
- Expected: all pass; `AI_PLAYER_NUDGE_MS` is 90000; no new event or frame field.
- Automated: `settings.test.ts`, `live.test.ts` "demo prompt unchanged", `bot-frames.real.test.ts`.

**TC-0259: Conservative floor after a rejoin** (AC-0479, Edge Case)
- Steps: seed the policy with replayed history (a human line, then an AI player line); separately, the reverse order.
- Expected: in the first case no nudge is due; in the second a nudge is due after the interval.
- Automated: `turn-policy.test.ts` "replayed history ending in an ai player line restores the closed floor".

## CHANGELOG line (under [Unreleased], Changed)

- AI players now prompt a quiet human instead of talking among themselves. A nudge asks the human seat that has spoken least in the scene a short question, by role title. Only one AI player nudges at a time, and none nudges again until a human speaks. AI players and AI characters address people only by role title, never by an invented name. The Game Master no longer judges or ends a scene on its exit conditions (or hidden-fact `earned_when` conditions) until a human player has spoken in it, and the facilitator sees one note while it waits (US-0081).

## THREAT_MODEL notes ("Live AI players", Turn rules)

- Add to the turn rules: a nudge targets one human seat by role title. One AI player of a session nudges at a time (`NudgeFloor`, control-service memory). A said nudge closes nudging for every AI player of the session until a human line in the scene.
- Game Master verdicts section: in a session with a human seat, no exit or `earned_when` verdict is requested before a human line in the scene. This narrows the "dangerous direction" (a `true` ends a scene): AI-only dialogue can no longer end a scene. An AI player can still steer the verdict once a human has spoken, because AI lines are still part of the Game Master's transcript (residual risk, unchanged).
- Residual risks:
  - The floor is in memory. After a control-service restart, the conservative replay rule (an AI line after the last human line) keeps the floor closed, so one nudge may be lost; a nudge is never doubled.
  - The once-per-scene gate alert is in memory, so a runtime restart can repeat it once.
  - The rosters add role ids and titles only, which models already saw as speaker tags; no new data reaches a model.
  - A model can still disobey the addressing rule. The rule reduces invented names; it cannot prevent them.

## ROLLBACK notes

- Code-only change. Rolling back restores the old nudge behaviour and the ungated Game Master. Logs stay readable both ways, because no event type, field or log format was added; the gate alert is an ordinary `facilitator.alert`. Deploy order does not matter between control and runtime: the new bot works with an old runtime, and the new runtime works with an old control service. Each half's behaviour simply applies on its own.
