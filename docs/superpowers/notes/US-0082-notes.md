# US-0082 notes: AI activity indicators, "Waiting for you" and @role addressing

Branch: `worktree-agent-ad1248c95359ae443` (cut from `feature/EPIC-0002-demo-feedback-fixes`), task TASK-0122. These notes carry what the
plan files should record (the builder did not touch `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `CHANGELOG.md`,
`progress.md`, `MEMORY.md` or `docs/plan-status.*`). Ids used: AC-0480 to AC-0499, TC-0260 to TC-0269, TASK-0122.

## Design in one paragraph

A new transient server frame `activity { roleId, state: "thinking" | "idle", outcome?: "timed_out" | "failed" }` is NOT a session event: it
has no seq, is never appended, replayed, resumed, evaluated or reported. The runtime holds who is thinking in memory only
(`services/runtime/src/host/activity.ts`, `ActivityBoard`). AI characters are inferred by the runtime itself (the `NpcAgent` reports the
start and end of its turn); live AI players report over their own WebSocket with a bot-only client message `activity { state, outcome? }`
(accepted only from an AI player seat; a human or the facilitator gets `forbidden`; strict schema). Delivery (`ws-server.ts`): the
facilitator gets every frame whole; a player gets the allowlisted copy (`activityForPlayer`: roleId and state, never the outcome) only while
the player AND the speaker are both participants of the CURRENT scene (default deny). The BFF picks fields again (`activity-copy.ts`) and
sends a named SSE event `activity` with no `id`. Addressing is an optional `to` on the `say` message and on the `utterance` event, kept by
the engine only for another role of the speaker's current scene (inside the mutex; otherwise dropped silently, the line is still recorded).

## Acceptance criteria

- [x] AC-0480: While an AI character or a live AI player composes a reply, the player page and the facilitator console show "<name> is thinking…" (transcript naming rule: role label; AI badge), and it disappears when the reply lands, the turn ends (timeout, skip, silence), the scene changes, the session pauses or ends.
- [x] AC-0481: The thinking signal is never written to the session log: no event, no alert, no field; replay, resume, evaluation, reports and the log format are unchanged (`ws-server.activity.test.ts` scans the log; mutation-checked).
- [x] AC-0482: A player receives an `activity` frame only for a role that shares the player's current scene; a player outside the scene, or with no current scene, receives none; the outcome is never in a player copy (runtime and BFF).
- [x] AC-0483: Only an AI player seat may report its turn (`activity` from a human seat or the facilitator is `forbidden`; an extra key is `bad_message`); a report for a role outside the current scene, before the start or while paused is ignored; an "idle" is always applied; a closed bot socket ends its activity.
- [x] AC-0484: A viewer that joins (or rejoins) mid-turn is told who is thinking right after `joined` (filtered by the same rule); a fresh joined clears the page's indicators first.
- [x] AC-0485: The page clears a thinking indicator by itself after 120 s (`ACTIVITY_EXPIRY_MS`), so a lost "idle" never leaves it stuck; the runtime does not re-announce an entry older than that.
- [x] AC-0486: The facilitator's AI players panel shows per AI player role: Thinking…, Waiting, Timed out (turn skipped) or No usable reply (turn skipped), in text (never colour alone). (An AI player never uses a fallback line: its failed turn is skipped, so the wording says so instead of "fallback used".)
- [x] AC-0487: Every client ignores an unknown frame: an old web app or terminal client with a new runtime shows nothing new and keeps working; a new web app with an old runtime shows no indicator; a bot sends `activity` only when its `joined` carries `activity: true` (a new runtime), so an old runtime never refuses one.
- [x] AC-0488: The utterance event may carry an optional `to` (a role id); absent, the event and the log are byte-identical to before; no log-format bump (every reader ignores unknown fields; `event-log.ts` checks only the type).
- [x] AC-0489: The runtime keeps `to` only when it names another role of the speaker's current scene (an own-property role); a role of another scene, the speaker itself, an unknown id or `__proto__` is dropped and the line is recorded without it (mutation-checked).
- [x] AC-0490: AI character and live AI player prompts carry the addressing rule and, when the latest line was addressed, "The last line was addressed to you (by X): answer it first, directly." or "The last line was addressed to <label> (by X): let them answer…". The cached NPC prefix is unchanged.
- [x] AC-0491: A line addressed to an AI character puts that character first in the round and it must speak; a line addressed to a player (human or AI) lets every character stay silent (even a lone one) and raises no "every AI character stayed silent" alert.
- [x] AC-0492: A line addressed to a live AI player makes its reply due at once (no settle wait) but still within the minimum gap, the per-scene line cap and the session budget; a line addressed to someone else sets no pending reply for other AI players (their nudge still runs); a bot still never reacts to another AI player.
- [x] AC-0493: An AI reply that begins with "@<role id>", "@<role words>" or "@<name>" of another role of the current scene is recorded with `to` and the token stripped; any other "@..." (an invented or out-of-scene role, mid-line, nothing left after it) is left as the model wrote it, with no `to`.
- [x] AC-0494: In the player composer, typing "@" at the start or after a space opens a list of the OTHER roles of the current scene (players, AI players, AI characters, labelled by role title with the person's name or kind); arrows move, Enter or Tab choose, Escape closes, a click chooses; choosing inserts "@Role title " and directs the line.
- [x] AC-0495: Removing the "@Role title" from the text drops the direction; one addressee per line; the line stays public (the composer says "everyone in the scene still sees the line").
- [x] AC-0496: The player transcript and the facilitator console timeline show "to <name>" on an addressed line ("to you" on the addressee's page, with a highlight that is also stated in words); the evaluator transcript is unchanged.
- [x] AC-0497: The addressed human sees a "Waiting for you" banner (polite live region) while the latest AI line of the current scene addressed to them is unanswered; any line by that role, a scene change or the end clears it; it survives a reload (derived from the transcript); an AI seat never gets one; a human's addressed line does not trigger it.
- [x] AC-0498: The BFF accepts `to` on `POST /api/v1/say` only as a string of 1 to the id limit (else 400) and passes it through; the console copy of an utterance keeps `to` (picked, not spread).
- [x] AC-0499: Demo counts unchanged (29, 32, 39, 42 with `--security --resume`, 14 showcase) and `pnpm demo --web` W-01..W-08 pass (all ran on this branch, mock mode).

## Test cases

| Id | Title | Steps | Expected |
| --- | --- | --- | --- |
| TC-0260 | AI character thinking reaches only the scene and the facilitator | Start Friday with `tech_lead` as AI player; advance to scene 2; delivery_lead says a line while the NPC reply is held. | delivery_lead, account_manager and the facilitator get `activity client_sponsor thinking`, then `idle` after the line; the tech_lead seat (not in scene 2) gets none; a facilitator joining mid-turn gets `thinking` after `joined`. (`ws-server.activity.test.ts`) |
| TC-0261 | Activity never reaches the log | Same run; read the log. | No `activity`/`thinking` text in any event; mutation (route through `engine.alert`) makes the test fail. |
| TC-0262 | Bot activity, outcome and refusal | The AI seat sends `activity thinking`, then `idle timed_out`; a human seat sends `activity`; the bot sends an extra key; the bot socket closes while thinking. | Players get role and state only, the facilitator also the outcome; human `forbidden`; extra key `bad_message`; closing clears the board. |
| TC-0263 | Addressee validation | delivery_lead says with `to` = account_manager, client_sponsor (other scene), itself, `nobody`, `__proto__`. | Only the first is recorded with `to`; the rest are recorded without it (mutation-checked). |
| TC-0264 | Addressed AI character answers first | Two AI characters (junior first by seniority); the host addresses the senior one. | The senior answers first, then the junior; the line carries `to`. |
| TC-0265 | Line for a player: no forced answer, no alert | A lone AI character; the host addresses another player; the model answers `<silent/>`. | No utterance, no "stayed silent" alert. |
| TC-0266 | AI player addressed reply timing | TurnPolicy: an addressed human line; then one right after the bot spoke; a line for someone else; an AI player's addressed line. | Due at once; still waits for the minimum gap; no reply for someone else's line; never reacts to an AI player. |
| TC-0267 | AI reply address parsing | NPC reply "@host, which date…", "@cfo …"; live AI player "@account_manager …", "@Priya Raman …" (other scene), no participants. | Valid ones stripped into `to`; the others unchanged with no `to`. |
| TC-0268 | Composer @ list and direction (jsdom) | Type "@", filter, Enter/Tab/arrows/Escape/click; delete the mention; submit. | List of other scene roles; "@Role title " inserted; `onSay(text, roleId)`; dropped mention sends `onSay(text)`; transcript and console timeline show "to …", "to you" highlighted. |
| TC-0269 | Waiting for you and expiry (jsdom) | AI line addressed to me; I answer; other scene; ended; AI seat; a thinking line left without idle for 120 s. | Banner only while unanswered in the current scene; thinking line clears by itself after the expiry; console turn labels read Thinking/Waiting/Timed out (turn skipped). |

Manual (not run, needs a browser): open a session with 1 human, 2 AI players and Priya; check the thinking line, the AI players panel
states, the @ list with a screen reader (VoiceOver: combobox and listbox announcements) and the "Waiting for you" banner.

## CHANGELOG line (for `[Unreleased]`, Added)

- Players and the facilitator now see "<name> is thinking…" while an AI character or AI player composes a reply (never recorded), the facilitator's AI players panel shows each AI player's turn state, a player sees "Waiting for you" when an AI addresses them, and the composer's "@" list directs a line at one role of the scene (the line stays public). (US-0082)

## THREAT_MODEL notes (to add under a new "Activity and addressing, US-0082" section)

- **Activity frames.** In memory only; never an event (no seq), never logged, so nothing in replay, resume, the evaluator, reports or exports can see one. Delivered through one function (`activityFor` in `ws-server.ts`): facilitator whole; player = allowlisted copy (`activityForPlayer`, key by key) only when both viewer and speaker are participants of the current scene. A player therefore learns only that a co-participant of the scene it is already in is composing (it already sees that role's lines), never a scene it is not in, never the outcome (model failure is facilitator business). The BFF picks fields again on both streams and sends no SSE id, so Last-Event-ID never moves for it.
- **Who may report.** Only an AI player seat (`isAiRole`) may send `activity`; strict schema; it can only report its own role (the role comes from the socket, never the message). A malicious bot (the control service is trusted) could at worst show a false "thinking"; the page expires it after 120 s. Reports count against the connection's rate bucket.
- **Timing side channel (residual).** A co-participant can see when an AI's model call starts and ends (and so roughly how long a model takes). Accepted: the same participant sees the reply arrive anyway.
- **Addressing.** `to` is never trusted from a client or a model: the engine records it only for another own-property role of the speaker's current scene, inside the mutex. It is public within the scene (like the line). An AI reply's "@..." is matched only against the other roles of the current scene; an invented addressee is left in the text, never in `to`. The addressing rule and the "addressed to" sentence in prompts use role ids, role words and AI character names only (no typed participant name), outside the cached NPC prefix.
- **Leak scans.** `"outcome":` (facilitator-only) is not on the `hub.runtime.test.ts` / W-07 lists because those scans require the facilitator to have seen the marker and a mock run never times out; the player-copy tests (`activity.test.ts` in runtime and web, `ws-server.activity.test.ts`) prove the drop instead.

## ROLLBACK notes

- **No log-format change.** Logs without addressing are byte-identical. A log WITH `to` is still format 2 or 3; an older runtime resumes it (the reader checks only the event type; the fold ignores the field), so a rollback keeps every session; only the direction is no longer shown.
- **Deploy order: any.** Runtime, control service and web are independent:
  - new runtime + old web: the old BFF drops the unknown `activity` frame and old `say` bodies carry no `to`; nothing changes.
  - old runtime + new web: no frames, no indicators; a `to` on `say` is stripped by the old runtime's non-strict `say` schema (the line is recorded without it).
  - new control (bots) + old runtime: the old runtime's `joined` has no `activity` flag, so the bot sends no report; a bot `say` with `to` is stripped by the old schema.
  - old control + new runtime: bots send no reports; AI player thinking is not shown (AI characters still are).
- Rolling back the web app alone removes the indicators and the @ list; nothing is stored in the browser.

## Files

Runtime: `services/runtime/src/host/activity.ts` (new), `host/addressing.ts` (new), `agents/address-prompt.ts` (new), `engine/session-engine.ts`
(`say` `to`), `host/session-host.ts`, `host/ws-server.ts`, `host/protocol.ts`, `agents/npc-agent.ts`, `agents/npc-prompt.ts`,
`players/turn-policy.ts`, `players/prompt.ts`, `players/live.ts`. Events: `packages/events/src/address.ts` (new), `events.ts`, `state.ts`,
`player-view.ts` (`PlayerLine.to`, `scene.participants`), `index.ts`. Control: `services/control/src/bots/bot.ts`, `bot-frames.ts`,
`bot-socket.ts`. Web: `apps/web/src/server/activity-copy.ts` (new), `stream-hub.ts`, `facilitator-hub.ts`, `facilitator-copies.ts`,
`handlers.ts`, `wire.ts`; `lib/activity.ts` (new), `use-session.ts`, `use-console-stream.ts`, `console-view.ts`, `app.css`; components
`ThinkingLines.tsx`, `WaitingForYou.tsx`, `SceneTalk.tsx`, `console/AiTurnState.tsx` (new), `SayBox.tsx`, `Transcript.tsx`,
`SessionScreen.tsx` (one line), `console/ConsoleTimeline.tsx`, `console/LiveView.tsx`, `console/AiPlayersPanel.tsx`, `console/ConsoleControls.tsx`.

Merge notes for US-0080/US-0081: `player-view.ts` gains `participants` on the view's scene (optional in the type) and `to` on lines;
`SessionScreen.tsx` swaps the `SayBox` line for `SceneTalk`; `turn-policy.ts` gains an `addressed` flag in the `line` case and `deadline()`.

## Verification

See the final report. Not verified: the UI in a real browser (jsdom only), screen-reader output, a real model's use of "@role".
