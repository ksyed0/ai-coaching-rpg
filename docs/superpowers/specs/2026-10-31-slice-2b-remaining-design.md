# Slice 2b remaining work: live console (2b-2) and AI players (2b-3), refinements

Addendum to `2026-10-30-web-client-slice-2b-design.md` (sections 7 and 8). Where the two differ, this one wins. 2b-1 is built and merged. A read-only Opus review (2026-11-01) checked the claims against the code; its findings are folded in below.

## 1. Understanding

A facilitator runs a whole session from the browser, and an AI player can fill a role. Success: no terminal is needed, and no participant frame ever carries `by`, facilitator-only data or an unlabelled AI line. Owner decisions of 2026-10-31 are marked **[owner]**; the rest is my recommendation, agreed in conversation.

## 2. Order and stacks

Seven stacks, in order. Each gets its own plan, written when the one before it is merged.

| Stack | Content |
| --- | --- |
| 2b-2a | Runtime protocol: allowlisted player copies (own PR, first), `by`, talk time, `end_now`, `remove_participant` as a reissue reason (not a ws message) **[owner]** |
| 2b-2b1 | Facilitator SSE channel and read-only live view **[owner]** |
| 2b-2b2 | Command route, controls and confirmations |
| 2b-3a | AI-role state (`set_ai_roles` IPC), start gate, marking incl. `aiRoles` reaching players, consent notice version, log format 3 (AC-0317, AC-0318 land across 3a/3b) |
| 2b-3b | Bot module, control-service host, AI toggle UI, Prompt AI player. The start gate of 3a ("an AI role needs a connected bot") ships here or behind a test-only path, so no released build has an AI role that cannot start |
| 2b-3c | Group-score option, evaluator change, report labels (own independent review, AC-0326) |

## 3. Stack 2b-2a (runtime)

