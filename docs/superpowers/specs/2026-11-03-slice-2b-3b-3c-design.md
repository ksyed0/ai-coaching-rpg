# Slices 2b-3b and 2b-3c: live AI players and the group-score option

Addendum to `2026-10-31-slice-2b-remaining-design.md` (sections 2 and 5) and `2026-10-30-web-client-slice-2b-design.md` (sections 8.1 to 8.5 and 9). Where they differ, this one wins. 2b-3a (the runtime record, start gate, `set_ai_roles` IPC, labels in player copies, consent notice v2) is built; its PR 3 (notice v2, BFF reserved names and 4004, player-page labels) must be merged before 3b PR 2. An Opus design review (2026-11-03) checked the claims against the code; its findings are folded in.

## 1. Understanding

A facilitator can fill any player role with an AI before the start, from the browser. Participants always see AI seats and lines labelled, and the evaluator never scores an AI player individually. Owner decisions of 2026-11-03 are marked **[owner]**.

- 3b is one plan with three PRs **[owner]**. 3b and 3c are released together; no release is tagged between their merges, and there is no guard task **[owner]**.
- The terminal client labels AI lines and seats; it does not refuse AI sessions **[owner]**.
- Whisper "private" label with reload survival, and the focus fallback after End session (to the final banner), are separate small changes after 3a, outside these plans **[owner]**.
- Report-access credentials and self-assessment for AI roles stay in 2c.

## 2. Decisions that amend the earlier specs

1. **Cap of 8 AI roles [owner].** `set_ai_roles` is refused when more than 8 roles are AI (the bot connection key allows 8 sockets per address). Together with the 12 player-role cap at create (`2H + B + 7 <= 32`).
2. **The prompt hint never enters the session log [owner].** Amends 8.3a: the runtime receives `prompt_ai { roleId }` only and logs a facilitator-only `facilitator.command` with `by`; the hint (at most 300 characters, cleaned) goes to the control service in the run step and is written only to the intent log.
3. **Single-role reissue and remove are refused for an AI role [owner].** The control service answers 409 "switch the role back to human first" for `aiRolesOf(id)` roles, before and after the start. `reissueAll` filters AI roles' codes out of its reply and re-sends `set_ai_roles` inside the same lock before replying.
4. **One spend budget per session [owner].** 60 model calls (a bot line or a prompt) across all bots, held in the control service and rebuilt after a restart from the replayed log (AI utterances plus `prompt_ai` commands). Bots send no nudge while no human is connected.
5. **A bot joins with a code only [owner].** No credential; it rejoins with its reconnect token within the same runtime, with a code after a runtime restart, and gets one reissue after a control-service restart. The dedicated revoke reason for a switched human who is not connected (3a note 10) is deferred; "signed out" is accepted.
6. **Amends A1:** routes ship "only with the bot host wired" (not "with the toggle"); 3b PR 2 ships them before the toggle (PR 3), which is harmless because no release is tagged between the PRs.
7. **Bot connection key.** Bots send the reserved forwarded key `scenecoach-bot` (console tabs use `scenecoach-console`); each bot closes its old socket before rejoining. A stale code can block one bot for the auth-throttle window; the host handles `unauthorized` by asking for a reissue, not by retrying.

## 3. Stack 2b-3b (one plan, three PRs)

### PR 1: bot engine, no routes

- **Shared module** `services/runtime/src/players/` (subpath export; AC-0319): generator, prompt builder, line cleaning, new `TurnPolicy`; own `PLAYER_MODEL` and `PLAYER_TEMPERATURE`, falling back to the NPC model; `MAX_LINE_CHARS` moves in; no dependency on `demo/showcase-script`; the demo keeps working through it.
- **TurnPolicy (reactive):** speaks when its role is addressed or an NPC or human finishes, or after a quiet-time nudge; never reacts to another AI line; defaults minimum gap 15 s, nudge 90 s, 10 lines per scene (reset on scene entry), all settings. Timers are suspended while paused; a reply produced for an earlier scene, or while paused or ended, is dropped. A model failure, timeout or empty reply skips the turn and raises a facilitator alert; never a canned line. Every model call has its own hard timeout (test: a never-resolving provider leaves the control API responsive; reconcile the turn when the call returns). Test: two bots and NPCs reach the scene cap and stop.
- **Prompt safety.** Dialogue and the hint are fenced as untrusted input; display names stay out of the prompt (role ids only, as `viewFromEvents` does today); revisit "never mention that you are an AI" for live seats; the residual risk (a human can talk the bot into its role's private facts) goes into the threat model.
- **Control-service bot host:** one socket per bot, no `displayName`, codes only in memory, the `scenecoach-bot` key; IPC `bot_alert { roleId, message }` (both copies, drift-tested) for the runtime to append `facilitator.alert`; facilitator-only intent log file per bot.
- **Runtime:** skip `releaseForRebind` and the "consent will be rebound" line for AI roles in a post-start reissue (3a note 7); the 8-AI-role cap in `set_ai_roles`; the 12 player-role cap at create.
- Driven by tests only; no HTTP route.

### PR 2: AI seats become reachable, labelled in the same PR

Precondition: 3a PR 3 merged.

- **Supervisor wiring:** `goLive` and `ready.aiRoles` start or rejoin bots (new port after a restart); `onEnded` and `onChildExit` stop them and drop replies in flight; after a control-service restart each AI role is reissued once.
- **Routes:** control API (service token) and BFF (facilitator cookie, `checkOrigin`, `checkFetchSite`, strict JSON) to set AI roles and to read the intent log (`GET /sessions/:id/ai-roles/:roleId/intents`, `roleId` validated with the IPC `RoleId` schema before any path is built; the file is deleted on a whole-session reissue and on removal). AI codes never reach the BFF. After a `set_ai_roles` timeout, reissue the changed roles before any code is used (A11). The refusals of decision 3.
- **Labels (the hard rule):** the terminal client (`cli/render.ts`, which prints raw role ids today) labels AI lines and seats from `aiRoles` in the snapshot; console readiness lists `ai` in `entryOf` and words AI rows apart from `seats_not_ready` humans; the console timeline labels from `state.aiRoles`.
- Leak scan extended to bot codes, the `scenecoach-bot` key and hint text.

### PR 3: toggle and Prompt AI player

- **Toggle** on the New session and readiness screens until the start, with confirmation (AC-0317, AC-0318) and the new code shown once when a role goes back to human.
- **Prompt AI player** with optional hint: (1) the BFF asks the control service to reserve the turn (refused when a turn is in flight or inside a debounce; in-memory, 10 s expiry); (2) the BFF sends the runtime `prompt_ai { roleId }` (refused unless AI-filled and running); (3) on success the BFF asks the control service to run the reserved turn with the hint. A failed log means nothing runs; a failed run after logging shows an alert and may be retried. A prompt skips the nudge, gap and scene cap but counts against the budget.
- Axe at laptop width; end-to-end tests; threat model and documents.

## 4. Stack 2b-3c (US-0061, own independent review, AC-0326)

- **`includeInGroup`** (default on, AC-0323), an optional field of `set_ai_roles`, the AI-role file (versioned record) and `session.started` (still format 3; absent means on). `setAiRoles` compares roles and the option together, so a change of the option alone is not dropped as a no-op. Both IPC copies change. A toggle in the UI until the start.
- **Evaluator (AC-0322, AC-0324):** takes AI roles from the log fold (`state.aiRoles`), not from `scenario.roles` (`evaluate.ts:101`, `verify.ts:20`); individual criteria never score an AI role; group rubric: on = AI lines are team evidence labelled AI in quoted evidence, off = context only (`transcript.ts` labels speakers by scenario role type today and must show AI lines as AI).
- **Other readers of player roles:** report model participant counts (`report-model.ts`), the review index row "AI player, not scored" (`review/view.ts`, `policy.ts`, `index-view.ts`), the calibration stamp (`StampState`/`normalizeStamp` gain an "includes AI" variant; AC-0325), and self-assessment (excluded because an AI role gets no draft).
- Tests for both settings; the independent review.

## 5. Risks carried into the plans

- A model call still in flight after a kick or restart must not send a duplicate line after the rejoin.
- Two copies of the IPC schema (drift test) change in 3b PR 1 and 3c.
- The reservation held by a call that never resolves: reconcile when it returns.
- No intermediate build may be released (a hand-run evaluator on `develop` between 3b PR 2 and 3c would score AI seats).
- The bot intent log is facilitator-only; the leak scan must cover it.