1. **Allowlisted copies first.** `viewFor` and `snapshotFor` become allowlisted: `by` is stripped from every command a player sees and a new state field reaches players only if listed. A test pins today's player snapshot so 2a players see no change. The leak scan covers `by`, `message` of `end_now` only where intended, and talk time.
2. **`by`.** Optional on `facilitator.command`, cleaned, at most 60 code points, attested by the BFF. Terminal facilitators send none.
3. **Talk time.** The spec's claim that the evaluator computes it is wrong: no formula exists (the method text only calls it "context, not a criterion"). Definition: words and lines per player role, folded from `utterance` events in the shared reducer in `packages/events`; a word is a whitespace-separated run of non-empty characters, Unicode-safe. NPC lines are counted apart as context. The console labels it "Words spoken", never "time". Facilitator snapshot only. **[owner: reducer]**
4. **`end_now { message? }`.** Facilitator client message handled outside the `command` branch, so it never reaches the auto-start (the real code is `if (!host.hasStarted) await host.start()` inside `command` only; the parent spec's quote of `status === "idle"` is stale). Refused before the start, after the end, and **while `host.isStarting` or `engine.startIncomplete`** (a start retry would otherwise append `scene.entered` after `session.ended`). Inside the engine mutex, in this order: `scene.exited {reason: "facilitator_end"}`, the facilitator-only alert naming `by`, then `session.ended {reason: "facilitator_end", message?}` **last** (`alert()` refuses after the end, `readLogStatus` reads "ended" only from the last line, and the `ended` IPC fires on `session.ended`). `ExitReason` gains `facilitator_end` (a type only; the reducer and fold ignore the reason; add keys to typed tables in `demo/`). **Restore:** if the last `scene.exited` has reason `facilitator_end` and no `session.ended` follows, the repair is `end_session {reason: facilitator_end}` (not `enter_scene`); the `message` is lost and the repair alert says so. A restore test cuts between the two appends. `message`: at most 300 characters, cleaned; `PlayerView.ended` gains `message` (rendered as text) and the player copy of `session.ended` is allowlisted (reason, message). The scene clock and Game Master stop. **[owner: scene.exited + session.ended]**
5. **Remove is the reissue IPC, not a ws message.** Code reissue is parent-only IPC (`host/main.ts`) and returns the new code only to the parent, and a code opens any role without a credential (`ws-server.ts` `byCode`), so a ws message could not reissue "in the same step" and a revoke-then-reissue gap would reopen the seat to the removed person's old code. Remove is the existing `reissueRole` (before the start: new codes written first, credential revoked, consent withdrawn, persisted, kicked, swapped) with `reason: "removed"` and a distinct close code (4003, shown as "the facilitator removed you"), sent by the control service; the B2 route calls the launcher. Mid-session removal is out of scope; the facilitator ends the session instead.
6. **Tests.** Engine, fold and restore for each event (including the cut between the two `end_now` appends); ws-server for `end_now` including "never auto-starts" and the refusal during an interrupted start; the talk-time update in both the `reduce` path and the restore fold's utterance fast path (`state.ts`); the remove close code and that the old code cannot reopen the seat; an in-flight NPC reply or Game Master tick when `end_now` lands appends nothing after `session.ended`; the leak scan.

## 4. Stacks 2b-2b1 and 2b-2b2 (BFF and console)

- **B1.** One facilitator socket per console tab, forwarded as SSE with seq ids and `Last-Event-ID` replay. `StreamHub` is player-shaped throughout (keyed by role and participant through `SessionCookie`, `playerJoined`, `initPlayerView`, player-only `SEND_ERRORS`, and a reset when `joined.logIdentity` differs from the cookie, while the facilitator `joined` carries no `logIdentity`, so every connect would reset). B1 therefore gives the facilitator its own key, caps and view fold (`reduce` throws on a seq gap) and shares only the replay and heartbeat mechanics; it is not a thin parameter. A route separate from the player stream, cookie checked on every connect and reconnect, with a test that a player credential gets nothing from it. **Connection budget:** the caps are already explicit (32 total, 8 per address, `TRUST_PROXY=1`, `child-env.ts`), and player streams send a per-player `X-Forwarded-For`, but facilitator sockets send none, so every console tab, readiness socket and command socket, and the 2b-3b bots joining from the control service, share one loopback address limit of 8, and the upgrade-level block uses the facilitator scope `""` (a stale token could also block bots). B1's first task sets a per-address budget for facilitator tabs, short-lived sockets and bots, says whether B2 commands reuse the tab's socket, and 2b-3b bots send a distinct forwarded key or get their own limit, with a test. Live view: scene and timer, transcript with Game Master notices and alerts, words spoken. Polite live region, text-only rendering under the nonce CSP, Axe at laptop width.
- **B2.** `POST /api/v1/console/command` for pause, resume, advance, inject, whisper, release fact, NPC stance, `end_now`, `remove_participant`. `by` comes only from the sealed cookie; `expectSceneId` stays. AC-0316's Axe audit runs again here for the controls and confirmation dialogs. Origin and `X-Requested-With`, strict JSON, neutral failures. Irreversible or audience-affecting actions use one confirmation naming subject and audience. A stale scene shows "the scene changed, review and retry" (acceptance criterion with a test).

## 5. Stacks 2b-3a, 3b, 3c

Design as in sections 8.1 to 8.5 of the parent spec, with these refinements:

- **Pacing defaults [owner: balanced]:** minimum gap 15 s, quiet-time nudge after 90 s, at most 10 lines per scene, 60 model calls per session (a bot line or a prompt). All are settings.
- **Never-hang rule:** every bot model call has its own hard timeout; a test proves a never-resolving provider leaves the control API responsive.
- **Reservation** for Prompt AI player is an in-memory map with a 10 s expiry in the control service; nothing persists.
- **Consent notice bump:** a test that a running session whose players consented under the old version is not locked out after a restart on the new version.
- **AI marking must reach players.** Player copies of `session.started` come from `STARTED_FOR_PLAYERS` and `PlayerView` has no roles field, so 3a adds `aiRoles` to `STARTED_FOR_PLAYERS`, the snapshot allowlist and `PlayerView`, with a test that a player frame labels an AI line (AC-0321).
- **Dependencies:** console labels need B1 and Prompt AI player needs B2; the linear order covers both.
- **3c** ships last, after 3a and 3b are merged and stable.

## 6. Open items left for the plans

1. The per-address connection budget (2b-2b1, first task; see B1).
2. `players/` subpath-export mechanism (2b-3b).
3. (Answered: `readLogStatus` in `services/control/src/log-tail.ts` is the lock-free log-tail check.)
4. (Answered by 2b-1: `fork()` under `tsx`.)
